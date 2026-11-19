import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { runAttempt } from "../../src/realistic/attempt.js";
import { buildExport, soloMedians } from "../../src/realistic/burst-cli.js";
import {
  accountRefusal,
  runPool,
  runRound,
  spendGuard,
  summarizeProvider,
  taskResult,
  type RoundPlan,
} from "../../src/realistic/burst.js";
import { ProviderTrace, systemClock } from "../../src/realistic/gaps.js";
import type { HarnessManifest } from "../../src/realistic/manifest.js";
import { attemptRecordSchema, type AttemptRecord } from "../../src/realistic/record.js";
import { attributionFor, emptyRecord, type SlotProvider } from "../../src/realistic/slots.js";
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
    expect(report.allDoneAt - report.startedAt).toBeGreaterThanOrEqual(300);
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
    expect(report.leftovers).toEqual([{ id: leaked, destroyed: true, goneAfter: true }]);
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
}: {
  round: number;
  task: number;
  wallS: number;
  completion?: AttemptRecord["completion"];
  created?: boolean;
  lastPhase?: "create" | "prepare" | "workload";
}): AttemptRecord {
  const record = emptyRecord(
    {
      runId: "rtb-test",
      attemptId: `rtb-test-r${batch}-t${task}-e2b`,
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
        ...(lastPhase === "workload"
          ? [{ name: "workload" as const, startedAt: 1_200, endedAt: end - 100 }]
          : []),
        { name: "destroy", startedAt: end - 100, endedAt: end },
      ]
    : [];

  return record;
}

describe("task results", () => {
  it("time each task from the create request to the confirmed deletion, not the record's end", () => {
    expect(taskResult(done({ round: 1, task: 0, wallS: 90 }))).toEqual({
      round: 1,
      wallS: 90,
      completed: true,
    });
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
    { round: 1, startedAt: 0, allDoneAt: 120_500 },
    { round: 2, startedAt: 500_000, allDoneAt: 610_000 },
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

    const row = summarizeProvider({ provider: "e2b", records, rounds, soloMedianWallS: 100 });

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
      records: [done({ round: 1, task: 0, wallS: 100 }), refused(1, 1)],
      rounds: rounds.slice(0, 1),
      soloMedianWallS: 50,
    });

    expect(mixed).toMatchObject({ status: "ran", attempts: 1, completed: 1, slowdown: 2 });

    const none = summarizeProvider({
      provider: "e2b",
      records: [refused(1, 0), refused(1, 1)],
      rounds: rounds.slice(0, 1),
      soloMedianWallS: 50,
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
        records: [],
        rounds: [],
        soloMedianWallS: 92.8,
        notRun: "Daytona's account allows 10 vCPU in total",
      }),
    ).toEqual({
      provider: "daytona",
      status: "not-run",
      reason: "Daytona's account allows 10 vCPU in total",
      tasks: [],
      medianWallS: null,
      completed: 0,
      attempts: 0,
      roundAllDoneS: [],
      soloMedianWallS: 92.8,
      slowdown: null,
    });
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
    expect(() => spendGuard(Number.NaN)).toThrow(/positive/);
  });
});

describe("the site data file", () => {
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
