import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { costPerCompleted, seededRandom } from "../src/cost/batch-stats.js";
import { coverageCommand } from "../src/cost/coverage-cli.js";
import {
  coverageReport,
  coverageScenarios,
  pilotVarianceSchema,
  recommendBatchCount,
  simulateBatches,
  trueCost,
} from "../src/cost/coverage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const small = { simulations: 20, replicates: 199, flips: 255, seed: 7 } as const;

/** Milder stress than the defaults, so a clear gap can certify within a small test budget. */
const mild = {
  skewLogSigma: 0.2,
  unequalSpreadLogSigma: 0.3,
  batchLogSigma: 0.1,
  providerBatchLogSigma: 0.05,
};

const pilot = (costs: readonly number[], logSigma = 0.15, failureRate = 0.02, stress = {}) =>
  pilotVarianceSchema.parse({
    stress,
    providers: costs.map((cost, i) => ({
      name: `p${i}`,
      costPerAttemptUSD: cost,
      logSigma,
      failureRate,
    })),
    batchLogSigma: 0.2,
  });

describe("simulated batches", () => {
  it("converge on the true cost per completed task, failures included", () => {
    const spec = pilotVarianceSchema.parse({
      providers: [
        {
          name: "a",
          costPerAttemptUSD: 1,
          logSigma: 0.3,
          failureRate: 0.2,
          failedCostFraction: 0.5,
        },
        { name: "b", costPerAttemptUSD: 2, logSigma: 0.1, failureRate: 0 },
      ],
      batchLogSigma: 0.2,
      providerBatchLogSigma: 0.1,
    });

    // 1 x (0.8 + 0.2 x 0.5) / 0.8, worked by hand.
    const [first] = spec.providers;

    if (!first) throw new Error("fixture");
    expect(trueCost(first)).toBeCloseTo(1.125, 12);
    const [a, b] = simulateBatches(spec, 20_000, seededRandom(3));
    expect(costPerCompleted(a?.batches ?? [])).toBeCloseTo(1.125, 1);
    expect(costPerCompleted(b?.batches ?? [])).toBeCloseTo(2, 1);
  });

  it("includes a scenario where one provider rarely completes", () => {
    const scenario = coverageScenarios(pilot([1, 2, 3])).find(
      (s) => s.name === "failures-and-zero-completions",
    );

    expect(scenario?.spec.providers.map((p) => p.failureRate)).toEqual([0.1, 0.1, 0.8]);
  });
});

describe("coverage report", () => {
  it("is deterministic for a fixed seed and reports every procedure", () => {
    const spec = pilot([1, 1.3, 1.6]);
    const first = coverageReport(spec, { ...small, batches: 10 });
    expect(coverageReport(spec, { ...small, batches: 10 })).toEqual(first);

    expect(first.procedures.map((p) => p.procedure)).toEqual([
      "centred-max-deviation",
      "studentised-max-deviation",
      "sign-flip-permutation",
    ]);

    for (const p of first.procedures) {
      expect(p.coverage.map((r) => r.scenario)).toEqual([
        "pilot",
        "equal-costs",
        "equal-costs-unequal-spread",
        "heavy-skew",
        "strong-batch-effects",
        "failures-and-zero-completions",
      ]);

      expect(p.power.map((r) => r.scenario)).toEqual(["pilot", "gap-10%", "gap-20%", "gap-30%"]);
      // Equal true costs: almost never a false directional claim.
      expect(
        p.coverage.find((r) => r.scenario === "equal-costs")?.noFalseClaimRate,
      ).toBeGreaterThanOrEqual(0.85);
      expect(p.coverage.find((r) => r.scenario === "equal-costs")?.power).toBeNull();
    }
  });
});

describe("batch-count recommendation", () => {
  it("recommends the smallest count at which a covering procedure certifies a large gap", () => {
    const result = recommendBatchCount({
      spec: pilot([1, 3, 5], 0.05, 0.02, mild),
      options: { ...small, simulations: 100 },
      counts: [10, 20],
      targetPower: 0.8,
    });

    expect(result.kind).toBe("batch-count");

    if (result.kind !== "batch-count") return;
    // Coverage at 10 batches falls short for every procedure in this input; 20 clears it.
    expect(result.batches).toBe(20);
    expect(result.power).toBeGreaterThanOrEqual(0.8);
    expect(result.reports.map((r) => r.chosen)).toEqual([null, result.procedure]);
  });

  it("says no count certifies when the pilot gap is tiny and noisy", () => {
    const result = recommendBatchCount({
      spec: pilot([1, 1.01], 0.5),
      options: small,
      counts: [10, 20],
      targetPower: 0.8,
    });

    expect(result.kind).toBe("descriptive-only");

    if (result.kind === "descriptive-only") {
      expect(result.batches).toBe(10);
      expect(result.reports.map((r) => r.batches)).toEqual([10, 20]);
    }
  });

  it("still simulates when the pilot's cheapest providers tie, and judges power at a 20% gap", () => {
    const result = recommendBatchCount({
      spec: pilot([1, 1, 2], 0.05),
      options: small,
      counts: [10],
      targetPower: 0.8,
    });

    expect(result.basis).toBe("gap-20%");
    expect(result.reports).toHaveLength(1);
  });
});

describe("review regressions", () => {
  const procedureReport = (report: ReturnType<typeof coverageReport>, name: string) =>
    report.procedures.find((p) => p.procedure === name);

  it("catches the sign-flip test's false claims when equal-cost providers differ in spread", () => {
    // Provider 0 gets lognormal sigma max(1, 3 x 0.7) = 2.1; the other has none.
    const spec = pilotVarianceSchema.parse({
      providers: [
        { name: "wide", costPerAttemptUSD: 1, logSigma: 0.7, failureRate: 0 },
        { name: "flat", costPerAttemptUSD: 1.3, logSigma: 0, failureRate: 0 },
      ],
      batchLogSigma: 0,
    });

    const report = coverageReport(spec, { ...small, simulations: 60, batches: 10 });
    const flips = procedureReport(report, "sign-flip-permutation");
    const unequal = flips?.coverage.find((r) => r.scenario === "equal-costs-unequal-spread");
    expect(unequal?.noFalseClaimRate).toBeLessThan(0.95);
    expect(flips?.meetsCoverage).toBe(false);
    expect(report.chosen).not.toBe("sign-flip-permutation");
  });

  it("counts a cheaper provider that breaks the completion rule as no pick", () => {
    // p0 is clearly cheapest but fails 20% of runs at no cost: at most one failure in ten runs
    // happens only 37.6% of the time, so power cannot be much above that.
    const spec = pilotVarianceSchema.parse({
      providers: [
        {
          name: "p0",
          costPerAttemptUSD: 1,
          logSigma: 0.05,
          failureRate: 0.2,
          failedCostFraction: 0,
        },
        { name: "p1", costPerAttemptUSD: 3, logSigma: 0.05, failureRate: 0 },
      ],
      batchLogSigma: 0.1,
    });

    const report = coverageReport(spec, { ...small, simulations: 60, batches: 10 });

    for (const p of report.procedures) expect(p.pilotPower ?? 1).toBeLessThan(0.6);
  });

  it("applies the accounting-sensitivity check in simulated picks", () => {
    const clear = pilot([1, 1.5], 0.05, 0);
    const before = coverageReport(clear, { ...small, batches: 10 });
    expect(procedureReport(before, "studentised-max-deviation")?.pilotPower).toBeGreaterThan(0.8);

    // A 60% reconciliation miss on the cheapest provider's own figure moves it above the rival.
    const shifted = pilotVarianceSchema.parse({
      ...clear,
      providers: clear.providers.map((p, i) => (i === 0 ? { ...p, accountingShift: 0.6 } : p)),
    });

    const after = coverageReport(shifted, { ...small, batches: 10 });

    for (const p of after.procedures) expect(p.pilotPower).toBe(0);
  });
});

describe("bench coverage command", () => {
  it("writes the report and recommendation as JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbx98-coverage-"));
    directories.push(directory);
    await writeFile(join(directory, "pilot.json"), JSON.stringify(pilot([1, 3, 5], 0.05)));

    await coverageCommand([
      "--input",
      join(directory, "pilot.json"),
      "--out",
      join(directory, "out.json"),
      "--counts",
      "10,12",
      "--simulations",
      "20",
      "--replicates",
      "199",
      "--flips",
      "255",
    ]);

    const written = JSON.parse(await readFile(join(directory, "out.json"), "utf8"));
    expect(written.atBatches.batches).toBe(10);
    expect(written.atBatches.coverageStandardError).toBeCloseTo(Math.sqrt((0.95 * 0.05) / 20), 12);
    expect(written.recommendation.kind).toBe("batch-count");
    await expect(
      coverageCommand(["--input", join(directory, "pilot.json"), "--batches", "9"]),
    ).rejects.toThrow(/from 10 to 20/);
  });
});
