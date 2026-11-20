import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { statistics } from "./stats.js";
import { command } from "./workloads.js";

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
  python: z.string(),
});

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
  const probe = cpuProbeSchema.parse(JSON.parse(output));

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
  /** Guest clock minus host clock, estimated from one round trip. */
  clockOffsetMs: number;
  /** Half that round trip: the offset is right to within this. */
  clockUncertaintyMs: number;
}

/**
 * Stage a probe run: write probes/cpu.py into the guest and read the guest clock once, so the
 * only thing left after a cohort's common start is dispatching one short command.
 */
/** One read of the guest clock: its offset from the host's, right to within half the round trip. */
async function readGuestClock(box: Sandbox, path: string, timeoutMs: number, signal?: AbortSignal) {
  const before = hostEpochMs();
  const reply = await command(box, `python3 ${path} clock`, timeoutMs, signal);
  const after = hostEpochMs();
  const guestMs = Number(reply) * 1000;

  if (!Number.isFinite(guestMs) || guestMs <= 0)
    throw new Error(`CPU probe clock reply is not a time: ${JSON.stringify(reply.slice(0, 80))}`);

  return { offsetMs: guestMs - (before + after) / 2, uncertaintyMs: (after - before) / 2 };
}

const probePath = (challenge: CpuChallenge) => `/tmp/bench-cpu-${challenge.seed.toString(16)}.py`;

export async function stageCpuProbe(
  box: Sandbox,
  challenge: CpuChallenge,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<StagedCpuProbe> {
  const script = await readFile(new URL("../probes/cpu.py", import.meta.url), "utf8");
  const path = probePath(challenge);
  await box.files.write(path, script);
  const clock = await readGuestClock(box, path, timeoutMs, signal);
  const { work, workers, seed } = challenge;

  return {
    challenge,
    command: `python3 ${path} run ${work.segments} ${work.steps} ${workers} ${seed}`,
    clockOffsetMs: clock.offsetMs,
    clockUncertaintyMs: clock.uncertaintyMs,
  };
}

/** Slack for the guest's timestamp resolution when comparing its clock with the host's. */
const clockResolutionMs = 2;

/** A [start, end] interval in host epoch milliseconds. */
export type Interval = readonly [number, number];

/**
 * The largest change in a guest clock's offset, between the reads before and after a probe run,
 * that a cohort may show and still be published. A larger change means the guest clock stepped
 * or drifted during the run: where its phases really fell on the host clock is unknown, so the
 * cohort is excluded as clock-unstable rather than modelled.
 */
export const clockStepToleranceMs = 20;

/**
 * Run a staged probe. `returnedAt` (`performance.now()`) is taken as soon as the exec returns,
 * before any checks or report writes; `guest` holds each phase's interval on the host clock,
 * placed with the offset read at staging.
 *
 * The guest clock is read again after the run. `clockDriftMs` is the offset change between the
 * two reads; publication refuses a cohort where it exceeds `clockStepToleranceMs`.
 * `clockUncertaintyMs` bounds the staged offset's error during the run by that change plus both
 * reads' own uncertainty, and the run is refused when its phases fall outside the exec even then.
 */
export async function runStagedCpuProbe(
  box: Sandbox,
  staged: StagedCpuProbe,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  const dispatchedAt = performance.now();
  const dispatchedEpoch = hostEpochMs();
  const output = await command(box, staged.command, timeoutMs, signal);
  const returnedAt = performance.now();

  if (signal?.aborted) throw new Error("CPU probe aborted");
  const result = cpuResult(output, staged.challenge, (returnedAt - dispatchedAt) / 1000);
  const after = await readGuestClock(box, probePath(staged.challenge), timeoutMs, signal);

  const onHost = (run: { startedAt: number; endedAt: number }): Interval => [
    run.startedAt * 1000 - staged.clockOffsetMs,
    run.endedAt * 1000 - staged.clockOffsetMs,
  ];

  const guest = { single: onHost(result.probe.single), all: onHost(result.probe.all) };
  const returnedEpoch = dispatchedEpoch + (returnedAt - dispatchedAt);
  const drift = after.offsetMs - staged.clockOffsetMs;

  const uncertainty =
    Math.abs(drift) + staged.clockUncertaintyMs + after.uncertaintyMs + clockResolutionMs;

  if (guest.single[0] < dispatchedEpoch - uncertainty || guest.all[1] > returnedEpoch + uncertainty)
    throw new Error("CPU probe timing is inconsistent: guest phases fall outside the exec");

  return { result, returnedAt, guest, clockUncertaintyMs: uncertainty, clockDriftMs: drift };
}

/** A cohort's CPU phases count as run together when all members overlap this share of a phase. */
export const overlapThreshold = 0.8;

/**
 * How closely a cohort's members ran each phase together, on the host clock: the spread of their
 * start times, and the share of a typical (median) phase during which every member was running
 * it. The worst case narrows the common interval by each side's clock uncertainty; `ok` needs
 * the worst case at or above `overlapThreshold` for both phases.
 */
export function cpuOverlap(
  members: readonly { single: Interval; all: Interval }[],
  clockUncertaintyMs: number,
) {
  const phase = (intervals: readonly Interval[]) => {
    const starts = intervals.map(([s]) => s);
    const ends = intervals.map(([, e]) => e);
    const typical = median(intervals.map(([s, e]) => e - s)) ?? 0;
    const common = Math.min(...ends) - Math.max(...starts);

    const share = (ms: number) => (typical > 0 ? Math.max(0, ms) / typical : 0);
    const worst = share(common - 2 * clockUncertaintyMs);

    return {
      startSkewMs: Math.round(Math.max(...starts) - Math.min(...starts)),
      allRunningFraction: Number(share(common).toFixed(3)),
      worstCaseFraction: Number(worst.toFixed(3)),
      // Compared before rounding, so 0.7996 is below a 0.8 cutoff.
      ok: worst >= overlapThreshold,
    };
  };

  const single = phase(members.map((m) => m.single));
  const all = phase(members.map((m) => m.all));

  return {
    single,
    all,
    clockUncertaintyMs: Math.round(clockUncertaintyMs),
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
