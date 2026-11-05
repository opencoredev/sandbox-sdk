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

const pilot = (costs: readonly number[], logSigma = 0.15) =>
  pilotVarianceSchema.parse({
    providers: costs.map((cost, i) => ({
      name: `p${i}`,
      costPerAttemptUSD: cost,
      logSigma,
      failureRate: 0.05,
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
  it("recommends 10 batches when the pilot gap is large", () => {
    const result = recommendBatchCount({
      spec: pilot([1, 3, 5], 0.05),
      options: small,
      counts: [10, 20],
      targetPower: 0.8,
    });

    expect(result).toMatchObject({ kind: "batch-count", batches: 10 });
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

  it("says so up front when the pilot's cheapest providers tie", () => {
    expect(
      recommendBatchCount({
        spec: pilot([1, 1, 2]),
        options: small,
        counts: [10],
        targetPower: 0.8,
      }),
    ).toMatchObject({
      kind: "descriptive-only",
      reason: "the pilot shows no gap between its cheapest providers",
    });
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
