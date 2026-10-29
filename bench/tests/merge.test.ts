import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFailure,
  mergeSources,
  reliability,
  readSource,
  sampleSchema,
  type MergeSource,
} from "../src/merge.js";
import type { Sample } from "../src/v2-model.js";

const host = {
  timestamp: "2026-10-19T00:00:00.000Z",
  load: [1, 2, 3],
  cpu: { user: 2, system: 1 },
  cpuTicks: [[1, 2, 3, 4, 5]],
  network: "preserved",
};

function sample(
  iteration: number,
  scenario = "cold",
  outcome: Sample["outcome"] = { kind: "sample", value: 10 },
): Sample {
  return {
    provider: "daytona",
    iteration,
    scenario,
    unit: "ms",
    startedAt: host.timestamp,
    finishedAt: host.timestamp,
    durationMs: 10,
    sandboxId: `box-${iteration}`,
    outcome,
    phases: { firstCommandOKMs: 10 },
    hostBefore: host,
    hostAfter: host,
    headroom: {
      normalizedLoad: 0.2,
      hostCpuBusy: 0.1,
      processCpuMs: 2,
      highLoad: false,
      rxBytesPerSecond: 1,
      txBytesPerSecond: 2,
    },
    fingerprint: null,
    estimatedCost: null,
    details: { retained: true },
  };
}

function source(runId: string, samples: Sample[]): MergeSource {
  return {
    schemaVersion: 2,
    runId,
    timestamp: host.timestamp,
    finishedAt: host.timestamp,
    config: { seed: 45, scenarios: ["command"], bursts: [] },
    metadata: { harnessCommit: "h", sdkCommit: "s" },
    host: { cpu: "test", os: "linux", runtime: "bun" },
    providers: [{ name: "daytona", configuredRegion: null, note: "default" }],
    budgets: {},
    cleanup: [],
    methodology: [],
    pricing: { daytona: { currency: "USD" } },
    samples: samples.map((s) => sampleSchema.parse(s)),
  };
}

describe("offline v2 merge", () => {
  it("refuses to publish one provider from two native products", async () => {
    const { publicationMarkdown } = await import("../src/publication-report.js");
    const { siteData } = await import("../src/site-data.js");

    const report = mergeSources([
      source("box", [sample(0)]),
      source("ephemeral", [{ ...sample(0), product: "ephemeral" }]),
    ]);

    expect(() => publicationMarkdown(report)).toThrow(/more than one native product/);
    expect(() => siteData(report)).toThrow(/native products/);
  });
  it("keeps native products in separate summaries", () => {
    const report = mergeSources([
      source("box", [sample(0, "cold", { kind: "sample", value: 1000 })]),
      source("ephemeral", [
        { ...sample(0, "cold", { kind: "sample", value: 10 }), product: "ephemeral" },
      ]),
    ]);

    const cold = report.summaries.filter((row) => row.scenario === "cold");
    expect(cold.map((row) => [row.product, row.stats.p50])).toEqual([
      [null, 1000],
      ["ephemeral", 10],
    ]);
  });
  it("offsets restarted iterations, preserves source identity and every original field", () => {
    const original = sample(0);

    const report = mergeSources([
      source("main", [original, sample(1)]),
      source("topup", [original, sample(0, "command")]),
    ]);

    expect(report.samples.map((s) => s.iteration)).toEqual([0, 1, 2, 2]);
    expect(report.samples.map((s) => s.sourceRunId)).toEqual(["main", "main", "topup", "topup"]);
    expect(report.samples.map((s) => s.sourceIteration)).toEqual([0, 1, 0, 0]);
    expect(report.samples.map((s) => s.sourceSampleIndex)).toEqual([0, 1, 0, 1]);
    expect(report.samples[2]).toMatchObject({ ...original, iteration: 2 });
    expect(original.iteration).toBe(0);
  });
  it("retains failures, skips and blocked rows; excludes only discarded runs", () => {
    const rows = [
      sample(0),
      sample(1, "cold", { kind: "failure", note: "provider failed" }),
      sample(1, "command", { kind: "blocked", blocked_by: "cold", note: "Blocked" }),
      sample(2, "pause-resume", { kind: "skipped", note: "unsupported" }),
    ];

    const report = mergeSources([
      source("main", rows),
      source("publication-001", [sample(9)]),
      source("topup", [sample(0)]),
    ]);

    expect(report.samples).toHaveLength(5); // 4 + 1 + 1 - 1 discarded
    expect(report.inputSampleCount).toBe(5);
    expect(report.samples.map((s) => s.outcome.kind)).toEqual([
      "sample",
      "failure",
      "blocked",
      "skipped",
      "sample",
    ]);
    expect(report.sources.map((s) => s.runId)).toEqual(["main", "topup"]);
  });
  it("keeps snapshot and main cold distributions separate and recomputes stats", () => {
    const snap = source("snapshot", [sample(0, "cold", { kind: "sample", value: 900 })]);
    snap.config.scenarios = ["snapshot"];

    const report = mergeSources([
      source("main", [sample(0), sample(1, "cold", { kind: "sample", value: 30 })]),
      source("topup", [sample(0, "cold", { kind: "sample", value: 20 })]),
      snap,
    ]);

    expect(report.summaries.find((s) => s.suite === "main")?.stats).toMatchObject({
      count: 3,
      p50: 20,
      p95: 30,
    });
    expect(report.summaries.find((s) => s.suite === "snapshot")?.stats.p50).toBe(900);
  });
  it("classifies only supported account/client evidence and exposes raw and adjusted rates", () => {
    const quota = {
      ...sample(1, "cold", {
        kind: "failure",
        note: "Boat request failed. The provider reported quota.",
      }),
      provider: "boat",
    };

    expect(classifyFailure(quota)).toBe("provider-account-limit");

    const concurrency = sample(1, "burst-25/cold", {
      kind: "failure",
      note: "Daytona request failed (invalid_argument).",
    });

    expect(classifyFailure(concurrency)).toBe("provider-account-limit");
    expect(classifyFailure({ ...concurrency, scenario: "tool-replay" })).toBe("provider-operation");

    const client = sample(1, "network-mbps", {
      kind: "failure",
      note: "HTTP Error 429: Too Many Requests",
    });

    expect(classifyFailure(client)).toBe("client-third-party");
    expect(
      classifyFailure({
        ...client,
        outcome: { kind: "failure", note: "Connection reset by peer" },
      }),
    ).toBe("client-third-party");
    expect(
      classifyFailure({ ...client, outcome: { kind: "failure", note: "invalid_argument" } }),
    ).toBe("provider-operation");

    const rows = [
      sample(0, "network-mbps"),
      client,
      sample(2, "network-mbps", { kind: "failure", note: "operation failed" }),
    ];

    const stats = mergeSources([source("main", rows)]).summaries[0];
    expect(stats?.reliability.raw?.rate).toBeCloseTo(1 / 3);
    expect(stats?.reliability.excludingLimitsAndClient?.rate).toBe(0.5);
    expect(stats?.comparable).toBe(false);
  });
  it("counts a sandbox's retried delete as one failure and keeps every raw row", () => {
    const conflict = { kind: "failure", note: "Daytona request failed (provider)." } as const;

    // Cleanup retried the failed delete of sandboxes 0 and 2, writing one row per attempt.
    const rows = [0, 0, 1, 2, 2].map((i) =>
      sample(i, "burst-10/destroy", i === 1 ? undefined : conflict),
    );

    const report = mergeSources([source("burst", rows)]);
    expect(report.samples.filter((s) => s.outcome.kind === "failure")).toHaveLength(4);
    const rel = reliability(report.samples);
    expect(rel).toMatchObject({ successes: 1, failures: 2, classes: { "provider-operation": 2 } });
    expect(rel.raw?.rate).toBeCloseTo(1 / 3);
    expect(
      report.summaries.find((s) => s.scenario === "burst-10/destroy")?.reliability.failures,
    ).toBe(2);
  });
  it("separates overlapping burst member and cohort identities and inherits quota failures", () => {
    const burst = source("burst", [
      sample(0, "burst-10/cold"),
      sample(0, "burst-10/all-ready"),
      sample(0, "burst-25/cold", {
        kind: "failure",
        note: "Daytona request failed (invalid_argument).",
      }),
      sample(0, "burst-25/all-ready", { kind: "failure", note: "0/25 ready" }),
    ]);

    burst.config.scenarios = ["burst"];
    const report = mergeSources([burst]);
    expect(new Set(report.samples.map((s) => s.iteration)).size).toBe(4);
    expect(report.samples[3]?.failureClass).toBe("provider-account-limit");
  });
  it("rejects duplicate sources rather than duplicating their measurements", () => {
    expect(() => mergeSources([source("same", []), source("same", [])])).toThrow(
      "Duplicate source",
    );
  });
  it("validates the two on-disk copies and preserves unknown raw fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sbx-merge-"));

    try {
      const raw = { ...sample(0), futureField: { kept: "verbatim" } };
      await writeFile(join(dir, "results.json"), JSON.stringify(source("disk", [raw])));
      await writeFile(join(dir, "samples.ndjson"), JSON.stringify(raw) + "\n");
      const parsed = await readSource(dir);
      expect(mergeSources([parsed]).samples[0]?.futureField).toEqual({ kept: "verbatim" });
      await writeFile(join(dir, "samples.ndjson"), JSON.stringify(sample(2)) + "\n");
      await expect(readSource(dir)).rejects.toThrow("differs from NDJSON");
      await writeFile(join(dir, "samples.ndjson"), "");
      await expect(readSource(dir)).rejects.toThrow("count mismatch");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

it("reports lifetime costs without double-counting scenario allocations or inventing missing costs", async () => {
  const { publicationMarkdown } = await import("../src/publication-report.js");

  const first = source("cost-a", [
    { ...sample(0, "cold"), estimatedCost: 0.2 },
    { ...sample(0, "sandbox-lifetime"), estimatedCost: 2 },
  ]);

  const second = source("cost-b", [
    { ...sample(0, "sandbox-lifetime"), estimatedCost: 3 },
    sample(1, "sandbox-lifetime", { kind: "skipped", note: "Creation failed; lifetime unknown" }),
  ]);

  const markdown = publicationMarkdown(mergeSources([first, second]));
  expect(markdown).toContain("| daytona | USD 5.00000 | 1 | unknown | not applicable | USD |");
  expect(markdown).not.toContain("Top-ups used");
});

it("selects first attempts by timestamp, keeps operation failures and replaces pause sources", () => {
  const old = source("old", [
    sample(0, "pause-resume"),
    ...Array.from({ length: 102 }, (_, i) => ({
      ...sample(i),
      startedAt: `2026-10-19T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`,
    })),
  ]);

  old.samples[2] = {
    ...sample(1, "cold", { kind: "failure", note: "real provider failure" }),
    startedAt: "2026-10-19T00:00:01.000Z",
  };
  const fresh = source("fresh", [sample(0, "pause-resume")]);

  const policy = {
    replacements: [
      {
        provider: "daytona",
        suite: "main" as const,
        scenario: "pause-resume",
        sourceRunIds: ["fresh"],
      },
    ],
    notRun: [],
  };

  const r = mergeSources([fresh, old], [], 45, policy);
  const cold = r.samples.filter((s) => s.scenario === "cold");
  expect(cold).toHaveLength(100);
  expect(cold[1]?.outcome.kind).toBe("failure");
  expect(cold.at(-1)?.sourceIteration).toBe(99);
  expect(r.samples.find((s) => s.scenario === "pause-resume")?.sourceRunId).toBe("fresh");
  expect(r.selectionRemoved).toEqual({ "replaced-source": 1, "above-target": 2 });
});

it("retains members only for the first three selected burst cohorts", () => {
  const rows = Array.from({ length: 4 }, (_, cohort) => [
    sample(cohort, "burst-10/all-ready"),
    ...Array.from({ length: 10 }, (_, member) => sample(cohort * 10 + member, "burst-10/cold")),
  ]).flat();

  const input = source("burst", rows);
  input.config.scenarios = ["burst"];
  const r = mergeSources([input], [], 45, { replacements: [], notRun: [] });
  expect(r.samples.filter((s) => s.scenario === "burst-10/all-ready")).toHaveLength(3);
  expect(r.samples.filter((s) => s.scenario === "burst-10/cold")).toHaveLength(30);
  expect(r.samples.some((s) => s.scenario === "burst-10/cold" && s.sourceIteration >= 30)).toBe(
    false,
  );
});

it("rejects both under-target and over-target counts and missing successful pause phases", async () => {
  const { checkAttempts } = await import("../src/attempts.js");
  const policy = { replacements: [], notRun: [] };

  for (const count of [99, 100, 101]) {
    const r = mergeSources([
      source(
        "main",
        Array.from({ length: count }, (_, i) => sample(i)),
      ),
    ]);

    expect(
      checkAttempts(r.samples, policy).find(
        (s) => s.provider === "daytona" && s.scenario === "cold",
      )?.pass,
    ).toBe(count === 100);
  }

  const r = mergeSources([
    source(
      "pause",
      Array.from({ length: 100 }, (_, i) => sample(i, "pause-resume")),
    ),
  ]);

  expect(
    checkAttempts(r.samples, policy).find(
      (s) => s.provider === "daytona" && s.scenario === "pause-resume",
    )?.pass,
  ).toBe(false);

  for (const s of r.samples) s.phases = { pauseMs: 1, resumeReturnedMs: 2, resumeReadyMs: 3 };
  expect(
    checkAttempts(r.samples, policy).find(
      (s) => s.provider === "daytona" && s.scenario === "pause-resume",
    )?.pass,
  ).toBe(true);
});

it("keeps collection costs for an excluded account-limited burst", () => {
  const input = source("burst", [
    sample(0, "burst-25/cold", { kind: "failure", note: "invalid_argument" }),
    sample(0, "burst-25/all-ready", { kind: "failure", note: "account limit" }),
    { ...sample(0, "burst-25/sandbox-lifetime"), estimatedCost: 0.12 },
  ]);

  input.config.scenarios = ["burst"];

  const report = mergeSources([input], [], 45, {
    replacements: [],
    notRun: [
      {
        provider: "daytona",
        suite: "burst",
        scenario: "burst-25/*",
        reason: "Account concurrency limit",
      },
    ],
  });

  expect(report.samples).toHaveLength(0);
  expect(report.sources[0]?.lifetimeCosts).toEqual([
    {
      provider: "daytona",
      sourceRunId: "burst",
      currency: "USD",
      known: 0.12,
      missing: 0,
      lifetimes: 1,
    },
  ]);
});

it("separates tracks in summaries, attempt selection, and site exports", async () => {
  const { siteData } = await import("../src/site-data.js");
  const { selectAttempts, checkAttempts } = await import("../src/attempts.js");

  const a = source(
    "default-track",
    Array.from({ length: 101 }, (_, i) => sample(i)),
  );

  const b = source(
    "same-spec-track",
    Array.from({ length: 101 }, (_, i) => ({
      ...sample(i),
      track: "same-spec" as const,
      requestedSize: { cpu: 4, memoryMb: 8192 },
      template: "four-eight",
      outcome: { kind: "sample" as const, value: 1000 },
    })),
  );

  b.config.track = "same-spec";
  const report = mergeSources([a, b], [], 45);
  expect(report.summaries.filter((s) => s.scenario === "cold")).toHaveLength(2);
  expect(report.summaries.map((s) => s.track)).toEqual(["default", "same-spec"]);
  const policy = { replacements: [], notRun: [] };
  const selected = selectAttempts(report.samples, policy);
  expect(selected.samples.filter((s) => s.track === "default")).toHaveLength(100);
  expect(selected.samples.filter((s) => s.track === "same-spec")).toHaveLength(100);
  expect(
    checkAttempts(selected.samples, policy)
      .filter((s) => s.provider === "daytona" && s.scenario === "cold")
      .map((s) => s.pass),
  ).toEqual([true, true]);
  expect(siteData(report).coldSamples.daytona).toHaveLength(101);
  expect(siteData(report).coldSamples.daytona?.[0]).toBe(0.01);
  expect(siteData(report, "same-spec").coldSamples.daytona?.[0]).toBe(1);
  expect(siteData(report, "same-spec").metrics.find((m) => m.id === "cold")?.values[0]?.p50).toBe(
    1,
  );

  const defaultOnlyPolicy = {
    replacements: [],
    notRun: [
      { provider: "daytona", suite: "main" as const, scenario: "cold", reason: "default only" },
    ],
  };

  expect(
    selectAttempts(report.samples, defaultOnlyPolicy).samples.every((s) => s.track === "same-spec"),
  ).toBe(true);
});

const allocationFingerprint = (cpu: number, memoryGiB: number) => ({
  cpuModel: "fixture",
  flags: [],
  nproc: cpu,
  cpuMax: "",
  quotaCpus: cpu,
  memoryMax: "",
  memTotalBytes: memoryGiB * 1024 ** 3,
  memoryBytes: memoryGiB * 1024 ** 3,
  diskBytes: 100 * 1024 ** 3,
  df: "",
  lsblk: "",
  virtualization: "",
  hypervisor: false,
  dmi: "",
  kernel: "test",
  distro: "test",
  user: "test",
  uid: 1000,
  sudo: false,
  stealPercent: 0,
  egress: null,
  tools: {},
  runtime: "test",
});

function allocationReport(
  provider: string,
  cpu: number,
  memory: number,
  size: Sample["requestedSize"] = { cpu, memoryMb: Math.round(memory * 1024) },
) {
  const input = source(`${provider}-allocation`, [
    {
      ...sample(0, "fingerprint"),
      provider,
      track: "same-spec",
      requestedSize: size,
      fingerprint: allocationFingerprint(cpu, memory),
    },
  ]);

  input.config.track = "same-spec";
  input.providers = [{ name: provider, configuredRegion: null, note: "test" }];

  return mergeSources([input], []);
}

it("prices each track from requested and verified CPU/memory instead of default allocations", async () => {
  const { hourly } = await import("../src/publication-report.js");
  const { siteData } = await import("../src/site-data.js");
  const e2b = allocationReport("e2b", 4, 8);
  expect(hourly(e2b, "e2b")).toBeCloseTo(0.3312);
  expect(siteData(e2b, "same-spec").providers[0]?.perVcpuHour).toBeCloseTo(0.0828);
  expect(hourly(allocationReport("upstash", 4, 7.8, "medium"), "upstash")).toBe(0.2);
  expect(hourly(allocationReport("boxd", 4, 16, { cpu: 4, memoryMb: 16384 }), "boxd")).toBeCloseTo(
    0.348,
  );

  const mismatch = siteData(
    allocationReport("daytona", 2, 8, { cpu: 4, memoryMb: 8192 }),
    "same-spec",
  ).providers[0];

  const { publicationMarkdown } = await import("../src/publication-report.js");
  expect(
    publicationMarkdown(allocationReport("daytona", 2, 8, { cpu: 4, memoryMb: 8192 })),
  ).toContain("Allocation mismatch");
  expect(mismatch?.hourly).toBeNull();
  expect(mismatch?.perVcpuHour).toBeNull();
  expect(mismatch?.allocationVerification).toMatchObject({
    verified: false,
    mismatches: [expect.stringContaining("vCPU")],
  });
});

it("exports measured allocation safeguards and never labels boxd or a 2-vCPU Superserve equal-spec", async () => {
  const { siteData } = await import("../src/site-data.js");
  const boxd = siteData(allocationReport("boxd", 4, 16, { cpu: 4, memoryMb: 16384 }), "same-spec");
  expect(boxd.providers[0]).toMatchObject({
    track: "same-spec",
    requestedAllocation: { size: { cpu: 4, memoryMb: 16384 }, compute: { cpu: 4, memoryGiB: 16 } },
    measuredAllocations: [{ cpu: 4, memoryGiB: 16, diskGiB: 100 }],
    equalSpec: false,
  });
  expect(boxd.allocations[0]).toMatchObject({
    provider: "boxd",
    track: "same-spec",
    equalSpec: false,
  });
  expect(siteData(allocationReport("superserve", 2, 8), "same-spec").providers[0]?.equalSpec).toBe(
    false,
  );

  for (const [cpu, memory, expected] of [
    [4, 7.6, true],
    [4, 8.4, true],
    [4, 7.59, false],
    [4, 8.41, false],
    [2, 8, false],
  ]) {
    if (typeof cpu !== "number" || typeof memory !== "number") throw new Error("Invalid fixture");
    expect(
      siteData(allocationReport("e2b", cpu, memory), "same-spec").providers[0]?.equalSpec,
    ).toBe(expected);
  }

  const noFingerprint = allocationReport("e2b", 4, 8);
  const missing = noFingerprint.samples[0];

  if (!missing) throw new Error("Missing fixture");
  missing.fingerprint = null;
  expect(siteData(noFingerprint, "same-spec").providers[0]).toMatchObject({
    equalSpec: false,
    measuredAllocations: [],
  });
  const mixed = allocationReport("e2b", 4, 8);
  const first = mixed.samples[0];

  if (!first) throw new Error("Missing fixture");
  mixed.samples.push({ ...first, fingerprint: allocationFingerprint(2, 8) });
  expect(siteData(mixed, "same-spec").providers[0]?.equalSpec).toBe(false);
});

it("checks same-spec-only attempt counts without creating a default-track requirement", async () => {
  const { checkAttempts } = await import("../src/attempts.js");
  const report = allocationReport("e2b", 4, 8);
  expect(
    checkAttempts(report.samples, { replacements: [], notRun: [] }).every(
      (r) => r.track === "same-spec",
    ),
  ).toBe(true);
  expect(
    checkAttempts([], { replacements: [], notRun: [] }, ["same-spec"]).every(
      (r) => r.track === "same-spec",
    ),
  ).toBe(true);
  expect(
    checkAttempts([], {
      replacements: [],
      notRun: [
        {
          provider: "e2b",
          suite: "main",
          scenario: "cold",
          track: "same-spec",
          reason: "not collected",
        },
      ],
    }).every((r) => r.track === "same-spec"),
  ).toBe(true);
});

it("includes restored fingerprints in allocation safeguards and excludes failed restore latencies", async () => {
  const { siteData } = await import("../src/site-data.js");
  const { allocationEvidence } = await import("../src/allocation.js");
  const report = allocationReport("e2b", 4, 8, { cpu: 4, memoryMb: 8192 });
  const first = report.samples[0];

  if (!first) throw new Error("fixture required");
  report.samples.push({
    ...first,
    scenario: "restore-fingerprint",
    fingerprint: allocationFingerprint(2, 8),
    outcome: { kind: "failure", note: "Restored allocation differs" },
  });
  report.samples.push({
    ...first,
    scenario: "create-from-snapshot",
    outcome: { kind: "failure", note: "Restored allocation differs" },
  });
  const evidence = allocationEvidence(report.samples, "e2b");
  expect(evidence).toMatchObject({ equalSpec: false, verified: false, pricingAllocation: null });
  const exported = siteData(report, "same-spec");
  expect(exported.providers[0]).toMatchObject({
    equalSpec: false,
    allocationVerification: { verified: false },
  });
  expect(exported.metrics.find((m) => m.id === "create-from-snapshot")?.values ?? []).toEqual([]);
});

it.each([
  ["e2b", "sandbox-bench-same-spec", 4, 7.75, 8],
  ["e2b", "r1h7gud12rf1f6iu29r0", 4, 7.75, 8],
  ["e2b", "sandbox-bench-advertised-default", 2, 3.9, 4],
  ["e2b", "base", 2, 0.49, 0.5],
  ["daytona", "daytona-large", 4, 7.9, 8],
  ["superserve", "sandbox-bench-node22-py311-1x1", 1, 0.98, 1],
  ["superserve", "sandbox-bench-node22-py311-1x1-pinned", 1, 0.98, 1],
  ["superserve", "522daf7b-fec9-41d8-80cd-361f3b8b1fa8", 1, 0.98, 1],
  ["superserve", "sandbox-bench-node22-py311-4x8-pinned", 4, 7.8, 8],
  ["superserve", "bd88e7c5-139e-419f-9a73-8d2ec34d3edf", 4, 7.8, 8],
])(
  "prices provisioned template resources for %s/%s",
  async (provider, template, cpu, usable, provisioned) => {
    const { allocationEvidence } = await import("../src/allocation.js");
    const { siteData } = await import("../src/site-data.js");
    const { hourly } = await import("../src/publication-report.js");
    const report = allocationReport(provider, cpu, usable, null);

    for (const row of report.samples) row.template = template;
    expect(allocationEvidence(report.samples, provider)).toMatchObject({
      requestedCompute: { cpu, memoryGiB: provisioned },
      verified: true,
      pricingAllocation: { cpu, memoryGiB: provisioned },
    });
    expect(siteData(report, "same-spec").providers[0]?.requestedAllocation.compute).toEqual({
      cpu,
      memoryGiB: provisioned,
    });

    if (cpu === 4 && ["e2b", "superserve"].includes(provider))
      expect(hourly(report, provider)).toBeCloseTo(0.3312);

    if (provider === "superserve" && cpu === 4)
      expect(siteData(report, "same-spec").providers[0]?.equalSpec).toBe(true);
    const first = report.samples[0];

    if (!first) throw new Error("fixture required");
    first.fingerprint = allocationFingerprint(cpu + 1, usable);
    expect(allocationEvidence(report.samples, provider)).toMatchObject({
      verified: false,
      pricingAllocation: null,
    });
  },
);

it("uses documented default allocations and leaves unknown templates unverified", async () => {
  const { allocationEvidence } = await import("../src/allocation.js");

  for (const [provider, cpu, memory] of [
    ["upstash", 2, 4],
    ["boat", 4, 8],
    ["boxd", 2, 8],
    ["freestyle", 4, 8],
  ] as const) {
    expect(
      allocationEvidence(allocationReport(provider, cpu, memory * 0.98, null).samples, provider),
    ).toMatchObject({ verified: true, pricingAllocation: { cpu, memoryGiB: memory } });
  }

  const report = allocationReport("e2b", 4, 8, null);

  for (const row of report.samples) row.template = "unknown-template";
  expect(allocationEvidence(report.samples, "e2b").requestedCompute).toBeNull();
});

it("rejects restored memory and disk mismatches even without a known provisioned request", async () => {
  const { allocationEvidence } = await import("../src/allocation.js");

  for (const fingerprint of [
    allocationFingerprint(4, 4),
    { ...allocationFingerprint(4, 8), diskBytes: 10 * 1024 ** 3 },
  ]) {
    const report = allocationReport("unknown-provider", 4, 8, null);
    const first = report.samples[0];

    if (!first) throw new Error("fixture required");
    report.samples.push({ ...first, scenario: "restore-fingerprint", fingerprint });
    expect(allocationEvidence(report.samples, "unknown-provider")).toMatchObject({
      verified: false,
      equalSpec: false,
      pricingAllocation: null,
    });
  }
});

it("exports snapshot metrics collected in all runs once alongside dedicated suites", async () => {
  const { siteData } = await import("../src/site-data.js");

  const all = source("all", [
    sample(0, "cold"),
    sample(0, "snapshot"),
    sample(0, "create-from-snapshot"),
  ]);

  all.config.scenarios = ["all"];

  const dedicated = source("snapshot-only", [
    sample(0, "cold"),
    sample(0, "snapshot"),
    sample(0, "create-from-snapshot"),
  ]);

  dedicated.config.scenarios = ["snapshot"];
  const report = mergeSources([all, dedicated], []);
  expect(report.samples).toHaveLength(6);
  const exported = siteData(report);

  for (const id of ["snapshot", "create-from-snapshot"]) {
    expect(exported.metrics.find((m) => m.id === id)?.values[0]).toMatchObject({
      n: 2,
      successes: 2,
    });
    expect(report.summaries.filter((s) => s.scenario === id)).toHaveLength(1);
  }

  expect(exported.metrics.find((m) => m.id === "cold")?.values[0]?.n).toBe(1);
  expect(
    siteData(mergeSources([all], [])).metrics.find((m) => m.id === "snapshot")?.values[0]?.n,
  ).toBe(1);
});

it.each([
  [0.5, 0.462, true],
  [0.5, 0.40625, true],
  [0.5, 0.4, false],
  [0.5, 0.501, false],
  [1, 0.92, true],
  [1, 0.90625, true],
  [1, 0.9, false],
  [1, 1.001, false],
  [8, 7.6, true],
  [8, 7.59, false],
  [8, 8.001, false],
])(
  "verifies %s GiB provisioned vs %s usable with fixed kernel overhead (valid=%s)",
  async (provisioned, usable, valid) => {
    const { allocationEvidence } = await import("../src/allocation.js");
    const report = allocationReport("e2b", 2, usable, { cpu: 2, memoryMb: provisioned * 1024 });
    expect(allocationEvidence(report.samples, "e2b").verified).toBe(valid);
  },
);

it("prices the E2B base template from its full 512 MiB despite kernel overhead", async () => {
  const { siteData } = await import("../src/site-data.js");
  const report = allocationReport("e2b", 2, 0.462, null);

  for (const row of report.samples) row.template = "base";
  expect(siteData(report, "same-spec").providers[0]).toMatchObject({
    hourly: 0.1089,
    allocationVerification: { verified: true },
    pricingAllocation: { cpu: 2, memoryGiB: 0.5 },
  });
});

it("shows Boat documented user-file disk separately from measured filesystem without pricing it", async () => {
  const { siteData } = await import("../src/site-data.js");
  const { allocationEvidence } = await import("../src/allocation.js");
  const report = allocationReport("boat", 4, 7.75, null);
  const first = report.samples[0];

  if (!first) throw new Error("fixture required");
  first.fingerprint = { ...allocationFingerprint(4, 7.75), diskBytes: 68.58 * 1024 ** 3 };
  report.samples.push({
    ...first,
    scenario: "restore-fingerprint",
    fingerprint: { ...first.fingerprint, diskBytes: 100 * 1024 ** 3 },
  });
  expect(allocationEvidence(report.samples, "boat")).toMatchObject({
    verified: true,
    mismatches: [],
    pricingAllocation: { cpu: 4, memoryGiB: 8 },
  });
  const provider = siteData(report, "same-spec").providers[0];
  expect(provider?.requestedAllocation.provisioned).toMatchObject({
    documentedDisk: {
      value: 50,
      unit: "GB",
      scope: expect.stringContaining("excludes operating system"),
      source: "https://docs.boat.dev/machines",
    },
  });
  expect(provider?.measuredAllocations.map((r) => r.diskGiB)).toEqual([68.58, 100]);
  expect(provider?.hourly).toBe(0.036);
});

function costSource(provider = "daytona", kind: "billed" | "metered" = "billed", complete = true) {
  const input = source(
    `cost-${provider}`,
    [0, 1].flatMap((i) =>
      ["cold", "tool-replay", "destroy", "sandbox-lifetime"].map((scenario) => ({
        ...sample(i, scenario),
        provider,
        sandboxId: `task-${i}`,
      })),
    ),
  );

  input.config.scenarios = ["cost"];
  input.providers = [{ name: provider, configuredRegion: null, note: "test" }];
  input.costBilling = {
    collectedAt: host.timestamp,
    providers: [
      {
        provider,
        source: "native usage",
        account: { window: { start: host.timestamp, end: host.timestamp } },
        sandboxes: [1, 3].map((usd, i) => ({
          id: `task-${i}`,
          source: "native per-ID usage",
          cost: { kind, complete, confidence: "medium", scope: "window", usd },
        })),
      },
    ],
  };

  return input;
}

it.each(["billed", "metered"] as const)(
  "exports a %s median only for isolated cost tasks and keeps latency separate",
  async (kind) => {
    const { costPerTask } = await import("../src/task-cost.js");
    const { siteData } = await import("../src/site-data.js");
    const cost = costSource("daytona", kind);
    const r = mergeSources([source("main", [sample(0)]), cost]);
    expect(r.samples.filter((s) => s.suite === "cost")).toHaveLength(8);
    expect(costPerTask(r, "daytona")).toMatchObject({ usd: 2, kind, n: 2, settled: true });
    const site = siteData(r);
    expect(site.providers.find((p) => p.id === "daytona")?.costPerTask).toMatchObject({
      usd: 2,
      kind,
    });
    expect(site.metrics.find((m) => m.id === "cold")?.values[0]?.n).toBe(1);
  },
);

it("keeps pending native costs in their own kind and never mixes or fills missing evidence", async () => {
  const { costPerTask } = await import("../src/task-cost.js");
  const cost = costSource("daytona", "billed", false);
  expect(costPerTask(mergeSources([cost]), "daytona")).toMatchObject({
    usd: 2,
    kind: "billed",
    settled: false,
  });
  const billing = cost.costBilling?.providers[0];

  if (!billing) throw new Error("missing fixture");
  billing.sandboxes[1] = {
    id: "task-1",
    source: "meter",
    cost: {
      kind: "metered",
      usd: 3,
      complete: true,
      confidence: "medium",
      scope: "sandbox-lifetime",
    },
  };
  expect(costPerTask(mergeSources([cost]), "daytona")).toMatchObject({
    usd: null,
    n: 0,
    settled: false,
  });
  billing.sandboxes.pop();
  expect(costPerTask(mergeSources([cost]), "daytona").usd).toBeNull();
});

it("requires a billing window enclosing the task and a successful replay/destruction", async () => {
  const { costPerTask } = await import("../src/task-cost.js");
  const cost = costSource("boxd", "metered", false);
  expect(costPerTask(mergeSources([cost]), "boxd")).toMatchObject({
    kind: "metered",
    usd: 2,
    settled: false,
  });
  const provider = cost.costBilling?.providers[0];

  if (!provider) throw new Error("missing fixture");
  provider.account = null;
  expect(costPerTask(mergeSources([cost]), "boxd").usd).toBeNull();
  const failed = costSource();
  const replay = failed.samples.find((s) => s.scenario === "tool-replay");

  if (!replay) throw new Error("missing fixture");
  replay.outcome = { kind: "failure", note: "task failed" };
  expect(costPerTask(mergeSources([failed]), "daytona").usd).toBeNull();
});

it("loads adjacent billing on cost sources at merge time for later recollection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bench-cost-billing-"));

  try {
    const input = costSource();
    const billing = input.costBilling;
    delete input.costBilling;
    await writeFile(join(dir, "results.json"), JSON.stringify(input));
    await writeFile(
      join(dir, "samples.ndjson"),
      input.samples.map((s) => JSON.stringify(s)).join("\n") + "\n",
    );
    expect((await readSource(dir)).costBilling).toBeUndefined();
    await writeFile(join(dir, "billing.json"), JSON.stringify(billing));
    expect((await readSource(dir)).costBilling).toEqual(billing);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["tenki", "freestyle"])(
  "estimates %s task lifetimes only at a verified allocation",
  async (provider) => {
    const { costPerTask } = await import("../src/task-cost.js");
    const cost = costSource(provider);
    const size = { cpu: 4, memoryMb: 8192 };

    for (const s of cost.samples) s.requestedSize = size;

    const main = source(`main-${provider}`, [
      {
        ...sample(0, "fingerprint"),
        provider,
        requestedSize: size,
        fingerprint: {
          cpuModel: "test",
          flags: [],
          nproc: 4,
          quotaCpus: 4,
          cpuMax: "400000 100000",
          memoryMax: "8589934592",
          memTotalBytes: 8 * 1024 ** 3,
          memoryBytes: 7.9 * 1024 ** 3,
          diskBytes: 32 * 1024 ** 3,
          df: "",
          lsblk: "",
          virtualization: "",
          hypervisor: false,
          dmi: "",
          kernel: "test",
          distro: "test",
          user: "test",
          uid: 1000,
          sudo: false,
          stealPercent: 0,
          egress: null,
          tools: {},
          runtime: "test",
        },
      },
    ]);

    expect(costPerTask(mergeSources([cost]), provider).usd).toBeNull();
    const valid = costPerTask(mergeSources([main, cost]), provider);
    expect(valid).toMatchObject({ kind: "estimate", n: 2, settled: true, confidence: "low" });
    expect(valid.usd).toBeGreaterThan(0);
    const fp = main.samples[0]?.fingerprint;

    if (!fp) throw new Error("missing fixture");
    fp.quotaCpus = 2;
    expect(costPerTask(mergeSources([main, cost]), provider).usd).toBeNull();
  },
);

it("prices undocumented Tenki defaults from the matching observed fingerprint", async () => {
  const { costPerTask } = await import("../src/task-cost.js");
  const cost = costSource("tenki");
  const { fingerprintSchema } = await import("../src/fingerprint.js");

  const fp = fingerprintSchema.parse({
    cpuModel: "test",
    flags: [],
    nproc: 2,
    quotaCpus: 2,
    cpuMax: "200000 100000",
    memoryMax: "4294967296",
    memTotalBytes: 4 * 1024 ** 3,
    memoryBytes: 3.9 * 1024 ** 3,
    diskBytes: 5 * 1024 ** 3,
    df: "",
    lsblk: "",
    virtualization: "",
    hypervisor: false,
    dmi: "",
    kernel: "test",
    distro: "test",
    user: "test",
    uid: 1000,
    sudo: false,
    stealPercent: 0,
    egress: null,
    tools: {},
    runtime: "test",
  });

  const main = source("tenki-default", [
    { ...sample(0, "fingerprint"), provider: "tenki", fingerprint: fp },
  ]);

  expect(costPerTask(mergeSources([main, cost]), "tenki")).toMatchObject({
    kind: "estimate",
    n: 2,
    settled: true,
  });
  expect(costPerTask(mergeSources([main, cost]), "tenki").usd).toBeGreaterThan(0);
});
