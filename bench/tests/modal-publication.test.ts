import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { allocationEvidence } from "../src/allocation.js";
import type { Fingerprint } from "../src/fingerprint.js";
import { mergeSources, sampleSchema, type MergeSource } from "../src/merge.js";
import { estimateCost } from "../src/pricing.js";
import { projectCosts } from "../src/projection.js";
import {
  hourly,
  hourlyPrice,
  publicationMarkdown,
  publicationRegion,
} from "../src/publication-report.js";
import { siteData } from "../src/site-data.js";
import { costPerTask } from "../src/task-cost.js";
import { parseV2 } from "../src/v2-config.js";
import type { ReportV2, Sample } from "../src/v2-model.js";
import { runV2, summarize } from "../src/v2-runner.js";

const gib = 1024 ** 3;
const at = "2026-11-09T12:00:00.000Z";

/** A Modal default-track guest: one CPU and the host's whole memory. */
function hostFingerprint(hostGiB: number): Fingerprint {
  return {
    cpuModel: "unknown",
    flags: [],
    nproc: 1,
    cpuMax: "",
    quotaCpus: null,
    memoryMax: "",
    memTotalBytes: hostGiB * gib,
    memoryBytes: hostGiB * gib,
    diskBytes: 500 * gib,
    df: "",
    lsblk: "",
    virtualization: "",
    hypervisor: false,
    dmi: "",
    kernel: "4.19.0-gvisor",
    distro: "",
    user: "root",
    uid: 0,
    sudo: false,
    stealPercent: null,
    egress: null,
    tools: {},
    runtime: "",
  };
}

const host = {
  timestamp: at,
  load: [0, 0, 0],
  cpu: { user: 0, system: 0 },
  cpuTicks: [[1, 2, 3, 4, 5]],
  network: "",
};

function sample(scenario: string, value: number, extra: Partial<Sample> = {}): Sample {
  return {
    provider: "modal",
    iteration: 0,
    scenario,
    unit: "ms",
    startedAt: at,
    finishedAt: at,
    durationMs: value,
    sandboxId: "sb-1",
    outcome: { kind: "sample", value },
    phases: {},
    hostBefore: host,
    hostAfter: host,
    headroom: {
      normalizedLoad: 0,
      hostCpuBusy: 0,
      processCpuMs: 0,
      highLoad: false,
      rxBytesPerSecond: 0,
      txBytesPerSecond: 0,
    },
    fingerprint: null,
    estimatedCost: null,
    details: null,
    ...extra,
  };
}

function source(
  runId: string,
  region: string | null,
  samples: Sample[],
  scenarios = ["command"],
): MergeSource {
  return {
    schemaVersion: 2,
    runId,
    timestamp: at,
    finishedAt: at,
    config: { seed: 45, scenarios, bursts: [] },
    metadata: { harnessCommit: "h", sdkCommit: "s" },
    host: { cpu: "test", os: "linux", runtime: "node" },
    providers: [{ name: "modal", configuredRegion: region, note: "default" }],
    budgets: {},
    cleanup: [],
    methodology: [],
    pricing: { modal: { currency: "USD" } },
    samples: samples.map((s) => sampleSchema.parse(s)),
  };
}

const defaultTrack = (hostGiB: number) => [
  sample("fingerprint", 1000, { fingerprint: hostFingerprint(hostGiB) }),
  sample("cold", 500),
  sample("command", 100),
];

// The minimum request, 0.125 CPU and 0.125 GiB, at Sandbox list rates: $0.0207 per hour.
const minimumHour = (0.125 * 0.00003942 + 0.125 * 0.00000667) * 3600;

describe("Modal publication pricing", () => {
  it("prices the minimum request when a restore lands on a host with other memory, keeping the caveat", () => {
    // Source on a 1,024 GiB host, restore on a 203 GiB one: the guest views differ, the request does not.
    const samples = [
      ...defaultTrack(1024),
      sample("restore-fingerprint", 1000, { fingerprint: hostFingerprint(203), sandboxId: "sb-2" }),
    ];

    const evidence = allocationEvidence(samples, "modal");
    expect(evidence.mismatches).toContain("Restored allocation differs from source");
    expect(evidence.verified).toBe(false);
    expect(evidence.pricingAllocation).toEqual({ cpu: 0.125, memoryGiB: 0.125 });
    expect(evidence.pricingBound).toBe("lower");

    const report = mergeSources([source("modal-hosts", null, samples)]);
    expect(hourly(report, "modal")).toBeCloseTo(minimumHour, 6);
    expect(publicationMarkdown(report)).toMatch(/caveat: Restored allocation differs from source/);

    // A request that varies still leaves no price.
    const mixed = [
      ...defaultTrack(1024),
      sample("command", 100, { requestedSize: { cpu: 4, memoryMb: 8192 } }),
    ];

    expect(allocationEvidence(mixed, "modal").pricingAllocation).toBeNull();
  });

  it("prices the published sandbox-hour on the request, never the guest's 1 TiB, and labels it a lower bound", () => {
    const report = mergeSources([source("modal-1tib", null, defaultTrack(1024))]);

    // The guest view would publish $24.73 an hour.
    expect(hourly(report, "modal")).toBeCloseTo(minimumHour, 6);
    expect(hourlyPrice(report, "modal")).toMatchObject({ bound: "lower", multiplier: 1 });

    // Two hosts, one price.
    const other = mergeSources([source("modal-203", null, defaultTrack(203))]);
    expect(hourly(other, "modal")).toBeCloseTo(minimumHour, 6);

    const markdown = publicationMarkdown(report);
    expect(markdown).toContain("(lower bound)");
    // Operations per dollar at a lower-bound price are an upper bound.
    expect(markdown).toMatch(/≤ [\d,]+ \(upper bound\)/);
    expect(markdown).not.toContain("24.7");

    const site = siteData(report).providers.find((p) => p.id === "modal");
    expect(site).toMatchObject({ pricingBound: "lower", pricingRegion: null, regionMultiplier: 1 });
    expect(site?.hourly).toBeCloseTo(minimumHour, 6);
    expect(site?.pricingAllocation).toEqual({ cpu: 0.125, memoryGiB: 0.125 });
  });

  it("carries the source runs' region into every published price", () => {
    const report = mergeSources([source("modal-east", "us-east", defaultTrack(1024))]);
    expect(publicationRegion(report, "modal")).toBe("us-east");
    expect(hourly(report, "modal")).toBeCloseTo(minimumHour * 1.75, 6);

    const site = siteData(report).providers.find((p) => p.id === "modal");
    expect(site).toMatchObject({ pricingRegion: "us-east", regionMultiplier: 1.75 });
    expect(site?.commonHourly).toBeCloseTo((4 * 0.00003942 + 8 * 0.00000667) * 3600 * 1.75, 6);

    // Runs billed at different multipliers cannot share one published price.
    const mixed = mergeSources([
      source("modal-a", "us-east", defaultTrack(1024)),
      source("modal-b", null, defaultTrack(1024)),
    ]);

    expect(() => hourly(mixed, "modal")).toThrow(/different multipliers/);
  });

  it("includes the region in each run's performance per dollar", async () => {
    const row = sample("cpu-single", 2000, { unit: "iterations/s" });
    const plain = summarize([row], 45)[0]?.performancePerDollar ?? 0;
    const east = summarize([row], 45, { modal: "us-east" })[0]?.performancePerDollar ?? 0;
    expect(plain / east).toBeCloseTo(1.75, 6);
    // Reviewer's synthetic case: 4,738 flattered versus 2,708 region-correct.
    expect(east).toBeCloseTo(
      2000 /
        (estimateCost("modal", 1000, { cpu: 0.125, memoryGiB: 0.125, diskGiB: 0 }, "us-east") ?? 1),
      3,
    );

    // The runner passes each provider's configured region.
    const out = await mkdtemp(join(tmpdir(), "bench-modal-region-"));

    try {
      const report = await runV2(
        [{ kind: "ready", name: "modal", cloud: false, region: "us-east", provider: memory() }],
        parseV2([
          "--providers",
          "modal",
          "--runs",
          "1",
          "--scenarios",
          "command",
          "--bursts",
          "",
          "--out",
          out,
        ]),
        async () => {},
      );

      const command = report.summaries.find((s) => s.scenario === "command");
      const value = report.samples.find((s) => s.scenario === "command")?.outcome;

      if (value?.kind !== "sample") throw new Error("No command sample");

      const rate =
        estimateCost("modal", 1000, { cpu: 0.125, memoryGiB: 0.125, diskGiB: 0 }, "us-east") ?? 0;

      expect(command?.performancePerDollar).toBeCloseTo(1000 / value.value / rate, 3);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("projects Modal on the request at the configured region, whatever host the guest saw", () => {
    const names = [
      "cold",
      "fingerprint",
      "perf",
      "command",
      "files-1kb",
      "files-10mb",
      "reconnect",
      "pause-resume",
      "snapshot-total",
      "create-from-snapshot",
      "snapshot-cleanup",
      "restore-fingerprint",
      "restore-destroy",
      "destroy",
      "git-clone",
      "npm-install",
      "preview-provisioning",
      "dev-server",
      "preview-first-byte",
      "edit-loop",
      "tool-replay",
      "pip-install",
      "burst-3/sandbox-lifetime",
    ];

    const pilot = (
      hostGiB: number,
      region: string | null,
    ): Pick<ReportV2, "config" | "providers" | "samples"> => ({
      config: parseV2(["--providers", "modal"]),
      samples: names.map((name) =>
        sample(name, 1000, name === "fingerprint" ? { fingerprint: hostFingerprint(hostGiB) } : {}),
      ),
      providers: [
        { name: "modal", kind: "ready", note: "", configuredRegion: region, requestedSize: null },
      ],
    });

    const [big] = projectCosts(pilot(1024, null));
    const [small] = projectCosts(pilot(203, null));
    const [east] = projectCosts(pilot(1024, "us-east"));
    expect(big?.total).toBeCloseTo(small?.total ?? 0, 9);
    expect(east?.total).toBeCloseTo((big?.total ?? 0) * 1.75, 9);
    expect(east).toMatchObject({ region: "us-east", bound: "lower" });
  });
});

describe("Modal cost per task", () => {
  const task = (id: string, lifetimeMs: number) =>
    ["cold", "tool-replay", "destroy", "sandbox-lifetime"].map((scenario) =>
      sample(scenario, scenario === "sandbox-lifetime" ? lifetimeMs : 100, { sandboxId: id }),
    );

  it("falls back to a labelled list-price estimate on the request at the source run's region", () => {
    const report = mergeSources([
      source("cost-east", "us-east", [...task("sb-a", 60_000), ...task("sb-b", 120_000)], ["cost"]),
    ]);

    const cost = costPerTask(report, "modal");
    const minimum = { cpu: 0.125, memoryGiB: 0.125, diskGiB: 0 };

    const median =
      ((estimateCost("modal", 60_000, minimum, "us-east") ?? 0) +
        (estimateCost("modal", 120_000, minimum, "us-east") ?? 0)) /
      2;

    expect(cost).toMatchObject({ kind: "estimate", bound: "lower", confidence: "low", n: 2 });
    expect(cost.usd).toBeCloseTo(median, 9);
    expect(cost.source).toMatch(/lower bound/);
  });

  it("uses Modal's per-App billing when every task has it, provisional until settled", () => {
    const input = source("cost-billed", "us-east", [...task("sb-a", 60_000)], ["cost"]);

    input.costBilling = {
      collectedAt: at,
      providers: [
        {
          provider: "modal",
          source: "Modal billing report",
          sandboxes: [
            {
              id: "sb-a",
              source: "Modal billing report",
              cost: {
                kind: "billed",
                usd: 0.0042,
                scope: "sandbox-lifetime",
                complete: false,
                confidence: "low",
              },
            },
          ],
        },
      ],
    };

    expect(costPerTask(mergeSources([input]), "modal")).toMatchObject({
      kind: "billed",
      usd: 0.0042,
      settled: false,
      bound: null,
    });
  });
});
