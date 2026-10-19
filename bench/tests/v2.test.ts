import { describe, it, expect } from "vitest";
import { roundRobin, schedule } from "../src/scheduler.js";
import { distribution, wilson, shuffle } from "../src/v2-stats.js";
import { estimateCost } from "../src/pricing.js";
import { parseFingerprint, resources } from "../src/fingerprint.js";
import { parseV2 } from "../src/v2-config.js";
describe("v2 scheduling", () => {
  it("interleaves providers by iteration and respects both concurrency limits", async () => {
    const jobs = roundRobin(["a", "b"], 3);
    expect(jobs.map((j) => j.provider)).toEqual(["a", "b", "a", "b", "a", "b"]);
    let global = 0,
      peak = 0;
    const counts = new Map<string, number>();
    await schedule(jobs, { global: 2, perProvider: 1 }, async (j) => {
      global++;
      peak = Math.max(peak, global);
      counts.set(j.provider, (counts.get(j.provider) ?? 0) + 1);
      expect(counts.get(j.provider)).toBe(1);
      await new Promise((r) => setTimeout(r, 2));
      counts.set(j.provider, 0);
      global--;
    });
    expect(peak).toBe(2);
    expect(global).toBe(0);
  });
  it("reproduces seeded order and validates budgets", () => {
    expect(shuffle([1, 2, 3, 4, 5], 45)).toEqual(shuffle([1, 2, 3, 4, 5], 45));
    expect(shuffle([1, 2, 3, 4, 5], 45)).not.toEqual(shuffle([1, 2, 3, 4, 5], 46));
    expect(parseV2(["--provider-max-dollars", "boat=1.5"])["provider-max-dollars"]).toEqual({
      boat: 1.5,
    });
    expect(() => parseV2(["--max-dollars", "-1"])).toThrow();
  });
});
describe("v2 statistics and cost", () => {
  it("retains tails and computes population stddev and deterministic CIs", () => {
    const s = distribution([1, 2, 3, 4, 5]);
    expect(s.mean).toBe(3);
    expect(s.p50).toBe(3);
    expect(s.p99).toBe(5);
    expect(s.stddev).toBeCloseTo(Math.sqrt(2));
    expect(s.p50CI).toEqual({ low: 1, high: 5 });
    expect(distribution([]).meanCI).toBeNull();
    expect(distribution([1, 2, 3, 4, 5])).toEqual(s);
    expect(() => distribution([NaN])).toThrow();
  });
  it("uses Wilson intervals with failures in denominator", () => {
    const ci = wilson(0, 10);
    expect(ci?.rate).toBe(0);
    expect(ci?.high).toBeCloseTo(0.27753, 4);
    expect(wilson(10, 10)?.low).toBeCloseTo(0.72247, 4);
    expect(wilson(0, 0)).toBeNull();
  });
  it("converts hourly rates, rounds seconds, excludes included disk and preserves unknown cost", () => {
    expect(estimateCost("daytona", 3600000, { cpu: 2, memoryGiB: 4, diskGiB: 5 })).toBeCloseTo(
      0.1656,
    );
    expect(estimateCost("e2b", 1001, { cpu: 2, memoryGiB: 4, diskGiB: 10 })).toBeCloseTo(0.000092);
    expect(estimateCost("boat", 3600000, null)).toBeCloseTo(0.036);
    expect(estimateCost("e2b", 1000, null)).toBeNull();
    expect(estimateCost("local", 10000, null)).toBe(0);
    expect(estimateCost("unknown", 1000, null)).toBeNull();
  });
});
describe("fingerprint boundary", () => {
  const sample = {
    cpuModel: "Test CPU",
    flags: ["hypervisor"],
    nproc: 32,
    cpuMax: "200000 100000",
    quotaCpus: 2,
    memoryMax: "1073741824",
    memTotalBytes: 32 * 1024 ** 3,
    memoryBytes: 1024 ** 3,
    diskBytes: 10 * 1024 ** 3,
    df: "overlay",
    lsblk: "",
    virtualization: "kvm",
    hypervisor: true,
    dmi: "",
    kernel: "Linux",
    distro: "test",
    user: "user",
    uid: 1000,
    sudo: false,
    stealPercent: 0,
    egress: null,
    tools: { python3: "/usr/bin/python3" },
    runtime: "Python 3.12",
  };
  it("distinguishes visible host resources from cgroup allocation", () => {
    expect(resources(parseFingerprint(JSON.stringify(sample)))).toEqual({
      cpu: 2,
      memoryGiB: 1,
      diskGiB: 10,
    });
    expect(() => parseFingerprint(JSON.stringify({ ...sample, quotaCpus: "unlimited" }))).toThrow();
    expect(() => parseFingerprint("{}")).toThrow();
  });
});
