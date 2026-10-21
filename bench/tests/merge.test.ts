import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyFailure,
  mergeSources,
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
    sandboxId: "box",
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
  const old = source("old", [sample(0, "pause-resume"), ...Array.from({length: 102}, (_, i) => ({...sample(i), startedAt: `2026-10-19T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z`}))]);
  old.samples[2] = {...sample(1, "cold", {kind: "failure", note: "real provider failure"}), startedAt: "2026-10-19T00:00:01.000Z"};
  const fresh = source("fresh", [sample(0, "pause-resume")]);
  const policy = {replacements: [{provider: "daytona", suite: "main" as const, scenario: "pause-resume", sourceRunIds: ["fresh"]}], notRun: []};
  const r = mergeSources([fresh, old], [], 45, policy);
  const cold = r.samples.filter(s => s.scenario === "cold");
  expect(cold).toHaveLength(100);
  expect(cold[1]?.outcome.kind).toBe("failure");
  expect(cold.at(-1)?.sourceIteration).toBe(99);
  expect(r.samples.find(s => s.scenario === "pause-resume")?.sourceRunId).toBe("fresh");
  expect(r.selectionRemoved).toEqual({"replaced-source": 1, "above-target": 2});
});

it("retains members only for the first three selected burst cohorts", () => {
  const rows = Array.from({length: 4}, (_, cohort) => [
    sample(cohort, "burst-10/all-ready"),
    ...Array.from({length: 10}, (_, member) => sample(cohort * 10 + member, "burst-10/cold")),
  ]).flat();
  const input = source("burst", rows); input.config.scenarios = ["burst"];
  const r = mergeSources([input], [], 45, {replacements: [], notRun: []});
  expect(r.samples.filter(s => s.scenario === "burst-10/all-ready")).toHaveLength(3);
  expect(r.samples.filter(s => s.scenario === "burst-10/cold")).toHaveLength(30);
  expect(r.samples.some(s => s.scenario === "burst-10/cold" && s.sourceIteration >= 30)).toBe(false);
});

it("rejects both under-target and over-target counts and missing successful pause phases", async () => {
  const {checkAttempts} = await import("../src/attempts.js");
  const policy = {replacements: [], notRun: []};
  for (const count of [99, 100, 101]) {
    const r = mergeSources([source("main", Array.from({length: count}, (_, i) => sample(i)))]);
    expect(checkAttempts(r.samples, policy).find(s => s.provider === "daytona" && s.scenario === "cold")?.pass).toBe(count === 100);
  }
  const r = mergeSources([source("pause", Array.from({length: 100}, (_, i) => sample(i, "pause-resume")))]);
  expect(checkAttempts(r.samples, policy).find(s => s.provider === "daytona" && s.scenario === "pause-resume")?.pass).toBe(false);
  for (const s of r.samples) s.phases = {pauseMs: 1, resumeReturnedMs: 2, resumeReadyMs: 3};
  expect(checkAttempts(r.samples, policy).find(s => s.provider === "daytona" && s.scenario === "pause-resume")?.pass).toBe(true);
});
