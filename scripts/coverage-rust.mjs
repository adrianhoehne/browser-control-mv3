/**
 * Line coverage of the bridge, measured by `cargo llvm-cov` (`docs/66`).
 *
 * The number itself is not computed here. `cargo llvm-cov --summary-only` prints the
 * per-module table and the `TOTAL` line, and this wrapper passes that output through
 * unchanged — a second implementation of the arithmetic would be a second number to
 * trust. What the wrapper does own is the frame around the run: the threshold, the
 * manifest, the serial test threads, and the sentence for a machine that lacks the
 * tools.
 *
 * Three decisions shape the run:
 *
 * 1. **The threshold is 90 % lines**, the same as the extension's (`docs/64`), and it
 *    lives in this file. `package.json` and any YAML stay free of it, so there is one
 *    place to read the rule from. `--min=<percent>` overrides it for a single run.
 * 2. **No PATH requirement.** `cargo` is looked up in `PATH` and then in
 *    `~/.cargo/bin`, because a rustup installation is often not on the PATH of the
 *    shell that runs `npm`.
 * 3. **A missing tool is a sentence, not a stack trace.** The message names both
 *    install commands and never installs anything itself.
 *
 * The arithmetic-free parts — `rustCoverageCommand`, `percentageFrom`, `findCargo`,
 * `missingToolchainMessage` — are pure and exported, which is what the tests pin.
 * `main` is the part that spawns a process.
 *
 * Exit code 0 means the measured share reached the threshold, 1 means it did not or
 * the toolchain is incomplete.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

const DEFAULT_MIN_PERCENT = 90;
const DEFAULT_MANIFEST_PATH = "bridge-rs/Cargo.toml";
const MINIMUM_FLAG = "--min=";

// The bridge's cases that start a real listener must not share a machine with each
// other; `CONTRIBUTING.md` gives the same rule to `cargo test`.
const SERIAL_TESTS_FLAG = "--test-threads=1";

// `cargo` is a shell script or an executable, depending on how rustup was set up.
const CARGO_NAME = process.platform === "win32" ? "cargo.exe" : "cargo";

/**
 * The argument list for `cargo`, without the binary itself.
 *
 * `--summary-only` keeps the table and drops the per-file detail; `--fail-under-lines`
 * is `cargo llvm-cov`'s own gate, so the exit code is the tool's, not ours. Everything
 * after `--` belongs to the test binary.
 */
export function rustCoverageCommand({ minimum = DEFAULT_MIN_PERCENT, manifestPath = DEFAULT_MANIFEST_PATH } = {}) {
  return [
    "llvm-cov",
    "--manifest-path",
    manifestPath,
    "--summary-only",
    "--fail-under-lines",
    String(minimum),
    "--",
    SERIAL_TESTS_FLAG,
  ];
}

/**
 * `--min=<percent>` for one run, or `{ error }` for anything unexpected.
 *
 * The decimal separator is a dot: `99.9`. A comma is refused with a sentence that
 * names the format, rather than parsed as something else — `Number("99,9")` is `NaN`
 * and a silent 90 % would be a measurement nobody asked for.
 */
export function percentageFrom(argv) {
  let minimum = DEFAULT_MIN_PERCENT;

  for (const argument of argv) {
    if (!argument.startsWith(MINIMUM_FLAG)) return { error: `unbekanntes Argument: ${argument}` };

    const raw = argument.slice(MINIMUM_FLAG.length);
    const parsed = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return { error: `--min verlangt eine Zahl zwischen 0 und 100 mit Punkt als Dezimaltrennzeichen, nicht "${raw}"` };
    }

    minimum = parsed;
  }

  return { minimum };
}

function isExecutableFile(candidate) {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * The `cargo` to run, or `null` when there is none.
 *
 * `PATH` first, so a shell that already answers `cargo` keeps answering it; then
 * `~/.cargo/bin`, which is where rustup puts it and where `npm` does not look. The
 * parameters exist so a test could point this at a temporary tree; both default to
 * what the running process sees.
 */
export function findCargo({ pathValue = process.env.PATH ?? "", homeDirectory = os.homedir() } = {}) {
  for (const directory of pathValue.split(path.delimiter)) {
    // An empty entry means "the working directory" to some shells and nothing to
    // others; guessing is not worth a false hit.
    if (directory === "") continue;

    const candidate = path.join(directory, CARGO_NAME);
    if (isExecutableFile(candidate)) return candidate;
  }

  const cargoBinCandidate = path.join(homeDirectory, ".cargo", "bin", CARGO_NAME);
  return isExecutableFile(cargoBinCandidate) ? cargoBinCandidate : null;
}

/**
 * The one sentence for a machine without the tools. One line, both commands, no
 * attempt to install anything.
 */
export function missingToolchainMessage() {
  return (
    "Werkzeug fehlt: rustup component add llvm-tools-preview ausführen und cargo install cargo-llvm-cov, " +
    "dann erneut messen."
  );
}

/** Whether `cargo` knows the subcommand — `cargo-llvm-cov` is a separate binary. */
function hasLlvmCovSubcommand(cargo) {
  const result = spawnSync(cargo, ["llvm-cov", "--version"], { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function main() {
  const threshold = percentageFrom(process.argv.slice(2));
  if (threshold.error) {
    process.stderr.write(`${threshold.error}\n`);
    return 1;
  }

  const cargo = findCargo();
  if (cargo === null || !hasLlvmCovSubcommand(cargo)) {
    process.stderr.write(`${missingToolchainMessage()}\n`);
    return 1;
  }

  // The output goes straight to the terminal — the table is the report, and a run
  // that takes minutes should say so while it runs.
  const result = spawnSync(cargo, rustCoverageCommand({ minimum: threshold.minimum }), {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
  });

  if (result.error) {
    process.stderr.write(`cargo llvm-cov nicht startbar: ${result.error.message}\n`);
    return 1;
  }

  // `cargo llvm-cov` answers 1 when the share is below the threshold; a signal death
  // has no status, and that is a failure too.
  return result.status ?? 1;
}

// Importing this file (the tests do) must not run `cargo`, so `main` only fires when
// node was pointed at this very file.
function isStartedAsScript() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}

if (isStartedAsScript()) {
  process.exitCode = main();
}
