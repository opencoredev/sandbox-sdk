import { z } from "zod";
import { statistics } from "./stats.js";

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

/** The probe's LCG seed, the same as perf.py's. */
const seed = 123456789;

const checksums = new Map<number, number>();

/** The LCG state after `steps` steps from the probe's seed, computed here, independent of the guest. */
export function lcgChecksum(steps: number): number {
  const known = checksums.get(steps);

  if (known !== undefined) return known;
  let x = seed;

  for (let i = 0; i < steps; i++) x = (Math.imul(1664525, x) + 1013904223) >>> 0;
  checksums.set(steps, x);

  return x;
}

const rate = z.number().positive().finite();

const runSchema = z.object({
  checksum: z.number().int().nonnegative(),
  seconds: rate,
  rates: z.array(rate).min(1),
});

export const cpuProbeSchema = z.object({
  segments: z.number().int().positive(),
  steps: z.number().int().positive(),
  single: runSchema,
  all: z.object({ workers: z.array(runSchema).min(1), wallSeconds: rate }),
  cpus: z.object({
    visible: z.number().int().positive().nullable(),
    affinity: z.number().int().positive(),
    quota: z.number().positive().finite().nullable(),
  }),
  python: z.string(),
});

export type CpuProbe = z.infer<typeof cpuProbeSchema>;

/** Mean rate of the last quarter of segments over the first quarter. Below 1, the guest slowed down. */
export function steadiness(rates: readonly number[]): number | null {
  const q = Math.max(1, Math.floor(rates.length / 4));

  if (rates.length < 2) return null;
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  return mean(rates.slice(-q)) / mean(rates.slice(0, q));
}

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
  singleSteadiness: number | null;
  allSteadiness: number | null;
  workers: number;
  /** CPUs the guest can use: its affinity set, capped by a cgroup quota when one is set. */
  guestVcpus: number;
}

/**
 * Parse the probe's JSON and check it did exactly the requested work: the same segments, steps and
 * worker count, and every process's final LCG state equal to the harness's own. Throws otherwise.
 */
export function cpuResult(output: string, work: CpuWork, workers: number): CpuResult {
  const probe = cpuProbeSchema.parse(JSON.parse(output));

  if (probe.segments !== work.segments || probe.steps !== work.steps)
    throw new Error(
      `CPU probe ran ${probe.segments}x${probe.steps} steps, not ${work.segments}x${work.steps}`,
    );

  if (probe.all.workers.length !== workers)
    throw new Error(`CPU probe ran ${probe.all.workers.length} workers, not ${workers}`);
  const expected = lcgChecksum(work.segments * work.steps);

  for (const run of [probe.single, ...probe.all.workers]) {
    if (run.rates.length !== work.segments)
      throw new Error(`CPU probe timed ${run.rates.length} segments, not ${work.segments}`);

    if (run.checksum !== expected)
      throw new Error(`CPU probe checksum ${run.checksum} differs from ${expected}`);
  }

  const total = work.segments * work.steps;

  return {
    probe,
    singleOpsPerSecond: total / probe.single.seconds,
    allOpsPerSecond: (total * workers) / probe.all.wallSeconds,
    singleSeconds: probe.single.seconds,
    allSeconds: probe.all.wallSeconds,
    singleSteadiness: steadiness(probe.single.rates),
    allSteadiness: steadiness(combinedRates(probe.all.workers)),
    workers,
    guestVcpus: Math.min(probe.cpus.affinity, probe.cpus.quota ?? Infinity),
  };
}

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
