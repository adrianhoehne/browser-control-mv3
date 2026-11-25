/**
 * The arithmetic behind `npm run test:coverage` (`docs/64`), exercised as data.
 *
 * `coverageReport` takes V8 script entries and source texts as plain values, so the
 * four properties the spec asks for can be pinned without a test run: the strict
 * line rule, the threshold, the scope, and the sum. The fixture is two ordinary
 * lines of code — long enough to have a middle, short enough to read.
 *
 * What is *not* pinned here is the measurement itself. Whether the real suite covers
 * 92 % is a number, not a contract; the acceptance run of the command shows it.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { coverageReport } from "../scripts/coverage.mjs";

// Two lines, each 16 and 17 characters plus the newline before the next one. Line
// one is at offsets 0-15, line two starts at 17.
const SOURCE = "const first = 1;\nconst second = 2;\n";

const WHOLE_FIRST_LINE = { startOffset: 0, endOffset: 16, count: 1 };
// Five of line two's seventeen characters: the `const` keyword, nothing else.
// A line that was executed only in part must not count as covered.
const HALF_OF_SECOND_LINE = { startOffset: 17, endOffset: 22, count: 1 };

const PROTOCOL = { path: "extension/protocol.js", text: SOURCE };

function scriptEntry(url, ranges) {
  return { url, functions: [{ functionName: "", ranges }] };
}

test("coverageReport_fromTheFixtureRanges_shouldCountAStrictLine", () => {
  // GIVEN a script whose first line ran completely and whose second line ran only
  // as far as its first five characters,
  const scripts = [scriptEntry("extension/protocol.js", [WHOLE_FIRST_LINE, HALF_OF_SECOND_LINE])];

  // WHEN the report counts its lines,
  const report = coverageReport({ scripts, sources: [PROTOCOL] });

  // THEN one of the two lines is covered — the partly executed one is not. Both
  // lines are lines of code, so both stay in the denominator.
  assert.deepEqual(
    report.rows.map((row) => [row.covered, row.total]),
    [[1, 2]],
  );
  assert.equal(report.rows[0].percent, 50);
});

test("coverageReport_withAPercentageBelowTheMinimum_shouldExitOne", () => {
  // GIVEN the same half-covered file and the default minimum of 90 %,
  const scripts = [scriptEntry("extension/protocol.js", [WHOLE_FIRST_LINE, HALF_OF_SECOND_LINE])];

  // WHEN the report compares the total against the minimum,
  const report = coverageReport({ scripts, sources: [PROTOCOL], minPercent: 90 });

  // THEN it has to fail, and say both numbers: what was measured and what was asked.
  assert.equal(report.exitCode, 1);
  assert.match(report.shortfall, /50,0 %/);
  assert.match(report.shortfall, /90,0 %/);
});

test("coverageReport_forAnUnknownUrl_shouldIgnoreIt", () => {
  // GIVEN a run that also executed scripts outside the product — the probe the tests
  // evaluate, a test helper, the coverage tool itself,
  const scripts = [
    scriptEntry("extension/protocol.js", [WHOLE_FIRST_LINE, HALF_OF_SECOND_LINE]),
    scriptEntry("injected:func.js", [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }]),
    scriptEntry("test/map-probe.js", [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }]),
    scriptEntry("scripts/coverage.mjs", [{ startOffset: 0, endOffset: SOURCE.length, count: 1 }]),
  ];

  // WHEN the report is computed,
  const report = coverageReport({ scripts, sources: [PROTOCOL] });

  // THEN only the product file appears, with only its own coverage: the foreign
  // ranges did not add a row and did not cover the second line either.
  assert.deepEqual(
    report.rows.map((row) => row.path),
    ["extension/protocol.js"],
  );
  assert.equal(report.rows[0].covered, 1);
  assert.equal(report.total.covered, 1);
  assert.equal(report.total.total, 2);
});

test("coverageReport_shouldSumTheFilesAndTheTotal", () => {
  // GIVEN three sources: one fully covered, one half, one not executed at all,
  const scripts = [
    scriptEntry("extension/protocol.js", [WHOLE_FIRST_LINE, { startOffset: 17, endOffset: SOURCE.length, count: 1 }]),
    scriptEntry("injected:page-agent.js", [WHOLE_FIRST_LINE]),
  ];
  const sources = [PROTOCOL, { path: "extension/page-agent.js", text: SOURCE }, { path: "extension/background.js", text: SOURCE }];

  // WHEN the report is computed,
  const report = coverageReport({ scripts, sources });

  // THEN each file keeps its own numbers and the sum is over all of them: 2 + 1 + 0
  // covered out of 2 + 2 + 2 lines.
  assert.deepEqual(
    report.rows.map((row) => [row.path, row.covered, row.total]),
    [
      ["extension/protocol.js", 2, 2],
      ["extension/page-agent.js", 1, 2],
      ["extension/background.js", 0, 2],
    ],
  );
  assert.deepEqual([report.total.covered, report.total.total], [3, 6]);
  assert.equal(report.total.percent, 50);

  // AND the printed table is one line per file plus the total, which is what the
  // operator reads under the suite's own output.
  assert.equal(report.lines.length, sources.length + 1);
  assert.match(report.lines.at(-1), /^total\s+3\/6\s+50,0 %$/);
});
