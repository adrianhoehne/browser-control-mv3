/**
 * The frame around `npm run test:coverage:rust` (`docs/66`), exercised without a
 * `cargo` run.
 *
 * What is pinned here is the contract the wrapper owns: the argument list handed to
 * `cargo` (threshold, manifest, serial test threads), the default threshold of 90 %,
 * and the sentence a machine without the tools gets. The measurement itself — that
 * `cargo llvm-cov` reports 92,92 % lines over 3 658 lines — is a number, not a
 * contract; the acceptance run of the command shows it, and it costs minutes.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { missingToolchainMessage, rustCoverageCommand } from "../scripts/coverage-rust.mjs";

test("rustCoverageCommand_shouldPassTheThresholdAndTheSerialFlag", () => {
  // GIVEN a run that asks for 95 % lines over the bridge manifest,
  // WHEN the argument list is built,
  const argv = rustCoverageCommand({ minimum: 95, manifestPath: "bridge-rs/Cargo.toml" });

  // THEN the tool gets the summary, its own threshold flag, the manifest, and the
  // serial test threads behind the separator that belongs to the test binary.
  assert.deepEqual(argv, [
    "llvm-cov",
    "--manifest-path",
    "bridge-rs/Cargo.toml",
    "--summary-only",
    "--fail-under-lines",
    "95",
    "--",
    "--test-threads=1",
  ]);
});

test("rustCoverageCommand_withoutAMinimum_shouldUseNinety", () => {
  // GIVEN a run without `--min`, so nothing overrides the rule,
  // WHEN the argument list is built,
  const argv = rustCoverageCommand({ manifestPath: "bridge-rs/Cargo.toml" });

  // THEN the threshold is the 90 % of `docs/64` — and it is a number, because
  // `cargo llvm-cov` parses the flag itself.
  assert.equal(argv[argv.indexOf("--fail-under-lines") + 1], "90");

  // AND the manifest defaults to the bridge, so a bare call measures the right crate.
  assert.equal(argv[argv.indexOf("--manifest-path") + 1], "bridge-rs/Cargo.toml");
});

test("missingToolchainMessage_shouldNameBothInstallCommands", () => {
  // GIVEN the machine that lacks both the rustup component and the subcommand,
  // WHEN the message is built,
  const message = missingToolchainMessage();

  // THEN it names both commands, so the operator does not have to guess which half
  // is missing.
  assert.match(message, /rustup component add llvm-tools-preview/);
  assert.match(message, /cargo install cargo-llvm-cov/);

  // AND it is one line, so it reads as a sentence on the console and not as a
  // stack trace.
  assert.doesNotMatch(message, /\n/);
  assert.match(message, /\.$/);
});
