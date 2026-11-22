/**
 * `scripts/install.sh` as the process it is: a temporary `HOME`, a stub directory
 * in front of `PATH`, and nothing of the real machine touched.
 *
 * Two things make these cases worth their runtime. First, the sandbox: the script
 * writes into `$HOME`, starts services through `systemctl` and asks `ss` who owns a
 * port — all three replaced, so a test can neither install anything nor kill the
 * operator's bridge. Second, the environment is assembled from scratch, never
 * inherited: `runInstall` passes exactly `HOME`, `PATH`, the stub log path and what
 * a case adds. A stray `BC_INSTALL_STUB_SS` from the developer's shell therefore
 * cannot colour a green run.
 *
 * The token fixtures are built at runtime (`"ab".repeat(16)`, a fresh
 * `randomBytes`). A literal 32- or 64-hex string in this file would trip the
 * repository's own secret grep — the acceptance would be red because of a test
 * fixture, which is exactly the kind of self-inflicted red nobody debugs twice.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout } from "node:timers/promises";

const BASH = "/bin/bash";
const SCRIPT_PATH = path.resolve(import.meta.dirname, "../scripts/install.sh");
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const UNIT_SOURCE_PATH = path.join(REPOSITORY_ROOT, "deploy", "browser-control.service");

const TOKEN_RELATIVE_PATH = path.join(".config", "browser-control", "token");
const UNIT_RELATIVE_PATH = path.join(".config", "systemd", "user", "browser-control.service");
const BINARY_RELATIVE_PATH = path.join(".local", "bin", "browser-control-bridge");

/**
 * Where the installer expects the built artefact: inside the clone at `$HOME/browser-control`,
 * the same path `bridge-rs/README.md` documents under "Building".
 */
const CLONE_ARTEFACT_RELATIVE_PATH = path.join(
  "browser-control",
  "bridge-rs",
  "target",
  "x86_64-unknown-linux-musl",
  "release",
  "browser-control-bridge",
);

/** Directory names are allowed only where the spec's `mkdir -p` would create them. */
const ALLOWED_EXACT_DIRECTORIES = new Set([
  ".config",
  ".config/systemd",
  ".config/browser-control",
  ".config/systemd/user",
  ".local",
  ".local/bin",
]);
const ALLOWED_PREFIXES = [".config/browser-control/", ".config/systemd/user/", ".local/bin/"];

/**
 * The stub for `systemctl`. It logs the call and answers by subcommand, so the
 * happy path and the "not active" path are both reachable from a test. A stub that
 * always answered 0 would make `is-active` untestable.
 */
const SYSTEMCTL_STUB = `#!/usr/bin/env bash
set -u
printf 'systemctl %s\\n' "$*" >>"$BC_INSTALL_STUB_LOG"
sub=""
for arg in "$@"; do
  case $arg in
    --*) ;;
    *) sub=$arg; break ;;
  esac
done
state="\${BC_INSTALL_STUB_LOG}.state"
case $sub in
  # The state file makes start/restart/stop visible to a later is-active, so the
  # "is it running now?" check after the start is reachable from a test.
  is-active) exit "$(cat "$state" 2>/dev/null || printf '%s' "\${BC_INSTALL_STUB_IS_ACTIVE:-0}")" ;;
  start|restart) printf '0' >"$state"; exit 0 ;;
  stop|disable) printf '1' >"$state"; exit 0 ;;
  show) printf '%s\\n' "\${BC_INSTALL_STUB_MAINPID:-4242}"; exit 0 ;;
  *) exit 0 ;;
esac
`;

/** `ss -ltnp` as this host prints it; the specs come per case through the environment. */
const SS_STUB = `#!/usr/bin/env bash
set -u
printf 'ss %s\\n' "$*" >>"$BC_INSTALL_STUB_LOG"
printf '%s\\n' "\${BC_INSTALL_STUB_SS:-}"
exit 0
`;

/** A real random token, generated at call time — never a fixed string in this file. */
const OPENSSL_STUB = `#!/usr/bin/env bash
set -u
printf 'openssl %s\\n' "$*" >>"$BC_INSTALL_STUB_LOG"
head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n'
printf '\\n'
`;

/** Builds a 64-hex token without putting one in the file text. */
function freshToken() {
  return randomBytes(32).toString("hex");
}

function writeStub(directory, name, body) {
  const targetPath = path.join(directory, name);
  fs.writeFileSync(targetPath, body);
  fs.chmodSync(targetPath, 0o755);
  return targetPath;
}

/**
 * A sandbox holding the temporary `HOME`, the stub directory and the stub log.
 * `home/browser-control/` with a build artefact below it exists because that is what
 * the installer copies from: the artefact has to be a real file with the execute bit,
 * so it is written as a stand-in script — nothing in a test may need a `cargo` build.
 */
function makeSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bc-install-"));
  const home = path.join(root, "home");
  const stubs = path.join(root, "stubs");
  const logPath = path.join(root, "stub.log");

  writeFakeBuild(path.join(home, CLONE_ARTEFACT_RELATIVE_PATH));
  fs.mkdirSync(stubs, { recursive: true });

  writeStub(stubs, "systemctl", SYSTEMCTL_STUB);
  writeStub(stubs, "ss", SS_STUB);
  writeStub(stubs, "openssl", OPENSSL_STUB);

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  return { root, home, stubs, logPath };
}

/**
 * A stand-in for the musl release artefact: an executable file with a recognisable
 * body, so a case can compare what was copied without building anything. The content
 * is deliberately not a valid ELF — the installer copies bytes and never runs them.
 */
function writeFakeBuild(targetPath, content = "#!/bin/sh\necho stand-in for the built bridge\n") {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content);
  fs.chmodSync(targetPath, 0o755);
  return targetPath;
}

/** A `node` stub that reports a chosen version and otherwise does nothing. */
function writeNodeStub(sandbox, version) {
  writeStub(
    sandbox.stubs,
    "node",
    `#!/usr/bin/env bash\nset -u\ncase "\${1:-}" in\n  -v) printf '%s\\n' "${version}" ;;\nesac\nexit 0\n`,
  );
}

/**
 * Runs the installer with an environment assembled here, not inherited. The `PATH` is
 * stubs first, then the two system directories — the script needs no interpreter of its
 * own beyond bash (`/bin/bash`), which the stubs' shebangs find the same way.
 */
function runInstall(sandbox, args = [], extraEnv = {}) {
  const result = spawnSync(BASH, [SCRIPT_PATH, ...args], {
    encoding: "utf8",
    env: {
      HOME: sandbox.home,
      PATH: [sandbox.stubs, "/usr/bin", "/bin"].join(":"),
      BC_INSTALL_STUB_LOG: sandbox.logPath,
      ...extraEnv,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

function stubLog(sandbox) {
  return fs.existsSync(sandbox.logPath) ? fs.readFileSync(sandbox.logPath, "utf8") : "";
}

function readToken(sandbox) {
  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  return fs.existsSync(tokenPath) ? fs.readFileSync(tokenPath, "utf8") : null;
}

function writeToken(sandbox, content, mode = 0o600) {
  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenPath, content);
  fs.chmodSync(tokenPath, mode);
  return tokenPath;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * One line per entry under `root`: kind, mode, size and content hash (plus the
 * modification time as a string, so a rewrite with identical content is visible).
 * A comparison of two of these maps answers "was anything written?" without
 * trusting a single property.
 */
function readTree(root) {
  const entries = new Map();

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = path.relative(root, fullPath);
      const stats = fs.statSync(fullPath, { bigint: true });
      const mode = Number(stats.mode & 0o777n).toString(8);

      if (entry.isDirectory()) {
        entries.set(relativePath, `dir ${mode}`);
        walk(fullPath);
      } else {
        const content = fs.readFileSync(fullPath);
        entries.set(relativePath, `file ${mode} ${content.length} ${sha256(content)} ${stats.mtimeNs}`);
      }
    }
  };

  if (fs.existsSync(root)) walk(root);
  return entries;
}

function relativePathsNewIn(before, after) {
  return [...after.keys()].filter((key) => !before.has(key));
}

function isAllowedPath(relativePath) {
  const posixPath = relativePath.split(path.sep).join("/");
  if (ALLOWED_EXACT_DIRECTORIES.has(posixPath)) return true;
  return ALLOWED_PREFIXES.some((prefix) => posixPath.startsWith(prefix));
}

test("install_helpPrintsTheOptionsAndWritesNothing", (t) => {
  // GIVEN an empty sandbox,
  const sandbox = makeSandbox(t);
  const before = readTree(sandbox.home);

  // WHEN the installer is asked for its help,
  const run = runInstall(sandbox, ["--help"]);

  // THEN it exits 0, names every option it has, writes nothing and does not talk
  // to systemd at all:
  assert.equal(run.status, 0, run.output);
  for (const option of ["--dry-run", "--print-token", "--uninstall", "--help"]) {
    assert.ok(run.stdout.includes(option), `help does not name ${option}:\n${run.stdout}`);
  }
  assert.deepEqual(readTree(sandbox.home), before);
  assert.equal(stubLog(sandbox), "");
  assert.equal(run.stderr, "");
});

test("install_withOldNodeOnThePath_ignoresTheVersion", (t) => {
  // GIVEN a sandbox whose `node` reports version 20 — the state the installer used to
  // refuse back when the unit started the Node bridge entry point (deleted by
  // docs/38; the unit runs a binary now),
  const sandbox = makeSandbox(t);
  writeNodeStub(sandbox, "v20.11.1");

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it installs and starts as on any other host: the service runs a binary, and
  // Node is not an operational prerequisite any more — refusing here would turn a
  // healthy machine into a red preflight:
  assert.equal(run.status, 0, run.output);
  assert.ok(!run.stderr.includes("Node"), run.stderr);
  assert.ok(fs.existsSync(path.join(sandbox.home, BINARY_RELATIVE_PATH)), "binary was not installed");
  assert.ok(fs.existsSync(path.join(sandbox.home, UNIT_RELATIVE_PATH)), "unit was not installed");
  assert.ok(readToken(sandbox), "no token was created");

  // AND the same run on a PATH without any `node` at all ends the same way, which is
  // what "not a prerequisite" has to mean:
  const nodeFree = makeSandbox(t);
  const withoutNode = runInstall(nodeFree, []);

  assert.equal(withoutNode.status, 0, withoutNode.output);
  assert.ok(!withoutNode.stderr.includes("Node"), withoutNode.stderr);
});

test("install_withOpenPort_abortsBeforeWriting", (t) => {
  // GIVEN a sandbox where port 8110 is taken by a foreign process,
  const sandbox = makeSandbox(t);
  const before = readTree(sandbox.home);

  // WHEN the installer runs,
  const run = runInstall(sandbox, [], {
    BC_INSTALL_STUB_SS: 'LISTEN 0 512 127.0.0.1:8110 0.0.0.0:* users:(("node",pid=4321,fd=8))',
  });

  // THEN it aborts with exit 1, names port and owning PID, suggests the next step
  // and leaves no token behind:
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /8110/);
  assert.match(run.stderr, /4321/);
  assert.match(run.stderr, /kill 4321/);
  assert.equal(readToken(sandbox), null);
  assert.deepEqual(readTree(sandbox.home), before);

  // AND an `ss` run without `-p` support — no `users:(…)` column — is reported as
  // "owner unknown" instead of crashing on an empty variable:
  const withoutOwner = runInstall(sandbox, [], {
    BC_INSTALL_STUB_SS: "LISTEN 0 512 127.0.0.1:8111 0.0.0.0:*",
  });

  assert.equal(withoutOwner.status, 1, withoutOwner.output);
  assert.match(withoutOwner.stderr, /8111/);
  assert.match(withoutOwner.stderr, /Besitzer nicht ermittelbar/);
  assert.equal(readToken(sandbox), null);
});

test("install_withMissingUnitTarget_abortsBeforeWriting", (t) => {
  // GIVEN a sandbox whose clone does not sit under `~/browser-control` — where the
  // installer looks for the artefact and INSTALL.md §4 clones to,
  const sandbox = makeSandbox(t);
  fs.rmSync(path.join(sandbox.home, "browser-control"), { recursive: true, force: true });
  const before = readTree(sandbox.home);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it aborts with exit 1 and names both paths — the expected clone target and
  // the directory this script actually runs from:
  assert.equal(run.status, 1, run.output);
  assert.ok(run.stderr.includes(path.join(sandbox.home, "browser-control")), run.stderr);
  assert.ok(run.stderr.includes(REPOSITORY_ROOT), run.stderr);
  assert.deepEqual(readTree(sandbox.home), before);
});

test("install_withMissingBinary_abortsBeforeWriting", (t) => {
  // GIVEN a sandbox whose clone exists but holds no build — the state after a fresh
  // clone, before `cargo build`,
  const sandbox = makeSandbox(t);
  fs.rmSync(path.join(sandbox.home, CLONE_ARTEFACT_RELATIVE_PATH));
  const before = readTree(sandbox.home);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it aborts with exit 1 before writing anything, names the missing artefact
  // and the command that produces it — a start without it would only fill the journal:
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /nicht gebaut/);
  assert.ok(run.stderr.includes(path.join(sandbox.home, CLONE_ARTEFACT_RELATIVE_PATH)), run.stderr);
  assert.match(run.stderr, /cargo build --release --target x86_64-unknown-linux-musl/);
  assert.deepEqual(readTree(sandbox.home), before);
  assert.equal(readToken(sandbox), null);

  // AND an artefact that exists but lost its execute bit is refused the same way and
  // by name: copying it would produce a service systemd starts and that dies with a
  // permission error instead of a German line. Same case, because the two halves are
  // one requirement — "the artefact has to be startable" — and a second name would
  // only inflate the count:
  const unexecutable = makeSandbox(t);
  const artefactPath = path.join(unexecutable.home, CLONE_ARTEFACT_RELATIVE_PATH);
  fs.chmodSync(artefactPath, 0o644);
  const beforeUnexecutable = readTree(unexecutable.home);

  const refused = runInstall(unexecutable, []);

  assert.equal(refused.status, 1, refused.output);
  assert.match(refused.stderr, /nicht ausführbar/);
  assert.ok(refused.stderr.includes(artefactPath), refused.stderr);
  assert.deepEqual(readTree(unexecutable.home), beforeUnexecutable);
});

test("install_copiesTheBinaryToLocalBin", async (t) => {
  // GIVEN a sandbox with nothing installed,
  const sandbox = makeSandbox(t);
  const artefactPath = path.join(sandbox.home, CLONE_ARTEFACT_RELATIVE_PATH);
  const installedPath = path.join(sandbox.home, BINARY_RELATIVE_PATH);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN the artefact lies under `~/.local/bin` — the path the unit's ExecStart names —
  // byte-identical to the build, executable, inside a 755 directory:
  assert.equal(run.status, 0, run.output);
  assert.ok(fs.existsSync(installedPath), "binary was not installed");
  assert.equal(fs.readFileSync(installedPath, "utf8"), fs.readFileSync(artefactPath, "utf8"));
  assert.equal(fs.statSync(installedPath).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.dirname(installedPath)).mode & 0o777, 0o755);
  assert.ok(run.stdout.includes(installedPath), run.stdout);

  // AND the unit that was installed starts exactly that file, so "copied somewhere"
  // and "started from there" cannot drift apart:
  const unitText = fs.readFileSync(path.join(sandbox.home, UNIT_RELATIVE_PATH), "utf8");
  assert.match(unitText, /^ExecStart=%h\/\.local\/bin\/browser-control-bridge --http$/m);

  // AND a second run with a moment in between rewrites nothing — same modification
  // time, and the line says so. A copy on every run would swap the inode under a
  // running service for no reason:
  const mtimeBefore = fs.statSync(installedPath, { bigint: true }).mtimeNs;
  await setTimeout(60);

  const again = runInstall(sandbox, []);

  assert.equal(again.status, 0, again.output);
  assert.equal(fs.statSync(installedPath, { bigint: true }).mtimeNs, mtimeBefore);
  assert.match(again.stdout, /Bridge-Binary ist schon aktuell/);

  // AND a new build is picked up: identical bytes are the only reason to skip the
  // copy, not the mere existence of the file:
  writeFakeBuild(artefactPath, "#!/bin/sh\necho rebuilt\n");

  const rebuilt = runInstall(sandbox, []);

  assert.equal(rebuilt.status, 0, rebuilt.output);
  assert.equal(fs.readFileSync(installedPath, "utf8"), fs.readFileSync(artefactPath, "utf8"));
  assert.match(rebuilt.stdout, /Bridge-Binary installieren/);
});

test("install_guardPathRejectsAPathOutsideTheAllowedSet", (t) => {
  // GIVEN the installer sourced into a shell of its own — sourcing defines the
  // functions and starts nothing,
  const sandbox = makeSandbox(t);
  const probe = (target) =>
    spawnSync(BASH, ["-c", `source "${SCRIPT_PATH}"; guard_path "${target}"`], {
      encoding: "utf8",
      env: {
        HOME: sandbox.home,
        PATH: [sandbox.stubs, path.dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        BC_INSTALL_STUB_LOG: sandbox.logPath,
      },
    });

  // WHEN the guard is handed a path outside the allowed set,
  const rejected = probe("/etc/passwd");

  // THEN it aborts with exit 1 and names the path, so the refusal is visible and not
  // a silent no-op:
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /Schreibziel außerhalb der erlaubten Pfade/);
  assert.match(rejected.stderr, /\/etc\/passwd/);

  // AND a path that climbs out with `..` is refused as well; a path inside the
  // token directory passes, which is what makes the guard falsifiable rather than
  // a function that always says no:
  const climbing = probe(`${sandbox.home}/.config/browser-control/../../etc/passwd`);
  assert.equal(climbing.status, 1, climbing.stderr);

  const allowed = probe(`${sandbox.home}/.config/browser-control/token`);
  assert.equal(allowed.status, 0, allowed.stderr);

  // AND the third place is allowed exactly, not its parent: `~/.local/bin/…` passes
  // and so does the staging name the installer writes before the rename, while
  // `~/.local/share/…` is refused — a guard that waved `~/.local` through would allow
  // every dotfile directory the operator owns:
  const binary = probe(`${sandbox.home}/.local/bin/browser-control-bridge`);
  assert.equal(binary.status, 0, binary.stderr);

  const staging = probe(`${sandbox.home}/.local/bin/browser-control-bridge.new`);
  assert.equal(staging.status, 0, staging.stderr);

  const share = probe(`${sandbox.home}/.local/share/browser-control/token`);
  assert.equal(share.status, 1, share.stderr);
  assert.match(share.stderr, /Schreibziel außerhalb der erlaubten Pfade/);
});

test("install_withUnknownOption_printsHelpAndExitsOne", (t) => {
  // GIVEN an empty sandbox,
  const sandbox = makeSandbox(t);
  const before = readTree(sandbox.home);

  // WHEN it is called with an option it does not know,
  const run = runInstall(sandbox, ["--nonsense"]);

  // THEN it exits 1 with the offending option and a short usage line on stderr,
  // writes nothing and does not run the preflight to the point of talking to ss:
  assert.equal(run.status, 1, run.output);
  assert.match(run.stderr, /Unbekannte Option: --nonsense/);
  assert.match(run.stderr, /Aufruf: scripts\/install\.sh/);
  assert.deepEqual(readTree(sandbox.home), before);
  assert.equal(stubLog(sandbox), "");
});

test("install_withUnwritableHome_abortsBeforeWriting", (t) => {
  // GIVEN a sandbox whose HOME cannot be written to,
  const sandbox = makeSandbox(t);
  fs.chmodSync(sandbox.home, 0o555);
  const before = readTree(sandbox.home);

  try {
    // WHEN the installer runs,
    const run = runInstall(sandbox, []);

    // THEN it aborts with exit 1 naming HOME and leaves no file behind:
    assert.equal(run.status, 1, run.output);
    assert.match(run.stderr, /nicht beschreibbar/);
    assert.ok(run.stderr.includes(sandbox.home), run.stderr);
    assert.equal(readToken(sandbox), null);
    assert.deepEqual(readTree(sandbox.home), before);
  } finally {
    fs.chmodSync(sandbox.home, 0o755);
  }
});

test("install_dryRunWritesNothing", (t) => {
  // GIVEN an empty sandbox,
  const sandbox = makeSandbox(t);
  const before = readTree(sandbox.home);

  // WHEN the installer runs in dry-run mode,
  const run = runInstall(sandbox, ["--dry-run"]);

  // THEN it exits 0, announces the steps in the future tense, and writes nothing —
  // not even the token, and without calling systemd once:
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /würde/);
  assert.match(run.stdout, /8110/);
  assert.deepEqual(readTree(sandbox.home), before);
  // The port preflight does ask `ss` — that is a question, not a call to systemd.
  assert.equal(
    stubLog(sandbox)
      .split("\n")
      .filter((line) => line.startsWith("systemctl"))
      .join("\n"),
    "",
  );
});

test("install_createsTokenWithTightPermissions", (t) => {
  // GIVEN an empty sandbox,
  const sandbox = makeSandbox(t);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it exits 0 and leaves a token file with 600, 65 bytes (64 hex characters
  // plus the newline INSTALL.md counts) inside a 700 directory:
  assert.equal(run.status, 0, run.output);

  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  const stats = fs.statSync(tokenPath);
  const directoryStats = fs.statSync(path.dirname(tokenPath));
  const content = fs.readFileSync(tokenPath, "utf8");

  assert.equal(stats.mode & 0o777, 0o600);
  assert.equal(directoryStats.mode & 0o777, 0o700);
  assert.equal(content.length, 65);
  assert.match(content, /^[0-9a-f]{64}\n$/);
});

test("install_withAnExistingToken_doesNotTouchIt", (t) => {
  // GIVEN a sandbox with a token file that already holds a usable token,
  const sandbox = makeSandbox(t);
  const token = `${freshToken()}\n`;
  const tokenPath = writeToken(sandbox, token);
  const beforeStats = fs.statSync(tokenPath, { bigint: true });
  const beforeHash = sha256(token);

  // WHEN the installer runs over it,
  const run = runInstall(sandbox, []);

  // THEN the run is green and says so, and the file is byte-identical, keeps its
  // modification time and its mode — "not overwritten" is checked, not promised:
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /Token bleibt unverändert/);

  const afterStats = fs.statSync(tokenPath, { bigint: true });
  assert.equal(sha256(fs.readFileSync(tokenPath, "utf8")), beforeHash);
  assert.equal(afterStats.mtimeNs, beforeStats.mtimeNs);
  assert.equal(afterStats.mode & 0o777n, beforeStats.mode & 0o777n);
});

test("install_withTooShortToken_exitsTwo", (t) => {
  // GIVEN a token file holding ten hex characters — the state the bridge refuses
  // with exit 2,
  const sandbox = makeSandbox(t);
  const tooShort = "abcdef0123\n";
  const tokenPath = writeToken(sandbox, tooShort);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it ends with the same code 2, names the path and leaves the file alone —
  // repairing by overwriting would be a rotation nobody asked for:
  assert.equal(run.status, 2, run.output);
  assert.match(run.stderr, /zu kurz/);
  assert.ok(run.stderr.includes(tokenPath), run.stderr);
  assert.equal(fs.readFileSync(tokenPath, "utf8"), tooShort);
});

test("install_withAShortButUsableToken_keepsGoing", (t) => {
  // GIVEN a token file holding exactly the 32 hex characters the bridge accepts —
  // built at runtime, because a literal would trip the repo's secret grep,
  const sandbox = makeSandbox(t);
  const shortButUsable = `${"ab".repeat(16)}\n`;
  const tokenPath = writeToken(sandbox, shortButUsable);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it continues with exit 0 and hints at the 64 characters INSTALL.md writes,
  // without touching the file. Refusing here would call a working setup broken:
  assert.equal(run.status, 0, run.output);
  assert.match(run.stderr, /Hinweis: das Token hat 32 Hex-Zeichen/);
  assert.match(run.stderr, /64/);
  assert.equal(fs.readFileSync(tokenPath, "utf8"), shortButUsable);
});

test("install_printTokenPrintsOnlyTheToken", (t) => {
  // GIVEN a sandbox with a token file,
  const sandbox = makeSandbox(t);
  const token = `${freshToken()}\n`;
  writeToken(sandbox, token);

  // WHEN only the token is asked for,
  const run = runInstall(sandbox, ["--print-token"]);

  // THEN stdout is exactly the file content — no progress lines, no endpoint, no
  // systemd — so the output can be piped into whatever needs it:
  assert.equal(run.status, 0, run.output);
  assert.equal(run.stdout, token);
  assert.equal(run.stderr, "");
  assert.equal(stubLog(sandbox), "");

  // AND without a token file the run ends with exit 2 and prints nothing on stdout,
  // because a client that reads stdout must not receive an error message there:
  const empty = makeSandbox(t);
  const missing = runInstall(empty, ["--print-token"]);

  assert.equal(missing.status, 2, missing.output);
  assert.equal(missing.stdout, "");
  assert.match(missing.stderr, /Tokendatei fehlt/);
});

test("install_withLooseTokenPermissions_reportsWithoutFixing", (t) => {
  // GIVEN a token file readable for everyone,
  const sandbox = makeSandbox(t);
  const token = `${freshToken()}\n`;
  const tokenPath = writeToken(sandbox, token, 0o644);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it says the mode is wrong and names 600, but does not change it: silently
  // fixing would hide that the file has been readable for others, maybe for days:
  assert.equal(run.status, 0, run.output);
  assert.match(run.stderr, /Rechte 644/);
  assert.match(run.stderr, /600/);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o644);
});

test("install_installsAndStartsTheUnit", (t) => {
  // GIVEN an empty sandbox,
  const sandbox = makeSandbox(t);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);

  // THEN it exits 0, the unit lies under ~/.config/systemd/user/ and is byte-identical
  // to deploy/ — copied, not rewritten:
  assert.equal(run.status, 0, run.output);

  const installedPath = path.join(sandbox.home, UNIT_RELATIVE_PATH);
  assert.ok(fs.existsSync(installedPath), "unit was not installed");
  assert.equal(fs.statSync(installedPath).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(installedPath, "utf8"), fs.readFileSync(UNIT_SOURCE_PATH, "utf8"));

  // AND the call order is the one that works: reload, then enable, then restart
  // (the stub reports an *active* service by default), then is-active. Enabling
  // before the reload would meet a unit systemd has not read; `enable --now` would
  // leave the running process on the old binary:
  const calls = stubLog(sandbox)
    .split("\n")
    .filter((line) => line.startsWith("systemctl"));

  const reloadIndex = calls.indexOf("systemctl --user daemon-reload");
  const enableIndex = calls.indexOf("systemctl --user enable browser-control");
  const restartIndex = calls.indexOf("systemctl --user restart browser-control");
  const activeIndex = calls.indexOf("systemctl --user is-active --quiet browser-control");

  assert.ok(reloadIndex >= 0, `no daemon-reload in:\n${calls.join("\n")}`);
  assert.ok(enableIndex > reloadIndex, `enable did not follow daemon-reload:\n${calls.join("\n")}`);
  assert.ok(restartIndex > enableIndex, `restart did not follow enable:\n${calls.join("\n")}`);
  assert.ok(
    calls.lastIndexOf("systemctl --user is-active --quiet browser-control") > restartIndex,
    `the final is-active did not follow restart:\n${calls.join("\n")}`,
  );
  assert.equal(
    calls.includes("systemctl --user enable --now browser-control"),
    false,
    `enable --now would keep the old process:\n${calls.join("\n")}`,
  );
});

test("install_withAStoppedService_startsItInsteadOfRestarting", (t) => {
  // GIVEN an empty sandbox whose service is not running,
  const sandbox = makeSandbox(t);

  // WHEN the installer runs,
  const run = runInstall(sandbox, [], { BC_INSTALL_STUB_IS_ACTIVE: "1" });

  // THEN it starts the unit, enables it for the next boot, and does not restart:
  assert.equal(run.status, 0, run.output);

  const calls = stubLog(sandbox)
    .split("\n")
    .filter((line) => line.startsWith("systemctl"));

  assert.ok(calls.includes("systemctl --user enable browser-control"), calls.join("\n"));
  assert.ok(calls.includes("systemctl --user start browser-control"), calls.join("\n"));
  assert.equal(calls.includes("systemctl --user restart browser-control"), false, calls.join("\n"));
});

test("install_isIdempotent", async (t) => {
  // GIVEN a sandbox the installer has already handled once,
  const sandbox = makeSandbox(t);
  const first = runInstall(sandbox, []);
  assert.equal(first.status, 0, first.output);

  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  const unitPath = path.join(sandbox.home, UNIT_RELATIVE_PATH);
  const tokenHashBefore = sha256(fs.readFileSync(tokenPath, "utf8"));
  const unitMtimeBefore = fs.statSync(unitPath, { bigint: true }).mtimeNs;
  const opensslCallsBefore = stubLog(sandbox)
    .split("\n")
    .filter((line) => line.startsWith("openssl")).length;

  // AND a moment has passed, so a rewrite would produce a different mtime:
  await setTimeout(60);

  // WHEN it runs again while its own service owns the port — the state after the
  // first run —,
  const second = runInstall(sandbox, [], {
    BC_INSTALL_STUB_SS: 'LISTEN 0 512 127.0.0.1:8110 0.0.0.0:* users:(("node",pid=4242,fd=8))',
  });

  // THEN nothing was rewritten: no second openssl call, the same unit modification
  // time, the same token bytes. And the own service on its port is not a conflict:
  assert.equal(second.status, 0, second.output);

  const opensslCallsAfter = stubLog(sandbox)
    .split("\n")
    .filter((line) => line.startsWith("openssl")).length;

  assert.equal(opensslCallsAfter, opensslCallsBefore, "a second token was generated");
  assert.equal(opensslCallsAfter, 1);
  assert.equal(fs.statSync(unitPath, { bigint: true }).mtimeNs, unitMtimeBefore);
  assert.equal(sha256(fs.readFileSync(tokenPath, "utf8")), tokenHashBefore);
  assert.match(second.stdout, /Systemd-Unit ist schon aktuell/);
  assert.match(second.stdout, /gehört zum eigenen Dienst \(PID 4242\)/);
});

test("install_dryRunUninstallKeepsTheUnit", (t) => {
  // GIVEN a sandbox the installer has set up, so there is a unit to remove,
  const sandbox = makeSandbox(t);
  const first = runInstall(sandbox, []);
  assert.equal(first.status, 0, first.output);

  const unitPath = path.join(sandbox.home, UNIT_RELATIVE_PATH);
  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  const unitHashBefore = sha256(fs.readFileSync(unitPath, "utf8"));

  // WHEN the removal is only previewed — the one combination where a preview used
  // to do the real thing,
  const run = runInstall(sandbox, ["--dry-run", "--uninstall"]);

  // THEN it exits 0 and says in the future tense what it would do, naming the unit:
  assert.equal(run.status, 0, run.output);
  assert.match(run.stdout, /würde/);
  assert.ok(run.stdout.includes(unitPath), run.stdout);
  assert.match(run.stdout, /Token bleibt/);

  // AND nothing happened: the unit is byte-identical and still there, the token is
  // where it was, and not one `disable` reached systemd:
  assert.ok(fs.existsSync(unitPath), "the dry run removed the unit");
  assert.equal(sha256(fs.readFileSync(unitPath, "utf8")), unitHashBefore);
  assert.ok(fs.existsSync(tokenPath), "the dry run removed the token");

  const disablingCalls = stubLog(sandbox)
    .split("\n")
    .filter((line) => line.includes("disable"));
  assert.deepEqual(disablingCalls, [], `a dry run called systemd: ${disablingCalls.join(" | ")}`);
});

test("install_uninstallKeepsTheToken", (t) => {
  // GIVEN a sandbox the installer has set up,
  const sandbox = makeSandbox(t);
  const first = runInstall(sandbox, []);
  assert.equal(first.status, 0, first.output);

  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  const unitPath = path.join(sandbox.home, UNIT_RELATIVE_PATH);
  const tokenHashBefore = sha256(fs.readFileSync(tokenPath, "utf8"));
  const tokenModeBefore = fs.statSync(tokenPath).mode & 0o777;

  // WHEN it is uninstalled,
  const run = runInstall(sandbox, ["--uninstall"]);

  // THEN the service is stopped and disabled, the unit is gone — and the token is
  // still there, byte-identical and 600. Uninstalling is not a token rotation:
  assert.equal(run.status, 0, run.output);
  assert.ok(stubLog(sandbox).includes("systemctl --user disable --now browser-control"), stubLog(sandbox));
  assert.ok(!fs.existsSync(unitPath), "unit was not removed");
  assert.ok(fs.existsSync(tokenPath), "token was removed with the unit");
  assert.equal(sha256(fs.readFileSync(tokenPath, "utf8")), tokenHashBefore);
  assert.equal(fs.statSync(tokenPath).mode & 0o777, tokenModeBefore);
  assert.match(run.stdout, /Token bleibt/);

  // AND a second uninstall — now without a unit, and on a sandbox that has no token
  // at all — claims no token it could keep and still ends with 0:
  const tokenless = makeSandbox(t);
  const nothingToKeep = runInstall(tokenless, ["--uninstall"]);

  assert.equal(nothingToKeep.status, 0, nothingToKeep.output);
  assert.match(nothingToKeep.stdout, /Kein Token vorhanden/);
  assert.ok(!nothingToKeep.stdout.includes("Token bleibt"), nothingToKeep.stdout);
});

/** Every regular file under `root`, read as text — except the token file itself. */
function textFilesUnder(root, excludedPath) {
  const files = [];

  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (fullPath !== excludedPath) {
        files.push({ path: fullPath, content: fs.readFileSync(fullPath, "utf8") });
      }
    }
  };

  walk(root);
  return files;
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

test("install_printsTheTokenOnce", (t) => {
  // GIVEN a full install run in an empty sandbox,
  const sandbox = makeSandbox(t);
  const run = runInstall(sandbox, []);
  assert.equal(run.status, 0, run.output);

  const tokenPath = path.join(sandbox.home, TOKEN_RELATIVE_PATH);
  const token = fs.readFileSync(tokenPath, "utf8").trim();

  // THEN the token appears exactly once on stdout — on the line that asks the
  // operator to paste it — and nowhere else:
  assert.equal(countOccurrences(run.stdout, token), 1, run.stdout);

  // ... not on stderr, where a log collector would pick it up:
  assert.equal(countOccurrences(run.stderr, token), 0, run.stderr);

  // ... not in the stub log, which stands in for every argument the script passed
  // to another program:
  assert.equal(countOccurrences(stubLog(sandbox), token), 0, stubLog(sandbox));

  // ... and in no file under HOME except the token file itself:
  for (const file of textFilesUnder(sandbox.home, tokenPath)) {
    assert.equal(countOccurrences(file.content, token), 0, `token leaked into ${file.path}`);
  }
});

test("install_writesOnlyUnderHome", (t) => {
  // GIVEN an empty sandbox and its state before the run,
  const sandbox = makeSandbox(t);
  const before = readTree(sandbox.home);

  // WHEN the installer runs,
  const run = runInstall(sandbox, []);
  assert.equal(run.status, 0, run.output);

  // THEN every new entry — file or directory — lies under one of the three places or
  // is a parent directory that `mkdir -p` had to create (`~/.config`, `~/.local`):
  const created = relativePathsNewIn(before, readTree(sandbox.home));

  assert.ok(created.length > 0, "the run created nothing, so this case proves nothing");
  for (const relativePath of created) {
    assert.ok(isAllowedPath(relativePath), `created outside the allowed set: ${relativePath}`);
  }

  // AND the expected pieces are among them, so the check is not satisfied by an
  // empty run:
  assert.ok(created.includes(TOKEN_RELATIVE_PATH), created.join(", "));
  assert.ok(created.includes(UNIT_RELATIVE_PATH), created.join(", "));
  assert.ok(created.includes(BINARY_RELATIVE_PATH), created.join(", "));
});
