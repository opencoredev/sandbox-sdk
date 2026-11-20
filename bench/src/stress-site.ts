import { z } from "zod";
import type { MergedSample, PublicationReport } from "./merge.js";
import { parseCohortScenario } from "./scenarios.js";
import { statistics } from "./stats.js";
import { distribution } from "./v2-stats.js";
import { throughputSpread } from "./cpu.js";
import { countedFailures } from "./merge.js";

/**
 * The site's `stress` section: CPU sustained, CPU burst and burst survival, added after the
 * publication runs. Its rows never feed the older site-data fields, so those stay identical
 * whether or not a report contains stress data (see `isStressSample`).
 */

/** Rows of the stress scenarios: cpu-sustained in the main suite, and the two new cohort suites. */
export function isStressSample(sample: Pick<MergedSample, "suite" | "scenario">) {
  return (
    sample.suite === "cpu-burst" ||
    sample.suite === "survival" ||
    /^cpu-sustained(-single|-all)?$/.test(sample.scenario)
  );
}

type StressInput = Pick<
  MergedSample,
  | "provider"
  | "suite"
  | "scenario"
  | "outcome"
  | "failureClass"
  | "details"
  | "sandboxId"
  | "sourceRunId"
  | "sourceIteration"
>;

const finite = z.number().finite();

/** What a CPU throughput row's details hold (v2-runner's cpuScenario). */
const cpuDetailsSchema = z.object({
  workers: z.number().int().positive(),
  seconds: finite.positive(),
  steadiness: finite.nullable(),
  guestVcpus: finite.positive(),
});

/** What a survival member's window row holds (survival.ts heartbeatDetails, plus the plan). */
const windowDetailsSchema = z.object({
  verdict: z.object({
    kind: z.enum(["survived", "died", "unresponsive", "interrupted"]),
  }),
  plan: z.object({ windowMs: finite.positive(), intervalMs: finite.positive() }),
});

const parsed = <T>(schema: z.ZodType<T>, rows: readonly StressInput[]) =>
  rows.flatMap((s) => {
    const result = schema.safeParse(s.details);

    return s.outcome.kind === "sample" && result.success ? [result.data] : [];
  });

const values = (rows: readonly StressInput[]) =>
  rows.flatMap((s) => (s.outcome.kind === "sample" ? [s.outcome.value] : []));

const round = (value: number | null, digits = 3) =>
  value === null ? null : Number(value.toFixed(digits));

const counts = (xs: readonly number[]) =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<number, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));

/** Failures by the harness's taxonomy: account limits and client errors are not the provider's. */
function failureClasses(rows: readonly StressInput[]) {
  const failures = countedFailures(rows);

  return {
    accountLimit: failures.filter((s) => s.failureClass === "provider-account-limit").length,
    clientNetwork: failures.filter((s) => s.failureClass === "client-third-party").length,
    provider: failures.filter(
      (s) => s.failureClass === "provider-operation" || s.failureClass === null,
    ).length,
  };
}

function throughput(rows: readonly StressInput[], seed: number) {
  const stats = distribution(values(rows), seed);

  return {
    n: stats.count,
    p50: stats.p50,
    p95: stats.p95,
    min: stats.min,
    max: stats.max,
    ciLow: stats.p50CI?.low ?? null,
    ciHigh: stats.p50CI?.high ?? null,
  };
}

function cpuSustained(samples: readonly StressInput[], provider: string, seed: number) {
  const mine = samples.filter((s) => s.suite === "main" && s.provider === provider);
  const probe = mine.filter((s) => s.scenario === "cpu-sustained");

  if (!probe.length) return null;
  const single = mine.filter((s) => s.scenario === "cpu-sustained-single");
  const all = mine.filter((s) => s.scenario === "cpu-sustained-all");
  const singleDetails = parsed(cpuDetailsSchema, single);
  const allDetails = parsed(cpuDetailsSchema, all);

  const seconds = (xs: readonly { seconds: number }[]) => {
    const s = statistics(xs.map((x) => x.seconds));

    return s.count ? { p50: round(s.p50), max: round(s.max) } : null;
  };

  const steady = (xs: readonly { steadiness: number | null }[]) => {
    const s = statistics(xs.flatMap((x) => (x.steadiness === null ? [] : [x.steadiness])));

    return s.count ? { p50: round(s.p50), min: round(s.min) } : null;
  };

  return {
    provider,
    single: throughput(single, seed),
    all: throughput(all, seed),
    singleSeconds: seconds(singleDetails),
    allSeconds: seconds(allDetails),
    steadiness: { single: steady(singleDetails), all: steady(allDetails) },
    guestVcpus: counts(allDetails.map((d) => d.guestVcpus)),
    workers: counts(allDetails.map((d) => d.workers)),
    attempts: {
      successes: probe.filter((s) => s.outcome.kind === "sample").length,
      failures: failureClasses(probe),
      blocked: probe.filter((s) => s.outcome.kind === "blocked").length,
      skipped: probe.filter((s) => s.outcome.kind === "skipped").length,
    },
  };
}

/** Rows of one provider's cohorts of one kind and size. */
function cohortRows(samples: readonly StressInput[], provider: string, kind: string, k: number) {
  return samples.filter((s) => {
    const cohort = parseCohortScenario(s.scenario);

    return s.provider === provider && cohort?.kind === kind && cohort.k === k;
  });
}

/** Cohort sizes collected for one kind, ascending. */
function sizes(samples: readonly StressInput[], kind: string) {
  return [
    ...new Set(
      samples.flatMap((s) => {
        const cohort = parseCohortScenario(s.scenario);

        return cohort?.kind === kind ? [cohort.k] : [];
      }),
    ),
  ].sort((a, b) => a - b);
}

function cpuBurst(samples: readonly StressInput[], provider: string, k: number) {
  const rows = cohortRows(samples, provider, "cpu-burst", k);
  const aggregates = rows.filter((s) => s.scenario === `cpu-burst-${k}/all-complete`);

  if (!aggregates.length) return null;
  const member = (name: string) => rows.filter((s) => s.scenario === `cpu-burst-${k}/${name}`);
  const cold = member("cold");
  const cpu = member("cpu");

  // The spread inside each cohort: its fastest member over its slowest, on one process.
  const withinCohort = aggregates.flatMap((s) => {
    const spread = z
      .object({ single: z.object({ maxOverMin: finite.nullable() }) })
      .safeParse(s.details);

    return spread.success && spread.data.single.maxOverMin !== null
      ? [spread.data.single.maxOverMin]
      : [];
  });

  const complete = statistics(values(aggregates).map((ms) => ms / 1000));
  const within = statistics(withinCohort);

  return {
    provider,
    cohorts: aggregates.length,
    completeCohorts: aggregates.filter((s) => s.outcome.kind === "sample").length,
    members: {
      attempted: cold.length,
      ready: values(cold).length,
      completed: values(cpu).length,
    },
    failures: failureClasses([...cold, ...cpu]),
    perSandbox: {
      single: throughputSpread(values(member("cpu-single"))),
      all: throughputSpread(values(member("cpu-all"))),
    },
    withinCohortMaxOverMin: within.count
      ? { p50: round(within.p50), max: round(within.max) }
      : null,
    allCompleteS: complete.count
      ? { n: complete.count, p50: round(complete.p50), max: round(complete.max) }
      : null,
  };
}

function burstSurvival(samples: readonly StressInput[], provider: string, k: number) {
  const rows = cohortRows(samples, provider, "survival", k);
  const aggregates = rows.filter((s) => s.scenario === `survival-${k}/cohort`);

  if (!aggregates.length) return null;
  const cold = rows.filter((s) => s.scenario === `survival-${k}/cold`);
  const windows = rows.filter((s) => s.scenario === `survival-${k}/window`);

  const verdicts = windows.flatMap((s) => {
    const details = windowDetailsSchema.safeParse(s.details);

    return details.success ? [details.data] : [];
  });

  const verdict = (kind: string) => verdicts.filter((v) => v.verdict.kind === kind).length;
  const createFailed = failureClasses(cold);

  const createFailures =
    createFailed.accountLimit + createFailed.clientNetwork + createFailed.provider;

  const windowFailures = failureClasses(windows);

  const plans = [
    ...new Set(verdicts.map((v) => JSON.stringify([v.plan.windowMs, v.plan.intervalMs]))),
  ];

  const survived = verdict("survived");

  // Sandboxes that had a fair chance: created or refused by the provider itself, not stopped by an
  // account limit, a client error or our own interruption.
  const denominator =
    cold.length - createFailed.accountLimit - createFailed.clientNetwork - verdict("interrupted");

  const plan = plans.length === 1 ? verdicts[0]?.plan : undefined;

  return {
    provider,
    windowS: plan ? plan.windowMs / 1000 : null,
    heartbeatS: plan ? plan.intervalMs / 1000 : null,
    cohorts: aggregates.length,
    attempted: cold.length,
    survived,
    createFailed: { total: createFailures, ...createFailed },
    died: verdict("died"),
    unresponsive: verdict("unresponsive"),
    interrupted: verdict("interrupted"),
    /** Heartbeat failures by class; account limits (rate-limited heartbeats) are not the provider's. */
    windowFailures,
    survivalRate: denominator > 0 ? round(survived / denominator, 4) : null,
  };
}

export function stressData(
  r: Pick<PublicationReport, "samples" | "sources" | "bootstrapSeed">,
  providers: readonly string[],
) {
  const samples = r.samples.filter(isStressSample);
  const runIds = new Set(samples.map((s) => s.sourceRunId));
  const seed = r.bootstrapSeed;

  return {
    observations: samples.length,
    runs: r.sources
      .filter((s) => runIds.has(s.runId))
      .map((s) => ({
        id: s.runId,
        suite: s.suite,
        samples: samples.filter((x) => x.sourceRunId === s.runId).length,
      })),
    cpuSustained: providers.flatMap((p) => cpuSustained(samples, p, seed) ?? []),
    cpuBurst: sizes(samples, "cpu-burst").map((k) => ({
      k,
      providers: providers.flatMap((p) => cpuBurst(samples, p, k) ?? []),
    })),
    burstSurvival: sizes(samples, "survival").map((k) => ({
      k,
      providers: providers.flatMap((p) => burstSurvival(samples, p, k) ?? []),
    })),
  };
}

export type StressData = ReturnType<typeof stressData>;
