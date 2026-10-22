import { describe, it, expect } from "vitest";
import { roundRobin, schedule } from "../src/scheduler.js";
import { distribution, wilson, shuffle } from "../src/v2-stats.js";
import { estimateCost, priceAtSize, settledBudgetUSD } from "../src/pricing.js";
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
  it("prices an unfingerprinted iteration by duration instead of leaving it unknown", () => {
    const observed = { cpu: 2, memoryGiB: 4, diskGiB: 20 };
    expect(settledBudgetUSD("tenki", 30_000, null, null)).toBeGreaterThan(0);
    expect(settledBudgetUSD("tenki", 30_000, null, observed)).toBe(settledBudgetUSD("tenki", 30_000, observed, null));
    expect(settledBudgetUSD("tenki", 30_000, null, null)!).toBeGreaterThan(settledBudgetUSD("tenki", 30_000, observed, null)!);
    expect(settledBudgetUSD("not-a-provider", 30_000, null, null)).toBeNull();
  });
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
    nproc: 64,
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

describe("Upstash Box PAYG size pricing", () => {
  it.each([
    [2, 4, 0.10], [4, 8, 0.20], [8, 16, 0.40],
  ])("prices %i vCPU / %i GiB as one box, not per vCPU", (cpu, memoryGiB, hourly) => {
    expect(estimateCost("upstash", 3600000, { cpu, memoryGiB, diskGiB: 0 })).toBeCloseTo(hourly);
  });
  it("accepts kernel-visible memory below the tier allocation", () => {
    expect(estimateCost("upstash", 3600000, { cpu: 2, memoryGiB: 3.8, diskGiB: 0 })).toBeCloseTo(0.10);
  });
  it("does not invent a price for an unknown size", () => {
    expect(estimateCost("upstash", 3600000, { cpu: 3, memoryGiB: 6, diskGiB: 0 })).toBeNull();
  });
});

describe("published compute-only size comparisons", () => {
  it.each([
    ["e2b", 0.3312], ["daytona", 0.3312], ["upstash", 0.20],
    ["boat", 0.036], ["freestyle", 0.26448], ["tenki", 0.3312], ["superserve", 0.3312],
  ])("prices an offered 4 vCPU / 8 GiB %s machine without storage", (provider, hourly) => {
    expect(priceAtSize(provider, { cpu: 4, memoryGiB: 8 })).toBeCloseTo(hourly);
  });
  it("leaves boxd's unlisted 4 vCPU / 8 GiB shape unpriced", () => {
    expect(priceAtSize("boxd", { cpu: 4, memoryGiB: 8 })).toBeNull();
    expect(priceAtSize("boxd", { cpu: 4, memoryGiB: 16 })).toBeCloseTo(0.348);
  });
  it("does not interpolate between Upstash tiers or Boat sizes", () => {
    expect(priceAtSize("upstash", { cpu: 4, memoryGiB: 4 })).toBeNull();
    expect(priceAtSize("boat", { cpu: 3, memoryGiB: 6 })).toBeNull();
  });
});

it("parses repeatable allocation flags and rejects malformed requests", async () => {
  const { parseV2 } = await import("../src/v2-config.js");
  const config = parseV2(["--track", "same-spec", "--size", "upstash=medium", "--size", "boxd=4:16384", "--size", "tenki=4:8192:5", "--template", "e2b=id", "--template", "daytona=daytona-large"]);
  expect(config).toMatchObject({track: "same-spec", size: {upstash: "medium", boxd: {cpu: 4, memoryMb: 16384}, tenki: {cpu: 4, memoryMb: 8192, diskGb: 5}}, template: {e2b: "id", daytona: "daytona-large"}});
  expect(parseV2([]).track).toBe("default");
  for (const value of ["x=4:0", "x=4:8192:0", "x=4:8192:5:6", "x=huge", "x=4:", "=medium"])
    expect(() => parseV2(["--size", value])).toThrow();
  expect(() => parseV2(["--track", "mixed"])).toThrow();
});

it("maps template flags to native factory options", async () => {
  const { loadProvider } = await import("../src/providers.js");
  const { memory } = await import("@opencoredev/sandbox-sdk/memory");
  for (const [name, key] of [["e2b", "template"], ["daytona", "snapshot"], ["freestyle", "snapshotId"], ["tenki", "image"], ["superserve", "template"]]) {
    if (!name || !key) throw new Error("Missing test mapping");
    const seen: unknown[] = [];
    const env = {E2B_API_KEY: "fixture", DAYTONA_API_KEY: "fixture", FREESTYLE_API_KEY: "fixture", TENKI_API_KEY: "fixture", SUPERSERVE_API_KEY: "fixture"};
    await loadProvider(name, env, async () => ({[name]: (options: unknown) => {seen.push(options); return memory();}}), {template: {[name]: "requested"}});
    expect(seen).toEqual([{[key]: "requested"}]);
  }
});
