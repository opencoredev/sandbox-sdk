import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { cpuResult, lcgChecksum, segmentConsistency, throughputSpread } from "../src/cpu.js";

const probePath = new URL("../probes/cpu.py", import.meta.url);
const at = 1_800_000_000;

/** One phase whose segment rates, timer and wall clock agree. */
function phase(steps: number, rates: number[], checksum: number, startedAt: number) {
  const seconds = rates.reduce((sum, r) => sum + steps / r, 0);

  return { checksum, seconds, rates, startedAt, endedAt: startedAt + seconds };
}

/** A probe output for `segments` x `steps` from `seed`, with every process reporting `checksum`. */
function output({
  seed = 7,
  segments = 4,
  steps = 10,
  workers = 2,
  checksum = lcgChecksum(seed, segments * steps),
  rates = Array.from({ length: segments }, () => 1000),
} = {}) {
  const single = phase(steps, rates, checksum, at);
  const start = single.endedAt;
  const worker = phase(steps, rates, checksum, start);
  const wallSeconds = worker.seconds * 1.25;

  return JSON.stringify({
    seed,
    segments,
    steps,
    single,
    all: {
      workers: Array.from({ length: workers }, () => worker),
      wallSeconds,
      startedAt: start,
      endedAt: start + wallSeconds,
    },
    cpus: { visible: 8, affinity: 4, quota: 2.5 },
    python: "3.12.3",
  });
}

const challenge = { work: { segments: 4, steps: 10 }, seed: 7, workers: 2 };

describe("CPU probe checksum", () => {
  it("matches the final LCG states CPython printed for perf.py's seed", () => {
    // From `python3 probes/cpu.py` on this kernel from seed 123456789: 2 x 1e6 and 4 x 1e7 steps.
    expect(lcgChecksum(123456789, 2_000_000)).toBe(750095765);
    expect(lcgChecksum(123456789, 40_000_000)).toBe(1127012117);
  });

  it("uses perf.py's kernel, so its rates compare with cpu-single and cpu-all", async () => {
    const perf = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
    const cpu = await readFile(probePath, "utf8");
    const kernel = "x=(1664525*x+1013904223)&0xffffffff";

    expect(perf).toContain(kernel);
    expect(cpu).toContain(kernel);
  });
});

describe("cpuResult", () => {
  it("computes throughput, consistency and guest CPUs from verified output", () => {
    const result = cpuResult(output({ rates: [1000, 1000, 500, 500] }), challenge, 10);

    // 40 steps in 0.06 s on one process; 2 x 40 steps in 0.075 s across both workers.
    expect(result.singleOpsPerSecond).toBeCloseTo(40 / 0.06);
    expect(result.allOpsPerSecond).toBeCloseTo(80 / 0.075);
    expect(result.single).toEqual({ minOverMedian: 500 / 750, lastOverFirst: 0.5 });
    expect(result.all.lastOverFirst).toBe(0.5);
    // Affinity 4, cgroup quota 2.5: the guest can use 2.5 CPUs.
    expect(result.guestVcpus).toBe(2.5);
  });

  it("fails a run whose checksum proves it skipped work", () => {
    expect(() => cpuResult(output({ checksum: 12345 }), challenge, 10)).toThrow(
      "checksum 12345 differs",
    );
  });

  it("fails output for different work, seed or worker count", () => {
    expect(() => cpuResult(output({ segments: 3 }), challenge, 10)).toThrow("not 4x10");
    expect(() => cpuResult(output({ workers: 1 }), challenge, 10)).toThrow("1 workers, not 2");
    expect(() => cpuResult(output({ rates: [1000, 1000] }), challenge, 10)).toThrow(
      "timed 2 segments",
    );
    expect(() => cpuResult(output({ seed: 8 }), challenge, 10)).toThrow("seed 8, not 7");
  });

  it("verifies the real probe's output end to end", async () => {
    const seed = 0xdeadbeef;
    const started = performance.now();

    const run = spawnSync(
      "python3",
      ["-I", probePath.pathname, "run", "3", "200000", "2", `${seed}`],
      {
        encoding: "utf8",
        timeout: 60_000,
      },
    );

    const hostSeconds = (performance.now() - started) / 1000;

    expect(run.status, run.stderr).toBe(0);

    const result = cpuResult(
      run.stdout,
      { work: { segments: 3, steps: 200_000 }, seed, workers: 2 },
      hostSeconds,
    );

    expect(result.workers).toBe(2);
    expect(result.probe.all.workers).toHaveLength(2);
    expect(result.singleOpsPerSecond).toBeGreaterThan(0);
  });

  it("prints the guest clock for staging", () => {
    const run = spawnSync("python3", ["-I", probePath.pathname, "clock"], { encoding: "utf8" });

    expect(Math.abs(Number(run.stdout) * 1000 - Date.now())).toBeLessThan(5000);
  });
});

describe("segmentConsistency", () => {
  it("reports the slowest segment over the median, and the last quarter over the first", () => {
    expect(segmentConsistency([10, 10, 10, 10, 5, 5, 5, 5])).toEqual({
      minOverMedian: 5 / 7.5,
      lastOverFirst: 0.5,
    });
    expect(segmentConsistency([4, 8])).toEqual({ minOverMedian: 4 / 6, lastOverFirst: 2 });
    expect(segmentConsistency([7])).toEqual({ minOverMedian: 1, lastOverFirst: null });
  });
});

describe("throughputSpread", () => {
  it("reports nearest-rank percentiles, fastest over slowest and the CV", () => {
    expect(throughputSpread([4, 1, 2, 3])).toEqual({
      n: 4,
      p50: 2,
      p95: 4,
      min: 1,
      max: 4,
      mean: 2.5,
      maxOverMin: 4,
      // Population SD sqrt(1.25) over mean 2.5.
      cv: Math.sqrt(1.25) / 2.5,
    });
  });

  it("is empty, never NaN, without values", () => {
    expect(throughputSpread([])).toEqual({
      n: 0,
      p50: null,
      p95: null,
      min: null,
      max: null,
      mean: null,
      maxOverMin: null,
      cv: null,
    });
  });
});
