/**
 * Syntax-check every `.js` and `.mjs` file in the tree with `node --check`.
 *
 * This replaces a pipeline of GNU tools that only exist on a Unix shell — the
 * acceptance block in `CONTRIBUTING.md` has to run on the operator's Windows machine
 * too, and the `FIND.EXE` there is an unrelated program. Only `node:fs`,
 * `node:path` and `node:child_process` are used, so the command is portable by
 * construction.
 *
 * The count in the output is a measurement, not a contract: it changes whenever
 * a file is added, and that is exactly what one wants to read off it.
 *
 * Exit code 0 means every file parsed, 1 means at least one did not. The success
 * line goes to stdout, the diagnosis and the summary of a failed run go to
 * stderr — so a caller redirecting stderr away keeps the count and never loses a
 * failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

// Skipped at any depth, not only at the top: a vendored `.git` or `node_modules`
// below the root is just as uninteresting as the one beside it.
// `target` is cargo's build directory: `cargo doc` writes dozens of rustdoc
// asset `.js` files there, and they are not product code. Without this the
// acceptance count jumps from 33 to 105 the first time anyone builds docs.
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "target"]);
const CHECKED_EXTENSIONS = new Set([".js", ".mjs"]);

// `node --check` prints `<path>:<line>` first and the actual diagnosis second,
// so the line worth reporting is the one naming the error, not the first one.
//
// The list is ordered and the first pattern with a matching line wins: a line with
// `SyntaxError` therefore always decides, and `\bError\b` only comes up for a
// failure that carries no syntax error — a file node cannot load, say, where it
// prefers `Error: Cannot find module ...` over the loader frame above it. (`\b`
// keeps `SyntaxError` itself from matching the second pattern.)
const DIAGNOSIS_PATTERNS = [/SyntaxError/, /\bError\b/];

export function collectFiles(root) {
  return listCheckableFiles(root, "").sort();
}

function listCheckableFiles(directory, relativeDirectory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => checkablePathsOf(entry, directory, relativeDirectory));
}

function checkablePathsOf(entry, directory, relativeDirectory) {
  const relativePath = path.join(relativeDirectory, entry.name);

  if (entry.isDirectory()) {
    return SKIPPED_DIRECTORIES.has(entry.name) ? [] : listCheckableFiles(path.join(directory, entry.name), relativePath);
  }

  // A symlink is not a file here: `Dirent.isFile()` is false for it, which is
  // the same behaviour as the old traversal without `-L`. Following links could
  // walk out of the tree or loop forever.
  const isCheckableFile = entry.isFile() && CHECKED_EXTENSIONS.has(path.extname(entry.name));
  return isCheckableFile ? [relativePath] : [];
}

/**
 * Returns the diagnosis for a file that does not parse, or `null` when it does.
 */
function checkFile(root, relativePath) {
  // The path is resolved against the root rather than the working directory: the
  // root is a parameter, so a caller can point this at a temporary tree.
  const result = spawnSync(process.execPath, ["--check", path.join(root, relativePath)]);
  if (result.status === 0) return null;
  return diagnosisOf(result);
}

function diagnosisOf(result) {
  if (result.error) return result.error.message;

  const lines = String(result.stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Falling back to the first line keeps the report non-empty even for a failure
  // that is not a syntax error at all (a crash before parsing, say).
  const pattern = DIAGNOSIS_PATTERNS.map((candidate) => lines.find((line) => candidate.test(line))).find(Boolean);
  return pattern ?? lines[0] ?? `exit code ${result.status}`;
}

function pluralizeFileCount(count) {
  return `checked ${count} ${count === 1 ? "file" : "files"}`;
}

function report(checkedCount, failures) {
  for (const failure of failures) {
    process.stderr.write(`${failure.relativePath}: ${failure.diagnosis}\n`);
  }

  if (failures.length === 0) {
    process.stdout.write(`${pluralizeFileCount(checkedCount)}\n`);
    return 0;
  }

  process.stderr.write(`${pluralizeFileCount(checkedCount)}, ${failures.length} failed\n`);
  return 1;
}

function main() {
  const root = path.resolve(process.argv[2] ?? DEFAULT_ROOT);

  let relativePaths;
  try {
    relativePaths = collectFiles(root);
  } catch (error) {
    // An unreadable root is a failure of the check, never a silent "0 files".
    process.stderr.write(`check failed: ${root}: ${error.message}\n`);
    return 1;
  }

  const failures = [];
  for (const relativePath of relativePaths) {
    const diagnosis = checkFile(root, relativePath);
    if (diagnosis !== null) failures.push({ relativePath, diagnosis });
  }

  return report(relativePaths.length, failures);
}

// Importing this file (the test does, for `collectFiles`) must not walk the tree
// as a side effect, so the check only fires when node was pointed at this very
// file. Comparing real paths makes the guard survive symlinked entry points.
function isStartedAsScript() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url));
  } catch {
    // No script path, or one that cannot be resolved: conservatively treat this
    // as an import, so a plain `import` never sets an exit code.
    return false;
  }
}

if (isStartedAsScript()) {
  process.exitCode = main();
}
