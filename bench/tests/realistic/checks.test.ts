import { describe, expect, it } from "vitest";
import {
  evaluateCheck,
  extractInvariants,
  normalise,
  parseVitestReport,
  type StepObservation,
} from "../../src/realistic/checks.js";
import { defaultNormalisation, stepCheckSchema } from "../../src/realistic/manifest.js";

const observation = (overrides: Partial<StepObservation>): StepObservation => ({
  exitCode: 0,
  timedOut: false,
  output: "",
  testReport: null,
  fileHashes: {},
  paths: { workdir: "/workspace/rw" },
  ...overrides,
});

const vitestOutput = `\x1b[32m RUN \x1b[39m v3.2.4 /workspace/rw/repo
 FAIL  |unit| packages/a.spec.ts > a > breaks 12ms
 Error: expected 1 to be 2 at 10:42:01.123
 Test Files  1 failed | 3 passed (4)
      Tests  2 failed | 40 passed | 1 skipped (43)
   Start at  10:42:00
   Duration  1.52s (transform 22ms) pid 31337 on localhost:51234 id 0123456789abcdef`;

describe("normalisation", () => {
  it("applies the rig's rules: paths, ANSI, timestamps, clock times, durations, PIDs, ports, hex ids", () => {
    const text = normalise(vitestOutput, defaultNormalisation, { workdir: "/workspace/rw" });

    expect(text).not.toContain("\x1b[");
    expect(text).toContain("<REPO>/repo");
    expect(text).toContain("Start at  <TIME>");
    expect(text).toContain("Duration  <DUR>");
    expect(text).toContain("pid <PID>");
    expect(text).toContain("localhost:<PORT>");
    expect(text).toContain("<HEX>");
    expect(
      normalise("2026-11-05T10:00:00.5Z /tmp/x", ["iso-timestamps", "paths"], { workdir: "/w" }),
    ).toBe("<TS> <TMP>/x");
  });

  it("extracts the same invariants the rig records, with key lines sorted", () => {
    const invariants = extractInvariants(
      normalise(vitestOutput, defaultNormalisation, { workdir: "/workspace/rw" }) +
        "\nFound 3 errors in 2 files.\nerror TS2322: nope",
    );

    expect(invariants.tests).toEqual({ failed: 2, passed: 40, skipped: 1 });
    expect(invariants.testFiles).toEqual({ failed: 1, passed: 3 });
    expect(invariants.tscErrors).toBe(3);
    expect(invariants.keyErrorLines).toEqual([
      "Error: expected 1 to be 2 at <TIME>",
      "FAIL  |unit| packages/a.spec.ts > a > breaks <DUR>",
      "error TS2322: nope",
    ]);
  });
});

describe("frozen step checks", () => {
  it("treats an expected non-zero exit as a pass and an unexpected zero as a failure", () => {
    const check = stepCheckSchema.parse({
      exit: "non-zero",
      outputInvariants: { tests: { failed: 2, passed: 40, skipped: 1 } },
    });

    expect(evaluateCheck(check, observation({ exitCode: 1, output: vitestOutput })).passed).toBe(
      true,
    );
    expect(
      evaluateCheck(check, observation({ exitCode: 0, output: vitestOutput })).failures,
    ).toEqual([{ kind: "exit", expected: "non-zero", actual: 0 }]);
  });

  it("compares counts exactly, a missing key counting as zero", () => {
    const check = stepCheckSchema.parse({ exit: 1, outputInvariants: { tests: { passed: 40 } } });
    const result = evaluateCheck(check, observation({ exitCode: 1, output: vitestOutput }));

    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatchObject({ kind: "invariant", key: "tests" });
  });

  it("fails on timeout, on a key line that is absent, and on postcondition hashes", () => {
    const check = stepCheckSchema.parse({
      exit: "any",
      outputInvariants: { keyErrorLines: ["Error: something else"] },
      postconditions: { files: { "src/a.ts": "a".repeat(64) }, exists: ["dist/index.js"] },
    });

    const result = evaluateCheck(
      check,
      observation({
        timedOut: true,
        exitCode: null,
        output: vitestOutput,
        fileHashes: { "src/a.ts": "b".repeat(64), "dist/index.js": null },
      }),
    );

    expect(result.failures.map((f) => f.kind)).toEqual([
      "timed-out",
      "invariant",
      "file-hash",
      "missing-file",
    ]);
  });

  it("counts excluded tests out, records their outcome, and accepts the exit 1 they cause", () => {
    const report = JSON.stringify({
      testResults: [
        {
          name: "/workspace/rw/repo/packages/x/__tests__/timing.spec.ts",
          assertionResults: [
            { fullName: "scheduler > flushes within 10ms", status: "failed" },
            { fullName: "scheduler > orders jobs", status: "passed" },
            { fullName: "scheduler > todo", status: "todo" },
            { fullName: "scheduler > skipped", status: "pending" },
          ],
        },
      ],
    });

    const check = stepCheckSchema.parse({
      exit: 0,
      outputInvariants: { tests: { passed: 1, skipped: 1, todo: 1 } },
      testReport: { kind: "vitest-json", path: "repo/report.json" },
      exclude: [
        {
          file: "packages/x/__tests__/timing.spec.ts",
          name: "scheduler > flushes within 10ms",
          reason: "timing-sensitive",
        },
      ],
    });

    const result = evaluateCheck(check, observation({ exitCode: 1, testReport: report }));

    expect(result.passed).toBe(true);
    expect(result.invariants.tests).toEqual({ passed: 1, skipped: 1, todo: 1 });
    expect(result.excluded).toEqual([
      expect.objectContaining({ name: "scheduler > flushes within 10ms", status: "failed" }),
    ]);

    // A counted failure is not excused by the exclusion list.
    const counted = report.replace(
      '{"fullName":"scheduler > orders jobs","status":"passed"}',
      '{"fullName":"scheduler > orders jobs","status":"failed"}',
    );

    expect(evaluateCheck(check, observation({ exitCode: 1, testReport: counted })).passed).toBe(
      false,
    );
    // A missing report fails the check instead of falling back to the summary line.
    expect(
      evaluateCheck(check, observation({ exitCode: 0, testReport: null })).failures[0],
    ).toMatchObject({ kind: "test-report" });
  });

  it("refuses exclusions without a per-test report", () => {
    expect(() => stepCheckSchema.parse({ exclude: [{ name: "x", reason: "timing" }] })).toThrow(
      /per-test report/,
    );
  });

  it("parses vitest's JSON reporter and maps pending to skipped", () => {
    expect(
      parseVitestReport(
        JSON.stringify({
          testResults: [
            { name: "/a.spec.ts", assertionResults: [{ fullName: "a", status: "pending" }] },
          ],
        }),
      ),
    ).toEqual([{ file: "/a.spec.ts", name: "a", status: "skipped" }]);
  });
});
