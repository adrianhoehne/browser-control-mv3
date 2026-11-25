/**
 * Line coverage of the extension, measured from the raw V8 data of a test run.
 *
 * Node writes one JSON file per process into `NODE_V8_COVERAGE` (`node:test` starts
 * one process per test file, so a run produces a crowd of them). This script starts
 * the suite itself — or reads a directory that is already there — and turns the
 * ranges into a table.
 *
 * Three decisions shape the number, and all three are the spec's (`docs/64`):
 *
 * 1. **The rule is strict.** A line counts as covered only when every non-whitespace
 *    character in it was executed. A partly executed line is not covered, so the
 *    number is a lower bound.
 * 2. **Executed wins.** The same file is loaded by several processes; per character
 *    position the maximum over the processes is taken. A position that ran in any
 *    process counts as run.
 * 3. **Only product code counts.** The four sources of the extension; `test/**` and
 *    `scripts/**` are the tool, not the product.
 *
 * The arithmetic lives in `coverageReport`, which takes data and source texts as
 * plain values and never touches the file system — that is what makes it testable
 * without a test run. `main` is the part that runs the suite and reads files.
 *
 * Exit 0 means the measured share reached the minimum (90 % by default, overridable
 * with `--min=<percent>`), 1 means it did not. The table goes to stdout, a diagnosis
 * to stderr, so a caller that redirects stderr away keeps the numbers.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

const DEFAULT_MIN_PERCENT = 90;
const MINIMUM_FLAG = "--min=";
const COVERAGE_FILE_SUFFIX = ".json";
const TEST_FILE_SUFFIX = ".test.js";

// The scope of the measurement, in the order the table prints it.
export const SOURCE_FILES = [
  "extension/bridge.js",
  "extension/page-agent.js",
  "extension/background.js",
  "extension/protocol.js",
];

// `page-agent.js` never reaches V8 as a file: the extension injects its text and
// names the script at that moment. The alias is the only handle the raw data offers.
export const INJECTED_URLS = new Map([["injected:page-agent.js", "extension/page-agent.js"]]);

// Whitespace is not executed and therefore not asked: a line with nothing but
// indentation and a closing bracket is covered by its bracket.
const IGNORED_CHARACTERS = new Set([" ", "\t", "\r", "\n"]);

const PATH_WIDTH = 24;
const COUNT_WIDTH = 12;
const PERCENT_WIDTH = 6;

/** Percentage of `covered` in `total`, `100` when there is nothing to cover. */
function percentageOf(covered, total) {
  return total === 0 ? 100 : (covered / total) * 100;
}

/** One decimal, with the decimal comma the operator's console reads. */
function percentText(percent) {
  return percent.toFixed(1).replace(".", ",");
}

/** The source path a V8 script URL belongs to, or `null` for anything else. */
function sourcePathForUrl(url) {
  if (INJECTED_URLS.has(url)) return INJECTED_URLS.get(url);
  return SOURCE_FILES.includes(url) ? url : null;
}

/**
 * All ranges of one script entry, in the order V8's "last write wins" needs:
 * by start offset ascending, and at the same start the longer range first, so an
 * inner range is written after the outer one that contains it.
 */
function sortedRangesOf(scriptEntry) {
  const ranges = [];
  for (const fn of scriptEntry?.functions ?? []) {
    for (const range of fn?.ranges ?? []) {
      if (!Number.isFinite(range?.startOffset) || !Number.isFinite(range?.endOffset)) continue;
      ranges.push(range);
    }
  }

  return ranges.sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset);
}

/**
 * Which character positions the entry executed, as one flag per position.
 *
 * The ranges are written in the sorted order and simply overwrite what is already
 * there; that is exactly the nesting V8 describes, because a later range is nested
 * in the earlier one or sits after it. Positions no range mentions stay 0.
 */
function executedPositionsOf(scriptEntry, sourceLength) {
  const executed = new Uint8Array(sourceLength);

  for (const range of sortedRangesOf(scriptEntry)) {
    const start = Math.max(0, Math.min(Math.trunc(range.startOffset), sourceLength));
    const end = Math.max(0, Math.min(Math.trunc(range.endOffset), sourceLength));
    if (end <= start) continue;
    executed.fill(range.count > 0 ? 1 : 0, start, end);
  }

  return executed;
}

/** The union of several processes: a position counts as run if any process ran it. */
function unionedPositionsOf(scriptEntries, sourceLength) {
  const union = new Uint8Array(sourceLength);

  for (const scriptEntry of scriptEntries) {
    const executed = executedPositionsOf(scriptEntry, sourceLength);
    for (let index = 0; index < union.length; index += 1) {
      if (executed[index] === 1) union[index] = 1;
    }
  }

  return union;
}

/**
 * Counts the lines of a source text under the strict rule: a line is covered when
 * every non-whitespace character in it was executed. Lines without any
 * non-whitespace character are not lines of code and drop out of both numbers.
 */
function lineCountsOf(sourceText, executed) {
  let covered = 0;
  let total = 0;
  let lineOffset = 0;

  for (const line of sourceText.split("\n")) {
    let significant = 0;
    let executedCharacters = 0;

    for (let index = 0; index < line.length; index += 1) {
      if (IGNORED_CHARACTERS.has(line.charAt(index))) continue;
      significant += 1;
      if (executed[lineOffset + index] === 1) executedCharacters += 1;
    }

    // `+ 1` skips the newline that `split` removed; the last line has none, which
    // only pushes the offset past the end, where nobody reads any more.
    lineOffset += line.length + 1;

    if (significant === 0) continue;
    total += 1;
    if (executedCharacters === significant) covered += 1;
  }

  return { covered, total };
}

function formatRow(row) {
  const counts = `${row.covered}/${row.total}`;
  return `${row.path.padEnd(PATH_WIDTH)} ${counts.padStart(COUNT_WIDTH)} ${percentText(row.percent).padStart(PERCENT_WIDTH)} %`;
}

/**
 * The whole calculation: script entries and source texts in, table and exit code out.
 *
 * - `scripts`: V8 script entries (`{ url, functions: [{ ranges }] }`) from any number
 *   of processes. Entries with the same URL are unioned; foreign URLs are ignored.
 * - `sources`: `[{ path, text }]`, in the order the table prints them. A source
 *   without any entry is reported as fully uncovered rather than dropped.
 * - `minPercent`: the threshold the total has to reach.
 */
export function coverageReport({ scripts = [], sources = [], minPercent = DEFAULT_MIN_PERCENT }) {
  const entriesByPath = new Map();
  for (const scriptEntry of scripts) {
    const sourcePath = sourcePathForUrl(scriptEntry?.url ?? "");
    if (sourcePath === null) continue;
    if (!entriesByPath.has(sourcePath)) entriesByPath.set(sourcePath, []);
    entriesByPath.get(sourcePath).push(scriptEntry);
  }

  const rows = sources.map(({ path: sourcePath, text }) => {
    const executed = unionedPositionsOf(entriesByPath.get(sourcePath) ?? [], text.length);
    const { covered, total } = lineCountsOf(text, executed);
    return { path: sourcePath, covered, total, percent: percentageOf(covered, total) };
  });

  const covered = rows.reduce((sum, row) => sum + row.covered, 0);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const totalRow = { path: "total", covered, total, percent: percentageOf(covered, total) };
  const exitCode = totalRow.percent < minPercent ? 1 : 0;

  return {
    rows,
    total: totalRow,
    minPercent,
    exitCode,
    lines: [...rows, totalRow].map(formatRow),
    shortfall:
      exitCode === 0
        ? null
        : `Zeilenabdeckung ${percentText(totalRow.percent)} % liegt unter der Schwelle ${percentText(minPercent)} %`,
  };
}

/** `--min=<percent>` for one run, or `{ error }` for anything unexpected. */
function minimumPercentageFrom(argv) {
  let minPercent = DEFAULT_MIN_PERCENT;

  for (const argument of argv) {
    if (!argument.startsWith(MINIMUM_FLAG)) return { error: `unbekanntes Argument: ${argument}` };

    const raw = argument.slice(MINIMUM_FLAG.length);
    const parsed = raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      return { error: `--min verlangt eine Zahl zwischen 0 und 100, nicht "${raw}"` };
    }
    minPercent = parsed;
  }

  return { minPercent };
}

function testFilePaths() {
  const testDirectory = path.join(REPOSITORY_ROOT, "test");
  return fs
    .readdirSync(testDirectory)
    .filter((name) => name.endsWith(TEST_FILE_SUFFIX))
    .sort()
    .map((name) => path.join("test", name));
}

/** Runs the suite the way `npm test` does, with the coverage directory set. */
function runTestSuite(coverageDirectory) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-concurrency=1", "--test-timeout=90000", ...testFilePaths()],
    {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory },
      stdio: "inherit",
    },
  );

  if (result.error) {
    process.stderr.write(`Testlauf nicht startbar: ${result.error.message}\n`);
    return 1;
  }

  return result.status ?? 1;
}

/** Every script entry of every coverage file, or `null` when nothing readable is there. */
function readScriptEntries(coverageDirectory) {
  let names;
  try {
    names = fs.readdirSync(coverageDirectory).filter((name) => name.endsWith(COVERAGE_FILE_SUFFIX));
  } catch (error) {
    process.stderr.write(`V8-Rohdaten nicht lesbar: ${coverageDirectory}: ${error.message}\n`);
    return null;
  }

  if (names.length === 0) {
    process.stderr.write(`keine V8-Rohdaten in ${coverageDirectory}\n`);
    return null;
  }

  const scriptEntries = [];
  for (const name of names) {
    let payload;
    try {
      payload = JSON.parse(fs.readFileSync(path.join(coverageDirectory, name), "utf8"));
    } catch (error) {
      process.stderr.write(`V8-Rohdaten nicht lesbar: ${name}: ${error.message}\n`);
      return null;
    }

    for (const scriptEntry of payload?.result ?? []) scriptEntries.push(scriptEntry);
  }

  return scriptEntries;
}

function sourceTexts() {
  return SOURCE_FILES.map((sourcePath) => ({
    path: sourcePath,
    text: fs.readFileSync(path.join(REPOSITORY_ROOT, sourcePath), "utf8"),
  }));
}

/**
 * A directory in `NODE_V8_COVERAGE` is read as it is, so the measurement can be
 * checked without running the suite a second time. Without one, the suite runs into
 * a temporary directory that is removed again afterwards.
 */
function main() {
  const minimum = minimumPercentageFrom(process.argv.slice(2));
  if (minimum.error) {
    process.stderr.write(`${minimum.error}\n`);
    return 1;
  }

  // An empty variable is a variable somebody exported without a value, not a
  // request to measure the working directory.
  const configuredDirectory = process.env.NODE_V8_COVERAGE || null;
  const coverageDirectory = configuredDirectory === null ? fs.mkdtempSync(path.join(os.tmpdir(), "bc-coverage-")) : path.resolve(configuredDirectory);

  try {
    let suiteStatus = 0;
    if (configuredDirectory === null) suiteStatus = runTestSuite(coverageDirectory);

    const scriptEntries = readScriptEntries(coverageDirectory);
    if (scriptEntries === null) return 1;

    const report = coverageReport({
      scripts: scriptEntries,
      sources: sourceTexts(),
      minPercent: minimum.minPercent,
    });

    for (const line of report.lines) process.stdout.write(`${line}\n`);

    // A failed suite keeps the table — the numbers are still informative — but it
    // can never end in 0: a green threshold over a red suite would be a lie.
    if (suiteStatus !== 0) {
      process.stderr.write(`Testlauf endete mit Exit ${suiteStatus}\n`);
      return 1;
    }

    if (report.shortfall !== null) {
      process.stderr.write(`${report.shortfall}\n`);
      return 1;
    }

    return 0;
  } finally {
    if (configuredDirectory === null) fs.rmSync(coverageDirectory, { recursive: true, force: true });
  }
}

// Importing this file (the tests do) must not run the suite, so `main` only fires
// when node was pointed at this very file.
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
