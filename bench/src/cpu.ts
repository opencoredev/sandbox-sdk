import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { statistics } from "./stats.js";
import { deadline, DeadlineError } from "./timing.js";
import { probeCommand } from "./workloads.js";

/**
 * Fixed work for the CPU probe (probes/cpu.py): `segments` runs of `steps` iterations of the same
 * 32-bit LCG kernel perf.py's cpu-single and cpu-all use, so the rates are directly comparable.
 */
export interface CpuWork {
  segments: number;
  steps: number;
}

/**
 * cpu-sustained: 200 M steps per process, about 10-25 s per phase on the CPUs published so far
 * (9-20 M steps/s), long enough to show quota throttling and steal as a falling rate.
 * cpu-burst: 40 M steps per process, a few seconds, run by every cohort member together.
 */
export const cpuWork = {
  sustained: { segments: 20, steps: 10_000_000 },
  burst: { segments: 4, steps: 10_000_000 },
} as const satisfies Record<string, CpuWork>;

/**
 * One probe run's challenge: the work, the worker count, and a fresh seed the guest must start
 * its LCG from, so a reply recorded on an earlier run carries the wrong checksum.
 */
export interface CpuChallenge {
  work: CpuWork;
  seed: number;
  workers: number;
}

/** A fresh 32-bit seed for one probe run. */
export function newCpuSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
}

const multiplier = 1664525;
const increment = 1013904223;

/**
 * The LCG state after `steps` steps from `seed`. The step x -> a*x + c (mod 2^32) is composed with
 * itself by repeated squaring, so this takes O(log steps) time. The same shortcut is open to a
 * guest, which is why the checksum proves the right answer, not that the work ran.
 */
export function lcgChecksum(seed: number, steps: number): number {
  let a = 1,
    c = 0,
    stepA = multiplier,
    stepC = increment;

  for (let n = steps; n > 0; n = Math.floor(n / 2)) {
    if (n % 2 === 1) {
      a = Math.imul(stepA, a) >>> 0;
      c = (Math.imul(stepA, c) + stepC) >>> 0;
    }

    stepC = (Math.imul(stepA, stepC) + stepC) >>> 0;
    stepA = Math.imul(stepA, stepA) >>> 0;
  }

  return (Math.imul(a, seed) + c) >>> 0;
}

/**
 * The fastest rate any process may claim, in LCG steps per second. CPython runs this kernel at
 * 9-30 M steps/s on current CPUs; anything above this bound is not a CPython guest doing the work.
 */
export const maxStepsPerSecond = 1e9;

const rate = z.number().positive().finite();
const epochSeconds = z.number().positive().finite();

const runSchema = z.object({
  checksum: z.number().int().nonnegative(),
  seconds: rate,
  rates: z.array(rate).min(1),
  /** Guest wall clock (epoch seconds) at the phase's start and end. */
  startedAt: epochSeconds,
  endedAt: epochSeconds,
});

export const cpuProbeSchema = z.object({
  seed: z.number().int().nonnegative(),
  segments: z.number().int().positive(),
  steps: z.number().int().positive(),
  single: runSchema,
  all: z.object({
    workers: z.array(runSchema).min(1),
    wallSeconds: rate,
    startedAt: epochSeconds,
    endedAt: epochSeconds,
  }),
  cpus: z.object({
    visible: z.number().int().positive().nullable(),
    affinity: z.number().int().positive(),
    quota: z.number().positive().finite().nullable(),
  }),
  /** `platform.python_version()`, such as 3.12.3 or 3.14.0rc1: nothing else is kept. */
  python: z.string().regex(/^\d{1,2}\.\d{1,3}\.\d{1,3}(?:(?:a|b|rc)\d{1,2})?\+?$/),
});

/** The longest probe reply parsed: its JSON is about 1 KiB per worker, so this fits 256 CPUs. */
export const maxProbeOutputChars = 256 * 1024;

export type CpuProbe = z.infer<typeof cpuProbeSchema>;

function median(xs: readonly number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (!sorted.length) return null;

  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * How even a phase's segment rates were. `minOverMedian` is the slowest segment over the median
 * one: 1 means every segment ran at the typical rate, and one stalled segment pulls it down
 * wherever it falls. `lastOverFirst` is the mean rate of the last quarter of segments over the
 * first quarter: below 1, the guest slowed down by the end (quota throttling, steal).
 */
export function segmentConsistency(rates: readonly number[]) {
  const mid = median(rates);
  const q = Math.max(1, Math.floor(rates.length / 4));
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return {
    minOverMedian: mid === null || mid <= 0 ? null : Math.min(...rates) / mid,
    lastOverFirst: rates.length < 2 ? null : mean(rates.slice(-q)) / mean(rates.slice(0, q)),
  };
}

export type SegmentConsistency = ReturnType<typeof segmentConsistency>;

/** Per-segment rates summed across the all-core workers, which start together and do equal work. */
function combinedRates(workers: CpuProbe["all"]["workers"]) {
  const length = Math.min(...workers.map((w) => w.rates.length));

  return Array.from({ length }, (_, i) => workers.reduce((sum, w) => sum + (w.rates[i] ?? 0), 0));
}

/** What one CPU probe measured, after its output passed every check. */
export interface CpuResult {
  probe: CpuProbe;
  /** Steps per second on one process. */
  singleOpsPerSecond: number;
  /** Steps per second across all workers, worker startup included (as perf.py's cpu-all). */
  allOpsPerSecond: number;
  singleSeconds: number;
  allSeconds: number;
  single: SegmentConsistency;
  all: SegmentConsistency;
  workers: number;
  /** CPUs the guest can use: its affinity set, capped by a cgroup quota when one is set. */
  guestVcpus: number;
}

/** Slack for comparing two clocks' readings of one interval: 10% plus a fixed margin. */
const close = (a: number, b: number, marginSeconds: number) =>
  Math.abs(a - b) <= 0.1 * Math.max(a, b) + marginSeconds;

/**
 * Check one phase's timings against each other: its segment durations must add up to its own
 * seconds, its wall-clock span must match them, and no rate may exceed what CPython can do.
 */
function checkRun(run: z.infer<typeof runSchema>, work: CpuWork, label: string) {
  const segmentSeconds = run.rates.reduce((sum, r) => sum + work.steps / r, 0);

  if (!close(segmentSeconds, run.seconds, 0.02))
    throw new Error(
      `CPU probe ${label} timing is inconsistent: its segments take ${segmentSeconds.toPrecision(3)} s, the phase ${run.seconds.toPrecision(3)} s`,
    );

  if (!close(run.endedAt - run.startedAt, run.seconds, 0.05))
    throw new Error(
      `CPU probe ${label} timing is inconsistent: wall clock ${(run.endedAt - run.startedAt).toPrecision(3)} s, timer ${run.seconds.toPrecision(3)} s`,
    );

  const fastest = Math.max(...run.rates, (work.segments * work.steps) / run.seconds);

  if (fastest > maxStepsPerSecond)
    throw new Error(
      `CPU probe ${label} claims a rate of ${fastest.toExponential(2)} steps/s, above the ${maxStepsPerSecond.toExponential(0)} steps/s any CPython process reaches`,
    );
}

/**
 * Parse the probe's JSON and check it did exactly the requested work: the same seed, segments,
 * steps and worker count; every process's final LCG state equal to the harness's own; phase,
 * segment and wall-clock timings that agree with each other; and phases that fit inside the
 * `hostSeconds` the exec took. Throws otherwise.
 *
 * These checks catch a wrong, stale or implausible reply. They cannot prove the guest executed
 * the work: the LCG has a closed form (see `lcgChecksum`), and a provider controls its guest and
 * its output, so a dishonest guest could compute the answer and report plausible timings.
 */
export function cpuResult(output: string, challenge: CpuChallenge, hostSeconds: number): CpuResult {
  const { work, workers, seed } = challenge;

  // Fixed messages only: a parser's message would copy guest text into the report.
  if (output.length > maxProbeOutputChars)
    throw new Error(`CPU probe output is longer than ${maxProbeOutputChars} characters`);
  let json: unknown;

  try {
    json = JSON.parse(output);
  } catch {
    throw new Error("CPU probe output is not JSON");
  }

  const parsed = cpuProbeSchema.safeParse(json);

  if (!parsed.success) throw new Error("CPU probe output does not match the probe's format");
  const probe = parsed.data;

  if (probe.seed !== seed) throw new Error(`CPU probe ran from seed ${probe.seed}, not ${seed}`);

  if (probe.segments !== work.segments || probe.steps !== work.steps)
    throw new Error(
      `CPU probe ran ${probe.segments}x${probe.steps} steps, not ${work.segments}x${work.steps}`,
    );

  if (probe.all.workers.length !== workers)
    throw new Error(`CPU probe ran ${probe.all.workers.length} workers, not ${workers}`);
  const expected = lcgChecksum(seed, work.segments * work.steps);

  for (const [index, run] of [probe.single, ...probe.all.workers].entries()) {
    const label = index === 0 ? "single" : `worker ${index}`;

    if (run.rates.length !== work.segments)
      throw new Error(`CPU probe timed ${run.rates.length} segments, not ${work.segments}`);

    if (run.checksum !== expected)
      throw new Error(`CPU probe checksum ${run.checksum} differs from ${expected}`);

    checkRun(run, work, label);
  }

  const { all } = probe;

  if (!close(all.endedAt - all.startedAt, all.wallSeconds, 0.05))
    throw new Error(
      `CPU probe all-core timing is inconsistent: wall clock ${(all.endedAt - all.startedAt).toPrecision(3)} s, timer ${all.wallSeconds.toPrecision(3)} s`,
    );

  // Workers and their phase read the same guest clock; allow the same margin as the spans above.
  for (const w of all.workers)
    if (
      w.seconds > all.wallSeconds * 1.05 + 0.02 ||
      w.startedAt < all.startedAt - 0.05 ||
      w.endedAt > all.endedAt + 0.05
    )
      throw new Error("CPU probe timing is inconsistent: a worker ran outside the all-core phase");

  // Each worker did the full work inside the phase, so the phase bounds every worker's rate too.
  const perWorker = (work.segments * work.steps) / all.wallSeconds;

  if (perWorker > maxStepsPerSecond)
    throw new Error(
      `CPU probe all-core phase claims a per-worker rate of ${perWorker.toExponential(2)} steps/s, above the ${maxStepsPerSecond.toExponential(0)} steps/s any CPython process reaches`,
    );

  if (probe.single.endedAt > all.startedAt + 0.05)
    throw new Error(
      "CPU probe timing is inconsistent: the all-core phase began before single ended",
    );

  const guestSeconds = probe.single.seconds + all.wallSeconds;

  if (guestSeconds > hostSeconds * 1.05 + 0.05)
    throw new Error(
      `CPU probe reports ${guestSeconds.toPrecision(3)} s of work, longer than the ${hostSeconds.toPrecision(3)} s the host saw the exec take`,
    );

  const total = work.segments * work.steps;

  return {
    probe,
    singleOpsPerSecond: total / probe.single.seconds,
    allOpsPerSecond: (total * workers) / all.wallSeconds,
    singleSeconds: probe.single.seconds,
    allSeconds: all.wallSeconds,
    single: segmentConsistency(probe.single.rates),
    all: segmentConsistency(combinedRates(all.workers)),
    workers,
    guestVcpus: Math.min(probe.cpus.affinity, probe.cpus.quota ?? Infinity),
  };
}

/** Milliseconds since the epoch on the host, at `performance.now()` resolution. */
export const hostEpochMs = () => performance.timeOrigin + performance.now();

/** A probe written to the guest, with the guest clock's offset from the host's, before it runs. */
export interface StagedCpuProbe {
  challenge: CpuChallenge;
  command: string;
  /** Guest clock minus host clock, estimated from one round trip. A diagnostic only. */
  clockOffsetMs: number;
}

/** One read of the guest clock: its offset from the host's, right to within half the round trip. */
async function readGuestClock(box: Sandbox, path: string, timeoutMs: number, signal?: AbortSignal) {
  const before = hostEpochMs();
  const reply = await probeCommand(box, `python3 ${path} clock`, timeoutMs, signal);
  const after = hostEpochMs();
  const guestMs = Number(reply) * 1000;

  if (!Number.isFinite(guestMs) || guestMs <= 0)
    throw new Error("CPU probe clock reply is not a time");

  return guestMs - (before + after) / 2;
}

const probePath = (challenge: CpuChallenge) => `/tmp/bench-cpu-${challenge.seed.toString(16)}.py`;

/**
 * Stage a probe run: write probes/cpu.py into the guest and read the guest clock once, so the
 * only thing left after a cohort's common start is dispatching one short command.
 */
export async function stageCpuProbe(
  box: Sandbox,
  challenge: CpuChallenge,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StagedCpuProbe> {
  const script = await readFile(new URL("../probes/cpu.py", import.meta.url), "utf8");
  const path = probePath(challenge);
  await box.files.write(path, script);
  const clockOffsetMs = await readGuestClock(box, path, timeoutMs, signal);
  const { work, workers, seed } = challenge;

  return {
    challenge,
    command: `python3 ${path} run ${work.segments} ${work.steps} ${workers} ${seed}`,
    clockOffsetMs,
  };
}

/** A [start, end] interval in host epoch milliseconds. */
export type Interval = readonly [number, number];

/** The longest the diagnostic clock read after a run may take. */
export const clockReadMs = 5_000;

/** How long before the step's end the diagnostic clock read must give up, to leave the step room. */
const clockReadMarginMs = 250;

/** Registers work that may outlive the wait on it, such as `PendingWork.track`. */
export type TrackWork = <T>(work: Promise<T>) => Promise<T>;

export interface RunStagedCpuProbeOptions {
  signal?: AbortSignal;
  /** `performance.now()` when the caller's step ends. */
  endBy?: number;
  /** Sees the diagnostic clock read's promise, which can outlive its deadline. */
  track?: TrackWork;
}

/** Why the clock read after a run gave no drift. Fixed reasons: a guest's reply is never copied. */
export type ClockDriftUnread = "no-time-left" | "timed-out" | "failed";

/**
 * The guest clock's drift since staging, read after a verified run: a diagnostic only, so it is
 * bounded to {@link clockReadMs} and to `endBy` (`performance.now()`, the step's deadline) less a
 * margin, and its failure is recorded, never thrown.
 */
async function clockDrift(
  box: Sandbox,
  staged: StagedCpuProbe,
  endBy: number,
  signal: AbortSignal | undefined,
  track: TrackWork,
): Promise<{ clockDriftMs: number | null; clockDriftUnread: ClockDriftUnread | null }> {
  const budget = Math.min(clockReadMs, endBy - clockReadMarginMs - performance.now());

  if (budget <= 0) return { clockDriftMs: null, clockDriftUnread: "no-time-left" };

  try {
    // The deadline only stops waiting: the read itself can still be running in the guest (the
    // SDK waits for the command to stop), so it is tracked on its own for cleanup to drain.
    const after = await deadline(budget, (own) =>
      track(
        readGuestClock(
          box,
          probePath(staged.challenge),
          budget,
          signal ? AbortSignal.any([signal, own]) : own,
        ),
      ),
    );

    return { clockDriftMs: after - staged.clockOffsetMs, clockDriftUnread: null };
  } catch (error) {
    return {
      clockDriftMs: null,
      clockDriftUnread: error instanceof DeadlineError ? "timed-out" : "failed",
    };
  }
}

/**
 * Run a staged probe. `returnedAt` (`performance.now()`) is taken as soon as the exec returns,
 * before any checks or report writes. `exec` is the exec on the host clock, from just before its
 * dispatch to its return: the guest ran both phases inside it, whatever its own clock says.
 *
 * The guest clock is read again after the run. `clockDriftMs`, the change in its offset from the
 * read at staging, is recorded as a diagnostic; nothing is placed or judged by the guest's clock.
 * A failed or late read leaves it null with the reason in `clockDriftUnread` and keeps the
 * verified result. `endBy` (`performance.now()`) is when the caller's step ends; it defaults to
 * `timeoutMs` after dispatch. `track` sees the clock read's own promise, so a read given up on
 * stays visible to the caller's cleanup until the guest command actually stops.
 */
export async function runStagedCpuProbe(
  box: Sandbox,
  staged: StagedCpuProbe,
  timeoutMs: number,
  { signal, endBy, track = (work) => work }: RunStagedCpuProbeOptions = {},
) {
  const dispatchedAt = performance.now();
  const dispatchedEpoch = hostEpochMs();
  const output = await probeCommand(box, staged.command, timeoutMs, signal, maxProbeOutputChars);
  const returnedAt = performance.now();

  if (signal?.aborted) throw new Error("CPU probe aborted");
  const result = cpuResult(output, staged.challenge, (returnedAt - dispatchedAt) / 1000);
  const exec: Interval = [dispatchedEpoch, dispatchedEpoch + (returnedAt - dispatchedAt)];
  const drift = await clockDrift(box, staged, endBy ?? dispatchedAt + timeoutMs, signal, track);

  return { result, returnedAt, exec, ...drift };
}

export type CpuRun = Awaited<ReturnType<typeof runStagedCpuProbe>>;

/** What a member's `cpu-single` or `cpu-all` row records about when its phase could have run. */
export function cpuPhaseEvidence(ran: CpuRun, phase: "single" | "all") {
  return {
    exec: ran.exec,
    seconds: phase === "single" ? ran.result.singleSeconds : ran.result.allSeconds,
    clockDriftMs: ran.clockDriftMs,
    clockDriftUnread: ran.clockDriftUnread,
  };
}

/** A cohort's CPU phases count as run together when all members provably overlap this share of a phase. */
export const overlapThreshold = 0.8;

/** One member's timing evidence: its exec on the host clock and its phases' guest timer lengths. */
export interface CpuMemberTiming {
  exec: Interval;
  singleSeconds: number;
  allSeconds: number;
}

/**
 * A proven lower bound on how long every member of a cohort ran each phase at the same time,
 * from the host clock and each guest's own monotonic phase timers, never a guest wall clock.
 *
 * Member i's exec ran from dispatch d to return r on the host clock, and it ran single (length
 * s) and then all-core (length a) inside it, in that order. So its single phase started no later
 * than r - a - s and ended no earlier than d + s; its all-core phase started no later than r - a
 * and ended no earlier than d + s + a. Every member was running a phase at least from the latest
 * of those latest starts to the earliest of those earliest ends, so that span (or zero) is the
 * proven overlap, however each guest's clock stepped. `provenFraction` divides it by the median
 * member's phase length; `ok` needs at least `overlapThreshold` for both phases.
 *
 * A member whose phases are longer than its exec has evidence that contradicts itself (its timer
 * ran fast, or the reply is wrong): the cohort is `inconsistent` and nothing is bounded.
 */
export function cpuOverlap(members: readonly CpuMemberTiming[]) {
  // Whole microseconds from the earliest dispatch. Epoch milliseconds lose precision in floating
  // point, and every rounding below goes the conservative way: a latest start rounds up, an
  // earliest end down, and a phase length up. So the bound can only shrink, never grow.
  const origin = Math.min(...members.map((m) => m.exec[0]));
  const us = (ms: number) => ms * 1000;

  const timings = members.map((m) => ({
    start: us(m.exec[0] - origin),
    end: us(m.exec[1] - origin),
    single: m.singleSeconds * 1e6,
    all: m.allSeconds * 1e6,
  }));

  if (timings.some((t) => t.single + t.all > t.end - t.start))
    return { kind: "inconsistent" as const, ok: false };

  const bound = (
    phase: readonly { latestStart: number; earliestEnd: number; length: number }[],
  ) => {
    const provenUs = Math.max(
      0,
      Math.min(...phase.map((p) => Math.floor(p.earliestEnd))) -
        Math.max(...phase.map((p) => Math.ceil(p.latestStart))),
    );

    const typicalUs = median(phase.map((p) => Math.ceil(p.length))) ?? 0;
    const fraction = typicalUs > 0 ? provenUs / typicalUs : 0;

    return {
      provenMs: Math.round(provenUs / 1000),
      provenFraction: Number(fraction.toFixed(3)),
      // Compared on whole microseconds before rounding, so 0.7996 is below a 0.8 cutoff.
      ok: typicalUs > 0 && provenUs >= overlapThreshold * typicalUs,
    };
  };

  const single = bound(
    timings.map((t) => ({
      latestStart: t.end - t.all - t.single,
      earliestEnd: t.start + t.single,
      length: t.single,
    })),
  );

  const all = bound(
    timings.map((t) => ({
      latestStart: t.end - t.all,
      earliestEnd: t.start + t.single + t.all,
      length: t.all,
    })),
  );

  const starts = timings.map((t) => t.start);

  return {
    kind: "bound" as const,
    single,
    all,
    /** How far apart the members' execs were dispatched, on the host clock. */
    dispatchSkewMs: Math.round((Math.max(...starts) - Math.min(...starts)) / 1000),
    threshold: overlapThreshold,
    ok: single.ok && all.ok,
  };
}

export type CpuOverlap = ReturnType<typeof cpuOverlap>;

/**
 * How far apart one cohort's members ran: nearest-rank percentiles of per-sandbox throughput,
 * the fastest over the slowest, and the coefficient of variation. Higher throughput is better, so
 * noisy neighbours and throttling show as a low `min` and a large `maxOverMin`.
 */
export function throughputSpread(values: readonly number[]) {
  const s = statistics(values);

  const cv =
    s.mean === null || s.mean === 0
      ? null
      : Math.sqrt(values.reduce((sum, v) => sum + (v - (s.mean ?? 0)) ** 2, 0) / values.length) /
        s.mean;

  return {
    n: s.count,
    p50: s.p50,
    p95: s.p95,
    min: s.min,
    max: s.max,
    mean: s.mean,
    maxOverMin: s.min === null || s.max === null || s.min <= 0 ? null : s.max / s.min,
    cv,
  };
}

export type ThroughputSpread = ReturnType<typeof throughputSpread>;
