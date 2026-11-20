import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { runAttempt } from "../../src/realistic/attempt.js";
import {
  buildExport,
  burstCommand,
  claimOutput,
  notRunLines,
  preloadArtifacts,
  requiredArtifacts,
  roundSchedule,
  runProviderRounds,
  soloMedians,
  type ProviderRounds,
  type RoundLineInput,
  type ScheduledRound,
} from "../../src/realistic/burst-cli.js";
import {
  accountRefusal,
  billableLifetimeMs,
  roundSpend,
  runPool,
  runRound,
  spendGuard,
  summarizeProvider,
  taskEnd,
  taskResult,
  type BurstTag,
  type Leftover,
  type RoundPlan,
  type RoundReport,
  type StoredRecord,
} from "../../src/realistic/burst.js";
import { sweepProviders } from "../../src/realistic/cli.js";
import { ProviderTrace, systemClock } from "../../src/realistic/gaps.js";
import type { HarnessManifest } from "../../src/realistic/manifest.js";
import { attemptRecordSchema, type AttemptRecord } from "../../src/realistic/record.js";
import { attributionFor, emptyRecord, type SlotProvider } from "../../src/realistic/slots.js";
import { sha256Hex } from "../../src/realistic/steps.js";
import { buildFixture, type Fixture } from "./fixture.js";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
});

afterAll(() => fixture.cleanup());

const sleep = (ms: number, signal?: AbortSignal) => systemClock.sleep(ms, signal);

type Script = {
  durationMs?: number;
  /** Leave the sandbox behind: no destroy, deletion unconfirmed. */
  leak?: boolean;
  /** Ignore the abort and never return. */
  hang?: boolean;
  completion?: AttemptRecord["completion"];
};

/**
 * A scripted attempt on a real in-memory provider: it creates a sandbox with the attempt's labels,
 * reports it, waits, and deletes it (unless told to leak), with create and destroy phases recorded.
 */
function scripted(script: (task: number) => Script, starts: number[]) {
  const fake: typeof runAttempt = async (plan, environment) => {
    const startedAt = Date.now();
    starts.push(startedAt);
    const step = script(plan.slot.index);

    const info = await plan.provider.provider.create({
      labels: { ...plan.labels, "sandbox-bench-run": plan.runId, "rw-attempt": plan.attemptId },
    });

    const created = Date.now();
    await environment.onSandbox?.(plan.provider.name, info.id);
    let completion: AttemptRecord["completion"] = step.completion ?? { kind: "completed" };

    try {
      if (step.hang) await new Promise(() => {});
      await sleep(step.durationMs ?? 20, environment.signal);
    } catch {
      completion = { kind: "incomplete", reason: "slot-timeout", detail: "aborted" };
    }

    const destroyStart = Date.now();

    if (!step.leak) await plan.provider.provider.destroy(info.id);

    const record = emptyRecord(
      { ...plan, provider: plan.provider.name },
      "error",
      "",
      startedAt,
      environment.attribution,
    );

    record.completion = completion;
    record.sandboxIds = [info.id];
    record.deletionConfirmed = !step.leak;
    record.phases = [
      { name: "create", startedAt, endedAt: created },
      { name: "workload", startedAt: created, endedAt: destroyStart },
      { name: "destroy", startedAt: destroyStart, endedAt: Date.now() + 5 },
    ];
    record.endedAt = Date.now() + 50;

    return { record, trace: new ProviderTrace(systemClock) };
  };

  return fake;
}

const entry = (overrides: Partial<SlotProvider> = {}): SlotProvider => ({
  name: "e2b",
  provider: memory(),
  attribution: attributionFor("e2b").attribution,
  settlementMs: null,
  paddingMs: 0,
  ...overrides,
});

function withSlotTimeout(manifest: HarnessManifest, slotTimeoutMs: number): HarnessManifest {
  const profile = manifest.profiles["fix-and-test"];

  if (!profile) throw new Error("fixture has no fix-and-test profile");

  return {
    ...manifest,
    profiles: { ...manifest.profiles, "fix-and-test": { ...profile, slotTimeoutMs } },
  };
}

const round = (overrides: Partial<RoundPlan>, records: AttemptRecord[]): RoundPlan => ({
  runId: "rtb-test",
  round: 1,
  size: 5,
  manifest: fixture.manifest,
  manifestSha256: null,
  profileName: "fix-and-test",
  track: "same-machine",
  entry: entry(),
  clock: systemClock,
  blobs: fixture.blobs,
  prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
  created: new Set(),
  onRecord: async (record) => {
    records.push(record);
  },
  ...overrides,
});

describe("a round", () => {
  it("releases every task together, after each task's own setup, and waits for the slowest", async () => {
    const records: AttemptRecord[] = [];
    const starts: number[] = [];
    const ready: number[] = [];

    // Modal-like per-task setup that takes a different time per task.
    const setupEntry = entry({
      beforeAttempt: async (attemptId) => {
        const task = Number(/-t(\d+)-/.exec(attemptId)?.[1]);
        await sleep(40 * task);
        ready.push(Date.now());

        return {
          labels: { "sandbox-bench-app": attemptId },
          created: async () => {},
          failed: async () => {},
          destroyed: async () => {},
        };
      },
    });

    const report = await runRound(
      round(
        {
          entry: setupEntry,
          round: 2,
          attempt: scripted((task) => ({ durationMs: task === 4 ? 300 : 20 }), starts),
        },
        records,
      ),
    );

    expect(starts).toHaveLength(5);
    // Nobody starts before the slowest setup is done, and all start within a few ms of each other.
    expect(Math.min(...starts)).toBeGreaterThanOrEqual(Math.max(...ready));
    expect(Math.max(...starts) - Math.min(...starts)).toBeLessThan(30);
    expect((report.allDoneAt ?? 0) - report.startedAt).toBeGreaterThanOrEqual(300);
    expect(records.map((r) => r.slot.id).sort()).toEqual([
      "r2-t0",
      "r2-t1",
      "r2-t2",
      "r2-t3",
      "r2-t4",
    ]);
    expect(new Set(records.map((r) => r.attemptId)).size).toBe(5);

    for (const record of records) {
      expect(attemptRecordSchema.parse(record).variant).toBe("concurrent");
      expect(record.batch).toBe(2);
    }

    expect(report.leftovers).toEqual([]);
    expect(report.after.ids).toEqual([]);
  });

  it("runs a control round as one task alone, with its own IDs and the batch it is given", async () => {
    const records: AttemptRecord[] = [];
    const starts: number[] = [];

    const report = await runRound(
      round(
        { round: 2, role: "control", batch: 3, size: 1, attempt: scripted(() => ({}), starts) },
        records,
      ),
    );

    expect(starts).toHaveLength(1);
    expect(report).toMatchObject({ round: 2, role: "control", batch: 3, size: 1 });
    expect(records.map((r) => [r.attemptId, r.slot.id, r.batch])).toEqual([
      ["rtb-test-c2-t0-e2b", "c2-t0", 3],
    ]);
    expect(report.leftovers).toEqual([]);
  });

  it("deletes only this run's leftovers and confirms them gone; a foreign sandbox is untouched", async () => {
    const records: AttemptRecord[] = [];
    const provider = memory();
    const foreign = await provider.create({ labels: { owner: "someone-else" } });
    const created = new Set<string>();

    const report = await runRound(
      round(
        {
          entry: entry({ provider }),
          created,
          attempt: scripted((task) => ({ leak: task === 1 }), []),
        },
        records,
      ),
    );

    const leaked = records.find((r) => r.slot.index === 1)?.sandboxIds[0];

    expect(report.before.ids).toEqual([foreign.id]);
    expect(report.ownBefore).toEqual([]);
    expect([...(report.after.ids ?? [])].sort()).toEqual([foreign.id, leaked].sort());
    expect(report.leftovers).toEqual([
      { id: leaked, destroyed: true, goneAfter: true, confirmedAt: expect.any(Number) },
    ]);
    expect((await provider.list({})).map((s) => s.id)).toEqual([foreign.id]);
    expect(created.size).toBe(5);

    // A second round sees nothing of ours before it starts.
    const second = await runRound(
      round(
        { entry: entry({ provider }), created, round: 2, attempt: scripted(() => ({}), []) },
        records,
      ),
    );

    expect(second.ownBefore).toEqual([]);
  });

  it("ends a task at the slot timeout and abandons one that ignores the abort", async () => {
    const records: AttemptRecord[] = [];

    const report = await runRound(
      round(
        {
          size: 3,
          manifest: withSlotTimeout(fixture.manifest, 100),
          timeoutGraceMs: 100,
          attempt: scripted(
            (task) => (task === 0 ? { durationMs: 10_000 } : task === 1 ? { hang: true } : {}),
            [],
          ),
        },
        records,
      ),
    );

    const byTask = new Map(records.map((r) => [r.slot.index, r]));

    expect(byTask.get(0)?.completion).toMatchObject({ reason: "slot-timeout" });
    expect(byTask.get(1)?.completion).toMatchObject({ reason: "slot-timeout" });
    expect(byTask.get(1)?.deletionConfirmed).toBe(false);
    expect(byTask.get(2)?.completion.kind).toBe("completed");
    // The abandoned task's sandbox was still listed after the round, so the round deleted it.
    expect(report.leftovers.map((l) => l.id)).toEqual(byTask.get(1)?.sandboxIds);
    expect(report.leftovers.every((l) => l.destroyed && l.goneAfter)).toBe(true);
  });
});

/** A finished record for summary tests: wall time from start to the end of its destroy phase. */
function done({
  round: batch,
  task,
  wallS,
  completion = { kind: "completed" },
  created = true,
  lastPhase = "workload",
  uploadS,
  attemptId = `rtb-test-r${batch}-t${task}-e2b`,
}: {
  round: number;
  task: number;
  wallS: number;
  completion?: AttemptRecord["completion"];
  created?: boolean;
  lastPhase?: "create" | "prepare" | "workload";
  /** Recorded as two uploads (toolchain, dependency cache) splitting this time. */
  uploadS?: number;
  attemptId?: string;
}): AttemptRecord {
  const record = emptyRecord(
    {
      runId: "rtb-test",
      attemptId,
      provider: "e2b",
      manifest: fixture.manifest,
      manifestSha256: null,
      profileName: "fix-and-test",
      track: "same-machine",
      variant: "concurrent",
      batch,
      slot: { index: task, id: `r${batch}-t${task}` },
      seed: 0,
      slotStartedAt: 1_000,
    },
    "error",
    "",
    1_000,
    "per-sandbox",
  );

  const end = 1_000 + wallS * 1000;
  record.completion = completion;
  record.sandboxIds = created ? [`sbx-${batch}-${task}`] : [];
  record.deletionConfirmed = true;
  record.endedAt = end + 500;
  record.phases = created
    ? [
        { name: "create", startedAt: 1_000, endedAt: 1_100 },
        ...(lastPhase === "create"
          ? []
          : [{ name: "prepare" as const, startedAt: 1_100, endedAt: 1_200 }]),
        ...(uploadS === undefined
          ? []
          : [
              {
                name: "download" as const,
                startedAt: 1_100,
                endedAt: 1_100 + uploadS * 400,
                label: "toolchain",
              },
              {
                name: "download" as const,
                startedAt: 2_000,
                endedAt: 2_000 + uploadS * 600,
                label: "dependency-cache",
              },
            ]),
        ...(lastPhase === "workload"
          ? [{ name: "workload" as const, startedAt: 1_200, endedAt: end - 100 }]
          : []),
        { name: "destroy", startedAt: end - 100, endedAt: end },
      ]
    : [];

  return record;
}

const byBatch = (records: AttemptRecord[]) =>
  records.map((record) => ({ round: record.batch, record }));

describe("task results", () => {
  it("time each task from the create request to the confirmed deletion, not the record's end", () => {
    expect(taskResult(done({ round: 1, task: 0, wallS: 90 }))).toEqual({
      round: 1,
      wallS: 90,
      uploadS: null,
      completed: true,
    });
  });

  it("carry the time spent uploading from the host, and the round they are given", () => {
    expect(taskResult(done({ round: 4, task: 0, wallS: 90, uploadS: 12.5 }), undefined, 2)).toEqual(
      { round: 2, wallS: 90, uploadS: 12.5, completed: true },
    );
  });

  it("name the stage a task failed at", () => {
    const failed = (completion: AttemptRecord["completion"], extra = {}) =>
      taskResult(done({ round: 1, task: 0, wallS: 10, completion, ...extra })).failure;

    expect(failed({ kind: "incomplete", reason: "check-failed", detail: "test-b: tests" })).toEqual(
      {
        stage: "workload",
        reason: "check-failed: test-b: tests",
      },
    );
    expect(
      failed(
        { kind: "incomplete", reason: "check-failed", detail: "install: exit" },
        { lastPhase: "prepare" },
      ),
    ).toMatchObject({ stage: "prepare" });
    expect(failed({ kind: "incomplete", reason: "slot-timeout", detail: "x" })).toMatchObject({
      stage: "timeout",
    });
    expect(
      failed(
        { kind: "incomplete", reason: "create-failed", detail: "HTTP 500 internal" },
        { created: false },
      ),
    ).toMatchObject({ stage: "create" });
    expect(
      failed(
        { kind: "incomplete", reason: "create-failed", detail: "HTTP 429: rate limit exceeded" },
        { created: false },
      ),
    ).toMatchObject({ stage: "account-limit" });
    expect(
      failed(
        { kind: "incomplete", reason: "create-failed", detail: "vCPU quota exceeded for org" },
        { created: false },
      ),
    ).toMatchObject({ stage: "account-limit" });

    const unconfirmed = done({ round: 1, task: 0, wallS: 10 });
    unconfirmed.deletionConfirmed = false;

    expect(taskResult(unconfirmed)).toMatchObject({
      completed: false,
      failure: { stage: "delete" },
    });
  });

  it("redacts the failure reason", () => {
    const record = done({
      round: 1,
      task: 0,
      wallS: 10,
      completion: { kind: "incomplete", reason: "error", detail: "bad token sk-secret-123" },
    });

    expect(
      taskResult(record, (t) => t.replaceAll("sk-secret-123", "[REDACTED]")).failure?.reason,
    ).toBe("error: bad token [REDACTED]");
  });
});

describe("a provider's row", () => {
  const rounds = [
    { round: 1, size: 3, startedAt: 0, allDoneAt: 120_500 },
    { round: 2, size: 2, startedAt: 500_000, allDoneAt: 610_000 },
  ];

  it("takes the median over completed tasks and compares it with the solo median", () => {
    const records = [
      done({ round: 1, task: 0, wallS: 100 }),
      done({ round: 1, task: 1, wallS: 110 }),
      done({
        round: 1,
        task: 2,
        wallS: 5,
        completion: { kind: "incomplete", reason: "check-failed", detail: "test-b: tests" },
      }),
      done({ round: 2, task: 0, wallS: 120 }),
      done({ round: 2, task: 1, wallS: 130 }),
    ];

    const row = summarizeProvider({
      provider: "e2b",
      tasks: byBatch(records),
      rounds,
      solo: { kind: "published", medianWallS: 100 },
    });

    expect(row).toMatchObject({
      provider: "e2b",
      status: "ran",
      medianWallS: 115,
      completed: 4,
      attempts: 5,
      roundAllDoneS: [120.5, 110],
      soloMedianWallS: 100,
      slowdown: 1.15,
    });
    expect(row.tasks.map((t) => `${t.round}/${t.completed}`)).toEqual([
      "1/true",
      "1/true",
      "1/false",
      "2/true",
      "2/true",
    ]);
  });

  it("does not count creates an account limit refused, and is not run when every one was", () => {
    const refused = (round: number, task: number) =>
      done({
        round,
        task,
        wallS: 0.2,
        created: false,
        completion: {
          kind: "incomplete",
          reason: "create-failed",
          detail: "429 Too Many Requests",
        },
      });

    const mixed = summarizeProvider({
      provider: "e2b",
      tasks: byBatch([done({ round: 1, task: 0, wallS: 100 }), refused(1, 1)]),
      rounds: [{ round: 1, size: 2, startedAt: 0, allDoneAt: 120_500 }],
      solo: { kind: "published", medianWallS: 50 },
    });

    // Half the round was refused, so it did not run 2 at once: no slowdown is claimed for it.
    expect(mixed).toMatchObject({
      status: "ran",
      attempts: 1,
      completed: 1,
      medianWallS: 100,
      slowdown: null,
      burstRounds: [{ round: 1, size: 2, admitted: 1, allDoneS: 120.5 }],
    });

    const none = summarizeProvider({
      provider: "e2b",
      tasks: byBatch([refused(1, 0), refused(1, 1)]),
      rounds: rounds.slice(0, 1),
      solo: { kind: "published", medianWallS: 50 },
    });

    expect(none).toMatchObject({
      status: "not-run",
      attempts: 0,
      medianWallS: null,
      slowdown: null,
    });
    expect(none.status === "not-run" && none.reason).toMatch(/^account limit: /);
    expect(none.roundAllDoneS).toEqual([]);
  });

  it("carries a reason it never ran", () => {
    expect(
      summarizeProvider({
        provider: "daytona",
        tasks: [],
        rounds: [],
        solo: { kind: "published", medianWallS: 92.8 },
        notRun: "Daytona's account allows 10 vCPU in total",
      }),
    ).toEqual({
      provider: "daytona",
      status: "not-run",
      reason: "Daytona's account allows 10 vCPU in total",
      tasks: [],
      medianWallS: null,
      medianUploadS: null,
      completed: 0,
      attempts: 0,
      roundAllDoneS: [],
      burstRounds: [],
      skippedBurstRounds: [],
      harnessFailures: [],
      solo: null,
      soloMedianWallS: 92.8,
      soloMedianUploadS: null,
      slowdown: null,
      slowdownWithoutUpload: null,
      slowdownWithheld: "No burst round ran",
    });
  });

  it("divides by the same-day control tasks, with and without the upload", () => {
    const control = (round: number, wallS: number, uploadS: number, extra = {}) => ({
      round,
      record: done({
        round: round * 2 - 1,
        task: 0,
        wallS,
        uploadS,
        attemptId: `rtb-test-c${round}-t0-e2b`,
        ...extra,
      }),
    });

    const burst = (round: number, task: number, wallS: number, uploadS: number) => ({
      round,
      record: done({ round: round * 2, task, wallS, uploadS }),
    });

    const row = summarizeProvider({
      provider: "e2b",
      tasks: [burst(1, 0, 120, 20), burst(1, 1, 130, 30), burst(2, 0, 110, 10)],
      rounds: [
        { round: 1, size: 2, startedAt: 0, allDoneAt: 131_000 },
        { round: 2, size: 1, startedAt: 500_000, allDoneAt: 611_000 },
      ],
      solo: { kind: "same-day", tasks: [control(2, 104, 4), control(1, 96, 6)] },
    });

    expect(row).toMatchObject({
      status: "ran",
      medianWallS: 120,
      medianUploadS: 20,
      completed: 3,
      attempts: 3,
      roundAllDoneS: [131, 111],
      solo: {
        tasks: [
          { round: 1, wallS: 96, uploadS: 6, completed: true },
          { round: 2, wallS: 104, uploadS: 4, completed: true },
        ],
        completed: 2,
        attempts: 2,
      },
      soloMedianWallS: 100,
      soloMedianUploadS: 5,
      slowdown: 1.2,
      // (wall - upload): burst 100, 100, 100 -> 100; control 90, 100 -> 95.
      slowdownWithoutUpload: 1.053,
    });
    expect(row.tasks.map((t) => t.round)).toEqual([1, 1, 2]);

    const failedControl = summarizeProvider({
      provider: "e2b",
      tasks: [burst(1, 0, 120, 20)],
      rounds: [],
      solo: {
        kind: "same-day",
        tasks: [
          control(1, 30, 5, {
            completion: { kind: "incomplete", reason: "prepare-failed", detail: "upload" },
          }),
        ],
      },
    });

    expect(failedControl).toMatchObject({
      solo: { completed: 0, attempts: 1 },
      soloMedianWallS: null,
      slowdown: null,
      slowdownWithoutUpload: null,
    });
    expect(failedControl.solo?.tasks[0]?.failure?.stage).toBe("prepare");
  });
});

describe("account limits", () => {
  it("refuse a round that cannot fit before anything is created", () => {
    expect(accountRefusal({ provider: "daytona", size: 5, vcpu: 4 })).toMatch(
      /20 vCPU does not fit/,
    );
    expect(accountRefusal({ provider: "daytona", size: 2, vcpu: 4 })).toBeNull();
    expect(accountRefusal({ provider: "beam", size: 5, vcpu: 4 })).toBeNull();
    expect(accountRefusal({ provider: "beam", size: 8, vcpu: 4 })).toMatch(/32 vCPU/);
    expect(accountRefusal({ provider: "baseten", size: 5, vcpu: 4 })).toBeNull();
    expect(accountRefusal({ provider: "baseten", size: 11, vcpu: 4 })).toMatch(/11 tasks/);
    expect(accountRefusal({ provider: "e2b", size: 50, vcpu: 4 })).toBeNull();
  });
});

describe("the provider pool", () => {
  it("runs at most `parallel` at once and never two on one account together", async () => {
    const items = ["e2b", "upstash", "upstash-ephemeral", "boxd", "vercel"];
    const account = (name: string) => (name.startsWith("upstash") ? "upstash" : name);
    const active = new Set<string>();
    let peak = 0;
    const overlaps: string[] = [];
    const ran: string[] = [];

    await runPool({
      items,
      parallel: 3,
      account,
      run: async (name) => {
        if ([...active].some((other) => account(other) === account(name))) overlaps.push(name);
        active.add(name);
        peak = Math.max(peak, active.size);
        await sleep(name === "upstash" ? 80 : 30);
        active.delete(name);
        ran.push(name);
      },
    });

    expect(peak).toBe(3);
    expect(overlaps).toEqual([]);
    expect(ran.sort()).toEqual([...items].sort());
  });

  it("runs every item even when one fails, then reports the failure", async () => {
    const ran: string[] = [];

    await expect(
      runPool({
        items: ["a", "b", "c"],
        parallel: 1,
        account: (x) => x,
        run: async (x) => {
          ran.push(x);

          if (x === "a") throw new Error("boom");
        },
      }),
    ).rejects.toThrow(/1 pool item/);
    expect(ran).toEqual(["a", "b", "c"]);
  });
});

describe("the spend guard", () => {
  it("refuses a reservation that would cross the ceiling and settles to the estimate", () => {
    const guard = spendGuard(15);

    expect(guard.reserve(10)).toBe(true);
    expect(guard.reserve(6)).toBe(false);
    guard.settle({ reservedUSD: 10, spentUSD: 1 });
    expect(guard.reserve(6)).toBe(true);
    expect(guard.state()).toEqual({ spentUSD: 1, reservedUSD: 6, capUSD: 15 });
    // Held only by another reservation: it could fit once that settles. Past the spend, never.
    expect(guard.reserve(9)).toBe(false);
    expect(guard.couldFit(9)).toBe(true);
    expect(guard.couldFit(14.5)).toBe(false);
    expect(() => spendGuard(Number.NaN)).toThrow(/positive/);
  });
});

describe("the round schedule", () => {
  it("puts a 1-task control round before each burst round when asked", () => {
    expect(roundSchedule({ rounds: 2, size: 5, control: true })).toEqual([
      { role: "control", round: 1, size: 1 },
      { role: "burst", round: 1, size: 5 },
      { role: "control", round: 2, size: 1 },
      { role: "burst", round: 2, size: 5 },
    ]);
    expect(roundSchedule({ rounds: 2, size: 5, control: false })).toEqual([
      { role: "burst", round: 1, size: 5 },
      { role: "burst", round: 2, size: 5 },
    ]);
  });
});

describe("the site data file", () => {
  it("divides by the run's own control tasks when the run had them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-export-control-"));

    try {
      await writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          id: "rtb-test",
          sdkCommit: "abc1234",
          startedAt: "2026-11-19T10:00:00.000Z",
          endedAt: "2026-11-19T11:00:00.000Z",
          location: "Boca Raton, FL (evo-1)",
          size: 2,
          rounds: 1,
          track: "same-machine",
          profile: "fix-and-test",
          providers: ["e2b"],
          budgetUSD: 10,
          mode: "one-provider-at-a-time",
          control: true,
        }),
      );

      const listing = { at: 0, ids: [], runIds: [], error: null };

      const line = (role: string, batch: number, size: number, attemptIds: string[]) => ({
        kind: "round",
        provider: "e2b",
        round: 1,
        role,
        size,
        startedAt: batch * 1_000_000,
        allDoneAt: batch * 1_000_000 + 131_000,
        before: listing,
        after: listing,
        ownBefore: [],
        leftovers: [],
        attemptIds,
      });

      await writeFile(
        join(dir, "rounds.jsonl"),
        [
          line("control", 1, 1, ["rtb-test-c1-t0-e2b"]),
          line("burst", 2, 2, ["rtb-test-r1-t0-e2b", "rtb-test-r1-t1-e2b"]),
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );

      await writeFile(
        join(dir, "attempts.jsonl"),
        [
          done({ round: 1, task: 0, wallS: 100, uploadS: 5, attemptId: "rtb-test-c1-t0-e2b" }),
          done({ round: 2, task: 0, wallS: 120, uploadS: 10, attemptId: "rtb-test-r1-t0-e2b" }),
          done({ round: 2, task: 1, wallS: 130, uploadS: 20, attemptId: "rtb-test-r1-t1-e2b" }),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );

      // The published solo median is not used when the run measured its own.
      const data = await buildExport([dir], new Map([["e2b", 999]]));

      expect(data.run.mode).toBe("one-provider-at-a-time");
      expect(data.providers[0]).toMatchObject({
        provider: "e2b",
        status: "ran",
        tasks: [
          { round: 1, wallS: 120, uploadS: 10, completed: true },
          { round: 1, wallS: 130, uploadS: 20, completed: true },
        ],
        medianWallS: 125,
        medianUploadS: 15,
        completed: 2,
        attempts: 2,
        roundAllDoneS: [131],
        solo: { tasks: [{ round: 1, wallS: 100, uploadS: 5, completed: true }], completed: 1 },
        soloMedianWallS: 100,
        soloMedianUploadS: 5,
        slowdown: 1.25,
        slowdownWithoutUpload: 1.158,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is built from a run folder with the published solo medians", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-export-"));

    try {
      await writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          id: "rtb-test",
          sdkCommit: "abc1234",
          startedAt: "2026-11-19T10:00:00.000Z",
          endedAt: "2026-11-19T11:00:00.000Z",
          location: "Boca Raton, FL (evo-1)",
          size: 2,
          rounds: 1,
          track: "same-machine",
          profile: "fix-and-test",
          providers: ["e2b", "daytona"],
          budgetUSD: 15,
        }),
      );

      const listing = { at: 0, ids: [], runIds: [], error: null };

      await writeFile(
        join(dir, "rounds.jsonl"),
        [
          { kind: "not-run", provider: "daytona", reason: "10 vCPU" },
          {
            kind: "round",
            provider: "e2b",
            round: 1,
            size: 2,
            startedAt: 1_000,
            allDoneAt: 131_000,
            before: listing,
            after: listing,
            ownBefore: [],
            leftovers: [],
            attemptIds: ["rtb-test-r1-t0-e2b", "rtb-test-r1-t1-e2b"],
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );

      await writeFile(
        join(dir, "attempts.jsonl"),
        [done({ round: 1, task: 0, wallS: 120 }), done({ round: 1, task: 1, wallS: 130 })]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );

      await writeFile(
        join(dir, "realistic.json"),
        JSON.stringify({
          rows: [
            {
              provider: "e2b",
              profile: "fix-and-test",
              track: "same-machine",
              variant: "headline",
              medianWallS: 100,
            },
            {
              provider: "e2b",
              profile: "build",
              track: "same-machine",
              variant: "headline",
              medianWallS: 999,
            },
            {
              provider: "e2b",
              profile: "fix-and-test",
              track: "default",
              variant: "headline",
              medianWallS: 999,
            },
            {
              provider: "daytona",
              profile: "fix-and-test",
              track: "same-machine",
              variant: "headline",
              medianWallS: 92.8,
            },
          ],
        }),
      );

      const data = await buildExport([dir], await soloMedians(join(dir, "realistic.json")));

      expect(data).toMatchObject({
        schema: 1,
        run: {
          id: "rtb-test",
          mode: "parallel",
          sdkCommit: "abc1234",
          startedAt: "2026-11-19T10:00:00.000Z",
          endedAt: "2026-11-19T11:00:00.000Z",
          location: "Boca Raton, FL (evo-1)",
        },
        size: 2,
        rounds: 1,
        track: "same-machine",
        profile: "fix-and-test",
      });
      expect(data.providers.map((p) => p.provider)).toEqual(["e2b", "daytona"]);
      expect(data.providers[0]).toMatchObject({
        status: "ran",
        medianWallS: 125,
        completed: 2,
        attempts: 2,
        roundAllDoneS: [130],
        soloMedianWallS: 100,
        slowdown: 1.25,
      });
      expect(data.providers[1]).toMatchObject({
        status: "not-run",
        reason: "10 vCPU",
        soloMedianWallS: 92.8,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

/** A memory provider whose create, destroy or both are replaced. */
function provider(
  change: (inner: ReturnType<typeof memory>) => Partial<ReturnType<typeof memory>>,
): ReturnType<typeof memory> {
  const inner = memory();

  return { ...inner, ...change(inner) };
}

const quota = () =>
  new SandboxError("Instabox create failed: a provider limit stopped the request", {
    code: "quota",
    provider: "instabox",
    retryable: true,
  });

/** A record tagged as a round writes it, for summary and export tests. */
function tagged(record: AttemptRecord, tag: Partial<BurstTag> = {}): StoredRecord {
  const burst: BurstTag = {
    role: "burst",
    round: record.batch,
    createError: null,
    harness: null,
    ...tag,
  };

  return Object.assign(record, { burst });
}

describe("create errors", () => {
  it("count a refusal as an account limit by the SDK's code, not the message's words", () => {
    const refused = (createError: BurstTag["createError"], detail: string) =>
      taskResult(
        tagged(
          done({
            round: 1,
            task: 0,
            wallS: 0.3,
            created: false,
            completion: { kind: "incomplete", reason: "create-failed", detail },
          }),
          { createError },
        ),
      ).failure?.stage;

    // Instabox's HTTP 429 quota_exceeded: no limit words in the message, but the SDK's quota code.
    expect(
      refused(
        { code: "quota", sandboxId: null },
        "Instabox create failed: a provider limit stopped the request",
      ),
    ).toBe("account-limit");
    // Limit words in a message the SDK coded as a provider failure: a create failure.
    expect(
      refused({ code: "provider", sandboxId: null }, "HTTP 429: rate limit exceeded upstream"),
    ).toBe("create");
    // A quota failure that names a sandbox was admitted first: a create failure, not a refusal.
    expect(
      refused({ code: "quota", sandboxId: "sbx-1" }, "Instabox operation op-1 failed: quota"),
    ).toBe("create");
  });

  it("are recorded with their code, and a refused round admits none", async () => {
    const records: AttemptRecord[] = [];

    const report = await runRound(
      round(
        {
          size: 2,
          entry: entry({
            provider: provider(() => ({
              create: async () => {
                throw quota();
              },
            })),
          }),
        },
        records,
      ),
    );

    expect(report.records.map((r) => r.burst.createError)).toEqual([
      { code: "quota", sandboxId: null },
      { code: "quota", sandboxId: null },
    ]);
    expect(report.records.every((r) => taskResult(r).failure?.stage === "account-limit")).toBe(
      true,
    );
    expect(report.admitted).toBe(0);
    // A refusal allocated nothing: the round is resolved.
    expect(report.unresolved).toEqual([]);
    expect(report.allDoneAt).not.toBeNull();
  });

  it("keep a sandbox the error names as this run's, and delete it by ID", async () => {
    const records: AttemptRecord[] = [];
    const created = new Set<string>();
    const noted: string[] = [];
    let allocated = "";

    // Beam's case: the container exists, unlabeled, when the create fails as outcome_unknown.
    const beam = provider((inner) => ({
      create: async () => {
        allocated = (await inner.create({ labels: {} })).id;
        throw new SandboxError("Beam create failed: the request may or may not have happened", {
          code: "outcome_unknown",
          provider: "beam",
          sandboxId: allocated,
        });
      },
    }));

    const report = await runRound(
      round(
        {
          size: 1,
          entry: entry({ provider: beam }),
          created,
          onSandbox: async (id) => {
            noted.push(id);
          },
        },
        records,
      ),
    );

    const [record] = report.records;

    expect(record?.burst.createError).toEqual({ code: "outcome_unknown", sandboxId: allocated });
    expect(record?.sandboxIds).toEqual([allocated]);
    expect(record?.deletionConfirmed).toBe(false);
    expect(created.has(allocated)).toBe(true);
    expect(noted).toEqual([allocated]);
    expect(report.leftovers).toMatchObject([{ id: allocated, destroyed: true, goneAfter: true }]);
    expect(await beam.list({})).toEqual([]);
    // Recovered by the cleanup, so the round ends when the cleanup confirmed it gone.
    expect(report.unresolved).toEqual([]);
    expect(report.allDoneAt).toBe(report.leftovers[0]?.confirmedAt);
  });

  it("leave the round unresolved when an unknown outcome names no sandbox", async () => {
    const records: AttemptRecord[] = [];

    const lost = provider(() => ({
      create: async () => {
        throw new SandboxError("create timed out", { code: "outcome_unknown", provider: "beam" });
      },
    }));

    const report = await runRound(round({ size: 1, entry: entry({ provider: lost }) }, records));

    expect(report.records[0]?.deletionConfirmed).toBe(false);
    expect(report.unresolved).toEqual([report.records[0]?.attemptId]);
    expect(report.allDoneAt).toBeNull();
  });
});

describe("a round's end", () => {
  it("is when the cleanup confirmed a recovered sandbox gone, not when its task ended", async () => {
    const records: AttemptRecord[] = [];

    // Deletion takes 30 ms, so the cleanup's confirmation comes well after the task's end.
    const slow = provider((inner) => ({
      destroy: async (id) => {
        await sleep(30);
        await inner.destroy(id);
      },
    }));

    const leaky = scripted((task) => ({ leak: task === 1 }), []);

    const report = await runRound(
      round(
        {
          size: 2,
          entry: entry({ provider: slow }),
          // The record ends when the attempt returns, as runAttempt's does.
          attempt: async (plan, environment) => {
            const outcome = await leaky(plan, environment);
            outcome.record.endedAt = Date.now();

            return outcome;
          },
        },
        records,
      ),
    );

    const leaked = records.find((r) => r.slot.index === 1);
    const confirmedAt = report.leftovers[0]?.confirmedAt ?? null;

    expect(confirmedAt).not.toBeNull();
    expect(confirmedAt ?? 0).toBeGreaterThanOrEqual((leaked?.endedAt ?? Infinity) + 30);
    expect(report.allDoneAt).toBe(confirmedAt);
  });

  it("is unknown while a sandbox could not be deleted, and a stalled deletion is not waited on", async () => {
    const records: AttemptRecord[] = [];
    const stuck = provider(() => ({ destroy: () => new Promise<never>(() => {}) }));

    const report = await runRound(
      round(
        {
          size: 2,
          entry: entry({ provider: stuck }),
          destroyTimeoutMs: 50,
          attempt: scripted(() => ({ leak: true }), []),
        },
        records,
      ),
    );

    expect(report.leftovers.map((l) => l.destroyed)).toEqual([false, false]);
    expect(report.unresolved).toHaveLength(2);
    expect(report.allDoneAt).toBeNull();
  }, 5_000);
});

describe("our side", () => {
  it("does not wait past the deadline for a per-task setup that ignores its abort", async () => {
    const records: AttemptRecord[] = [];
    const starts: number[] = [];

    const stalled = entry({
      beforeAttempt: async (attemptId) => {
        // Task 1's App lookup never returns and never looks at the signal.
        if (attemptId.includes("-t1-")) await new Promise<never>(() => {});

        return {
          labels: {},
          created: async () => {},
          failed: async () => {},
          destroyed: async () => {},
        };
      },
    });

    const report = await runRound(
      round(
        {
          size: 2,
          entry: stalled,
          manifest: withSlotTimeout(fixture.manifest, 100),
          attempt: scripted(() => ({}), starts),
        },
        records,
      ),
    );

    expect(starts).toHaveLength(1);
    expect(report.records[1]?.burst.harness).toMatchObject({ stage: "setup" });
    expect(report.records[1]?.sandboxIds).toEqual([]);
  }, 5_000);

  it("is a harness failure, apart from the provider's attempts", async () => {
    const records: AttemptRecord[] = [];
    const memoryProvider = memory();
    let journaled = 0;

    // A local App-journal write fails before any create; a sandbox journal write fails after one.
    const journal = entry({
      provider: memoryProvider,
      beforeAttempt: async (attemptId) => {
        if (attemptId.includes("-t0-")) throw new Error("ENOSPC: apps.jsonl");

        return {
          labels: {},
          created: async () => {},
          failed: async () => {},
          destroyed: async () => {},
        };
      },
    });

    const report = await runRound(
      round(
        {
          size: 3,
          entry: journal,
          onSandbox: async () => {
            journaled += 1;

            if (journaled === 1) throw new Error("ENOSPC: notes.jsonl");
          },
          attempt: scripted(() => ({}), []),
        },
        records,
      ),
    );

    expect(report.records.map((r) => r.burst.harness?.stage ?? "provider").sort()).toEqual([
      "journal",
      "provider",
      "setup",
    ]);
    expect(report.admitted).toBe(1);
    // The sandbox whose journal write failed was still deleted.
    expect(await memoryProvider.list({})).toEqual([]);
    expect(report.unresolved).toEqual([]);

    const row = summarizeProvider({
      provider: "e2b",
      tasks: report.records.map((record) => ({ round: 1, record })),
      rounds: [{ round: 1, size: 3, startedAt: report.startedAt, allDoneAt: report.allDoneAt }],
      solo: { kind: "published", medianWallS: 50 },
    });

    expect(row).toMatchObject({ status: "ran", attempts: 1, completed: 1 });
    expect(row.tasks).toHaveLength(1);
    expect(row.harnessFailures.map((h) => [h.role, h.round, h.stage]).sort()).toEqual([
      ["burst", 1, "journal"],
      ["burst", 1, "setup"],
    ]);
    // Two of 3 tasks never ran on the provider, so the round did not run 3 at once.
    expect(row.slowdown).toBeNull();
  });

  it("writing a record that fails still cleans up the round, then fails it", async () => {
    const memoryProvider = memory();

    await expect(
      runRound({
        ...round({ entry: entry({ provider: memoryProvider }), size: 2 }, []),
        attempt: scripted((task) => ({ leak: task === 1 }), []),
        onRecord: async () => {
          throw new Error("ENOSPC: attempts.jsonl");
        },
      }),
    ).rejects.toThrow(/Writing 2 attempt record/);
    expect(await memoryProvider.list({})).toEqual([]);
  });
});

describe("a partly admitted burst", () => {
  it("gets no slowdown unless some round had every task admitted", () => {
    const task = (round: number, index: number, refused: boolean) =>
      tagged(
        done({
          round,
          task: index,
          wallS: refused ? 0.2 : 100 + index,
          created: !refused,
          completion: refused
            ? { kind: "incomplete", reason: "create-failed", detail: "Instabox create failed" }
            : { kind: "completed" },
        }),
        { createError: refused ? { code: "quota", sandboxId: null } : null },
      );

    // Size 5, four creates refused: 1 task ran, alone in effect.
    const partial = Array.from({ length: 5 }, (_, i) => task(1, i, i > 0));

    const row = summarizeProvider({
      provider: "instabox",
      tasks: byBatch(partial),
      rounds: [{ round: 1, size: 5, startedAt: 0, allDoneAt: 101_000 }],
      solo: { kind: "published", medianWallS: 50 },
    });

    expect(row).toMatchObject({
      status: "ran",
      attempts: 1,
      medianWallS: 100,
      burstRounds: [{ round: 1, size: 5, admitted: 1, allDoneS: 101 }],
      slowdown: null,
      slowdownWithoutUpload: null,
      slowdownWithheld: "No burst round had all 5 of its tasks admitted",
    });

    // A second round admitted in full: the slowdown is given.
    const full = Array.from({ length: 5 }, (_, i) => task(2, i, false));

    const both = summarizeProvider({
      provider: "instabox",
      tasks: byBatch([...partial, ...full]),
      rounds: [
        { round: 1, size: 5, startedAt: 0, allDoneAt: 101_000 },
        { round: 2, size: 5, startedAt: 500_000, allDoneAt: 610_000 },
      ],
      solo: { kind: "published", medianWallS: 50 },
    });

    // The slowdown is from the fully admitted round only: 100 to 104, median 102, over 50. Round
    // 1's lone task ran alone in effect and stays out of it, though medianWallS counts it.
    expect(both).toMatchObject({ slowdownWithheld: null, slowdown: 2.04, medianWallS: 101.5 });
  });
});

describe("round spend", () => {
  const leftover = (id: string, confirmedAt: number): Leftover => ({
    id,
    destroyed: true,
    goneAfter: true,
    confirmedAt,
  });

  it("caps a late cleanup's time at the provider's hard lifetime, and caps nothing without one", () => {
    // $1 per second; the cleanup confirmed the sandbox gone 2,000 s after its start.
    const price = (_: StoredRecord, ms: number) => ms / 1000;
    const leaked = tagged(done({ round: 1, task: 1, wallS: 100 }));
    leaked.deletionConfirmed = false;

    const spend = (hardLifetimeMs: number | null) =>
      roundSpend({
        records: [leaked],
        leftovers: [leftover("sbx-1-1", 2_001_000)],
        perTaskUSD: 900,
        hardLifetimeMs,
        price,
      });

    // A 900 s hard lifetime: it cannot have billed past it, so the settlement stays in its share.
    expect(spend(900_000)).toBe(900);
    // No hard lifetime: it billed until it was confirmed gone.
    expect(spend(null)).toBe(2_000);
  });

  it("charges an unresolved task its whole reservation and a recovered one until it was confirmed gone", () => {
    // $1 per second of sandbox.
    const price = (_: StoredRecord, ms: number) => ms / 1000;
    const finished = tagged(done({ round: 1, task: 0, wallS: 100 }));
    const leaked = tagged(done({ round: 1, task: 1, wallS: 100 }));
    leaked.deletionConfirmed = false;
    const lost = tagged(done({ round: 1, task: 2, wallS: 100 }));
    lost.deletionConfirmed = false;

    const spend = (records: StoredRecord[], leftovers: Leftover[]) =>
      roundSpend({ records, leftovers, perTaskUSD: 1_000, hardLifetimeMs: null, price });

    expect(spend([finished], [])).toBe(100.5);
    // Its record ended at 101.5 s; the cleanup confirmed it gone 300 s after the start.
    expect(spend([leaked], [leftover("sbx-1-1", 301_000)])).toBe(300);
    // Nothing confirmed its deletion: it may bill to its lifetime.
    expect(spend([lost], [])).toBe(1_000);
  });

  it("reserves through the longest billable lifetime, so settlements stay under the ceiling", () => {
    // $1 per minute; a 30-minute slot. The old reservation was the slot alone ($30 a task).
    const perMinute = (ms: number) => ms / 60_000;
    const perTask = perMinute(billableLifetimeMs(30 * 60_000));

    expect(perTask).toBe(45);

    // Two 1-task rounds fit a $90 ceiling; each task ran the slot, the grace and the cleanup.
    const guard = spendGuard(90);

    expect(guard.reserve(perTask)).toBe(true);
    expect(guard.reserve(perTask)).toBe(true);

    const record = tagged(done({ round: 1, task: 0, wallS: 30 * 60 + 150 + 120 + 60 }));

    const spent = roundSpend({
      records: [record],
      leftovers: [],
      perTaskUSD: perTask,
      hardLifetimeMs: billableLifetimeMs(30 * 60_000),
      price: (_, ms) => perMinute(ms),
    });

    expect(spent).toBeLessThanOrEqual(perTask);
    guard.settle({ reservedUSD: perTask, spentUSD: spent });
    guard.settle({ reservedUSD: perTask, spentUSD: spent });
    expect(guard.state().spentUSD).toBeLessThanOrEqual(90);
  });
});

/** A provider's rounds with a fake round runner, writing into memory. */
function rounds({
  capUSD,
  perTaskUSD,
  control,
  round: run,
  hardLifetimeMs = 45 * 60_000,
  guard = spendGuard(capUSD),
}: {
  capUSD: number;
  perTaskUSD: number;
  control: boolean;
  round: ProviderRounds["runRound"];
  hardLifetimeMs?: number | null;
  guard?: ReturnType<typeof spendGuard>;
}) {
  const lines: RoundLineInput[] = [];
  const notes: { kind: string }[] = [];
  const notRun: string[] = [];

  const plan: ProviderRounds = {
    name: "e2b",
    schedule: roundSchedule({ rounds: 2, size: 2, control }),
    guard,
    perTaskUSD,
    hardLifetimeMs,
    price: () => 0.01,
    runRound: run,
    writeRound: async (line) => {
      lines.push(line);
    },
    notRun: async (reason) => {
      notRun.push(reason);
    },
    note: async (entry) => {
      notes.push(entry);
    },
    say: () => {},
    sleep: async () => {},
  };

  return { plan, lines, notes, notRun, guard };
}

const emptyListing = { at: 0, ids: [], runIds: [], error: null };

const report = (step: ScheduledRound): RoundReport => ({
  provider: "e2b",
  round: step.round,
  role: step.role,
  batch: 1,
  size: step.size,
  startedAt: 0,
  allDoneAt: 1_000,
  admitted: step.size,
  unresolved: [],
  before: emptyListing,
  after: emptyListing,
  ownBefore: [],
  leftovers: [],
  records: [],
});

describe("a provider's rounds", () => {
  it("keep a failed round's whole reservation and skip the burst rounds after it", async () => {
    const run = rounds({
      capUSD: 100,
      perTaskUSD: 5,
      control: false,
      round: async () => {
        throw new Error("Writing 2 attempt record(s) failed: ENOSPC");
      },
    });

    await runProviderRounds(run.plan);

    // Two tasks ran and may have billed: their $10 stays spent, not $0.
    expect(run.guard.state()).toMatchObject({ spentUSD: 10, reservedUSD: 0 });
    // The round is marked failed, so the export leaves out any record of it that was written.
    expect(run.lines).toEqual([
      expect.objectContaining({
        kind: "failed",
        role: "burst",
        round: 1,
        reason: expect.stringContaining("ENOSPC"),
      }),
      expect.objectContaining({ kind: "skipped", role: "burst", round: 2 }),
    ]);
  });

  it("are not run when the ceiling fits a control round but not the first burst", async () => {
    // A control task reserves $7, a burst round of 2 $14; the ceiling is $12.
    const run = rounds({ capUSD: 12, perTaskUSD: 7, control: true, round: async (s) => report(s) });

    await runProviderRounds(run.plan);

    expect(
      run.lines.map((l) => [l.kind, "role" in l ? l.role : null, "round" in l ? l.round : null]),
    ).toEqual([
      ["round", "control", 1],
      ["skipped", "burst", 1],
      ["skipped", "burst", 2],
    ]);
    expect(run.notRun).toHaveLength(1);
    expect(run.notRun[0]).toMatch(/^spend ceiling/);
  });
});

describe("the output folder", () => {
  it("is refused when it already holds a run, and nothing in it is replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-used-"));

    try {
      const runJson = JSON.stringify({ id: "earlier" });
      await writeFile(join(dir, "run.json"), runJson);
      await writeFile(join(dir, "attempts.jsonl"), "");
      const solo = join(dir, "solo.json");
      await writeFile(solo, JSON.stringify({ rows: [] }));

      await expect(
        burstCommand([
          "--out",
          dir,
          "--run",
          "later",
          "--providers",
          "e2b",
          "--solo",
          solo,
          "--manifest",
          join(dir, "no-such-manifest.json"),
        ]),
      ).rejects.toThrow(/already holds a run \(run\.json, attempts\.jsonl\)/);
      expect(await readFile(join(dir, "run.json"), "utf8")).toBe(runJson);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("local artifacts", () => {
  it("are read and checked before any round, and a missing or corrupt one stops the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-artifacts-"));

    try {
      const good = new TextEncoder().encode("toolchain bytes");
      const bad = new TextEncoder().encode("cache bytes");
      await writeFile(join(dir, "toolchain.tar"), good);
      await writeFile(join(dir, "cache.tar"), bad);
      const goodSha = sha256Hex(good);
      const badSha = sha256Hex(new TextEncoder().encode("what the manifest froze"));

      await expect(
        preloadArtifacts({
          required: new Map([
            [goodSha, "toolchain"],
            ["0".repeat(64), "patch A"],
          ]),
          found: new Map([[goodSha, join(dir, "toolchain.tar")]]),
        }),
      ).rejects.toThrow(/Local artifacts missing: patch A/);

      await expect(
        preloadArtifacts({
          required: new Map([[badSha, "cache"]]),
          found: new Map([[badSha, join(dir, "cache.tar")]]),
        }),
      ).rejects.toThrow(/has hash/);

      const source = await preloadArtifacts({
        required: new Map([[goodSha, "toolchain"]]),
        found: new Map([[goodSha, join(dir, "toolchain.tar")]]),
      });

      // Read once, before the run: a task's upload no longer touches the disk.
      await rm(join(dir, "toolchain.tar"));
      expect(new TextDecoder().decode(await source.read(goodSha))).toBe("toolchain bytes");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("required for Fix and test are its toolchain, cache and patches for every architecture", () => {
    const required = requiredArtifacts(fixture.manifest, "fix-and-test");
    const profile = fixture.manifest.profiles["fix-and-test"];

    for (const patch of Object.values(profile?.patches ?? {}))
      expect(required.has(patch.sha256)).toBe(true);
    expect([...required.values()].some((name) => name.includes("toolchain"))).toBe(true);
  });
});

describe("the site data file, from tagged records", () => {
  it("places a control task by its record when its round line was never written, and lists skipped rounds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-export-tagged-"));

    try {
      await writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          id: "rtb-test",
          sdkCommit: "abc1234",
          startedAt: "2026-11-19T10:00:00.000Z",
          endedAt: "2026-11-19T11:00:00.000Z",
          location: "Boca Raton, FL (evo-1)",
          size: 2,
          rounds: 2,
          track: "same-machine",
          profile: "fix-and-test",
          providers: ["e2b", "vercel"],
          budgetUSD: 10,
          mode: "one-provider-at-a-time",
          control: true,
        }),
      );

      const listing = { at: 0, ids: [], runIds: [], error: null };

      const line = (
        provider: string,
        role: string,
        round: number,
        size: number,
        ids: string[],
      ) => ({
        kind: "round",
        provider,
        round,
        role,
        size,
        startedAt: 1_000_000 * round,
        allDoneAt: 1_000_000 * round + 131_000,
        admitted: size,
        before: listing,
        after: listing,
        ownBefore: [],
        leftovers: [],
        attemptIds: ids,
      });

      await writeFile(
        join(dir, "rounds.jsonl"),
        [
          line("e2b", "control", 1, 1, ["rtb-test-c1-t0-e2b"]),
          line("e2b", "burst", 1, 2, ["rtb-test-r1-t0-e2b", "rtb-test-r1-t1-e2b"]),
          // Control round 2's record was written; the process stopped before its round line.
          { kind: "skipped", provider: "e2b", role: "burst", round: 2, reason: "round-error" },
          // vercel: the ceiling fit its control round but not its first burst.
          line("vercel", "control", 1, 1, ["rtb-test-c1-t0-vercel"]),
          { kind: "skipped", provider: "vercel", role: "burst", round: 1, reason: "spend ceiling" },
          { kind: "skipped", provider: "vercel", role: "burst", round: 2, reason: "spend ceiling" },
          { kind: "not-run", provider: "vercel", reason: "spend ceiling: $9 spent" },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );

      const control = (round: number, batch: number, wallS: number, provider = "e2b") => {
        const record = done({
          round: batch,
          task: 0,
          wallS,
          attemptId: `rtb-test-c${round}-t0-${provider}`,
        });

        record.provider = provider;

        return tagged(record, { role: "control", round });
      };

      await writeFile(
        join(dir, "attempts.jsonl"),
        [
          control(1, 1, 100),
          tagged(done({ round: 2, task: 0, wallS: 120, attemptId: "rtb-test-r1-t0-e2b" }), {
            round: 1,
          }),
          tagged(done({ round: 2, task: 1, wallS: 130, attemptId: "rtb-test-r1-t1-e2b" }), {
            round: 1,
          }),
          // Batch 3 in run order: an untagged record there would read as burst round 3.
          control(2, 3, 110),
          control(1, 1, 90, "vercel"),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );

      const data = await buildExport([dir], new Map());
      const [e2b, vercel] = data.providers;

      expect(e2b).toMatchObject({
        status: "ran",
        attempts: 2,
        medianWallS: 125,
        solo: { completed: 2, attempts: 2 },
        soloMedianWallS: 105,
        skippedBurstRounds: [2],
      });
      expect(e2b?.tasks.map((t) => t.round)).toEqual([1, 1]);
      expect(vercel).toMatchObject({
        status: "not-run",
        reason: "spend ceiling: $9 spent",
        attempts: 0,
        skippedBurstRounds: [1, 2],
        solo: { completed: 1 },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a create the SDK stopped waiting on", () => {
  it("is followed to the end: a sandbox its late error names is owned and deleted by ID", async () => {
    const records: AttemptRecord[] = [];
    const created = new Set<string>();
    const noted: string[] = [];
    let allocated = "";

    // Beam's half-create, answered after the slot timeout: the SDK has already returned `aborted`.
    const beam = provider((inner) => ({
      create: async () => {
        allocated = (await inner.create({ labels: {} })).id;
        await sleep(300);
        throw new SandboxError("Beam create failed: the request may or may not have happened", {
          code: "outcome_unknown",
          provider: "beam",
          sandboxId: allocated,
        });
      },
    }));

    const report = await runRound(
      round(
        {
          size: 1,
          entry: entry({ provider: beam }),
          manifest: withSlotTimeout(fixture.manifest, 100),
          created,
          onSandbox: async (id) => {
            noted.push(id);
          },
        },
        records,
      ),
    );

    const [record] = report.records;

    expect(record?.completion).toMatchObject({ reason: "slot-timeout" });
    expect(record?.burst.createError).toEqual({ code: "outcome_unknown", sandboxId: allocated });
    expect(record?.sandboxIds).toEqual([allocated]);
    expect(created.has(allocated)).toBe(true);
    expect(noted).toEqual([allocated]);
    expect(report.leftovers).toMatchObject([{ id: allocated, destroyed: true, goneAfter: true }]);
    expect(await beam.list({})).toEqual([]);
    expect(report.unresolved).toEqual([]);
  }, 5_000);

  it("owns a sandbox the create returned after the abort", async () => {
    const records: AttemptRecord[] = [];
    let allocated = "";

    const slow = provider((inner) => ({
      create: async (input) => {
        await sleep(300);
        const info = await inner.create(input);
        allocated = info.id;

        return info;
      },
    }));

    const report = await runRound(
      round(
        {
          size: 1,
          entry: entry({ provider: slow }),
          manifest: withSlotTimeout(fixture.manifest, 100),
        },
        records,
      ),
    );

    const [record] = report.records;

    expect(record?.burst.createError).toEqual({ code: "aborted", sandboxId: allocated });
    expect(record?.sandboxIds).toEqual([allocated]);
    expect(await slow.list({})).toEqual([]);
    expect(report.unresolved).toEqual([]);
  }, 5_000);
});

describe("the cleanup's result", () => {
  it("overrides an attempt's confirmed deletion that the listing after the round contradicts", async () => {
    const records: AttemptRecord[] = [];

    const stuck = provider(() => ({
      destroy: async () => {
        throw new Error("delete refused");
      },
    }));

    const leaky = scripted(() => ({ leak: true }), []);

    const report = await runRound(
      round(
        {
          size: 1,
          entry: entry({ provider: stuck }),
          // The attempt says its deletion was confirmed, but the sandbox is still there.
          attempt: async (plan, environment) => {
            const outcome = await leaky(plan, environment);
            outcome.record.deletionConfirmed = true;

            return outcome;
          },
        },
        records,
      ),
    );

    expect(report.leftovers).toMatchObject([{ destroyed: false, goneAfter: false }]);
    expect(report.unresolved).toEqual([report.records[0]?.attemptId]);
    expect(report.allDoneAt).toBeNull();

    // When the cleanup did delete it, the task ends when the cleanup confirmed it gone.
    const record = tagged(done({ round: 1, task: 0, wallS: 100 }));

    expect(
      taskEnd(record, [{ id: "sbx-1-0", destroyed: true, goneAfter: true, confirmedAt: 500_000 }]),
    ).toEqual({ kind: "recovered", at: 500_000 });
  });
});

describe("admitted tasks", () => {
  it("are only those the provider allocated a sandbox for; other refusals stay failed attempts", async () => {
    const records: AttemptRecord[] = [];
    const ok = scripted(() => ({}), []);

    // Task 0 runs; the other four creates are refused for a bad key, not an account limit.
    const attempt: typeof runAttempt = async (plan, environment) => {
      if (plan.slot.index === 0) return ok(plan, environment);

      const error = new SandboxError("E2B create failed: invalid API key", {
        code: "auth",
        provider: "e2b",
      });

      await environment.onCreateFailed?.(plan.provider.name, error);

      const record = emptyRecord(
        { ...plan, provider: plan.provider.name },
        "create-failed",
        error.message,
        Date.now(),
        environment.attribution,
      );

      record.deletionConfirmed = true;

      return { record, trace: new ProviderTrace(systemClock) };
    };

    const report = await runRound(round({ size: 5, attempt }, records));

    expect(report.admitted).toBe(1);

    const row = summarizeProvider({
      provider: "e2b",
      tasks: report.records.map((record) => ({ round: 1, record })),
      rounds: [{ round: 1, size: 5, startedAt: report.startedAt, allDoneAt: report.allDoneAt }],
      solo: { kind: "published", medianWallS: 50 },
    });

    expect(row).toMatchObject({
      attempts: 5,
      completed: 1,
      burstRounds: [{ round: 1, size: 5, admitted: 1 }],
      slowdown: null,
    });
    expect(row.tasks.filter((t) => t.failure?.stage === "create")).toHaveLength(4);
  });
});

describe("a provider with no hard lifetime", () => {
  it("stops every provider's rounds once a round leaves one of its sandboxes unresolved", async () => {
    const unresolvedRound = async (step: ScheduledRound) => ({
      ...report(step),
      allDoneAt: null,
      unresolved: [`rtb-test-r${step.round}-t0-e2b`],
    });

    const guard = spendGuard(100);

    const run = rounds({
      capUSD: 100,
      perTaskUSD: 5,
      control: false,
      hardLifetimeMs: null,
      guard,
      round: unresolvedRound,
    });

    await runProviderRounds(run.plan);

    expect(run.lines.map((l) => [l.kind, "round" in l ? l.round : null])).toEqual([
      ["round", 1],
      ["skipped", 2],
    ]);
    // Another provider's next round is not admitted either, and does not wait for room.
    expect(guard.couldFit(1)).toBe(false);
    expect(guard.reserve(1)).toBe(false);

    // With a hard lifetime the same round bounds its own spend, and the run goes on.
    const bounded = rounds({
      capUSD: 100,
      perTaskUSD: 5,
      control: false,
      round: unresolvedRound,
    });

    await runProviderRounds(bounded.plan);
    expect(bounded.lines.map((l) => l.kind)).toEqual(["round", "round"]);
  });
});

describe("the final sweep", () => {
  const slot = (name: string, inner: SlotProvider["provider"]): SlotProvider => ({
    name,
    provider: inner,
    attribution: attributionFor("e2b").attribution,
    settlementMs: null,
    paddingMs: 0,
  });

  it("deletes known IDs when a listing fails, and a stalled provider does not stop the next", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-sweep-"));

    try {
      // Unlabeled sandboxes the run owns (a create error named them), on three providers.
      const failing = memory();
      const a = (await failing.create({ labels: {} })).id;
      const stalling = memory();
      const b = (await stalling.create({ labels: {} })).id;
      const fine = memory();
      const c = (await fine.create({ labels: { "sandbox-bench-run": "rtb-sweep" } })).id;

      const result = await sweepProviders(
        "rtb-sweep",
        [
          slot("e2b", {
            ...failing,
            list: async () => {
              throw new Error("listing failed");
            },
          }),
          slot("vercel", { ...stalling, list: () => new Promise<never>(() => {}) }),
          slot("daytona", fine),
        ],
        async () => {},
        dir,
        {
          // Live ownership: no attempt record names these.
          known: new Map([
            ["e2b", new Set([a])],
            ["vercel", new Set([b])],
          ]),
          callTimeoutMs: 50,
        },
      );

      expect(await failing.list({})).toEqual([]);
      expect(await stalling.list({})).toEqual([]);
      expect(await fine.list({})).toEqual([]);
      expect(c).toBeTruthy();
      // Both failed listings are reported, so the run still fails and says so.
      expect(result).toEqual({ unchecked: 0, failed: 2, undeleted: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 5_000);
});

describe("a round that throws", () => {
  it("is left out of every count, and its reason is published", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-export-failed-"));

    try {
      await writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          id: "rtb-test",
          sdkCommit: "abc1234",
          startedAt: "2026-11-19T10:00:00.000Z",
          endedAt: "2026-11-19T11:00:00.000Z",
          location: "Boca Raton, FL (evo-1)",
          size: 2,
          rounds: 2,
          track: "same-machine",
          profile: "fix-and-test",
          providers: ["e2b"],
          budgetUSD: 10,
          mode: "one-provider-at-a-time",
          control: false,
        }),
      );

      const listing = { at: 0, ids: [], runIds: [], error: null };

      await writeFile(
        join(dir, "rounds.jsonl"),
        [
          {
            kind: "round",
            provider: "e2b",
            round: 1,
            role: "burst",
            size: 2,
            startedAt: 0,
            allDoneAt: 131_000,
            admitted: 2,
            before: listing,
            after: listing,
            ownBefore: [],
            leftovers: [],
            attemptIds: ["rtb-test-r1-t0-e2b", "rtb-test-r1-t1-e2b"],
          },
          // Round 2 wrote one record, then a second write failed and the round threw.
          {
            kind: "failed",
            provider: "e2b",
            role: "burst",
            round: 2,
            reason: "round 2 failed before it finished: ENOSPC",
          },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );

      await writeFile(
        join(dir, "attempts.jsonl"),
        [
          tagged(done({ round: 1, task: 0, wallS: 120 })),
          tagged(done({ round: 1, task: 1, wallS: 130 })),
          tagged(done({ round: 2, task: 0, wallS: 999 })),
        ]
          .map((r) => JSON.stringify(r))
          .join("\n") + "\n",
      );

      const [e2b] = (await buildExport([dir], new Map([["e2b", 100]]))).providers;

      expect(e2b).toMatchObject({
        status: "ran",
        attempts: 2,
        medianWallS: 125,
        slowdown: 1.25,
        harnessFailures: [
          {
            role: "burst",
            round: 2,
            stage: "round",
            reason: "round 2 failed before it finished: ENOSPC",
          },
        ],
      });
      expect(e2b?.tasks.map((t) => t.round)).toEqual([1, 1]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // When the only burst round failed, the provider is not run, and the reason says why.
    const row = summarizeProvider({
      provider: "e2b",
      tasks: [{ round: 1, record: tagged(done({ round: 1, task: 0, wallS: 120 })) }],
      rounds: [],
      solo: { kind: "published", medianWallS: 100 },
      failed: [{ role: "burst", round: 1, reason: "round 1 failed before it finished: ENOSPC" }],
    });

    expect(row).toMatchObject({
      status: "not-run",
      reason: "our side: round 1 failed before it finished: ENOSPC",
      attempts: 0,
    });
  });
});

describe("claiming the output folder", () => {
  it("lets only one of two runs that start together write there", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rtb-claim-"));
    const out = join(dir, "out");

    const info = (id: string): Parameters<typeof claimOutput>[1] => ({
      id,
      sdkCommit: "abc1234",
      startedAt: "2026-11-19T10:00:00.000Z",
      endedAt: null,
      location: "Boca Raton, FL (evo-1)",
      size: 5,
      rounds: 2,
      track: "same-machine",
      profile: "fix-and-test",
      providers: ["e2b"],
      budgetUSD: 10,
      mode: "parallel",
      control: false,
    });

    try {
      const results = await Promise.allSettled([
        claimOutput(out, info("first")),
        claimOutput(out, info("second")),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      const winner = results[0]?.status === "fulfilled" ? "first" : "second";
      const stored: unknown = JSON.parse(await readFile(join(out, "run.json"), "utf8"));

      expect(stored).toMatchObject({ id: winner });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a provider not run before its first round", () => {
  it("has every scheduled burst round recorded as skipped", () => {
    const reason =
      "Daytona's account allows 10 vCPU in total; 5 tasks x 4 vCPU = 20 vCPU does not fit";

    expect(
      notRunLines({
        provider: "daytona",
        schedule: roundSchedule({ rounds: 2, size: 5, control: true }),
        reason,
      }),
    ).toEqual([
      { kind: "skipped", provider: "daytona", role: "burst", round: 1, reason },
      { kind: "skipped", provider: "daytona", role: "burst", round: 2, reason },
      { kind: "not-run", provider: "daytona", reason },
    ]);
  });
});
