import { describe, expect, it } from "vitest";
import { mergeSources, sampleSchema, type MergeSource } from "../src/merge.js";
import { attemptApp, journalApp, type JournalApp } from "../src/modal-apps.js";
import type { AttemptPolicy } from "../src/attempts.js";
import { siteData } from "../src/site-data.js";
import type { Sample } from "../src/v2-model.js";

const at = "2026-11-09T12:00:00.000Z";

const host = {
  timestamp: at,
  load: [0, 0, 0],
  cpu: { user: 0, system: 0 },
  cpuTicks: [[1, 2, 3, 4, 5]],
  network: "",
};

function sample({
  iteration,
  sandboxId = `sb-${iteration}`,
  failed = false,
}: {
  iteration: number;
  sandboxId?: string | null;
  failed?: boolean;
}): Sample {
  return {
    provider: "modal",
    iteration,
    scenario: "cold",
    unit: "ms",
    startedAt: at,
    finishedAt: at,
    durationMs: 300,
    sandboxId,
    outcome: failed
      ? {
          kind: "failure",
          note: "Modal request failed: the provider rejected the request as invalid.",
          code: "invalid_argument",
          stage: "cold",
          elapsedMs: 200,
        }
      : { kind: "sample", value: 300 },
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
  };
}

function source(
  runId: string,
  samples: Sample[],
  track: "default" | "same-spec" = "default",
): MergeSource {
  return {
    schemaVersion: 2,
    runId,
    timestamp: at,
    finishedAt: at,
    config: { seed: 45, scenarios: ["cold"], bursts: [], track },
    metadata: { harnessCommit: "h", sdkCommit: "s" },
    host: { cpu: "test", os: "linux", runtime: "node" },
    providers: [{ name: "modal", configuredRegion: "us-east", note: "default" }],
    budgets: {},
    cleanup: [],
    methodology: [],
    pricing: { modal: { currency: "USD" } },
    samples: samples.map((s) => sampleSchema.parse(s)),
  };
}

/** One App per iteration, as `--app-per-attempt modal` journals it. */
function apps(run: string, iterations: number, override: Record<number, Partial<JournalApp>> = {}) {
  return Array.from({ length: iterations }, (_, i) => ({
    ...journalApp("modal", attemptApp(run, i)),
    ...(i in override ? override[i] : { appId: `ap-${i}`, sandboxes: [`sb-${i}`] }),
  }));
}

const notRun = (track: "default" | "same-spec") => ({
  provider: "modal",
  track,
  suite: "main" as const,
  scenario: "pause-resume",
  reason: "Modal Sandboxes have no pause/resume",
});

const pauseRow = (iteration: number): Sample => ({
  ...sample({ iteration }),
  scenario: "pause-resume",
});

const policy: AttemptPolicy = {
  replacements: [],
  notRun: [notRun("default"), notRun("same-spec")],
  superseded: [
    {
      provider: "modal",
      suite: "main",
      track: "default",
      sourceRunId: "main",
      iterations: [2],
      rerunSourceRunIds: ["makeup"],
      reason: "Our side: Modal's 200-App limit refused the App lookup",
    },
  ],
};

const sources = [
  source("main", [
    sample({ iteration: 0 }),
    sample({ iteration: 1 }),
    sample({ iteration: 2, sandboxId: null, failed: true }),
    pauseRow(0),
  ]),
  source("makeup", [sample({ iteration: 0 })]),
  source("spec", [sample({ iteration: 0 }), pauseRow(0), pauseRow(1)], "same-spec"),
];

const journals = new Map([
  [
    "main",
    [0, 1, 2].map((i) => ({
      ...journalApp("modal", attemptApp("main", i)),
      ...(i === 2 ? {} : { appId: `ap-${i}`, sandboxes: [`sb-${i}`] }),
    })),
  ],
]);

describe("site-data exclusions", () => {
  const merged = mergeSources(sources, [], 45, policy, { journals });

  it("discloses each track's removed counts, reasons, source iterations and reruns", () => {
    expect(siteData(merged, "default").exclusions).toEqual({
      removed: { "documented-not-run": 1, "superseded-by-rerun": 1 },
      superseded: [
        {
          provider: "modal",
          suite: "main",
          sourceRunId: "main",
          iterations: [2],
          rerunSourceRunIds: ["makeup"],
          reason: "Our side: Modal's 200-App limit refused the App lookup",
        },
      ],
      notRun: [
        {
          provider: "modal",
          suite: "main",
          scenario: "pause-resume",
          reason: "Modal Sandboxes have no pause/resume",
        },
      ],
      replacements: [],
    });

    expect(siteData(merged, "same-spec").exclusions).toEqual({
      removed: { "documented-not-run": 2 },
      superseded: [],
      notRun: [
        {
          provider: "modal",
          suite: "main",
          scenario: "pause-resume",
          reason: "Modal Sandboxes have no pause/resume",
        },
      ],
      replacements: [],
    });
  });

  it("reads a single-track report written before per-track counts", () => {
    const one = mergeSources(sources.slice(0, 2), [], 45, policy, { journals });
    const { selectionRemovedByTrack: _dropped, ...older } = one;

    expect(siteData(older, "default").exclusions.removed).toEqual(one.selectionRemoved);
  });

  it("has no per-track counts for an older report that mixed tracks", () => {
    const { selectionRemovedByTrack: _dropped, ...older } = merged;

    expect(siteData(older, "default").exclusions.removed).toBeNull();
  });
});
