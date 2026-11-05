import { describe, expect, it } from "vitest";
import {
  batchPercentileInterval,
  compareAll,
  costPerCompleted,
  median,
  pairedBatches,
  procedures,
  seededRandom,
  type BatchTotal,
  type ProviderBatches,
} from "../src/cost/batch-stats.js";
import type { Eligibility } from "../src/cost/eligibility.js";
import { ONLY_VERIFIED_LABEL, PICK_LABEL, pick, type Candidate } from "../src/cost/picks.js";
import { attempt, cleanAudit, failed } from "./cost-fixtures.js";

/** Ten batches around `mean` with a shared batch effect and ±`spread` noise, one completion each. */
function batches(
  mean: number,
  spread: number,
  seed: number,
  completions?: readonly number[],
): BatchTotal[] {
  const shared = seededRandom(1);
  const own = seededRandom(seed);

  return Array.from({ length: 10 }, (_, i) => ({
    costUSD: mean * (0.9 + 0.2 * shared()) * (1 - spread + 2 * spread * own()),
    attempts: 1,
    completions: completions?.[i] ?? 1,
  }));
}

const eligible: Eligibility = {
  kind: "eligible",
  status: { costKind: "billed", settled: true, provisional: null },
};

const unsettled: Eligibility = {
  kind: "ineligible",
  reasons: [{ kind: "unsettled", attempts: 10 }],
  status: { costKind: "billed", settled: false, provisional: null },
};

const candidate = (
  provider: string,
  data: BatchTotal[],
  patch: Partial<Candidate> = {},
): Candidate => ({
  provider,
  batches: data,
  eligibility: eligible,
  audit: cleanAudit,
  ...patch,
});

const options = { replicates: 2000 } as const;

describe("cost per completed task", () => {
  it("divides every attempt's cost by completions, and is infinite with none", () => {
    expect(
      costPerCompleted([
        { costUSD: 3, attempts: 2, completions: 1 },
        { costUSD: 1, attempts: 1, completions: 1 },
      ]),
    ).toBe(2);

    expect(costPerCompleted([{ costUSD: 1, attempts: 1, completions: 0 }])).toBe(Infinity);
  });

  it("pairs batches across providers, charging failed attempts and skipping not-run ones", () => {
    const ok = attempt({ attemptId: "ok", batch: 0 });
    const bad = failed({ attemptId: "bad", batch: 0 });

    const skipped = failed({
      attemptId: "skip",
      batch: 1,
      completion: { kind: "not-run", reason: "exceeds-plan-limit" },
    });

    const next = attempt({ attemptId: "next", batch: 1 });

    const costs = new Map([
      ["ok", 0.02],
      ["bad", 0.01],
      ["next", 0.03],
    ]);

    const [row] = pairedBatches([
      { provider: "upstash", attempts: [ok, bad, skipped, next], costUSD: costs },
    ]);

    expect(row?.batches).toEqual([
      { costUSD: 0.03, attempts: 2, completions: 1 },
      { costUSD: 0.03, attempts: 1, completions: 1 },
    ]);

    expect(() =>
      pairedBatches([
        { provider: "a", attempts: [ok], costUSD: costs },
        { provider: "b", attempts: [next], costUSD: costs },
      ]),
    ).toThrow(/no attempt in batch/);
  });
});

describe("simultaneous comparisons", () => {
  const clear: ProviderBatches[] = [
    { provider: "a", batches: batches(1, 0.05, 2) },
    { provider: "b", batches: batches(2, 0.05, 3) },
    { provider: "c", batches: batches(3, 0.05, 4) },
  ];

  it.each(procedures)("%s separates a clearly cheaper provider from every rival", (procedure) => {
    const pairs = compareAll(clear, { procedure, ...options });
    expect(pairs).toHaveLength(3);

    for (const pair of pairs.filter((p) => p.a === "a")) expect(pair.favours).toBe("a");
  });

  it("is reproducible from the fixed seed", () => {
    const first = compareAll(clear, { procedure: "centred-max-deviation", ...options });
    const again = compareAll(clear, { procedure: "centred-max-deviation", ...options });
    expect(again).toEqual(first);
  });

  it("widens centred intervals to infinity when a provider has zero completions in replicates", () => {
    const sparse = [
      ...clear,
      { provider: "d", batches: batches(1, 0.05, 5, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    ];

    const pairs = compareAll(sparse, { procedure: "centred-max-deviation", ...options });
    expect(pairs.every((p) => p.interval?.high === Infinity && p.favours === null)).toBe(true);
  });
  it.each(procedures)(
    "%s gives an unbounded interval, never NaN, when a provider never completed",
    (procedure) => {
      const none = {
        provider: "z",
        batches: batches(
          1,
          0.05,
          6,
          Array.from({ length: 10 }, () => 0),
        ),
      };

      const pairs = compareAll([...clear, none], { procedure, ...options }).filter(
        (p) => p.b === "z",
      );

      for (const pair of pairs) {
        expect(pair.favours).toBeNull();

        if (pair.interval) expect(pair.interval).toEqual({ low: -Infinity, high: Infinity });
        else expect(pair.adjustedP).toBe(1);
      }
    },
  );
});

describe("picks", () => {
  it("names the lowest verified cost among eligible providers", () => {
    const verdict = pick({
      candidates: [
        candidate("b", batches(2, 0.05, 3)),
        candidate("a", batches(1, 0.05, 2)),
        candidate("c", batches(3, 0.05, 4)),
      ],
      procedure: "centred-max-deviation",
      options,
    });

    expect(verdict).toMatchObject({
      kind: "lowest-verified-cost",
      label: PICK_LABEL,
      provider: "a",
      eligible: ["a", "b", "c"],
    });
  });

  it("reads 'no clear winner' for a tie and names every inseparable provider", () => {
    const verdict = pick({
      candidates: [
        candidate("a", batches(1, 0.3, 2)),
        candidate("b", batches(1.02, 0.3, 3)),
        candidate("c", batches(3, 0.05, 4)),
      ],
      procedure: "studentised-max-deviation",
      options,
    });

    expect(verdict.kind).toBe("no-clear-winner");

    if (verdict.kind === "no-clear-winner") {
      expect(verdict.cause).toBe("intervals");
      expect([...verdict.inseparable].sort()).toEqual(["a", "b"]);
    }
  });

  it("lets the accounting-sensitivity check flip a separated winner to 'no clear winner'", () => {
    // a's meter read $0.90 for a window the provider settled at $1.00: an 11.1% miss on our figure.
    const meterLow = {
      ...cleanAudit,
      reconciliation: {
        kind: "reconciled",
        window: "profile-track",
        reportedUSD: 0.9,
        settledUSD: 1,
      },
    } as const;

    const a = candidate("a", batches(1, 0.01, 2));
    const b = candidate("b", batches(1.105, 0.01, 2));
    const clean = pick({ candidates: [a, b], procedure: "centred-max-deviation", options });
    expect(clean.kind).toBe("lowest-verified-cost");

    // Moving a up by 10% of its cost would leave it below b; moving it by the real miss does not.
    const verdict = pick({
      candidates: [{ ...a, audit: meterLow }, b],
      procedure: "centred-max-deviation",
      options,
    });

    expect(verdict).toMatchObject({
      kind: "no-clear-winner",
      cause: "accounting-sensitivity",
      inseparable: ["a", "b"],
    });

    // Monetary resolution counts too: $0.12 per attempt on b closes the same gap.
    const coarse = pick({
      candidates: [a, { ...b, audit: { ...cleanAudit, resolutionUSDPerAttempt: 0.12 } }],
      procedure: "centred-max-deviation",
      options,
    });

    expect(coarse).toMatchObject({ kind: "no-clear-winner", cause: "accounting-sensitivity" });
  });

  it("flags lower unverified costs and providers that did not complete", () => {
    const verdict = pick({
      candidates: [
        candidate("a", batches(1, 0.05, 2)),
        candidate("b", batches(2, 0.05, 3)),
        candidate("cheap-unsettled", batches(0.5, 0.05, 4), { eligibility: unsettled }),
        candidate(
          "never",
          batches(
            0.1,
            0.05,
            5,
            Array.from({ length: 10 }, () => 0),
          ),
        ),
      ],
      procedure: "sign-flip-permutation",
    });

    expect(verdict.kind).toBe("lowest-verified-cost");
    expect(verdict.didNotComplete).toEqual(["never"]);
    expect(verdict.lowerUnverified).toEqual([
      {
        provider: "cheap-unsettled",
        costPerCompletedUSD: expect.any(Number),
        reasons: ["unsettled (10 attempts)"],
      },
    ]);
  });

  it("labels a sole eligible provider as the only verified cost, not the lowest", () => {
    const verdict = pick({
      candidates: [
        candidate("a", batches(1, 0.05, 2)),
        candidate("b", batches(0.5, 0.05, 3), { eligibility: unsettled }),
      ],
      procedure: "centred-max-deviation",
      options,
    });

    expect(verdict).toMatchObject({
      kind: "lowest-verified-cost",
      label: ONLY_VERIFIED_LABEL,
      provider: "a",
      eligible: ["a"],
    });

    expect(verdict.lowerUnverified.map((u) => u.provider)).toEqual(["b"]);
  });

  it("reads 'no certified winner' without a frozen procedure or without eligible providers", () => {
    const candidates = [candidate("a", batches(1, 0.05, 2)), candidate("b", batches(2, 0.05, 3))];

    expect(pick({ candidates, procedure: null })).toMatchObject({
      kind: "no-certified-winner",
      lowest: "a",
      reason: "no-procedure-reached-coverage",
    });

    expect(
      pick({
        candidates: candidates.map((c) => ({ ...c, eligibility: unsettled })),
        procedure: "centred-max-deviation",
      }),
    ).toMatchObject({ kind: "no-certified-winner", lowest: null, reason: "no-eligible-provider" });
  });
});

describe("descriptive intervals", () => {
  it("resamples whole batches for a median, reproducibly", () => {
    const elapsed = [[100, 120], [110], [130, 90], [105], [115]];
    const statistic = (rows: readonly number[][]) => median(rows.flat()) ?? 0;
    const interval = batchPercentileInterval({ batches: elapsed, statistic, replicates: 1000 });
    expect(interval).toEqual(
      batchPercentileInterval({ batches: elapsed, statistic, replicates: 1000 }),
    );
    expect(interval && interval.low <= 110 && 110 <= interval.high).toBe(true);
  });
});
