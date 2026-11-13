import { describe, expect, it } from "vitest";
import { mergeSources, sampleSchema, type MergeSource } from "../src/merge.js";
import { attemptApp, journalApp, type JournalApp } from "../src/modal-apps.js";
import type { AttemptPolicy } from "../src/attempts.js";
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
  extra: Partial<Record<"admissionStopped" | "cleanupReview", unknown[]>> = {},
): MergeSource {
  return {
    schemaVersion: 2,
    runId,
    timestamp: at,
    finishedAt: at,
    config: { seed: 45, scenarios: ["cold"], bursts: [] },
    metadata: { harnessCommit: "h", sdkCommit: "s" },
    host: { cpu: "test", os: "linux", runtime: "node" },
    providers: [{ name: "modal", configuredRegion: "us-east", note: "default" }],
    budgets: {},
    cleanup: [],
    methodology: [],
    pricing: { modal: { currency: "USD" } },
    samples: samples.map((s) => sampleSchema.parse(s)),
    ...extra,
  };
}

/** One App per iteration, as `--app-per-attempt modal` journals it. */
function apps(run: string, iterations: number, override: Record<number, Partial<JournalApp>> = {}) {
  return Array.from({ length: iterations }, (_, i) => ({
    ...journalApp("modal", attemptApp(run, i)),
    ...(i in override ? override[i] : { appId: `ap-${i}`, sandboxes: [`sb-${i}`] }),
  }));
}

const policy: AttemptPolicy = {
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
};

const main = source("main", [
  sample({ iteration: 0 }),
  sample({ iteration: 1 }),
  sample({ iteration: 2, sandboxId: null, failed: true }),
]);

const makeup = source("makeup", [sample({ iteration: 0 })]);

/** The App lookup was refused: no App ID and no create journaled. */
const refusedLookup = { 2: { appId: null, sandboxes: [], allocations: [] } };

describe("superseded iterations need journal evidence", () => {
  it("drops an iteration whose journaled App never received a create", () => {
    const merged = mergeSources([main, makeup], [], 45, policy, {
      journals: new Map([
        ["main", apps("main", 3, refusedLookup)],
        ["makeup", []],
      ]),
    });

    expect(merged.selectionRemoved).toEqual({ "superseded-by-rerun": 1 });
  });

  it("skips a rule for a run outside this merge, such as another track's", () => {
    const other = source("other", [sample({ iteration: 0 })]);

    expect(mergeSources([other], [], 45, policy).selectionRemoved).toEqual({});
  });

  it("refuses without the source's ownership journal", () => {
    expect(() => mergeSources([main, makeup], [], 45, policy)).toThrow(
      /main.*no ownership journal/,
    );
  });

  it("refuses when the iteration journaled a create", () => {
    const journals = new Map([
      [
        "main",
        apps("main", 3, {
          2: { appId: "ap-2", sandboxes: [], allocations: [{ id: "a", state: "submitted" }] },
        }),
      ],
    ]);

    expect(() => mergeSources([main, makeup], [], 45, policy, { journals })).toThrow(
      /iteration 2 journaled 1 create/,
    );
  });

  it("refuses when the iteration's App is not in the journal", () => {
    const journals = new Map([["main", apps("main", 2)]]);

    expect(() => mergeSources([main, makeup], [], 45, policy, { journals })).toThrow(
      /iteration 2 has no journaled App/,
    );
  });

  it("refuses when a superseded sample names a sandbox", () => {
    const named = source("main", [
      sample({ iteration: 0 }),
      sample({ iteration: 1 }),
      sample({ iteration: 2, sandboxId: "sb-known", failed: true }),
    ]);

    const journals = new Map([["main", apps("main", 3, refusedLookup)]]);

    expect(() => mergeSources([named, makeup], [], 45, policy, { journals })).toThrow(
      /iteration 2 recorded sandbox sb-known/,
    );
  });

  it("refuses a rerun that is not merged", () => {
    const journals = new Map([["main", apps("main", 3, refusedLookup)]]);

    expect(() => mergeSources([main], [], 45, policy, { journals })).toThrow(
      /rerun makeup is not among the merged sources/,
    );
  });

  it("refuses a rerun that stopped admission or left cleanup unresolved", () => {
    const journals = new Map([["main", apps("main", 3, refusedLookup)]]);
    const stopped = source("makeup", [sample({ iteration: 0 })], { admissionStopped: [{}] });
    const unclean = source("makeup", [sample({ iteration: 0 })], { cleanupReview: [{}] });

    expect(() => mergeSources([main, stopped], [], 45, policy, { journals })).toThrow(
      /rerun makeup did not complete/,
    );
    expect(() => mergeSources([main, unclean], [], 45, policy, { journals })).toThrow(
      /rerun makeup did not complete/,
    );
  });

  // Review finding: a snapshot-only rerun on the same provider and track authorized removing a main-suite iteration.
  it("refuses a rerun from another suite, such as a snapshot-only run", () => {
    const journals = new Map([["main", apps("main", 3, refusedLookup)]]);

    const snapshotOnly: MergeSource = {
      ...source("makeup", [{ ...sample({ iteration: 0 }), scenario: "snapshot" }]),
      config: { seed: 45, scenarios: ["snapshot"], bursts: [] },
    };

    expect(() => mergeSources([main, snapshotOnly], [], 45, policy, { journals })).toThrow(
      /rerun makeup ran 0 modal main iterations/,
    );
  });

  it("refuses a rerun with fewer iterations than it replaces", () => {
    const journals = new Map([["main", apps("main", 3, refusedLookup)]]);
    const empty = source("makeup", []);

    expect(() => mergeSources([main, empty], [], 45, policy, { journals })).toThrow(
      /rerun makeup ran 0 modal main iterations/,
    );
  });
});
