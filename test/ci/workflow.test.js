/**
 * The workflow file, read as text (`docs/40`, `## Testing`).
 *
 * Every case checks what a `run:` line or a `with:` block actually contains, not
 * what a comment promises. The four forgettable lines of `docs/40` — `--release`,
 * the artifact hop, `--test-threads=1`, `permissions: contents: write` — are
 * pinned here because each one is invisible in a green log: a build without
 * `--release` still exits 0, and `scripts/parity.sh` then cannot find its binary.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIR = path.join(REPO_ROOT, ".github", "workflows");
const WORKFLOW = path.join(WORKFLOW_DIR, "test.yml");

/**
 * Drops YAML comments.
 *
 * Without this, `# - run: npm test` would satisfy a check for `npm test` — a
 * green case about a line that never ran. A `#` starts a comment only at the
 * beginning of a line or after whitespace, which is the same rule YAML uses.
 */
function withoutComments(text) {
  return text
    .split("\n")
    .map((line) => {
      const start = /(^|\s)#/.exec(line);
      return start ? line.slice(0, start.index) : line;
    })
    .join("\n");
}

function workflowText() {
  return withoutComments(readFileSync(WORKFLOW, "utf8"));
}

/** The lines of one job, from its `  name:` down to the next job key. */
function jobBlock(name) {
  const lines = workflowText().split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `no job "${name}" in ${WORKFLOW}`);
  const rest = lines.slice(start + 1);
  // Job keys sit at two spaces; anything indented deeper belongs to the job.
  const end = rest.findIndex((line) => /^ {2}[a-z0-9-]+:/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** The single-line `- run:` commands of a job block, in order. */
function runCommands(block) {
  return block
    .split("\n")
    .map((line) => /^\s*- run:\s*(.+)$/.exec(line)?.[1]?.trim())
    .filter(Boolean);
}

test("workflow_coverageJob_shouldRunTheCoverageCommand", () => {
  // GIVEN the coverage job,
  const block = jobBlock("coverage");

  // WHEN its runner, its commands and its Node version are read,
  const commands = runCommands(block);

  // THEN it runs the command from `docs/64` on the standard runner with Node 22,
  // the same version as the unit job — without the command the job is green and
  // measures nothing:
  assert.match(block, /^\s{4}runs-on: ubuntu-latest$/m);
  assert.ok(commands.includes("npm run test:coverage"), commands.join("\n"));
  assert.match(block, /^\s+node-version: 22$/m);
});

test("workflow_coverageJob_shouldNotDependOnAnotherJob", () => {
  // GIVEN the coverage job,
  const block = jobBlock("coverage");

  // WHEN the block is searched for a `needs:` line,
  // THEN there is none: the job stays independent, so a coverage drop turns the
  // pull request red without adding time to the Rust job it would wait for:
  assert.doesNotMatch(block, /^\s{2,}needs:/m);
});

test("workflow_unitJob_shouldBuildBothTargetsInRelease", () => {
  // GIVEN the unit job,
  const commands = runCommands(jobBlock("unit"));

  // WHEN its cargo build commands are collected,
  const builds = commands.filter((command) => command.startsWith("cargo build"));

  // THEN both targets are built, each with `--release`: `scripts/parity.sh` and
  // `scripts/bundle.sh` look in `target/<triple>/release/`, so a debug build is a
  // binary that exists and is not found:
  assert.equal(builds.length, 2, builds.join("\n"));
  const targets = builds.map((build) => /--target (\S+)/.exec(build)?.[1]);
  assert.deepEqual(targets.slice().sort(), [
    "x86_64-pc-windows-gnu",
    "x86_64-unknown-linux-musl",
  ]);
  for (const build of builds) {
    assert.match(build, /--release/, build);
  }
});

test("workflow_unitJob_shouldRunTheRustTestsSerially", () => {
  // GIVEN the unit job,
  const commands = runCommands(jobBlock("unit"));

  // WHEN the Rust test command is looked up,
  const testCommand = commands.find((command) => command.startsWith("cargo test"));

  // THEN it runs with one thread: the cases start real bridges that bind ports,
  // and two of them on one machine is a failure that looks like a code bug:
  assert.ok(testCommand, commands.join("\n"));
  assert.match(testCommand, /--test-threads=1/);
});

test("workflow_e2eJob_shouldRunOnWindowsAndUseTheScript", () => {
  // GIVEN the e2e job,
  const block = jobBlock("e2e");

  // WHEN its runner and its commands are read,
  const commands = runCommands(block);

  // THEN it runs where Firefox is installed, and it runs the script — not a
  // hand-assembled copy of the ten steps, which would drift apart from the one
  // the operator runs locally:
  assert.match(block, /^\s{4}runs-on: windows-latest$/m);
  assert.ok(commands.includes("node scripts/e2e/run.mjs"), commands.join("\n"));
});

test("workflow_e2eJob_shouldDownloadTheBinary", () => {
  // GIVEN the e2e job,
  const block = jobBlock("e2e");

  // WHEN its artifact download and its environment are read,
  // THEN the released `.exe` is downloaded into the directory the cargo build
  // would have written it to, and `E2E_BINARY` names that path — the test then
  // measures the binary Windows users get, not a fresh debug build:
  assert.match(block, /uses: actions\/download-artifact@v4/);
  assert.match(block, /^\s+name: bridge-windows$/m);
  assert.match(block, /^\s+path: bridge-rs\/target\/x86_64-pc-windows-gnu\/release\/$/m);
  assert.match(
    block,
    /^\s+E2E_BINARY: bridge-rs\/target\/x86_64-pc-windows-gnu\/release\/browser-control-bridge\.exe$/m,
  );
});

test("workflow_bundleJob_shouldUploadTheZips", () => {
  // GIVEN the bundle job,
  const commands = runCommands(jobBlock("bundle"));
  const block = jobBlock("bundle");

  // WHEN the build, the tests and the upload are read,
  const bundleStep = commands.findIndex((command) => command.includes("scripts/bundle.sh"));
  const testStep = commands.findIndex((command) => command.includes("npm run test:bundle"));

  // THEN the zips are built before the cases that read them, both binaries are
  // fetched from the unit job, and the result is handed on under the name the
  // release job downloads:
  assert.notEqual(bundleStep, -1, commands.join("\n"));
  assert.notEqual(testStep, -1, commands.join("\n"));
  assert.ok(bundleStep < testStep, "test:bundle runs before bundle.sh");
  assert.match(block, /^\s+name: bridge-linux$/m);
  assert.match(block, /^\s+name: bridge-windows$/m);
  assert.match(block, /uses: actions\/upload-artifact@v4/);
  assert.match(block, /^\s+name: portable-zips$/m);
});

test("workflow_releaseJob_shouldAskForWritePermissions", () => {
  // GIVEN the release job — in the same file as bundle, because `needs:` and
  // `download-artifact` do not cross workflow files,
  const block = jobBlock("release");

  // WHEN its permissions, its download and its command are read,
  // THEN it may write contents (the default token is read-only, and
  // `gh release create` answers 403 with it), it merges the downloaded zips into
  // one directory, and it attaches them to the tag:
  assert.match(block, /^\s{4}permissions:$/m);
  assert.match(block, /^\s+contents: write$/m);
  assert.match(block, /^\s+needs: bundle$/m);
  assert.match(block, /^\s+merge-multiple: true$/m);
  assert.ok(
    runCommands(block).some((command) => command.includes("gh release create")),
    block,
  );
});

test("workflow_shouldNotContainAStyleLinter", () => {
  // GIVEN every workflow file (there is one; the directory is what criterion 5
  // greps),
  const files = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0);

  // WHEN each file is read as text,
  for (const name of files) {
    const text = readFileSync(path.join(WORKFLOW_DIR, name), "utf8");

    // THEN it names no style linter: STE100 is a writing rule for the guides, not
    // a check step, and a lint that fails on a German comment teaches nobody:
    assert.doesNotMatch(text, /ste-lint/, name);
    assert.doesNotMatch(text, /actionlint/, name);
  }
});
