import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { cpuResult, lcgChecksum, steadiness, throughputSpread } from "../src/cpu.js";

const probePath = new URL("../probes/cpu.py", import.meta.url);

/** A probe output for `segments` x `steps`, with every process reporting `checksum`. */
function output({
  segments = 4,
  steps = 10,
  workers = 2,
  checksum = lcgChecksum(segments * steps),
  rates = Array.from({ length: segments }, () => 1000),
} = {}) {
  const run = { checksum, seconds: 0.5, rates };

  return JSON.stringify({
    segments,
    steps,
    single: { ...run, seconds: 0.04 },
    all: { workers: Array.from({ length: workers }, () => run), wallSeconds: 0.1 },
    cpus: { visible: 8, affinity: 4, quota: 2.5 },
    python: "3.12.3",
  });
}

describe("CPU probe checksum", () => {
  it("matches the final LCG states CPython printed for the same seed", () => {
    // From `python3 probes/cpu.py` on this kernel: 2 x 1e6 and 4 x 1e7 steps.
    expect(lcgChecksum(2_000_000)).toBe(750095765);
    expect(lcgChecksum(40_000_000)).toBe(1127012117);
  });

  it("uses perf.py's kernel and seed, so its rates compare with cpu-single and cpu-all", async () => {
    const perf = await readFile(new URL("../probes/perf.py", import.meta.url), "utf8");
    const cpu = await readFile(probePath, "utf8");
    const kernel = "x=(1664525*x+1013904223)&0xffffffff";

    expect(perf).toContain(kernel);
    expect(cpu).toContain(kernel);
    expect(perf).toContain("x=123456789");
    expect(cpu).toContain("SEED=123456789");
  });
});

describe("cpuResult", () => {
  it("computes throughput, steadiness and guest CPUs from verified output", () => {
    const result = cpuResult(
      output({ rates: [1000, 1000, 500, 500] }),
      { segments: 4, steps: 10 },
      2,
    );

    // 40 steps in 0.04 s on one process; 2 x 40 steps in 0.1 s across both workers.
    expect(result.singleOpsPerSecond).toBeCloseTo(1000);
    expect(result.allOpsPerSecond).toBeCloseTo(800);
    expect(result.singleSteadiness).toBe(0.5);
    expect(result.allSteadiness).toBe(0.5);
    // Affinity 4, cgroup quota 2.5: the guest can use 2.5 CPUs.
    expect(result.guestVcpus).toBe(2.5);
  });

  it("fails a run whose checksum proves it skipped work", () => {
    expect(() => cpuResult(output({ checksum: 12345 }), { segments: 4, steps: 10 }, 2)).toThrow(
      "checksum 12345 differs",
    );
  });

  it("fails output for different work or a different worker count", () => {
    expect(() => cpuResult(output({ segments: 3 }), { segments: 4, steps: 10 }, 2)).toThrow(
      "not 4x10",
    );
    expect(() => cpuResult(output({ workers: 1 }), { segments: 4, steps: 10 }, 2)).toThrow(
      "1 workers, not 2",
    );
    expect(() => cpuResult(output({ rates: [1000, 1000] }), { segments: 4, steps: 10 }, 2)).toThrow(
      "timed 2 segments",
    );
  });

  it("verifies the real probe's output end to end", async () => {
    // Piped into python3 on stdin, as the harness sends it to the guest.
    const run = spawnSync("python3", ["-I", "-"], {
      input: await readFile(probePath, "utf8"),
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, BENCH_CPU_SEGMENTS: "3", BENCH_CPU_STEPS: "200000", BENCH_CORES: "2" },
    });

    expect(run.status, run.stderr).toBe(0);
    const result = cpuResult(run.stdout, { segments: 3, steps: 200_000 }, 2);

    expect(result.workers).toBe(2);
    expect(result.probe.all.workers).toHaveLength(2);
    expect(result.singleOpsPerSecond).toBeGreaterThan(0);
  });
});

describe("steadiness", () => {
  it("divides the last quarter's mean rate by the first quarter's", () => {
    expect(steadiness([10, 10, 10, 10, 5, 5, 5, 5])).toBe(0.5);
    expect(steadiness([4, 8])).toBe(2);
    expect(steadiness([7])).toBeNull();
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
