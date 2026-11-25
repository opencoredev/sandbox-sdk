import { z } from "zod";
import {
  classifyFailure,
  countedFailures,
  publicationTrack,
  type MergedSample,
  type PublicationReport,
} from "./merge.js";
import { parseCohortScenario } from "./scenarios.js";
import { statistics } from "./stats.js";
import { distribution } from "./v2-stats.js";
import { cpuOverlap, throughputSpread } from "./cpu.js";
import { isStressRun, isStressSample, stressUnit } from "./suite.js";
import {
  memberEvidence,
  windowEvidenceSchema,
  type InvalidEvidence,
  type WindowFailure,
} from "./survival.js";

/**
 * The site's `stress` section: CPU sustained, CPU burst and burst survival, collected after the
 * publication runs and merged into their own report. The older site-data fields never read it.
 */

/** A merged stress report (`bun bench merge` over stress runs only), as site-data reads it. */
export type StressReport = Pick<PublicationReport, "samples" | "sources" | "bootstrapSeed"> &
  Partial<Pick<PublicationReport, "stressSelectionRemoved" | "stressSelectionRemovedByTrack">>;

type StressInput = Pick<
  MergedSample,
  | "provider"
  | "suite"
  | "scenario"
  | "outcome"
  | "details"
  | "sandboxId"
  | "sourceRunId"
  | "sourceIteration"
  | "requestedSize"
  | "template"
  | "product"
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

/** The CPU work a cpu-burst cohort aggregate records, to group cohorts that ran the same. */
const cpuAggregateSchema = z.object({
  work: z.object({ segments: z.number().int().positive(), steps: z.number().int().positive() }),
});

/**
 * What a cpu-burst member's throughput row records about when its phase could have run
 * (`cpuPhaseEvidence`): its exec on the host clock and the phase's guest timer length. Rows from
 * before the exec was recorded do not parse, and their cohort is invalid evidence.
 */
const cpuPhaseSchema = z.object({
  exec: z.tuple([finite, finite]).refine(([start, end]) => end >= start),
  seconds: finite.positive(),
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

/**
 * The allocation a row was collected at: requested size, template and native product (such as
 * Upstash's `ephemeral`), so two products of one provider are never pooled into one entry.
 */
const allocation = (s: Pick<StressInput, "requestedSize" | "template" | "product">) => ({
  requestedSize: s.requestedSize ?? null,
  template: s.template ?? null,
  product: s.product ?? null,
});

/** An entry's allocation when the group has no row to read it from. */
const noAllocation = { requestedSize: null, template: null, product: null };

/**
 * Failures by the harness's taxonomy: account limits and client errors are not the provider's.
 * Each class is recomputed from the row's raw outcome by `classifyFailure`, the rule merge uses;
 * the row's stored `failureClass` is never read, so editing it cannot move a published rate.
 */
function failureClasses(rows: readonly StressInput[]) {
  const classes = countedFailures(rows).map((s) => classifyFailure(s));

  return {
    accountLimit: classes.filter((c) => c === "provider-account-limit").length,
    clientNetwork: classes.filter((c) => c === "client-third-party").length,
    provider: classes.filter((c) => c === "provider-operation" || c === null).length,
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

/** One iteration of one provider in one source run. */
const iterationKey = (s: Pick<StressInput, "sourceRunId" | "provider" | "sourceIteration">) =>
  JSON.stringify([s.sourceRunId, s.provider, s.sourceIteration]);

/**
 * Failed creates of a cpu-sustained run's iterations that have no probe row: `runV2` records a
 * failed create as the iteration's `cold` row and returns before the probe. Only the sustained
 * run's own `cold` rows count, never a cohort's member rows; an iteration with a probe row is
 * already counted by that row (or the failure that blocked it). Only the iterations a source run
 * planned a probe for count (below its `runs`): an older run with `--workload-runs` above `runs`
 * also created extra iterations that were never going to probe.
 */
function unprobedCreateFailures(
  samples: readonly StressInput[],
  plannedRuns: ReadonlyMap<string, number>,
) {
  const probed = new Set(
    samples.flatMap((s) => (s.scenario === "cpu-sustained" ? [iterationKey(s)] : [])),
  );

  return samples.filter(
    (s) =>
      s.suite === "cpu-sustained" &&
      s.scenario === "cold" &&
      s.outcome.kind === "failure" &&
      s.sourceIteration < (plannedRuns.get(s.sourceRunId) ?? Number.POSITIVE_INFINITY) &&
      !probed.has(iterationKey(s)),
  );
}

/**
 * The failed row a blocked row names in `blocked_by`, from the same source run, provider and
 * iteration; undefined when the row is not blocked or its blocker did not fail. `step` names a
 * row's step the way `blocked_by` does: the scenario itself, or a cohort row's member.
 */
function failedBlocker({
  blocked,
  rows,
  step = (s) => s.scenario,
}: {
  blocked: StressInput;
  rows: readonly StressInput[];
  step?: (row: StressInput) => string | undefined;
}) {
  const { outcome } = blocked;

  if (outcome.kind !== "blocked") return undefined;

  return rows.find(
    (s) =>
      s.sourceRunId === blocked.sourceRunId &&
      s.sourceIteration === blocked.sourceIteration &&
      s.provider === blocked.provider &&
      step(s) === outcome.blocked_by &&
      s.outcome.kind === "failure",
  );
}

/**
 * What cpu-sustained attempts came to, one per iteration: by its probe row, where a probe blocked
 * by a failed create or fingerprint counts as that row's failure, or by its failed create when
 * the run stopped before the probe. Either way a refusal stays visible as a failed attempt.
 */
function sustainedAttempts(
  probes: readonly StressInput[],
  failedCreates: readonly StressInput[],
  samples: readonly StressInput[],
) {
  const blocker = (probe: StressInput) => failedBlocker({ blocked: probe, rows: samples });

  const failed = probes.flatMap((probe) => {
    if (probe.outcome.kind === "failure") return [probe];
    const cause = blocker(probe);

    return cause ? [cause] : [];
  });

  return {
    successes: probes.filter((s) => s.outcome.kind === "sample").length,
    failures: failureClasses([...failed, ...failedCreates]),
    blocked: probes.filter((s) => s.outcome.kind === "blocked" && !blocker(s)).length,
    skipped: probes.filter((s) => s.outcome.kind === "skipped").length,
  };
}

/** cpu-sustained per provider and allocation. */
function cpuSustained({
  samples,
  seed,
  plannedRuns,
}: {
  samples: readonly StressInput[];
  seed: number;
  plannedRuns: ReadonlyMap<string, number>;
}) {
  const rows = [
    ...samples.filter((s) => /^cpu-sustained(-single|-all)?$/.test(s.scenario)),
    ...unprobedCreateFailures(samples, plannedRuns),
  ];

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
      ...allocation(first ?? noAllocation),
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
      attempts: sustainedAttempts(
        probe,
        mine.filter((s) => s.scenario === "cold"),
        samples,
      ),
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

const memberStep = (s: StressInput) => parseCohortScenario(s.scenario)?.member;

/**
 * Each admitted cpu-burst member's failure, counted once: its failed create, its failed CPU run,
 * or the failed step (such as its fingerprint) that blocked the run. A member whose fingerprint
 * failed after it started is a failed attempt, not one that silently drops out of the counts.
 */
function cpuMemberFailures(units: readonly CohortUnit[]) {
  return units.flatMap((u) =>
    u.cold.flatMap((cold) => {
      if (cold.outcome.kind === "failure") return [cold];

      const cpu = u.rows.find(
        (s) => memberStep(s) === "cpu" && s.sourceIteration === cold.sourceIteration,
      );

      if (!cpu) return [];

      if (cpu.outcome.kind === "failure") return [cpu];
      const cause = failedBlocker({ blocked: cpu, rows: u.rows, step: memberStep });

      return cause ? [cause] : [];
    }),
  );
}

/** Incomplete cohorts (budget or caps admitted fewer than K): reported, never pooled into K-way figures. */
const incomplete = (units: readonly CohortUnit[]) => {
  const partial = units.filter((u) => !u.complete);

  return { cohorts: partial.length, members: partial.reduce((n, u) => n + u.cold.length, 0) };
};

/** Why a complete cpu-burst cohort is left out of the K-way spread. */
type CpuExclusion = "low-overlap" | "invalid-evidence";

/**
 * Whether a complete cpu-burst cohort's members provably ran their CPU phases together,
 * recomputed from the members' own rows by `cpuOverlap` (host exec windows and guest timer
 * lengths, never guest wall clocks); the aggregate's stored overlap is never read. A member
 * whose rows are missing, unreadable, from two different execs, or whose phases are longer than
 * its exec makes the cohort invalid evidence; otherwise the proven overlap must reach the threshold.
 */
function cpuCohort(u: CohortUnit) {
  const phases = (name: "cpu-single" | "cpu-all") =>
    u.cold.map((c) => {
      const row = u.rows.find(
        (s) =>
          parseCohortScenario(s.scenario)?.member === name &&
          s.sourceIteration === c.sourceIteration &&
          s.outcome.kind === "sample",
      );

      return cpuPhaseSchema.safeParse(row?.details).data ?? null;
    });

  const single = phases("cpu-single");
  const all = phases("cpu-all");

  // Both rows of a member come from one exec, so they must record the same window.
  const members = single.flatMap((s, i) => {
    const a = all[i];

    return s && a && s.exec[0] === a.exec[0] && s.exec[1] === a.exec[1]
      ? [{ exec: s.exec, singleSeconds: s.seconds, allSeconds: a.seconds }]
      : [];
  });

  if (members.length !== u.k) return { exclusion: "invalid-evidence" as const, overlap: null };
  const overlap = cpuOverlap(members);

  if (overlap.kind === "inconsistent")
    return { exclusion: "invalid-evidence" as const, overlap: null };

  return { exclusion: overlap.ok ? null : ("low-overlap" as const), overlap };
}

function cpuBurst(units: readonly CohortUnit[]) {
  const work = (u: CohortUnit) => cpuAggregateSchema.safeParse(u.aggregate?.details).data?.work;

  return groupBy(units, (u) =>
    JSON.stringify([u.provider, allocation(u.cold[0] ?? u.rows[0]!), work(u) ?? null]),
  ).map((group) => {
    const [first] = group;
    const complete = group.filter((u) => u.complete);
    const finished = complete.filter((u) => u.aggregate?.outcome.kind === "sample");
    const judged = finished.map((u) => ({ u, ...cpuCohort(u) }));

    // K-way spreads come only from cohorts whose members all completed and ran together.
    const together = judged.flatMap((j) => (j.exclusion === null ? [j.u] : []));

    const excluded = (reason: CpuExclusion) => judged.filter((j) => j.exclusion === reason).length;

    const withinCohort = together.flatMap((u) => {
      const spread = throughputSpread(values(member([u], "cpu-single"))).maxOverMin;

      return spread === null ? [] : [spread];
    });

    const complete_ = statistics(
      values(complete.flatMap((u) => (u.aggregate ? [u.aggregate] : []))).map((ms) => ms / 1000),
    );

    const within = statistics(withinCohort);

    const skew = statistics(judged.flatMap((j) => (j.overlap ? [j.overlap.dispatchSkewMs] : [])));

    return {
      provider: first?.provider ?? "",
      ...allocation(first?.cold[0] ?? first?.rows[0] ?? noAllocation),
      work: (first && work(first)) ?? null,
      cohorts: complete.length,
      completeCohorts: finished.length,
      /** Complete cohorts left out of the K-way spread, by reason. */
      excluded: {
        lowOverlap: excluded("low-overlap"),
        invalidEvidence: excluded("invalid-evidence"),
      },
      incomplete: incomplete(group),
      members: {
        attempted: member(complete, "cold").length,
        ready: values(member(complete, "cold")).length,
        completed: values(member(complete, "cpu")).length,
      },
      failures: failureClasses(cpuMemberFailures(complete)),
      /** From cohorts that all completed with a proven overlap of their CPU phases. */
      perSandbox: {
        cohorts: together.length,
        single: throughputSpread(values(member(together, "cpu-single"))),
        all: throughputSpread(values(member(together, "cpu-all"))),
      },
      withinCohortMaxOverMin: within.count
        ? { p50: round(within.p50), max: round(within.max) }
        : null,
      /** How far apart a cohort's execs were dispatched, on the host clock. */
      dispatchSkewMs: skew.count ? { p50: round(skew.p50, 0), max: round(skew.max, 0) } : null,
      allCompleteS: complete_.count
        ? { n: complete_.count, p50: round(complete_.p50), max: round(complete_.max) }
        : null,
    };
  });
}

type SurvivalMember =
  | { kind: "create-failed" }
  /** Created but never given its window: the run stopped while it waited. */
  | { kind: "no-window" }
  | { kind: "invalid"; reason: InvalidEvidence }
  | { kind: "decided"; verdict: SurvivalVerdictKind; failure: WindowFailure | null };

type SurvivalVerdictKind = "survived" | "died" | "unresponsive" | "interrupted";

/** One survival member, from its create row and its window's raw heartbeats (see `memberEvidence`). */
function survivalMember(
  cold: StressInput,
  window: StressInput | undefined,
  plan: z.infer<typeof survivalPlanSchema> | null,
): SurvivalMember {
  if (cold.outcome.kind !== "sample") return { kind: "create-failed" };

  if (!window || window.outcome.kind === "skipped" || window.outcome.kind === "blocked")
    return { kind: "no-window" };

  const parsed = windowEvidenceSchema.safeParse(window.details);

  if (!parsed.success) return { kind: "invalid", reason: "unreadable" };
  const evidence = memberEvidence(parsed.data, plan);

  return evidence.kind === "valid"
    ? { kind: "decided", verdict: evidence.verdict, failure: evidence.failure }
    : evidence;
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

    const members = complete.flatMap((u) =>
      u.cold.map((c) =>
        survivalMember(
          c,
          u.rows.find(
            (w) =>
              parseCohortScenario(w.scenario)?.member === "window" &&
              w.sourceIteration === c.sourceIteration,
          ),
          plan(u),
        ),
      ),
    );

    const decided = members.flatMap((m) => (m.kind === "decided" ? [m] : []));
    const verdict = (kind: SurvivalVerdictKind) => decided.filter((m) => m.verdict === kind).length;
    const invalid = members.flatMap((m) => (m.kind === "invalid" ? [m.reason] : []));
    const createFailed = failureClasses(cold);

    // Recomputed from each window's heartbeats; a window's own row is never read for its class.
    const windowFailures = {
      accountLimit: decided.filter((m) => m.failure === "provider-account-limit").length,
      clientNetwork: 0,
      provider: decided.filter((m) => m.failure === "provider-operation").length,
    };

    const interrupted =
      verdict("interrupted") + members.filter((m) => m.kind === "no-window").length;

    const survived = verdict("survived");

    // Members the provider had a fair chance with: not refused by an account limit or a client
    // error at create or during the window, not cut short by our own interruption, and with
    // heartbeat evidence that bears out its verdict.
    const denominator =
      cold.length -
      createFailed.accountLimit -
      createFailed.clientNetwork -
      interrupted -
      invalid.length -
      windowFailures.accountLimit;

    const p = first ? plan(first) : null;

    return {
      provider: first?.provider ?? "",
      ...allocation(first?.cold[0] ?? first?.rows[0] ?? noAllocation),
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
      interrupted,
      /** Members whose raw heartbeat evidence does not hold up: left out. */
      invalidEvidence: invalid.length,
      /** `invalidEvidence` by reason. */
      invalidReasons: Object.fromEntries(counts_(invalid)),
      /** Heartbeat failures by class; account limits (rate-limited heartbeats) are not the provider's. */
      windowFailures,
      survivalRate: denominator > 0 ? round(survived / denominator, 4) : null,
    };
  });
}

/** How often each string occurs, in first-seen order. */
const counts_ = (xs: readonly string[]) => [
  ...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>()),
];

/** Cohort sizes collected for one kind, ascending. */
function sizes(units: readonly CohortUnit[]) {
  return [...new Set(units.map((u) => u.k))].sort((a, b) => a - b);
}

/**
 * The stress rows the attempt policy removed on one track. A report merged before removals were
 * kept by track holds only the total. When every source ran on one track the total is that
 * track's, and the other track removed nothing; when its runs span tracks it cannot be split
 * (unless nothing was removed), and the report must be merged again.
 */
function trackRemovals(report: StressReport, track: "default" | "same-spec") {
  const byTrack = report.stressSelectionRemovedByTrack;

  if (byTrack) return byTrack[track] ?? {};
  const total = report.stressSelectionRemoved ?? {};
  const tracks = new Set(report.sources.map((s) => s.config.track ?? "default"));

  if (Object.keys(total).length === 0) return {};

  if (tracks.size === 1) return tracks.has(track) ? total : {};
  throw new Error(
    "The stress report's selection removals are not split by track and its runs span tracks: merge it again",
  );
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
    /** This track's stress rows the attempt policy removed, by whole cohort or iteration, by reason. */
    selectionRemoved: trackRemovals(report, track),
    cpuSustained: cpuSustained({
      samples,
      seed: report.bootstrapSeed,
      plannedRuns: new Map(
        report.sources.flatMap((s) =>
          s.config.runs === undefined ? [] : [[s.runId, s.config.runs]],
        ),
      ),
    }),
    cpuBurst: sizes(cpu).map((k) => ({ k, providers: cpuBurst(cpu.filter((u) => u.k === k)) })),
    burstSurvival: sizes(survival).map((k) => ({
      k,
      providers: burstSurvival(survival.filter((u) => u.k === k)),
    })),
  };
}

export type StressData = ReturnType<typeof stressData>;
