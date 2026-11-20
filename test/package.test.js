// The packaging script: an XPI is a zip whose root is manifest.json. These cases
// run the script for real and read the archive back, because the failure mode
// that matters is silent — an archive Firefox refuses to install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/package.sh", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../extension/manifest.json", import.meta.url));
const VERSION = JSON.parse(readFileSync(MANIFEST, "utf8")).version;

function hasTool(name) {
  return spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).status === 0;
}

const SKIP = !hasTool("bash") || !hasTool("zip") || !hasTool("unzip")
  ? "needs bash, zip and unzip"
  : false;

function makeOutDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bc-package-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args) {
  const result = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8" });
  assert.equal(result.error, undefined, String(result.error));
  return result;
}

function entries(artifact) {
  const listed = spawnSync("unzip", ["-Z1", artifact], { encoding: "utf8" });
  assert.equal(listed.status, 0, listed.stderr);
  return listed.stdout.split("\n").filter((line) => line !== "");
}

test("package_buildsAnXpiWithTheManifestAtItsRoot", { skip: SKIP }, (t) => {
  // GIVEN a temporary output directory,
  const outDir = makeOutDir(t);

  // WHEN the packaging script runs,
  const result = run(["--out-dir", outDir]);

  // THEN it succeeds, names the artifact after the manifest's version, and the
  // archive carries manifest.json at the root — the one thing Firefox checks
  // before it looks at anything else:
  assert.equal(result.status, 0, result.stderr);
  const artifact = path.join(outDir, `browser-control-${VERSION}.xpi`);
  assert.ok(existsSync(artifact), `expected ${artifact}\nstdout: ${result.stdout}`);

  const names = entries(artifact);
  assert.ok(names.includes("manifest.json"), `entries were: ${names.join(", ")}`);
  // Background and options have to be there too: an XPI without them installs
  // and then does nothing, which looks like a bridge problem.
  assert.ok(names.includes("background.js"));
  assert.ok(names.includes("options.html"));
});

test("package_keepsTheFolderOutOfTheArchive", { skip: SKIP }, (t) => {
  // GIVEN a temporary output directory,
  const outDir = makeOutDir(t);

  // WHEN the script runs,
  const result = run(["--out-dir", outDir]);

  // THEN no entry carries an `extension/` prefix and none is a dotfile — both
  // are the classic `zip -r build extension/` mistake, and Firefox refuses the
  // first while a reviewer refuses the second:
  assert.equal(result.status, 0, result.stderr);
  const names = entries(path.join(outDir, `browser-control-${VERSION}.xpi`));
  assert.deepEqual(
    names.filter((name) => name.startsWith("extension/")),
    [],
  );
  assert.deepEqual(
    names.filter((name) => /(^|\/)\./.test(name)),
    [],
  );
});

test("package_usesTheVersionFromTheManifest", { skip: SKIP }, (t) => {
  // GIVEN a temporary output directory,
  const outDir = makeOutDir(t);

  // WHEN the script runs,
  const result = run(["--out-dir", outDir]);

  // THEN the version inside the archive is the manifest's — a build label that
  // drifts from the manifest makes two builds indistinguishable in about:addons:
  assert.equal(result.status, 0, result.stderr);
  const artifact = path.join(outDir, `browser-control-${VERSION}.xpi`);
  const unpacked = spawnSync("unzip", ["-p", artifact, "manifest.json"], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  assert.equal(JSON.parse(unpacked.stdout).version, VERSION);
});

test("package_refusesAnUnknownArgument", { skip: SKIP }, () => {
  // GIVEN no output directory and a typo on the command line,
  const result = run(["--out-dri", "/tmp/nope"]);

  // THEN the script stops instead of building into the default place: a typo
  // that builds anyway is a release with the wrong artifact, unremarked.
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /unknown argument/);
});

test("sign_withoutAmoEnv_shouldExitOneAndNameThePath", async () => {
  // GIVEN a machine without the API credentials — the likeliest failure, and the one
  // whose message decides whether the operator looks in the right place,
  const script = fileURLToPath(new URL("../scripts/sign.sh", import.meta.url));
  const missing = path.join(os.tmpdir(), "bc-no-such-amo.env");

  // WHEN the signing script runs,
  const result = spawnSync("bash", [script], {
    env: { ...process.env, BC_AMO_ENV: missing, HOME: os.tmpdir() },
    encoding: "utf8",
  });

  // THEN it stops with exit 1 and names the path it looked for — "AMO_JWT_ISSUER is
  // not set" would send the operator hunting in the environment instead of the file,
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no API credentials at/);
  assert.match(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("verifySignature_withoutAFile_shouldExitOneAndNameIt", async () => {
  // GIVEN the signature checker and a path that does not exist,
  const script = fileURLToPath(new URL("../scripts/verify-signature.sh", import.meta.url));
  const missing = path.join(os.tmpdir(), "bc-no-such.xpi");

  // WHEN it runs,
  const result = spawnSync("bash", [script, missing], { encoding: "utf8" });

  // THEN it stops before starting a browser and names the file — a checker that
  // silently passes on a typo would be worse than no checker,
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no such file/);
  assert.match(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("verifySignature_withoutAnArgument_shouldPrintTheUsage", async () => {
  // GIVEN the checker with no argument at all,
  const script = fileURLToPath(new URL("../scripts/verify-signature.sh", import.meta.url));

  // WHEN it runs,
  const result = spawnSync("bash", [script], { encoding: "utf8" });

  // THEN the usage is on stderr and the exit code says "you called me wrong",
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: scripts\/verify-signature\.sh/);
});
