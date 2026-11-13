import { describe, expect, it } from "vitest";
import { mergeSources, sampleSchema, type MergeSource } from "../src/merge.js";
import { siteData } from "../src/site-data.js";
import type { Sample } from "../src/v2-model.js";
import { attemptApp, journalApp } from "../src/modal-apps.js";

const at = "2026-11-09T12:00:00.000Z";

const host = {
  timestamp: at,
  load: [0, 0, 0],
  cpu: { user: 0, system: 0 },
  cpuTicks: [[1, 2, 3, 4, 5]],
  network: "",
};

function sample(
  provider: string,
  scenario: string,
  value: number,
  phases: Record<string, number> = {},
  iteration = 0,
): Sample {
  return {
    provider,
    iteration,
    scenario,
    unit: "ms",
    startedAt: at,
    finishedAt: at,
    durationMs: value,
    sandboxId: `${provider}-${iteration}`,
    outcome: { kind: "sample", value },
    phases,
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
  };
}

function source(samples: Sample[], runId = "destroy-timing"): MergeSource {
  return {
    schemaVersion: 2,
    runId,
    timestamp: at,
    finishedAt: at,
    config: { seed: 45, scenarios: ["command"], bursts: [] },
    metadata: { harnessCommit: "h", sdkCommit: "s" },
    host: { cpu: "test", os: "linux", runtime: "node" },
    providers: [
      { name: "modal", configuredRegion: "us-east", note: "default" },
      { name: "e2b", configuredRegion: null, note: "default" },
    ],
    budgets: {},
    cleanup: [],
    methodology: [],
    pricing: { modal: { currency: "USD" }, e2b: { currency: "USD" } },
    samples: samples.map((s) => sampleSchema.parse(s)),
  };
}

describe("site-data destroy timing", () => {
  // Modal's destroy rows last until the confirmed stop; the request is a phase.
  const modal = [
    sample("modal", "destroy", 30_000, { terminateRequestMs: 250, confirmedStopMs: 30_000 }, 0),
    sample("modal", "destroy", 420, { terminateRequestMs: 40, confirmedStopMs: 400 }, 1),
    sample("modal", "destroy", 520, { terminateRequestMs: 50, confirmedStopMs: 500 }, 2),
    // The request's response was lost: only the confirmed stop is known.
    sample("modal", "destroy", 900, { confirmedStopMs: 880 }, 3),
  ];

  const e2b = [100, 110, 120].map((ms, i) => sample("e2b", "destroy", ms, {}, i));

  const destroy = siteData(mergeSources([source([...modal, ...e2b])])).metrics.find(
    (m) => m.id === "destroy",
  );

  it("publishes Modal's terminate request, not its confirmed stop, with the stop beside it", () => {
    const row = destroy?.values.find((v) => v.provider === "modal");

    // A 250 ms request with a 30 s confirmed stop must not publish 30 s.
    expect(row).toMatchObject({
      n: 3,
      p50: 0.05,
      p95: 0.25,
      min: 0.04,
      timed: "terminate-request",
      requestUnknown: 1,
      successes: 4,
      failures: 0,
      confirmedStop: { n: 4, p50: 0.5, p95: 30, max: 30, unconfirmed: 0 },
    });
    expect(row?.ciLow).toBeLessThanOrEqual(0.05);
    expect(row?.ciHigh).toBeGreaterThanOrEqual(0.05);
  });

  it("leaves other providers' destroy rows as the measured duration", () => {
    const row = destroy?.values.find((v) => v.provider === "e2b");

    expect(row).toMatchObject({ n: 3, p50: 0.11, min: 0.1 });
    expect(row).not.toHaveProperty("timed");
    expect(row).not.toHaveProperty("confirmedStop");
  });
});

describe("superseded iterations", () => {
  const failed: Sample = {
    ...sample("modal", "cold", 200, {}, 2),
    sandboxId: null,
    outcome: {
      kind: "failure",
      note: "Modal request failed: the provider rejected the request as invalid.",
      code: "invalid_argument",
      stage: "cold",
      elapsedMs: 200,
    },
  };

  const main = source(
    [sample("modal", "cold", 380, {}, 0), sample("modal", "cold", 390, {}, 1), failed],
    "main",
  );

  const makeup = source([sample("modal", "cold", 400, {}, 0)], "makeup");

  it("drops a rerun's superseded iterations and counts them, keeping every other sample", () => {
    const merged = mergeSources(
      [main, makeup],
      [],
      45,
      {
        replacements: [],
        notRun: [],
        superseded: [
          {
            provider: "modal",
            suite: "main",
            sourceRunId: "main",
            iterations: [2],
            rerunSourceRunIds: ["makeup"],
            reason: "Modal's 200-App limit stopped the App lookup; no create reached Modal",
          },
        ],
      },
      {
        journals: new Map([["main", [journalApp("modal", attemptApp("main", 2))]]]),
      },
    );

    const cold = merged.samples.filter((s) => s.provider === "modal" && s.scenario === "cold");

    expect(cold.map((s) => [s.sourceRunId, s.outcome.kind])).toEqual([
      ["main", "sample"],
      ["main", "sample"],
      ["makeup", "sample"],
    ]);
    expect(merged.selectionRemoved).toEqual({ "superseded-by-rerun": 1 });
    expect(merged.attemptPolicy?.superseded?.[0]?.reason).toMatch(/200-App limit/);
  });

  it("keeps the failure without a superseded rule", () => {
    const merged = mergeSources([main, makeup], [], 45, { replacements: [], notRun: [] });

    expect(
      merged.samples.filter((s) => s.scenario === "cold" && s.outcome.kind === "failure"),
    ).toHaveLength(1);
  });
});
