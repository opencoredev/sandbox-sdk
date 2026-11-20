import { z } from "zod";
import {
  countedFailures,
  publicationTrack,
  type MergedSample,
  type PublicationReport,
} from "./merge.js";
import { parseCohortScenario } from "./scenarios.js";
import { statistics } from "./stats.js";
import { distribution } from "./v2-stats.js";
import { throughputSpread } from "./cpu.js";
import { isStressRun, isStressSample, stressUnit } from "./suite.js";
import { windowEvidenceSchema, windowVerdict } from "./survival.js";

/**
 * The site's `stress` section: CPU sustained, CPU burst and burst survival, collected after the
 * publication runs and merged into their own report. The older site-data fields never read it.
 */

/** A merged stress report (`bun bench merge` over stress runs only), as site-data reads it. */
export type StressReport = Pick<PublicationReport, "samples" | "sources" | "bootstrapSeed"> &
  Partial<Pick<PublicationReport, "stressSelectionRemoved">>;

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
  | "requestedSize"
  | "template"
>;

const finite = z.number().finite();

/** What a CPU throughput row's details hold (v2-runner's cpuScenario). */
const cpuDetailsSchema = z.object({
  workers: z.number().int().positive(),
  seconds: finite.positive(),
  consistency: z.object({ minOverMedian: finite.nullable(), lastOverFirst: finite.nullable() }),
  guestVcpus: finite.positive(),
});

const survivalPlanSchema = z.object({ windowMs: finite.positive(), intervalMs: finite.positive() });

/** The plan a cohort aggregate records: the survival window, or the CPU work. */
const survivalAggregateSchema = z.object({ plan: survivalPlanSchema });

const cpuAggregateSchema = z.object({
  work: z.object({ segments: z.number().int().positive(), steps: z.number().int().positive() }),
  overlap: z
    .object({
      ok: z.boolean(),
      single: z.object({ startSkewMs: finite }),
      all: z.object({ startSkewMs: finite }),
    })
    .nullable()
    .optional(),
  single: z.object({ maxOverMin: finite.nullable() }).optional(),
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

/** Group rows by a key, keeping first-seen order. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();

  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);

  return [...groups.values()];
}

/** The allocation a row was collected at: requested size and template. */
const allocation = (s: Pick<StressInput, "requestedSize" | "template">) => ({
  requestedSize: s.requestedSize ?? null,
  template: s.template ?? null,
});

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

/** Median and minimum of a ratio, null when there are none. */
function ratio(xs: readonly (number | null)[]) {
  const s = statistics(xs.flatMap((x) => (x === null ? [] : [x])));

  return s.count ? { p50: round(s.p50), min: round(s.min) } : null;
}

/**
 * What one cpu-sustained attempt came to, by its probe row: a probe blocked by a failed create or
 * fingerprint counts as that row's failure, so a refusal stays visible as a failed attempt.
 */
function sustainedAttempts(probes: readonly StressInput[], samples: readonly StressInput[]) {
  const blocker = (probe: StressInput) =>
    probe.outcome.kind === "blocked"
      ? samples.find(
          (s) =>
            probe.outcome.kind === "blocked" &&
            s.sourceRunId === probe.sourceRunId &&
            s.sourceIteration === probe.sourceIteration &&
            s.provider === probe.provider &&
            s.scenario === probe.outcome.blocked_by &&
            s.outcome.kind === "failure",
        )
      : undefined;

  const failed = probes.flatMap((probe) => {
    if (probe.outcome.kind === "failure") return [probe];
    const cause = blocker(probe);

    return cause ? [cause] : [];
  });

  return {
    successes: probes.filter((s) => s.outcome.kind === "sample").length,
    failures: failureClasses(failed),
    blocked: probes.filter((s) => s.outcome.kind === "blocked" && !blocker(s)).length,
    skipped: probes.filter((s) => s.outcome.kind === "skipped").length,
  };
}

/** cpu-sustained per provider and allocation. */
function cpuSustained(samples: readonly StressInput[], seed: number) {
  const rows = samples.filter((s) => /^cpu-sustained(-single|-all)?$/.test(s.scenario));

  return groupBy(rows, (s) => JSON.stringify([s.provider, allocation(s)])).map((mine) => {
    const [first] = mine;
    const probe = mine.filter((s) => s.scenario === "cpu-sustained");
    const single = mine.filter((s) => s.scenario === "cpu-sustained-single");
    const all = mine.filter((s) => s.scenario === "cpu-sustained-all");
    const singleDetails = parsed(cpuDetailsSchema, single);
    const allDetails = parsed(cpuDetailsSchema, all);

    const seconds = (xs: readonly { seconds: number }[]) => {
      const s = statistics(xs.map((x) => x.seconds));

      return s.count ? { p50: round(s.p50), max: round(s.max) } : null;
    };

    return {
      provider: first?.provider ?? "",
      ...allocation(first ?? { requestedSize: null, template: null }),
      single: throughput(single, seed),
      all: throughput(all, seed),
      singleSeconds: seconds(singleDetails),
      allSeconds: seconds(allDetails),
      /** Slowest segment over the median segment, per run: 1 is perfectly even. */
      consistency: {
        single: ratio(singleDetails.map((d) => d.consistency.minOverMedian)),
        all: ratio(allDetails.map((d) => d.consistency.minOverMedian)),
      },
      /** Last quarter of segments over the first quarter, per run: below 1 the guest slowed. */
      trend: {
        single: ratio(singleDetails.map((d) => d.consistency.lastOverFirst)),
        all: ratio(allDetails.map((d) => d.consistency.lastOverFirst)),
      },
      guestVcpus: counts(allDetails.map((d) => d.guestVcpus)),
      workers: counts(allDetails.map((d) => d.workers)),
      attempts: sustainedAttempts(probe, samples),
    };
  });
}

/** One collected cohort: its aggregate row and its members' rows, by member iteration. */
interface CohortUnit {
  k: number;
  provider: string;
  aggregate: StressInput | null;
  rows: StressInput[];
  /** Members admitted (a create was attempted), from their cold rows. */
  cold: StressInput[];
  /** Every admitted member was created at once: the cohort is K-way evidence. */
  complete: boolean;
}

function cohortUnits(samples: readonly StressInput[], kind: "cpu-burst" | "survival") {
  const rows = samples.filter((s) => parseCohortScenario(s.scenario)?.kind === kind);

  return groupBy(rows, (s) => {
    const unit = stressUnit(s);

    return JSON.stringify([s.sourceRunId, s.provider, unit.name, unit.index]);
  }).flatMap((unitRows): CohortUnit[] => {
    const first = unitRows[0];
    const cohort = first ? parseCohortScenario(first.scenario) : null;

    if (!first || !cohort) return [];
    const cold = unitRows.filter((s) => parseCohortScenario(s.scenario)?.member === "cold");

    return [
      {
        k: cohort.k,
        provider: first.provider,
        aggregate: unitRows.find((s) => parseCohortScenario(s.scenario)?.aggregate) ?? null,
        rows: unitRows,
        cold,
        complete: cold.length === cohort.k,
      },
    ];
  });
}

/** Rows of one member scenario across units. */
const member = (units: readonly CohortUnit[], name: string) =>
  units.flatMap((u) => u.rows.filter((s) => parseCohortScenario(s.scenario)?.member === name));

/** Incomplete cohorts (budget or caps admitted fewer than K): reported, never pooled into K-way figures. */
const incomplete = (units: readonly CohortUnit[]) => {
  const partial = units.filter((u) => !u.complete);

  return { cohorts: partial.length, members: partial.reduce((n, u) => n + u.cold.length, 0) };
};

function cpuBurst(units: readonly CohortUnit[]) {
  const plan = (u: CohortUnit) => cpuAggregateSchema.safeParse(u.aggregate?.details).data ?? null;

  return groupBy(units, (u) =>
    JSON.stringify([u.provider, allocation(u.cold[0] ?? u.rows[0]!), plan(u)?.work ?? null]),
  ).map((group) => {
    const [first] = group;
    const complete = group.filter((u) => u.complete);

    // K-way spreads come only from cohorts whose members all completed and ran together.
    const together = complete.filter(
      (u) => u.aggregate?.outcome.kind === "sample" && plan(u)?.overlap?.ok === true,
    );

    const overlaps = complete.flatMap((u) => {
      const overlap = plan(u)?.overlap;

      return overlap ? [overlap] : [];
    });

    const withinCohort = together.flatMap((u) => {
      const spread = plan(u)?.single?.maxOverMin;

      return spread === undefined || spread === null ? [] : [spread];
    });

    const complete_ = statistics(
      values(complete.flatMap((u) => (u.aggregate ? [u.aggregate] : []))).map((ms) => ms / 1000),
    );

    const within = statistics(withinCohort);
    const skew = statistics(overlaps.map((o) => Math.max(o.single.startSkewMs, o.all.startSkewMs)));
    const work = first ? plan(first)?.work : undefined;

    return {
      provider: first?.provider ?? "",
      ...allocation(first?.cold[0] ?? first?.rows[0] ?? { requestedSize: null, template: null }),
      work: work ?? null,
      cohorts: complete.length,
      completeCohorts: complete.filter((u) => u.aggregate?.outcome.kind === "sample").length,
      /** Complete cohorts whose members' CPU phases overlapped less than the threshold. */
      lowOverlapCohorts: overlaps.filter((o) => !o.ok).length,
      incomplete: incomplete(group),
      members: {
        attempted: member(complete, "cold").length,
        ready: values(member(complete, "cold")).length,
        completed: values(member(complete, "cpu")).length,
      },
      failures: failureClasses([...member(complete, "cold"), ...member(complete, "cpu")]),
      /** From cohorts that all completed with overlapping CPU phases. */
      perSandbox: {
        cohorts: together.length,
        single: throughputSpread(values(member(together, "cpu-single"))),
        all: throughputSpread(values(member(together, "cpu-all"))),
      },
      withinCohortMaxOverMin: within.count
        ? { p50: round(within.p50), max: round(within.max) }
        : null,
      startSkewMs: skew.count ? { p50: round(skew.p50, 0), max: round(skew.max, 0) } : null,
      allCompleteS: complete_.count
        ? { n: complete_.count, p50: round(complete_.p50), max: round(complete_.max) }
        : null,
    };
  });
}

/**
 * One survival member's verdict, from its create and window rows. The window's verdict is
 * recomputed from its heartbeats and plan; evidence that does not bear it out is `invalid`.
 */
function survivalMember(cold: StressInput, window: StressInput | undefined) {
  if (cold.outcome.kind !== "sample") return "create-failed";

  // Created but never given its window: the run stopped while it waited.
  if (!window || window.outcome.kind === "skipped" || window.outcome.kind === "blocked")
    return "interrupted";

  const evidence = windowEvidenceSchema.safeParse(window.details);

  if (!evidence.success) return "invalid";
  const checked = windowVerdict(evidence.data);

  return checked.kind === "valid" ? checked.verdict : "invalid";
}

function burstSurvival(units: readonly CohortUnit[]) {
  const plan = (u: CohortUnit) =>
    survivalAggregateSchema.safeParse(u.aggregate?.details).data?.plan ?? null;

  return groupBy(units, (u) =>
    JSON.stringify([u.provider, allocation(u.cold[0] ?? u.rows[0]!), plan(u)]),
  ).map((group) => {
    const [first] = group;
    const complete = group.filter((u) => u.complete);
    const cold = member(complete, "cold");
    const windows = member(complete, "window");

    const members = cold.map((c) => {
      const window = windows.find(
        (w) =>
          w.sourceRunId === c.sourceRunId &&
          w.provider === c.provider &&
          w.sourceIteration === c.sourceIteration,
      );

      return { window, verdict: survivalMember(c, window) };
    });

    const verdict = (kind: (typeof members)[number]["verdict"]) =>
      members.filter((m) => m.verdict === kind).length;

    const createFailed = failureClasses(cold);

    // Window failures of members whose evidence bears out their verdict.
    const windowFailures = failureClasses(
      members.flatMap((m) => (m.window && m.verdict !== "invalid" ? [m.window] : [])),
    );

    const survived = verdict("survived");

    // Members the provider had a fair chance with: not refused by an account limit or a client
    // error at create or during the window, not cut short by our own interruption, and with
    // heartbeat evidence that bears out its verdict.
    const denominator =
      cold.length -
      createFailed.accountLimit -
      createFailed.clientNetwork -
      verdict("interrupted") -
      verdict("invalid") -
      windowFailures.accountLimit -
      windowFailures.clientNetwork;

    const p = first ? plan(first) : null;

    return {
      provider: first?.provider ?? "",
      ...allocation(first?.cold[0] ?? first?.rows[0] ?? { requestedSize: null, template: null }),
      windowS: p ? p.windowMs / 1000 : null,
      heartbeatS: p ? p.intervalMs / 1000 : null,
      cohorts: complete.length,
      incomplete: incomplete(group),
      attempted: cold.length,
      survived,
      createFailed: {
        total: createFailed.accountLimit + createFailed.clientNetwork + createFailed.provider,
        ...createFailed,
      },
      died: verdict("died"),
      unresponsive: verdict("unresponsive"),
      /** Members whose window the run cut short, counted once each and never against the provider. */
      interrupted: verdict("interrupted"),
      /** Members whose heartbeat evidence does not bear out their recorded verdict: left out. */
      invalidEvidence: verdict("invalid"),
      /** Heartbeat failures by class; account limits (rate-limited heartbeats) are not the provider's. */
      windowFailures,
      survivalRate: denominator > 0 ? round(survived / denominator, 4) : null,
    };
  });
}

/** Cohort sizes collected for one kind, ascending. */
function sizes(units: readonly CohortUnit[]) {
  return [...new Set(units.map((u) => u.k))].sort((a, b) => a - b);
}

/**
 * The stress section from a separately merged stress report, for one track. Its runs are the
 * report's own sources; none is inferred from which rows survived selection.
 */
export function stressData(report: StressReport | null, track: "default" | "same-spec") {
  if (!report)
    return {
      observations: 0,
      runs: [],
      selectionRemoved: {},
      cpuSustained: [],
      cpuBurst: [],
      burstSurvival: [],
    };

  const others = report.sources.filter((s) => !isStressRun(s)).map((s) => s.runId);

  if (others.length)
    throw new Error(
      `The stress report includes runs that are not stress runs (${others.join(", ")}): merge only cpu-sustained, cpu-burst and survival runs into it`,
    );

  const r = publicationTrack({ ...report, summaries: [] }, track);

  const samples = r.samples.filter(isStressSample);
  const cpu = cohortUnits(samples, "cpu-burst");
  const survival = cohortUnits(samples, "survival");

  return {
    observations: samples.length,
    runs: r.sources.map((s) => ({
      id: s.runId,
      suite: s.suite,
      samples: samples.filter((x) => x.sourceRunId === s.runId).length,
    })),
    /** Stress rows the attempt policy removed, by whole cohort or iteration, by reason. */
    selectionRemoved: report.stressSelectionRemoved ?? {},
    cpuSustained: cpuSustained(samples, report.bootstrapSeed),
    cpuBurst: sizes(cpu).map((k) => ({ k, providers: cpuBurst(cpu.filter((u) => u.k === k)) })),
    burstSurvival: sizes(survival).map((k) => ({
      k,
      providers: burstSurvival(survival.filter((u) => u.k === k)),
    })),
  };
}

export type StressData = ReturnType<typeof stressData>;
