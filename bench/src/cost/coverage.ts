/**
 * Coverage and power simulation (gate A3.5). Before any provider result is examined, each
 * candidate procedure runs on simulated paired batch data with skew, batch effects, failures and
 * zero-completion cases. The procedure that reaches at least 95% simultaneous coverage in every
 * scenario is frozen. With the pilot's variance it then recommends a batch count from 10 to 20, or
 * says that no count certifies a winner and the profile runs at 10 batches as descriptive only.
 *
 * Simultaneous coverage means: every pair's true difference lies inside its interval. The sign-flip
 * test has no intervals, so for it coverage means no false directional claim in any pair (the
 * share of simulations where every separated pair is separated the right way). Both are reported
 * for every procedure.
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

export const REQUIRED_COVERAGE = 0.95;

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
      }),
    )
    .min(2),
  /** Lognormal sigma of a batch effect shared by every provider (time of day, registry load). */
  batchLogSigma: z.number().finite().nonnegative(),
  /** Lognormal sigma of a batch effect specific to each provider. */
  providerBatchLogSigma: z.number().finite().nonnegative().default(0),
  attemptsPerBatch: z.int().positive().default(1),
});

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
  simulations: 200,
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

/** Stress scenarios for coverage: the pilot, equal costs, heavy skew, strong batch effects, failures. */
export function coverageScenarios(spec: PilotVariance): Scenario[] {
  const typical = medianOf(spec.providers.map(trueCost));
  const costs = spec.providers.map(trueCost);
  const priciest = costs.indexOf(Math.max(...costs));

  return [
    { name: "pilot", spec },
    {
      name: "equal-costs",
      spec: { ...spec, providers: spec.providers.map((p) => withCost(p, typical)) },
    },
    {
      name: "heavy-skew",
      spec: {
        ...spec,
        providers: spec.providers.map((p) => ({ ...p, logSigma: Math.max(2 * p.logSigma, 0.6) })),
      },
    },
    {
      name: "strong-batch-effects",
      spec: {
        ...spec,
        batchLogSigma: Math.max(2 * spec.batchLogSigma, 0.4),
        providerBatchLogSigma: Math.max(2 * spec.providerBatchLogSigma, 0.2),
      },
    },
    {
      name: "failures-and-zero-completions",
      spec: {
        ...spec,
        providers: spec.providers.map((p, i) =>
          i === priciest
            ? { ...p, failureRate: 0.8 }
            : { ...p, failureRate: Math.max(p.failureRate, 0.1) },
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

/** The observed cheapest, when it is separated in its favour from every other provider. */
export function certifiedCheapest(
  data: readonly ProviderBatches[],
  pairs: readonly PairComparison[],
): string | null {
  const [cheapest] = [...data].sort(
    (x, y) => costPerCompleted(x.batches) - costPerCompleted(y.batches),
  );

  if (!cheapest) return null;

  const separated = pairs.every(
    (p) =>
      (p.a !== cheapest.provider && p.b !== cheapest.provider) || p.favours === cheapest.provider,
  );

  return separated ? cheapest.provider : null;
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
    // A provider that never completed is "did not complete" and is not compared.
    const data = simulateBatches(scenario.spec, options.batches, random).filter((p) =>
      Number.isFinite(costPerCompleted(p.batches)),
    );

    const results = compareWith(data, procedures, {
      replicates: options.replicates,
      flips: options.flips,
      seed: Math.floor(random() * 2 ** 32),
    });

    for (const { procedure, pairs } of results) {
      const tally = tallies.get(procedure);

      if (!tally) continue;
      const winner = certifiedCheapest(data, pairs);

      if (covers(pairs, truth)) tally.covered++;

      if (noFalseClaim(pairs, truth)) tally.noFalseClaim++;

      if (winner !== null && winner === best) tally.certifiedTrue++;
      else if (winner !== null) tally.certifiedWrong++;
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
      /** Share of simulations that certified the true cheapest; null when the truth is a tie. */
      power: best === null ? null : t.certifiedTrue / n,
      wrongPickRate: t.certifiedWrong / n,
    };
  });
}

export type ScenarioResult = ReturnType<typeof runScenario>[number];

export interface ProcedureReport {
  readonly procedure: Procedure;
  /** Lowest simultaneous coverage over the coverage scenarios. */
  readonly minCoverage: number;
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
  readonly procedures: readonly ProcedureReport[];
  /** The procedure to freeze: meets coverage, then highest pilot power, then listed order. */
  readonly chosen: Procedure | null;
}

function simultaneousCoverage(result: ScenarioResult): number {
  return result.intervalCoverage ?? result.noFalseClaimRate;
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
    const minCoverage = Math.min(...own.map(simultaneousCoverage));

    return {
      procedure,
      minCoverage,
      meetsCoverage: minCoverage >= REQUIRED_COVERAGE,
      pilotPower: own.find((r) => r.scenario === "pilot")?.power ?? null,
      coverage: own,
      power: power.filter((r) => r.procedure === procedure),
    };
  });

  const [chosen] = reports
    .filter((r) => r.meetsCoverage)
    .sort((x, y) => (y.pilotPower ?? 0) - (x.pilotPower ?? 0));

  return {
    batches: options.batches,
    options,
    coverageStandardError: Math.sqrt(
      (REQUIRED_COVERAGE * (1 - REQUIRED_COVERAGE)) / options.simulations,
    ),
    procedures: reports,
    chosen: chosen?.procedure ?? null,
  };
}

export type Recommendation =
  | {
      readonly kind: "batch-count";
      readonly batches: number;
      readonly procedure: Procedure;
      readonly pilotPower: number;
      readonly reports: readonly CoverageReport[];
    }
  | {
      readonly kind: "descriptive-only";
      /** Run at the minimum count and publish descriptive intervals, no certified pick. */
      readonly batches: typeof MIN_BATCHES;
      readonly reason: string;
      readonly reports: readonly CoverageReport[];
    };

/**
 * The smallest count from 10 to 20 at which a procedure meets coverage and certifies the pilot's
 * cheapest provider with at least `targetPower`.
 */
export function recommendBatchCount(input: {
  readonly spec: PilotVariance;
  readonly options: Omit<SimulationOptions, "batches">;
  readonly counts: readonly number[];
  readonly targetPower: number;
}): Recommendation {
  if (trueCheapest(input.spec) === null)
    return {
      kind: "descriptive-only",
      batches: MIN_BATCHES,
      reason: "the pilot shows no gap between its cheapest providers",
      reports: [],
    };

  const reports: CoverageReport[] = [];
  const counts = [...new Set(input.counts)].sort((x, y) => x - y);

  for (const batches of counts) {
    if (batches < MIN_BATCHES || batches > MAX_BATCHES)
      throw new Error(`Batch counts must be from ${MIN_BATCHES} to ${MAX_BATCHES}`);
    const report = coverageReport(input.spec, { ...input.options, batches });
    reports.push(report);
    const chosen = report.procedures.find((p) => p.procedure === report.chosen);

    if (chosen && chosen.pilotPower !== null && chosen.pilotPower >= input.targetPower)
      return {
        kind: "batch-count",
        batches,
        procedure: chosen.procedure,
        pilotPower: chosen.pilotPower,
        reports,
      };
  }

  const last = reports.at(-1);
  const best = last?.procedures.find((p) => p.procedure === last.chosen);

  return {
    kind: "descriptive-only",
    batches: MIN_BATCHES,
    reason: best
      ? `at ${last?.batches} batches ${best.procedure} certifies the pilot's cheapest provider in only ${((best.pilotPower ?? 0) * 100).toFixed(0)}% of simulations`
      : `no procedure reached ${REQUIRED_COVERAGE * 100}% simultaneous coverage`,
    reports,
  };
}
