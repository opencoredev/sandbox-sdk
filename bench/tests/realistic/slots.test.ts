import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runAttempt } from "../../src/realistic/attempt.js";
import { ProviderTrace, systemClock } from "../../src/realistic/gaps.js";
import { attemptRecordSchema, type AttemptRecord } from "../../src/realistic/record.js";
import {
  attributionFor,
  batchSeed,
  edgeAtOrAfter,
  emptyRecord,
  runBatch,
  slotOrder,
  type BatchPlan,
  type SlotProvider,
  type SlotSpec,
} from "../../src/realistic/slots.js";
import { buildFixture, type Fixture } from "./fixture.js";
import { hostProvider, type HostProvider } from "./host-provider.js";

let fixture: Fixture;

beforeAll(async () => {
  fixture = await buildFixture();
});

afterAll(() => fixture.cleanup());

const headline: SlotSpec = {
  id: "fat-same",
  profile: "fix-and-test",
  track: "same-machine",
  variant: "headline",
};

const zeroWait: SlotSpec = {
  id: "zero-wait",
  profile: "fix-and-test",
  track: "same-machine",
  variant: "zero-wait",
  idle: { policy: "provider-defaults", idleMs: 0 },
};

const slots: SlotSpec[] = [
  headline,
  { id: "fat-same-twin", profile: "fix-and-test", track: "same-machine", variant: "instrumented" },
  {
    id: "held-10",
    profile: "fix-and-test",
    track: "same-machine",
    variant: "held-open",
    idle: { policy: "provider-defaults", idleMs: 600_000 },
  },
  zeroWait,
  { id: "prepared", profile: "fix-and-test", track: "same-machine", variant: "prepared" },
];

const sleep = (ms: number, signal?: AbortSignal) => systemClock.sleep(ms, signal);

type Behaviour = { durationMs?: number; delayMs?: number; hang?: boolean };

/** A scripted attempt: records when it started, waits, honours the slot's abort. */
function scripted(behaviour: (provider: string, slot: string) => Behaviour, log: string[]) {
  const fake: typeof runAttempt = async (plan, environment) => {
    const at = Date.now();
    log.push(`${plan.slot.id}:${plan.provider.name}:start`);
    const script = behaviour(plan.provider.name, plan.slot.id);
    let completion: AttemptRecord["completion"] = { kind: "completed" };

    try {
      if (script.hang) await sleep(60_000, environment.signal);
      else await sleep(script.durationMs ?? 20, environment.signal);
    } catch {
      completion = { kind: "incomplete", reason: "slot-timeout", detail: "aborted" };
    }

    log.push(`${plan.slot.id}:${plan.provider.name}:end`);

    const record = emptyRecord(
      { ...plan, provider: plan.provider.name },
      "error",
      "",
      at + (script.delayMs ?? 0),
      environment.attribution,
    );

    record.completion = completion;
    record.sandboxIds = [`${plan.provider.name}-${plan.slot.index}`];

    return { record, trace: new ProviderTrace(systemClock) };
  };

  return fake;
}

const provider = (name: string, overrides: Partial<SlotProvider> = {}): SlotProvider => ({
  name,
  provider: memory(),
  attribution: attributionFor(name).attribution,
  settlementMs: null,
  paddingMs: 0,
  ...overrides,
});

const batch = (overrides: Partial<BatchPlan>, records: AttemptRecord[]): BatchPlan => ({
  runId: "rw-slots",
  batch: 2,
  seed: 20261105,
  manifest: fixture.manifest,
  manifestSha256: null,
  slots,
  providers: [provider("e2b"), provider("upstash"), provider("boxd")],
  clock: systemClock,
  blobs: fixture.blobs,
  prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
  onRecord: async (record) => {
    records.push(record);
  },
  ...overrides,
});

describe("slot order", () => {
  it("is drawn once per batch from the published seed and shared by every provider", async () => {
    const order = slotOrder(slots, 20261105, 2).map((s) => s.id);

    expect(slotOrder(slots, 20261105, 2).map((s) => s.id)).toEqual(order);
    expect(new Set(order)).toEqual(new Set(slots.map((s) => s.id)));

    const orders = new Set(
      Array.from({ length: 6 }, (_, b) =>
        slotOrder(slots, 20261105, b)
          .map((s) => s.id)
          .join(),
      ),
    );

    expect(orders.size).toBeGreaterThan(1);
    expect(batchSeed(20261105, 2)).not.toBe(batchSeed(20261105, 3));
    const records: AttemptRecord[] = [];
    const log: string[] = [];
    const report = await runBatch(batch({ attempt: scripted(() => ({}), log) }, records));

    expect(report.order).toEqual(order);

    for (const name of ["e2b", "upstash", "boxd"])
      expect(records.flatMap((r) => (r.provider === name ? [r.slot.id] : []))).toEqual(order);
  });

  it("refuses two slots for the same profile, track and variant: twins get their own window", () => {
    expect(() => slotOrder([...slots, { ...headline, id: "again" }], 1, 0)).toThrow(/own window/);
  });
});

describe("slot execution", () => {
  it("starts every provider together, records offsets, and waits for the slowest before the next slot", async () => {
    const records: AttemptRecord[] = [];
    const log: string[] = [];

    const report = await runBatch(
      batch(
        {
          slots: slots.slice(0, 2),
          startWindowMs: 50,
          attempt: scripted(
            (name) => (name === "boxd" ? { durationMs: 300, delayMs: 120 } : { durationMs: 20 }),
            log,
          ),
        },
        records,
      ),
    );

    const [first, second] = report.order;
    const lastEndOfFirst = log.lastIndexOf(`${first}:boxd:end`);

    for (const name of ["e2b", "upstash", "boxd"])
      expect(log.indexOf(`${second}:${name}:start`)).toBeGreaterThan(lastEndOfFirst);

    for (const record of records) expect(record.startOffsetMs).toBeGreaterThanOrEqual(0);
    expect(report.slots[0]?.lateStarts).toEqual(["boxd"]);
    expect(records.find((r) => r.provider === "boxd")?.startOffsetMs).toBeGreaterThanOrEqual(120);
  });

  it("abandons an attempt that ignores the abort after the grace, keeping its sandbox IDs", async () => {
    const records: AttemptRecord[] = [];

    const quick = {
      ...fixture.manifest,
      profiles: {
        "fix-and-test": { ...fixture.manifest.profiles["fix-and-test"]!, slotTimeoutMs: 100 },
      },
    };

    const stubborn: typeof runAttempt = async (plan, environment) => {
      await environment.onSandbox?.(plan.provider.name, "stuck-1");
      await sleep(5_000);

      throw new Error("never seen");
    };

    const started = Date.now();

    const report = await runBatch(
      batch(
        {
          manifest: quick,
          slots: slots.slice(0, 1),
          providers: [provider("e2b")],
          timeoutGraceMs: 100,
          attempt: stubborn,
        },
        records,
      ),
    );

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(report.slots[0]?.timedOut).toEqual(["e2b"]);
    const [abandoned] = records;

    if (!abandoned) throw new Error("Expected the abandoned attempt's record");
    expect(abandoned.endedAt - abandoned.startedAt).toBeGreaterThanOrEqual(150);
    expect(abandoned.startOffsetMs).toBeLessThan(50);
    expect(records[0]).toMatchObject({
      sandboxIds: ["stuck-1"],
      deletionConfirmed: false,
      completion: { kind: "incomplete", reason: "slot-timeout" },
    });
  });

  it("voids a window whose listing is only SDK-scoped", async () => {
    const records: AttemptRecord[] = [];
    await runBatch(
      batch(
        {
          slots: slots.slice(0, 1),
          providers: [provider("e2b")],
          attempt: scripted(() => ({}), []),
        },
        records,
      ),
    );

    expect(records[0]?.costEvidence.window).toMatchObject({
      listingScope: "sdk-scoped",
      void: true,
      voidReasons: ["Listing is SDK-scoped: sandboxes made outside the SDK are invisible"],
    });
  });

  it("lists each provider at its own window edges", async () => {
    const records: AttemptRecord[] = [];

    const boxd = provider("boxd", {
      settlementMs: 300,
      paddingMs: 30,
      listAccount: async () => [],
    });

    const e2b = provider("e2b", { paddingMs: 10, listAccount: async () => [] });

    const report = await runBatch(
      batch(
        {
          slots: slots.slice(0, 1),
          providers: [boxd, e2b],
          attempt: scripted(() => ({ durationMs: 30 }), []),
        },
        records,
      ),
    );

    const slot = report.slots[0];

    for (const window of slot?.windows ?? []) {
      const [open, close] = window.listings;

      expect(open?.at).toBeGreaterThanOrEqual(window.openedAt);
      expect(open?.at).toBeLessThanOrEqual(slot?.startedAt ?? -Infinity);
      expect(close?.at).toBeGreaterThanOrEqual(window.closedAt);
    }

    const e2bWindow = slot?.windows.find((w) => w.provider === "e2b");

    // e2b's window opens just before the start and closes just after its attempt, not at boxd's edges.
    expect((slot?.startedAt ?? 0) - (e2bWindow?.openedAt ?? 0)).toBeLessThan(50);
    expect(e2bWindow?.closedAt).toBeLessThan(
      slot?.windows.find((w) => w.provider === "boxd")?.closedAt ?? -Infinity,
    );
  });

  it("ends a hung attempt at the slot's frozen timeout and goes on", async () => {
    const records: AttemptRecord[] = [];

    const quick = {
      ...fixture.manifest,
      profiles: {
        "fix-and-test": { ...fixture.manifest.profiles["fix-and-test"]!, slotTimeoutMs: 200 },
      },
    };

    const started = Date.now();

    const report = await runBatch(
      batch(
        {
          manifest: quick,
          slots: slots.slice(0, 2),
          attempt: scripted((name) => (name === "upstash" ? { hang: true } : {}), []),
        },
        records,
      ),
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report.slots.map((s) => s.timedOut)).toEqual([["upstash"], ["upstash"]]);
    expect(
      records.filter((r) => r.provider === "e2b").every((r) => r.completion.kind === "completed"),
    ).toBe(true);
  });

  it("counts a failed health check as an unavailable attempt and pauses after 3 in a row", async () => {
    const records: AttemptRecord[] = [];
    let listings = 0;

    const down = provider("superserve", {
      listAccount: async () => {
        listings++;
        throw new Error("503");
      },
    });

    const report = await runBatch(
      batch({ providers: [provider("e2b"), down], attempt: scripted(() => ({}), []) }, records),
    );

    const reasons = records.flatMap((r) =>
      r.provider !== "superserve"
        ? []
        : [r.completion.kind === "incomplete" ? r.completion.reason : "completed"],
    );

    expect(reasons).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "provider-paused",
      "provider-paused",
    ]);
    expect(listings).toBe(3);
    expect(report.paused).toEqual([{ provider: "superserve", afterSlot: report.order[2] }]);
    expect(
      records.filter((r) => r.provider === "e2b").every((r) => r.completion.kind === "completed"),
    ).toBe(true);
  });

  it("resets the unavailable count when a health check passes", async () => {
    const records: AttemptRecord[] = [];
    // Listing calls in order: slot 1 open, slot 2 open, slot 3 open and close, slot 4 open, slot 5 open.
    const script = [false, false, true, true, false, false];

    const flaky = provider("daytona", {
      listAccount: async () => {
        if (!script.shift()) throw new Error("timeout");

        return [];
      },
    });

    const report = await runBatch(
      batch({ providers: [flaky], attempt: scripted(() => ({}), []) }, records),
    );

    expect(
      records.map((r) => (r.completion.kind === "incomplete" ? r.completion.reason : "completed")),
    ).toEqual(["unavailable", "unavailable", "completed", "unavailable", "unavailable"]);
    expect(report.paused).toEqual([]);
    expect(script).toEqual([]);
  });

  it("pads windows to settlement edges, lists the account at each edge, and voids on strays", async () => {
    const records: AttemptRecord[] = [];
    let closes = 0;

    const boxd = provider("boxd", {
      settlementMs: 250,
      paddingMs: 30,
      listAccount: async () => [],
      cleanup: async () => ["boxd-leftover"],
    });

    const superserve = provider("superserve", {
      paddingMs: 10,
      listAccount: async () => (++closes === 4 ? ["someone-else"] : []),
    });

    const report = await runBatch(
      batch(
        {
          slots: slots.slice(0, 2),
          providers: [boxd, superserve],
          attempt: scripted(() => ({ durationMs: 40 }), []),
        },
        records,
      ),
    );

    for (const slot of report.slots) {
      const window = slot.windows.find((w) => w.provider === "boxd");

      if (!window) throw new Error("boxd window");

      expect(window.openedAt % 250).toBe(0);
      expect(window.closedAt % 250).toBe(0);
      expect(slot.startedAt).toBeGreaterThanOrEqual((window?.openedAt ?? 0) + 30);
      expect(window?.listings.map((l) => l.edge)).toEqual(["open", "close"]);
      expect(window?.void).toBe(false);
      // Cleanup only in the reserved gap after every window closed, with its IDs recorded.
      expect(slot.cleanup).toEqual([
        expect.objectContaining({ provider: "boxd", ids: ["boxd-leftover"], error: null }),
      ]);
      expect(slot.cleanup[0]?.at).toBeGreaterThanOrEqual(window?.closedAt ?? Infinity);
    }

    const second = report.slots[1]?.windows.find((w) => w.provider === "superserve");

    expect(second?.void).toBe(true);
    expect(second?.voidReasons).toEqual(["close: 1 sandbox(es) present"]);
    expect(report.slots[1]?.startedAt).toBeGreaterThan(report.slots[0]?.cleanup[0]?.at ?? Infinity);
    expect(records.every((r) => r.costEvidence.window !== null)).toBe(true);
    expect(edgeAtOrAfter(1001, 250)).toBe(1250);
    expect(edgeAtOrAfter(1000, 250)).toBe(1000);
  });
});

describe("end to end through the scheduler", () => {
  let alpha: HostProvider;
  let beta: HostProvider;

  beforeAll(async () => {
    alpha = await hostProvider();
    beta = await hostProvider();
  });

  afterAll(async () => {
    await alpha.dispose();
    await beta.dispose();
  });

  it("runs the tiny fix-and-test fixture on two providers in shared slots with clean windows", async () => {
    const lines: string[] = [];

    const providers = [alpha, beta].map(
      (host, index): SlotProvider => ({
        name: index ? "beta" : "alpha",
        provider: host,
        attribution: "per-sandbox",
        settlementMs: 200,
        paddingMs: 20,
        // The fake host's list is account-wide, as a native account listing would be.
        listAccount: async () => (await host.list({})).map((item) => item.id),
      }),
    );

    const report = await runBatch({
      runId: "rw-e2e",
      batch: 0,
      seed: 42,
      manifest: fixture.manifest,
      manifestSha256: null,
      slots: [headline, zeroWait],
      providers,
      clock: systemClock,
      blobs: fixture.blobs,
      prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
      onRecord: async (record) => {
        lines.push(JSON.stringify(record));
      },
    });

    const records = lines.map((line) => attemptRecordSchema.parse(JSON.parse(line)));

    expect(records).toHaveLength(4);
    expect(records.map((r) => [r.slot.id, r.provider, r.completion.kind])).toEqual(
      report.order.flatMap((id) => [
        [id, "alpha", "completed"],
        [id, "beta", "completed"],
      ]),
    );

    for (const record of records) {
      expect(record.costEvidence.window?.void).toBe(false);
      expect(record.costEvidence.window?.listings.map((l) => l.ids)).toEqual([[], []]);
      expect(record.deletionConfirmed).toBe(true);
      expect(record.startOffsetMs).toBeLessThan(5 * 60_000);
    }

    expect(records.find((r) => r.variant === "zero-wait")?.steps.at(-1)).toMatchObject({
      id: "resume-test",
      status: "passed",
    });
    expect(await alpha.list({})).toEqual([]);
    expect(await beta.list({})).toEqual([]);
  }, 60_000);
});
