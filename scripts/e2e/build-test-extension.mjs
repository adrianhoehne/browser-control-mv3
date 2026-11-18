#!/usr/bin/env node
/**
 * Builds the test copy of the extension: `extension/` minus three lines, plus the
 * endpoint, token and switch state the E2E run actually needs.
 *
 * The extension reads endpoint and token from `storage.local` and nowhere else,
 * and `about:debugging` cannot be driven by a script. `web-ext` installs a
 * temporary add-on — exactly what that button does — so the two values a human
 * would type are replaced here, in a **copy**, with the anchors counted first
 * (`docs/40`, step 3).
 *
 * Only `<copy>/bridge.js` is patched for endpoint and token, and the state line in
 * `<copy>/bridge.js` **and** `<copy>/background.js`. `options.js` carries the same
 * endpoint anchor, so a count over the whole folder would report 2 and a patch would
 * hit the wrong file. Since spec 42 the socket lives in the bridge tab, so that is
 * where the endpoint and the token are read — `background.js` is the coordinator and
 * carries neither. Since spec 44 the switch has two sides: the page that must not dial
 * (`bridge.js`) and the coordinator that must not build the tab (`background.js`).
 *
 * The count is `grep -Fc`, one per anchor, and it must be exactly 1. `-F`
 * matters: the second anchor contains `[` and `]`, which `grep` would read as a
 * bracket expression, and a BRE would silently never match. A moved seam is a
 * hard failure — the shipped extension is not touched by any of this.
 *
 * Usage:
 *   scripts/e2e/build-test-extension.mjs --out <dir> --token <hex>
 *   scripts/e2e/build-test-extension.mjs --self-check --source extension
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_SOURCE = path.join(REPO_ROOT, "extension");
// The socket, the settings and the switch live in the bridge tab (spec 42); the
// coordinator is the second file of the state seam, because it has to decide about the
// tab before that page exists.
const SEAM_FILE = "bridge.js";
const COORDINATOR_FILE = "background.js";
const MANIFEST = "manifest.json";

/** The port the E2E run owns; 8110 belongs to the operator's service. */
export const E2E_ENDPOINT = "ws://127.0.0.1:18810";

/**
 * The three seams, in the order `docs/40` lists them. Every one is a **replacement** of
 * a whole line — that is why `grep -c` can count it before and after.
 *
 * `files` is a list because the state seam has two sides: the page that must not dial
 * and the coordinator that must not build the tab both default to `off`, and an E2E copy
 * that patched only one of them would come up switched off and never connect.
 */
export const SEAMS = [
  {
    name: "endpoint",
    files: [SEAM_FILE],
    before: 'const DEFAULT_ENDPOINT = "ws://127.0.0.1:8110";',
    after: `const DEFAULT_ENDPOINT = "${E2E_ENDPOINT}";`,
  },
  {
    name: "token",
    files: [SEAM_FILE],
    before: "      token: asText(stored[TOKEN_KEY]),",
    // The fallback keeps a stored token winning; it only fills the empty case the
    // options page would otherwise be needed for.
    after: (token) => `      token: asText(stored[TOKEN_KEY]) || "${token}",`,
  },
  {
    name: "state",
    files: [SEAM_FILE, COORDINATOR_FILE],
    before: "const DEFAULT_BRIDGE_ENABLED = false;",
    after: "const DEFAULT_BRIDGE_ENABLED = true;",
  },
];

/**
 * How often `needle` occurs as a line in `file`, counted by `grep -Fc`.
 *
 * `grep` is the counter because the spec says so, and because a counter that
 * shares its reading of the file with the patcher could agree with itself about
 * a wrong anchor. Where `grep` is missing (a bare Windows box without Git), the
 * fallback says so on stderr instead of reporting a count nobody can attribute.
 */
export function countAnchor(file, needle) {
  const result = spawnSync("grep", ["-Fc", needle, file], { encoding: "utf8" });
  if (result.error) {
    process.stderr.write(
      `warning: grep is not available (${result.error.code}); counting lines in JS\n`,
    );
    const lines = readFileSync(file, "utf8").split("\n");
    return lines.filter((line) => line.includes(needle)).length;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`grep failed on ${file}: ${result.stderr.trim()}`);
  }
  return Number.parseInt(result.stdout.trim() || "0", 10);
}

function seamAnchors(token) {
  return SEAMS.map((seam) => ({
    ...seam,
    replacement: typeof seam.after === "function" ? seam.after(token) : seam.after,
  }));
}

/**
 * Counts every anchor in every file of its seam; throws `seam moved` if any is off.
 *
 * Which files those are is part of the seam: when the socket moved from
 * `background.js` into the bridge tab (`docs/42`), the endpoint and token lines moved
 * with it, and a counter aimed at the old file would report 0 hits for both anchors.
 * `docs/44` added a seam that has to hold in two files at once.
 */
export function checkSeams(sourceDir, { token = "<token>" } = {}) {
  if (!existsSync(path.join(sourceDir, MANIFEST))) {
    throw new Error(`no ${MANIFEST} in ${sourceDir} — is --source pointing at the extension folder?`);
  }
  const counts = {};
  const moved = [];
  for (const seam of seamAnchors(token)) {
    for (const file of seam.files) {
      const fullPath = path.join(sourceDir, file);
      if (!existsSync(fullPath)) throw new Error(`no ${fullPath} — cannot count ${seam.name}`);
      const count = countAnchor(fullPath, seam.before);
      counts[seam.name] = count;
      if (count !== 1) moved.push(`${seam.name} (${count} hits in ${file})`);
    }
  }
  if (moved.length > 0) {
    throw new Error(`seam moved: ${moved.join(", ")} — expected exactly 1 per file`);
  }
  return counts;
}

/**
 * Copies `sourceDir` to `targetDir` and patches the seams in the copy.
 *
 * Order matters: every anchor is counted **before** the first write, so a moved
 * seam leaves no half-patched copy behind that a later run could mistake for a
 * working one.
 */
export function buildTestExtension({ sourceDir = DEFAULT_SOURCE, targetDir, token }) {
  if (!targetDir) throw new Error("targetDir is required");
  if (!token) throw new Error("a token is required — the test copy has to authenticate");
  if (!existsSync(path.join(sourceDir, MANIFEST))) {
    throw new Error(`no ${MANIFEST} in ${sourceDir}`);
  }

  const counts = checkSeams(sourceDir, { token });
  cpSync(sourceDir, targetDir, { recursive: true });

  for (const seam of seamAnchors(token)) {
    for (const file of seam.files) {
      const target = path.join(targetDir, file);
      const source = readFileSync(target, "utf8");
      // Exactly one occurrence, so `replaceAll` is the same edit as "replace the
      // one line" — and it cannot silently pick a second, unexpected site.
      writeFileSync(target, source.replaceAll(seam.before, seam.replacement));
    }
  }

  for (const seam of seamAnchors(token)) {
    for (const file of seam.files) {
      if (countAnchor(path.join(targetDir, file), seam.before) !== 0) {
        throw new Error(`seam moved: ${seam.name} survived the patch in ${file}`);
      }
    }
  }
  return { counts };
}

function parseArgs(argv) {
  const options = { source: DEFAULT_SOURCE, selfCheck: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--source":
        if (!value) throw new Error("--source needs a directory");
        options.source = path.resolve(value);
        index += 1;
        break;
      case "--out":
        if (!value) throw new Error("--out needs a directory");
        options.out = path.resolve(value);
        index += 1;
        break;
      case "--token":
        if (!value) throw new Error("--token needs a value");
        options.token = value;
        index += 1;
        break;
      case "--self-check":
        options.selfCheck = true;
        break;
      case "--help":
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return (
    "usage: scripts/e2e/build-test-extension.mjs --out <dir> --token <hex> [--source <dir>]\n" +
    "       scripts/e2e/build-test-extension.mjs --self-check [--source <dir>]\n\n" +
    "Copies the extension and replaces the endpoint, token and state lines in the copy.\n" +
    "  --self-check  only count the three anchors; write nothing\n"
  );
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }

  if (options.selfCheck) {
    const counts = checkSeams(options.source, { token: options.token ?? "<token>" });
    process.stdout.write(
      `seams ok: endpoint=${counts.endpoint} token=${counts.token} state=${counts.state} in ` +
        `${options.source}\n`,
    );
    return 0;
  }

  if (!options.out) throw new Error("--out is required (or use --self-check)");
  if (!options.token) throw new Error("--token is required");
  const { counts } = buildTestExtension({
    sourceDir: options.source,
    targetDir: options.out,
    token: options.token,
  });
  process.stdout.write(
    `test copy at ${options.out}: endpoint=${counts.endpoint} token=${counts.token} state=${counts.state}\n`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
