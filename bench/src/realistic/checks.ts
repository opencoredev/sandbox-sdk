/**
 * Output normalisation, invariant extraction and the frozen per-step checks. Pure functions: a step's
 * success is decided only here, from its exit status, normalised output, test report and file hashes.
 * Rules and patterns match the session rig (`rig/common.py`) so recorded invariants compare directly.
 */
import { z } from "zod";
import type {
  ExcludedTest,
  ExpectedExit,
  NormaliseRule,
  OutputInvariants,
  StepCheck,
  TestCounts,
} from "./manifest.js";

const rules: Record<Exclude<NormaliseRule, "paths">, [RegExp, string]> = {
  // oxlint-disable-next-line no-control-regex -- ANSI escapes start with ESC by definition.
  ansi: [/\x1b\[[0-9;?]*[A-Za-z]/g, ""],
  "iso-timestamps": [/\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:?\d\d)?/g, "<TS>"],
  "clock-times": [/\b\d\d:\d\d:\d\d(\.\d+)?\b/g, "<TIME>"],
  durations: [/\b\d+(\.\d+)?\s?(ms|s|m|µs|us|ns|sec|seconds|min)\b/g, "<DUR>"],
  pids: [/\b(pid|PID|process)\s*[:=#]?\s*\d+/g, "$1 <PID>"],
  ports: [/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):\d+/g, "$1:<PORT>"],
  "hex-ids": [/\b[0-9a-f]{12,}\b/g, "<HEX>"],
};

/** Paths replaced by `paths`, longest first so a checkout inside HOME keeps its own tag. */
export interface PathTags {
  workdir: string;
  home?: string;
}

export function normalise(text: string, applied: readonly NormaliseRule[], paths: PathTags) {
  let result = text;

  for (const rule of applied) {
    if (rule === "paths") {
      const tags: [string, string][] = [[paths.workdir, "<REPO>"]];

      if (paths.home) tags.push([paths.home, "<HOME>"]);
      tags.push(["/tmp", "<TMP>"]);

      for (const [path, tag] of tags.sort((a, b) => b[0].length - a[0].length))
        result = result.replaceAll(path, tag);
      continue;
    }

    const [pattern, replacement] = rules[rule];
    result = result.replace(pattern, replacement);
  }

  return result;
}

const testsLine = /^\s*Tests\s+(.*)$/gm;
const filesLine = /^\s*Test Files\s+(.*)$/gm;
const tscFound = /Found (\d+) errors?/g;
const countPart = /(\d+)\s+(passed|failed|skipped|todo)/g;
const errorLine = /^.*\b(FAIL|Error|error TS\d+|AssertionError|ERR_[A-Z_]+)\b.*$/;

function counts(summary: string): TestCounts {
  const result: TestCounts = {};

  for (const match of summary.matchAll(countPart)) {
    const value = Number(match[1]);

    switch (match[2]) {
      case "passed":
        result.passed = value;
        break;
      case "failed":
        result.failed = value;
        break;
      case "skipped":
        result.skipped = value;
        break;
      case "todo":
        result.todo = value;
        break;
    }
  }

  return result;
}

/** The rig's `invariants()`: last summary lines win; key error lines sorted and de-duplicated. */
export function extractInvariants(normalised: string): OutputInvariants {
  const invariants: OutputInvariants = {};
  const tests = [...normalised.matchAll(testsLine)].at(-1);
  const files = [...normalised.matchAll(filesLine)].at(-1);
  const tsc = [...normalised.matchAll(tscFound)].at(-1);

  if (tests?.[1] !== undefined) invariants.tests = counts(tests[1]);

  if (files?.[1] !== undefined) invariants.testFiles = counts(files[1]);

  if (tsc?.[1] !== undefined) invariants.tscErrors = Number(tsc[1]);
  const lines = new Set<string>();

  for (const line of normalised.split("\n"))
    if (errorLine.test(line)) lines.add(line.trim().slice(0, 200));

  if (lines.size) invariants.keyErrorLines = [...lines].sort().slice(0, 20);

  return invariants;
}

const vitestReport = z.object({
  numRuntimeErrorTestSuites: z.number().int().nonnegative().optional(),
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.string().optional(),
      message: z.string().optional(),
      assertionResults: z.array(
        z.object({
          fullName: z.string(),
          status: z.enum(["passed", "failed", "skipped", "pending", "todo", "disabled"]),
        }),
      ),
    }),
  ),
});

export interface TestOutcome {
  file: string;
  name: string;
  status: "passed" | "failed" | "skipped" | "todo";
}

function outcomeStatus(status: string): TestOutcome["status"] {
  if (status === "passed" || status === "failed" || status === "todo") return status;

  return "skipped";
}

/** Parse vitest's `--reporter=json` output into per-test outcomes. */
export function parseVitestReport(text: string): TestOutcome[] {
  return readVitestReport(text).outcomes;
}

/** Per-test outcomes, plus files that failed without a failing test (collection or runtime errors). */
function readVitestReport(text: string) {
  const report = vitestReport.parse(JSON.parse(text));
  const outcomes: TestOutcome[] = [];
  const suiteErrors: string[] = [];

  if (report.numRuntimeErrorTestSuites)
    suiteErrors.push(`${report.numRuntimeErrorTestSuites} suite(s) with runtime errors`);

  for (const file of report.testResults) {
    let failedTests = 0;

    for (const test of file.assertionResults) {
      const status = outcomeStatus(test.status);

      if (status === "failed") failedTests++;
      outcomes.push({ file: file.name, name: test.fullName, status });
    }

    // A suite-level message (collection, hook or runtime error) is never one test's failure.
    if (file.message) suiteErrors.push(`${file.name}: ${file.message.slice(0, 200)}`);
    else if (file.status === "failed" && failedTests === 0)
      suiteErrors.push(`${file.name}: failed without a failing test`);
  }

  return { outcomes, suiteErrors };
}

const failId = /^\s*FAIL\s+(?:\|[^|]+\|\s+)?(\S+\.(?:spec|test)\.[cm]?[jt]sx?)\s+>\s+(.+?)\s*$/;
const errorsLine = /^\s*Errors\s+\d+\s+errors?/m;

/**
 * The rig's text-mode exclusion (`rig/common.py exclude_tests`, `tools/completion.py`): excluded tests
 * are identified as `file > name` in the normalised FAIL lines; their FAIL lines are dropped, and they
 * are taken out of the counts (every excluded test runs, so passes lose the ones that passed). A test
 * file moves from failed to passed only when all of its failures are excluded.
 */
function excludeFromText(normalised: string, exclusions: readonly ExcludedTest[]) {
  const ids = new Map(exclusions.map((item) => [`${item.file ?? ""} > ${item.name}`, item]));
  const kept: string[] = [];
  const excludedFailed = new Set<string>();
  const otherFailed = new Set<string>();
  const filesExcluded = new Set<string>();
  const filesOther = new Set<string>();

  const lines = normalised.split("\n");
  // Like the rig, only the last run counts: its FAIL lines follow the previous run's Tests summary.
  const summaries = lines.flatMap((line, index) => (/^\s*Tests\s/.test(line) ? [index] : []));
  const segmentStart = summaries.length > 1 ? (summaries.at(-2) ?? -1) + 1 : 0;

  for (const [index, line] of lines.entries()) {
    const match = index >= segmentStart ? failId.exec(line) : null;

    if (match?.[1] && match[2]) {
      const id = `${match[1]} > ${match[2]}`;

      if (ids.has(id)) {
        excludedFailed.add(id);
        filesExcluded.add(match[1]);
        continue;
      }

      otherFailed.add(id);
      filesOther.add(match[1]);
    }

    kept.push(line);
  }

  const invariants = extractInvariants(kept.join("\n"));

  if (invariants.tests) {
    const failed = (invariants.tests.failed ?? 0) - excludedFailed.size;
    const passed = (invariants.tests.passed ?? 0) - (ids.size - excludedFailed.size);
    invariants.tests = { ...invariants.tests, passed };

    if (failed > 0) invariants.tests.failed = failed;
    else delete invariants.tests.failed;
  }

  if (invariants.testFiles) {
    const moved = [...filesExcluded].filter((file) => !filesOther.has(file)).length;
    const failed = (invariants.testFiles.failed ?? 0) - moved;
    invariants.testFiles = {
      ...invariants.testFiles,
      passed: (invariants.testFiles.passed ?? 0) + moved,
    };

    if (failed > 0) invariants.testFiles.failed = failed;
    else delete invariants.testFiles.failed;
  }

  const excluded: TestOutcome[] = [...ids].map(([id, item]) => ({
    file: item.file ?? "",
    name: item.name,
    status: excludedFailed.has(id) ? "failed" : "passed",
  }));

  const suiteErrors = errorsLine.test(normalised) ? ["Runner reported unhandled errors"] : [];

  if ((invariants.testFiles?.failed ?? 0) > 0 && (invariants.tests?.failed ?? 0) === 0)
    suiteErrors.push("A test file failed without a failing test");

  return {
    invariants,
    excluded,
    onlyExcludedFailed: excludedFailed.size > 0 && otherFailed.size === 0,
    suiteErrors,
  };
}

export function isExcluded(outcome: TestOutcome, exclusions: readonly ExcludedTest[]) {
  return exclusions.some(
    (exclusion) =>
      exclusion.name === outcome.name &&
      (exclusion.file === undefined ||
        outcome.file === exclusion.file ||
        outcome.file.endsWith(`/${exclusion.file}`)),
  );
}

function tally(outcomes: readonly TestOutcome[]): TestCounts {
  const result: TestCounts = {};

  for (const { status } of outcomes) result[status] = (result[status] ?? 0) + 1;

  return result;
}

const keys = ["passed", "failed", "skipped", "todo"] as const;

function sameCounts(expected: TestCounts, observed: TestCounts | undefined) {
  return keys.every((key) => (expected[key] ?? 0) === (observed?.[key] ?? 0));
}

function exitMatches(expected: ExpectedExit, exitCode: number | null) {
  if (exitCode === null) return false;

  if (expected === "any") return true;

  if (expected === "non-zero") return exitCode !== 0;

  return exitCode === expected;
}

/** What a step produced, as the step runner observed it. */
export interface StepObservation {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  /** The test report's text, when the check names one; null when it could not be read. */
  testReport: string | null;
  /** sha256 of each postcondition path, null when the file is missing. */
  fileHashes: Record<string, string | null>;
  paths: PathTags;
}

export type CheckFailure =
  | { kind: "timed-out" }
  | { kind: "exit"; expected: ExpectedExit; actual: number | null }
  | {
      kind: "invariant";
      key: keyof OutputInvariants;
      expected: OutputInvariants[keyof OutputInvariants];
      actual: OutputInvariants[keyof OutputInvariants] | null;
    }
  | { kind: "test-report"; detail: string }
  | { kind: "failing-tests"; unexpected: string[]; missing: string[] }
  | { kind: "file-hash"; path: string; expected: string; actual: string | null }
  | { kind: "missing-file"; path: string }
  | { kind: "readiness"; process: string; timeoutMs: number }
  | { kind: "error"; detail: string };

export interface CheckResult {
  passed: boolean;
  failures: CheckFailure[];
  invariants: OutputInvariants;
  /** Outcomes of excluded tests: run, recorded, not counted. */
  excluded: TestOutcome[];
}

/** Decide a step from its frozen check only. Raw output is kept by the caller for inspection. */
export function evaluateCheck(check: StepCheck, observed: StepObservation): CheckResult {
  const failures: CheckFailure[] = [];
  const normalised = normalise(observed.output, check.normalise, observed.paths);
  let invariants = extractInvariants(normalised);
  let excluded: TestOutcome[] = [];
  let excludedOnlyFailures = false;

  if (observed.timedOut) failures.push({ kind: "timed-out" });

  if (check.testReport) {
    if (observed.testReport === null)
      failures.push({ kind: "test-report", detail: `${check.testReport.path} was not written` });
    else {
      try {
        const report = readVitestReport(observed.testReport);
        excluded = report.outcomes.filter((outcome) => isExcluded(outcome, check.exclude));
        const counted = report.outcomes.filter((outcome) => !isExcluded(outcome, check.exclude));
        // Per-test counts replace the summary line, which cannot leave excluded tests out.
        invariants.tests = tally(counted);
        excludedOnlyFailures =
          report.suiteErrors.length === 0 &&
          excluded.some((outcome) => outcome.status === "failed") &&
          !counted.some((outcome) => outcome.status === "failed");

        // A collection, hook or runtime error is never part of a frozen result.
        if (report.suiteErrors.length)
          failures.push({
            kind: "test-report",
            detail: `Suite errors: ${report.suiteErrors.slice(0, 3).join("; ")}`,
          });

        if (check.failing) {
          const failed = counted.filter((outcome) => outcome.status === "failed");
          const expected = check.failing.map((item) => ({ ...item, reason: "" }));

          const unexpected = failed.flatMap((outcome) =>
            isExcluded(outcome, expected) ? [] : [`${outcome.file} > ${outcome.name}`],
          );

          const missing = check.failing.flatMap((item) =>
            failed.some((outcome) => isExcluded(outcome, [{ ...item, reason: "" }]))
              ? []
              : [`${item.file ?? ""} > ${item.name}`],
          );

          if (unexpected.length || missing.length)
            failures.push({ kind: "failing-tests", unexpected, missing });
        }
      } catch (error) {
        failures.push({
          kind: "test-report",
          detail: `Unreadable report: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } else if (check.exclude.length) {
    const result = excludeFromText(normalised, check.exclude);
    invariants = result.invariants;
    excluded = result.excluded;
    excludedOnlyFailures =
      result.onlyExcludedFailed &&
      result.suiteErrors.length === 0 &&
      (invariants.tests?.failed ?? 0) === 0;
  }

  // An excluded test failing makes the runner exit 1; the frozen exit describes the counted set.
  const exitOk =
    exitMatches(check.exit, observed.exitCode) ||
    (check.exit === 0 && observed.exitCode === 1 && excludedOnlyFailures);

  if (!observed.timedOut && !exitOk)
    failures.push({ kind: "exit", expected: check.exit, actual: observed.exitCode });
  const expected = check.outputInvariants;

  if (expected.tests && !sameCounts(expected.tests, invariants.tests))
    failures.push({
      kind: "invariant",
      key: "tests",
      expected: expected.tests,
      actual: invariants.tests ?? null,
    });

  if (expected.testFiles && !sameCounts(expected.testFiles, invariants.testFiles))
    failures.push({
      kind: "invariant",
      key: "testFiles",
      expected: expected.testFiles,
      actual: invariants.testFiles ?? null,
    });

  if (expected.tscErrors !== undefined && expected.tscErrors !== invariants.tscErrors)
    failures.push({
      kind: "invariant",
      key: "tscErrors",
      expected: expected.tscErrors,
      actual: invariants.tscErrors ?? null,
    });

  if (expected.keyErrorLines) {
    const seen = new Set(invariants.keyErrorLines ?? []);

    if (!expected.keyErrorLines.every((line) => seen.has(line)))
      failures.push({
        kind: "invariant",
        key: "keyErrorLines",
        expected: expected.keyErrorLines,
        actual: invariants.keyErrorLines ?? null,
      });
  }

  for (const [path, hash] of Object.entries(check.postconditions.files)) {
    const actual = observed.fileHashes[path] ?? null;

    if (actual !== hash) failures.push({ kind: "file-hash", path, expected: hash, actual });
  }

  for (const path of check.postconditions.exists)
    if (!observed.fileHashes[path]) failures.push({ kind: "missing-file", path });

  return { passed: failures.length === 0, failures, invariants, excluded };
}
