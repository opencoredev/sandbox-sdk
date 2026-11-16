/**
 * Coverage and power simulation (gate A3.5). Before any provider result is examined, each
 * candidate procedure runs on simulated paired batch data with skew, batch effects, failures and
 * zero-completion cases. The procedure that reaches an estimated 96% simultaneous coverage (95% nominal plus a noise margin) in every
 * scenario is frozen. With the pilot's variance it then recommends a batch count from 10 to 20, or
 * says that no count certifies a winner and the profile runs at 10 batches as descriptive only.
 *
 * Two guarantees are measured, and they are not the same:
 * - simultaneous coverage: every pair's true difference lies inside its interval (the bootstrap
 *   procedures, which give intervals);
 * - directional error control: no pair is separated the wrong way (all three procedures).
 * Coverage implies directional control, not the reverse. A procedure with intervals that reaches
 * 96% estimated coverage in every scenario is preferred. The sign-flip test, which has no intervals, is
 * frozen only when no interval procedure qualifies, and the report then names the weaker
 * guarantee so the page can state it.
 *
 * Power runs the real pick rules on each simulated data set: the completion rule (at most one
 * incomplete run), separation from every other eligible provider, and the accounting-sensitivity
 * check with each provider's reconciliation miss and resolution.
 */
import { z } from "zod";
import {
  compareWith,
  costPerCompleted,
  procedures,
  seededRandom,
  type BatchTotal,
  type PairComparison,
  type Procedure,
  type ProviderBatches,
} from "./batch-stats.js";
import { MAX_INCOMPLETE_RUNS } from "./eligibility.js";
import { decide, type Candidate } from "./picks.js";

/** Nominal simultaneous coverage. */
export const NOMINAL_COVERAGE = 0.95;

/**
 * Estimated coverage a procedure needs to qualify: one point above nominal, so a procedure at the
 * edge of 95% cannot flip in or out on simulation noise (plan section 3).
 */
export const QUALIFYING_COVERAGE = 0.96;

export const MIN_BATCHES = 10;

export const MAX_BATCHES = 20;

const share = z.number().min(0).max(1);

/** Pilot variance per provider, the simulation's only input. Costs are per attempt, in USD. */
export const pilotVarianceSchema = z.object({
  providers: z
    .array(
      z.object({
        name: z.string().min(1),
        /** Mean cost of a completed attempt. */
        costPerAttemptUSD: z.number().finite().positive(),
        /** Lognormal sigma of attempt cost within a batch: the skew. */
        logSigma: z.number().finite().nonnegative(),
        failureRate: z.number().min(0).max(0.95),
        /** A failed attempt's cost as a share of a completed one's. */
        failedCostFraction: share.default(0.5),
        /** Reconciliation miss as a share of our figure, for the sensitivity check. */
        accountingShift: z.number().finite().min(0).max(1).default(0),
        /** Monetary resolution in USD per attempt, for the sensitivity check. */
        resolutionUSDPerAttempt: z.number().finite().nonnegative().default(0),
      }),
    )
    .min(2),
  /** Lognormal sigma of a batch effect shared by every provider (time of day, registry load). */
  batchLogSigma: z.number().finite().nonnegative(),
  /** Lognormal sigma of a batch effect specific to each provider. */
  providerBatchLogSigma: z.number().finite().nonnegative().default(0),
  attemptsPerBatch: z.int().positive().default(1),
  /**
   * Stress levels the pilot measured. Any level left out uses its published default
   * (STRESS_DEFAULTS); the report says which source each level came from.
   */
  stress: z
    .object({
      /** Attempt-cost spread (lognormal sigma) for every provider in "heavy-skew". */
      skewLogSigma: z.number().finite().nonnegative(),
      /** One provider's spread in "equal-costs-unequal-spread". */
      unequalSpreadLogSigma: z.number().finite().nonnegative(),
      /** Shared batch effect in "strong-batch-effects". */
      batchLogSigma: z.number().finite().nonnegative(),
      /** Per-provider batch effect in "strong-batch-effects". */
      providerBatchLogSigma: z.number().finite().nonnegative(),
      /** Failure rate for every provider in "failures-and-zero-completions". */
      failureRate: z.number().min(0).max(0.95),
      /** Share of batches in which the stressed provider completes nothing, in that scenario. */
      zeroCompletionRate: z.number().min(0).max(0.95),
    })
    .partial()
    .prefault({}),
});

/** Published defaults for stress levels the pilot did not measure. */
export const STRESS_DEFAULTS = {
  skewLogSigma: 0.6,
  unequalSpreadLogSigma: 0.6,
  batchLogSigma: 0.4,
  providerBatchLogSigma: 0.2,
  failureRate: 0.1,
  zeroCompletionRate: 0.8,
} as const;

export type StressName = keyof typeof STRESS_DEFAULTS;

export interface StressLevel {
  readonly value: number;
  readonly source: "pilot" | "default";
}

export type StressLevels = { readonly [K in StressName]: StressLevel };

/** Each stress level with the source it came from: the pilot's measurement, else the default. */
export function stressLevels(spec: { readonly stress: PilotVariance["stress"] }): StressLevels {
  const level = (name: StressName): StressLevel => {
    const measured = spec.stress[name];

    return measured === undefined
      ? { value: STRESS_DEFAULTS[name], source: "default" }
      : { value: measured, source: "pilot" };
  };

  return {
    skewLogSigma: level("skewLogSigma"),
    unequalSpreadLogSigma: level("unequalSpreadLogSigma"),
    batchLogSigma: level("batchLogSigma"),
    providerBatchLogSigma: level("providerBatchLogSigma"),
    failureRate: level("failureRate"),
    zeroCompletionRate: level("zeroCompletionRate"),
  };
}

export type PilotVariance = z.infer<typeof pilotVarianceSchema>;

type SimProvider = PilotVariance["providers"][number];

export interface SimulationOptions {
  readonly batches: number;
  readonly simulations: number;
  readonly replicates: number;
  readonly flips: number;
  readonly seed: number;
}

export const defaultSimulation: Omit<SimulationOptions, "batches"> = {
  simulations: 1000,
  replicates: 999,
  flips: 1023,
  seed: 20_261_202,
};

export interface Scenario {
  readonly name: string;
  readonly spec: PilotVariance;
}

/** True cost per completed task: mean attempt cost over completion probability. */
export function trueCost(p: SimProvider): number {
  const f = p.failureRate;

  return (p.costPerAttemptUSD * (1 - f + f * p.failedCostFraction)) / (1 - f);
}

function normal(random: () => number): number {
  const u = Math.max(random(), Number.MIN_VALUE);

  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Lognormal factor with mean 1. */
function factor(random: () => number, sigma: number): number {
  return sigma === 0 ? 1 : Math.exp(sigma * normal(random) - (sigma * sigma) / 2);
}

/** One simulated paired data set: shared and provider batch effects, skewed costs, failures. */
export function simulateBatches(
  spec: PilotVariance,
  batches: number,
  random: () => number,
): ProviderBatches[] {
  const rows = spec.providers.map((): BatchTotal[] => []);

  for (let b = 0; b < batches; b++) {
    const shared = factor(random, spec.batchLogSigma);

    spec.providers.forEach((p, i) => {
      const own = factor(random, spec.providerBatchLogSigma);

      let costUSD = 0,
        completions = 0;

      for (let a = 0; a < spec.attemptsPerBatch; a++) {
        const completed = random() >= p.failureRate;
        const cost = p.costPerAttemptUSD * shared * own * factor(random, p.logSigma);
        costUSD += completed ? cost : cost * p.failedCostFraction;
        completions += completed ? 1 : 0;
      }

      rows[i]?.push({ costUSD, attempts: spec.attemptsPerBatch, completions });
    });
  }

  return spec.providers.map((p, i) => ({ provider: p.name, batches: rows[i] ?? [] }));
}

function withCost(p: SimProvider, target: number): SimProvider {
  return { ...p, costPerAttemptUSD: p.costPerAttemptUSD * (target / trueCost(p)) };
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Stress scenarios: the pilot, equal costs (equal and unequal spread), heavy skew, strong batch effects, failures. */
export function coverageScenarios(spec: PilotVariance): Scenario[] {
  const typical = medianOf(spec.providers.map(trueCost));
  const costs = spec.providers.map(trueCost);
  const priciest = costs.indexOf(Math.max(...costs));
  const stress = stressLevels(spec);

  return [
    { name: "pilot", spec },
    {
      name: "equal-costs",
      spec: { ...spec, providers: spec.providers.map((p) => withCost(p, typical)) },
    },
    {
      // Equal means, very different spread: sign flips assume the two providers' batch totals are
      // interchangeable, which equal cost per completed task does not make true.
      name: "equal-costs-unequal-spread",
      spec: {
        ...spec,
        providers: spec.providers.map((p, i) =>
          withCost(
            {
              ...p,
              logSigma:
                i === 0 ? Math.max(stress.unequalSpreadLogSigma.value, p.logSigma) : p.logSigma,
            },
            typical,
          ),
        ),
      },
    },
    {
      name: "heavy-skew",
      spec: {
        ...spec,
        providers: spec.providers.map((p) => ({
          ...p,
          logSigma: Math.max(p.logSigma, stress.skewLogSigma.value),
        })),
      },
    },
    {
      name: "strong-batch-effects",
      spec: {
        ...spec,
        batchLogSigma: Math.max(spec.batchLogSigma, stress.batchLogSigma.value),
        providerBatchLogSigma: Math.max(
          spec.providerBatchLogSigma,
          stress.providerBatchLogSigma.value,
        ),
      },
    },
    {
      name: "failures-and-zero-completions",
      spec: {
        ...spec,
        providers: spec.providers.map((p, i) =>
          i === priciest
            ? {
                ...p,
                // Zero completions in a batch means every attempt in it failed. Never below the
                // provider's own pilot rate or the scenario's failure level.
                failureRate: Math.max(
                  p.failureRate,
                  stress.failureRate.value,
                  stress.zeroCompletionRate.value ** (1 / spec.attemptsPerBatch),
                ),
              }
            : { ...p, failureRate: Math.max(p.failureRate, stress.failureRate.value) },
        ),
      },
    },
  ];
}

/** Power scenarios: the pilot as measured, then one provider cheaper than the rest by a fixed gap. */
export function powerScenarios(spec: PilotVariance, gaps: readonly number[]): Scenario[] {
  const typical = medianOf(spec.providers.map(trueCost));

  return [
    { name: "pilot", spec },
    ...gaps.map((gap) => ({
      name: `gap-${Math.round(gap * 100)}%`,
      spec: {
        ...spec,
        providers: spec.providers.map((p, i) =>
          withCost(p, i === 0 ? typical * (1 - gap) : typical),
        ),
      },
    })),
  ];
}

function trueCheapest(spec: PilotVariance): string | null {
  const ranked = spec.providers
    .map((p) => ({ name: p.name, cost: trueCost(p) }))
    .sort((x, y) => x.cost - y.cost);

  const [first, second] = ranked;

  if (!first) return null;

  return second && second.cost - first.cost <= 1e-12 * first.cost ? null : first.name;
}

function covers(pairs: readonly PairComparison[], truth: ReadonlyMap<string, number>): boolean {
  return pairs.every((pair) => {
    const d = (truth.get(pair.a) ?? 0) - (truth.get(pair.b) ?? 0);

    return pair.interval !== null && pair.interval.low <= d && d <= pair.interval.high;
  });
}

function noFalseClaim(
  pairs: readonly PairComparison[],
  truth: ReadonlyMap<string, number>,
): boolean {
  return pairs.every((pair) => {
    if (pair.favours === null) return true;
    const other = pair.favours === pair.a ? pair.b : pair.a;

    return (truth.get(pair.favours) ?? 0) < (truth.get(other) ?? 0);
  });
}

/** Simulated providers that pass the completion rule, cheapest first, as pick candidates. */
function eligibleCandidates(data: readonly ProviderBatches[], spec: PilotVariance): Candidate[] {
  return data
    .flatMap((p): Candidate[] => {
      const provider = spec.providers.find((s) => s.name === p.provider);
      let incomplete = 0;

      for (const b of p.batches) incomplete += b.attempts - b.completions;

      if (!provider || incomplete > MAX_INCOMPLETE_RUNS) return [];

      return [
        {
          provider: p.provider,
          batches: p.batches,
          eligibility: {
            kind: "eligible",
            status: { costKind: "billed", settled: true, provisional: null },
          },
          audit: {
            reconciliation: {
              kind: "reconciled",
              window: "profile-track",
              reportedUSD: 1,
              settledUSD: 1 - provider.accountingShift,
            },
            resolutionUSDPerAttempt: provider.resolutionUSDPerAttempt,
            provisional: null,
          },
        },
      ];
    })
    .sort((x, y) => costPerCompleted(x.batches) - costPerCompleted(y.batches));
}

interface Tally {
  covered: number;
  noFalseClaim: number;
  certifiedTrue: number;
  certifiedWrong: number;
}

/** Run every procedure on the same simulated data sets for one scenario. */
function runScenario(scenario: Scenario, options: SimulationOptions, seed: number) {
  const random = seededRandom(seed);
  const truth = new Map(scenario.spec.providers.map((p) => [p.name, trueCost(p)]));
  const best = trueCheapest(scenario.spec);

  const tallies = new Map<Procedure, Tally>(
    procedures.map((p) => [
      p,
      { covered: 0, noFalseClaim: 0, certifiedTrue: 0, certifiedWrong: 0 },
    ]),
  );

  for (let s = 0; s < options.simulations; s++) {
    const all = simulateBatches(scenario.spec, options.batches, random);
    // Coverage is judged on every provider with a completion, the hardest set for the procedure.
    const data = all.filter((p) => Number.isFinite(costPerCompleted(p.batches)));
    const eligible = eligibleCandidates(all, scenario.spec);
    const compareSeed = Math.floor(random() * 2 ** 32);
    const settings = { replicates: options.replicates, flips: options.flips, seed: compareSeed };
    const results = compareWith(data, procedures, settings);

    // Picks compare only eligible providers; rerun when the completion rule removed any.
    const pickResults =
      eligible.length === data.length || eligible.length < 2
        ? results
        : compareWith(eligible, procedures, settings);

    for (const { procedure, pairs } of results) {
      const tally = tallies.get(procedure);

      if (!tally) continue;

      if (covers(pairs, truth)) tally.covered++;

      if (noFalseClaim(pairs, truth)) tally.noFalseClaim++;
      const [first, ...rest] = eligible;

      if (!first) continue;

      const pickPairs =
        eligible.length < 2
          ? []
          : (pickResults.find((r) => r.procedure === procedure)?.pairs ?? []);

      const decision = decide([first, ...rest], pickPairs);

      if (decision.kind !== "certified") continue;

      if (decision.provider === best) tally.certifiedTrue++;
      else tally.certifiedWrong++;
    }
  }

  return procedures.map((procedure) => {
    const t = tallies.get(procedure) ?? {
      covered: 0,
      noFalseClaim: 0,
      certifiedTrue: 0,
      certifiedWrong: 0,
    };

    const n = options.simulations;

    return {
      procedure,
      scenario: scenario.name,
      intervalCoverage: procedure === "sign-flip-permutation" ? null : t.covered / n,
      noFalseClaimRate: t.noFalseClaim / n,
      /** Share of simulations whose pick was the true cheapest; null when the truth is a tie. */
      power: best === null ? null : t.certifiedTrue / n,
      wrongPickRate: t.certifiedWrong / n,
    };
  });
}

export type ScenarioResult = ReturnType<typeof runScenario>[number];

export type Guarantee = "simultaneous-coverage" | "directional-error-control";

export interface ProcedureReport {
  readonly procedure: Procedure;
  readonly guarantee: Guarantee;
  /** Lowest interval coverage over the coverage scenarios; null without intervals. */
  readonly minCoverage: number | null;
  /** Lowest rate of no false directional claim over the coverage scenarios. */
  readonly minNoFalseClaim: number;
  /** Reaches 96% on its own guarantee in every coverage scenario. */
  readonly meetsCoverage: boolean;
  /** Power on the pilot scenario; null when the pilot's cheapest providers tie. */
  readonly pilotPower: number | null;
  readonly coverage: readonly ScenarioResult[];
  readonly power: readonly ScenarioResult[];
}

export interface CoverageReport {
  readonly batches: number;
  readonly options: SimulationOptions;
  /** Monte Carlo standard error of a coverage estimate near 95% at this simulation count. */
  readonly coverageStandardError: number;
  /** The stress levels used, each with its source; published before the gate runs. */
  readonly stress: StressLevels;
  readonly procedures: readonly ProcedureReport[];
  /**
   * The procedure to freeze: one with 96% estimated simultaneous coverage if any (highest pilot power, then
   * listed order), else the sign-flip test if it controls directional error, else none.
   */
  readonly chosen: Procedure | null;
  readonly chosenGuarantee: Guarantee | null;
}

export function coverageReport(
  spec: PilotVariance,
  options: SimulationOptions,
  gaps: readonly number[] = [0.1, 0.2, 0.3],
): CoverageReport {
  const coverage = coverageScenarios(spec).flatMap((scenario, i) =>
    runScenario(scenario, options, options.seed + i * 7919),
  );

  // The pilot scenario is shared, so its results are reused for power.
  const power = [
    ...coverage.filter((r) => r.scenario === "pilot"),
    ...powerScenarios(spec, gaps)
      .slice(1)
      .flatMap((scenario, i) => runScenario(scenario, options, options.seed + 104_729 + i * 7919)),
  ];

  const reports = procedures.map((procedure): ProcedureReport => {
    const own = coverage.filter((r) => r.procedure === procedure);
    const intervals = procedure !== "sign-flip-permutation";
    const minNoFalseClaim = Math.min(...own.map((r) => r.noFalseClaimRate));
    const minCoverage = intervals ? Math.min(...own.map((r) => r.intervalCoverage ?? 0)) : null;

    return {
      procedure,
      guarantee: intervals ? "simultaneous-coverage" : "directional-error-control",
      minCoverage,
      minNoFalseClaim,
      meetsCoverage: (minCoverage ?? minNoFalseClaim) >= QUALIFYING_COVERAGE,
      pilotPower: own.find((r) => r.scenario === "pilot")?.power ?? null,
      coverage: own,
      power: power.filter((r) => r.procedure === procedure),
    };
  });

  const rank = (r: ProcedureReport) => (r.guarantee === "simultaneous-coverage" ? 0 : 1);

  const [chosen] = reports
    .filter((r) => r.meetsCoverage)
    .sort((x, y) => rank(x) - rank(y) || (y.pilotPower ?? 0) - (x.pilotPower ?? 0));

  return {
    batches: options.batches,
    options,
    stress: stressLevels(spec),
    coverageStandardError: Math.sqrt(
      (NOMINAL_COVERAGE * (1 - NOMINAL_COVERAGE)) / options.simulations,
    ),
    procedures: reports,
    chosen: chosen?.procedure ?? null,
    chosenGuarantee: chosen?.guarantee ?? null,
  };
}

export type Recommendation =
  | {
      readonly kind: "batch-count";
      readonly batches: number;
      readonly procedure: Procedure;
      readonly guarantee: Guarantee;
      /** The power scenario the count was chosen on. */
      readonly basis: string;
      readonly power: number;
      readonly reports: readonly CoverageReport[];
    }
  | {
      readonly kind: "descriptive-only";
      /** Run at the minimum count and publish descriptive intervals, no certified pick. */
      readonly batches: typeof MIN_BATCHES;
      readonly basis: string;
      readonly reason: string;
      readonly reports: readonly CoverageReport[];
    };

/** The gap used for the recommendation when the pilot's cheapest providers tie. */
const TIE_BASIS = "gap-20%";

/**
 * The smallest count from 10 to 20 at which a frozen procedure certifies the true cheapest
 * provider with at least `targetPower`: on the pilot as measured, or at a 20% gap when the pilot's
 * cheapest providers tie (a tie in the pilot does not show a real gap is undetectable).
 */
export function recommendBatchCount(input: {
  readonly spec: PilotVariance;
  readonly options: Omit<SimulationOptions, "batches">;
  readonly counts: readonly number[];
  readonly targetPower: number;
}): Recommendation {
  const basis = trueCheapest(input.spec) === null ? TIE_BASIS : "pilot";
  const reports: CoverageReport[] = [];
  const counts = [...new Set(input.counts)].sort((x, y) => x - y);

  for (const batches of counts) {
    if (batches < MIN_BATCHES || batches > MAX_BATCHES)
      throw new Error(`Batch counts must be from ${MIN_BATCHES} to ${MAX_BATCHES}`);
    const report = coverageReport(input.spec, { ...input.options, batches }, [0.1, 0.2, 0.3]);
    reports.push(report);
    const chosen = report.procedures.find((p) => p.procedure === report.chosen);
    const power = chosen?.power.find((r) => r.scenario === basis)?.power ?? null;

    if (chosen && power !== null && power >= input.targetPower)
      return {
        kind: "batch-count",
        batches,
        procedure: chosen.procedure,
        guarantee: chosen.guarantee,
        basis,
        power,
        reports,
      };
  }

  // The best the sweep reached, so the reason names the count and power behind "descriptive only".
  const reached = reports.flatMap((report) => {
    const chosen = report.procedures.find((p) => p.procedure === report.chosen);
    const power = chosen?.power.find((r) => r.scenario === basis)?.power;

    return chosen && power !== undefined && power !== null
      ? [{ batches: report.batches, procedure: chosen.procedure, power }]
      : [];
  });

  const best = reached.sort((x, y) => y.power - x.power)[0];

  return {
    kind: "descriptive-only",
    batches: MIN_BATCHES,
    basis,
    reason: best
      ? `the best was ${best.procedure} at ${best.batches} batches, certifying the true cheapest provider (${basis}) in ${(best.power * 100).toFixed(0)}% of simulations, below the ${(input.targetPower * 100).toFixed(0)}% target`
      : `no procedure reached ${QUALIFYING_COVERAGE * 100}% on its guarantee in every scenario at any count`,
    reports,
  };
}
