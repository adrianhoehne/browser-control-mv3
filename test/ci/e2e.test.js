/**
 * The seam patch and the beacon, without a browser (`docs/40`, `## Testing`).
 *
 * What cannot be a unit case is the E2E run itself: it starts Firefox and stands
 * as operator criteria 1–2. What can be pinned is criterion 3 — the patch finds
 * its two lines or says `seam moved` — and the beacon's two answers, which are
 * what criterion 2 turns on.
 *
 * The patch is a text patch on two lines. It is counted and it fails loudly, but
 * it is not a contract: the cases here are what stops a renamed anchor from
 * turning into a silent no-op patch.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBeacon } from "../../scripts/e2e/beacon.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = path.join(REPO_ROOT, "scripts", "e2e", "build-test-extension.mjs");
const EXTENSION = path.join(REPO_ROOT, "extension");

function selfCheck(sourceDir) {
  return spawnSync(process.execPath, [SCRIPT, "--self-check", "--source", sourceDir], {
    encoding: "utf8",
  });
}

function buildCopy(targetDir, token) {
  return spawnSync(process.execPath, [SCRIPT, "--out", targetDir, "--token", token], {
    encoding: "utf8",
  });
}

/** `sed -i 's/DEFAULT_ENDPOINT/ENDPOINT/g'`, or the same edit when sed is absent. */
function renameEndpointAnchor(file) {
  const result = spawnSync("sed", ["-i", "s/DEFAULT_ENDPOINT/ENDPOINT/g", file], {
    encoding: "utf8",
  });
  if (result.error) {
    writeFileSync(file, readFileSync(file, "utf8").replaceAll("DEFAULT_ENDPOINT", "ENDPOINT"));
  }
}

function scratch(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "bc-seam-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function porcelainOfExtension() {
  const result = spawnSync("git", ["status", "--porcelain", "extension/"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("e2e_seamPatch_shouldFindBothLines", (t) => {
  // GIVEN the tracked extension and a scratch directory,
  const directory = scratch(t);
  const target = path.join(directory, "ext");
  const token = "a".repeat(64);

  // WHEN the self-check counts the two anchors,
  const checked = selfCheck(EXTENSION);

  // THEN it finds each exactly once — and so does a real build into a copy,
  const patch = buildCopy(target, token);

  // ... whose bridge.js carries the rewritten endpoint and the token fallback,
  // with the token as a *fallback*: a stored token keeps winning. That file and not
  // `background.js`: since spec 42 the socket and the settings live in the bridge tab.
  const patched = readFileSync(path.join(target, "bridge.js"), "utf8");

  // AND the tracked file is untouched by all of it: the patch only ever writes
  // inside the copy, and a dirty `extension/` would make every later diff a lie.
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /endpoint=1 token=1/);
  assert.equal(patch.status, 0, patch.stderr);
  assert.match(patched, /const DEFAULT_ENDPOINT = "ws:\/\/127\.0\.0\.1:18810";/);
  assert.match(patched, /token: asText\(stored\[TOKEN_KEY\]\) \|\| "[a]+",/);
  assert.doesNotMatch(patched, /ws:\/\/127\.0\.0\.1:8110/);
  assert.equal(porcelainOfExtension(), "");
});

test("e2e_seamPatch_withRenamedAnchor_shouldReportSeamMoved", (t) => {
  // GIVEN a copy of the extension whose endpoint anchor has been renamed — the
  // `sed` from criterion 3, applied to the copy and never to the tracked file,
  const directory = scratch(t);
  const copy = path.join(directory, "ext");
  cpSync(EXTENSION, copy, { recursive: true });
  renameEndpointAnchor(path.join(copy, "bridge.js"));

  // WHEN the self-check runs against that copy,
  const result = selfCheck(copy);

  // THEN it fails with `seam moved` and names the anchor it could not find,
  // instead of "patching" nothing and letting the E2E fail much later with
  // `auth failed` against the operator's service:
  assert.equal(result.status, 1);
  assert.match(result.stderr, /seam moved: endpoint \(0 hits\)/);

  // AND the tracked file is still untouched.
  assert.equal(porcelainOfExtension(), "");
});

test("e2e_beacon_shouldAnswerPingWith204AndRecordTheHit", async (t) => {
  // GIVEN a beacon in the default mode, on a free port so the suite owns nothing
  // of the E2E's 18990,
  const beacon = createBeacon();
  const port = await beacon.listen(0);
  t.after(() => beacon.close());

  // WHEN the page and then `/ping` are requested the way the browser does it,
  const page = await fetch(`http://127.0.0.1:${port}/page`);
  const pageText = await page.text();
  const ping = await fetch(`http://127.0.0.1:${port}/ping`);
  const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();

  // THEN the page carries the `fetch("/ping")` that makes it phone home, the hit
  // is answered 204, and the stamp is recorded — that stamp is the line
  // criterion 1 prints:
  assert.equal(page.status, 200);
  assert.match(pageText, /fetch\("\/ping"\)/);
  assert.equal(ping.status, 204);
  assert.equal(state.hits, 1);
  assert.match(state.lastPing, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("e2e_beacon_inBrokenMode_shouldAnswerPingWith500AndCountNoHit", async (t) => {
  // GIVEN a beacon that is broken on purpose (`E2E_BEACON_MODE=broken`),
  const beacon = createBeacon({ mode: "broken" });
  const port = await beacon.listen(0);
  t.after(() => beacon.close());

  // WHEN the page's request arrives,
  const ping = await fetch(`http://127.0.0.1:${port}/ping`);
  const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();

  // THEN it is answered 500 and counted as an attempt, never as a hit: a hit is
  // what makes criterion 2 able to fail, and a failed request is not one.
  assert.equal(ping.status, 500);
  assert.equal(state.hits, 0);
  assert.equal(state.attempts, 1);
  assert.equal(state.lastPing, null);
});
