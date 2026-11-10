import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import {
  allocationLabel,
  appLabel,
  journalApp,
  realisticAttemptApp,
  type JournalApp,
} from "../../src/modal-apps.js";
import { estimateCost } from "../../src/pricing.js";
import { destroyTimings } from "../../src/providers.js";
import {
  appJournalFile,
  ownedApps,
  prepareAttemptApp,
  readAppJournal,
  readStops,
  stopJournalFile,
  type AttemptApp,
} from "../../src/realistic/apps.js";
import { attemptBudget, sweepProviders } from "../../src/realistic/cli.js";
import { ProviderTrace, systemClock } from "../../src/realistic/gaps.js";
import type { AttemptRecord } from "../../src/realistic/record.js";
import { providerSetup } from "../../src/realistic/setup.js";
import {
  attributionFor,
  emptyRecord,
  runBatch,
  type SlotProvider,
} from "../../src/realistic/slots.js";
import { buildFixture, type Fixture } from "./fixture.js";

let root: string;
let fixture: Fixture;
let count = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rw-modal-apps-"));
  fixture = await buildFixture();
});

afterAll(async () => {
  await fixture.cleanup();
  await rm(root, { recursive: true, force: true });
});

/** A fresh output directory's journal paths. */
async function paths() {
  const dir = await mkdtemp(join(root, `run-${count++}-`));

  return { dir, apps: join(dir, appJournalFile), stops: join(dir, stopJournalFile) };
}

async function journalLines(path: string): Promise<JournalApp[]> {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

interface Fake {
  listed?: { id: string; labels: Record<string, string> }[];
  pending?: { id: string; labels: Record<string, string> }[];
  appId?: string | null;
}

/** A memory provider named modal with Modal's App helpers, recording every call in `log`. */
function modalLike(log: string[], journal: string | null, fake: Fake = {}): Provider {
  const base = memory();

  return Object.assign(Object.create(base), {
    name: "modal",
    prepareApp: async (name: string, options?: { createIfMissing?: boolean }) => {
      // The journal line must already exist when Modal is asked for the App.
      const lines = journal ? (await readFile(journal, "utf8")).trim().split("\n") : [];
      log.push(`prepare:${name}:${options?.createIfMissing ?? true}:journaled=${lines.length}`);
      const appId = fake.appId === undefined ? "ap-1" : fake.appId;

      return appId === null ? null : { name, appId };
    },
    list: async (labels?: Record<string, string>) => {
      log.push(`list:${JSON.stringify(labels ?? {})}`);

      return (fake.listed ?? []).map((item) => ({ ...item, status: "running" }));
    },
    listPending: async () => {
      log.push("pending");

      return fake.pending ?? [];
    },
    destroy: async (id: string) => {
      log.push(`destroy:${id}`);
    },
  });
}

const slot = {
  id: "fat-same",
  profile: "fix-and-test",
  track: "same-machine",
  variant: "headline",
} as const;

describe("realistic per-attempt Modal Apps", () => {
  it("journals the App, its ID and the submitted create before allocating, then the sandbox", async () => {
    const at = await paths();
    const log: string[] = [];
    const attemptId = "rw-1-b0-s0-fat-same-modal";

    const app = await prepareAttemptApp(at, modalLike(log, at.apps), attemptId);

    const name = realisticAttemptApp(attemptId);
    const allocation = app.labels[allocationLabel] ?? "";

    expect(log).toEqual([`prepare:${name}:true:journaled=1`]);
    expect(app.labels).toEqual({ [appLabel]: name, [allocationLabel]: allocation });
    expect(await journalLines(at.apps)).toEqual([
      { provider: "modal", name, appId: null, sandboxes: [], allocations: [] },
      {
        provider: "modal",
        name,
        appId: "ap-1",
        sandboxes: [],
        allocations: [{ id: allocation, state: "submitted" }],
      },
    ]);

    await app.created("sb-1");

    expect(await readAppJournal(at.apps)).toEqual([
      {
        provider: "modal",
        name,
        appId: "ap-1",
        sandboxes: ["sb-1"],
        allocations: [{ id: allocation, state: "allocated", sandboxId: "sb-1" }],
      },
    ]);
  });

  it("fails before allocation when Modal returns no App, leaving the journaled name", async () => {
    const at = await paths();
    const attemptId = "rw-1-b0-s1-build-same-modal";

    await expect(
      prepareAttemptApp(at, modalLike([], at.apps, { appId: null }), attemptId),
    ).rejects.toThrow(/could not be created/);
    expect(await readAppJournal(at.apps)).toEqual([
      journalApp("modal", realisticAttemptApp(attemptId)),
    ]);
  });

  it("keeps a failed create ambiguous unless the failure names the sandbox it allocated", async () => {
    const at = await paths();
    const lost = await prepareAttemptApp(at, modalLike([], at.apps), "rw-2-b0-s0-lost-modal");
    const refused = await prepareAttemptApp(at, modalLike([], at.apps), "rw-2-b0-s1-refused-modal");
    const named = await prepareAttemptApp(at, modalLike([], at.apps), "rw-2-b0-s2-named-modal");

    await lost.failed(new Error("socket hang up"));
    await refused.failed(new SandboxError("Quota exceeded", { code: "quota", provider: "modal" }));
    await named.failed(
      new SandboxError("Setup failed", {
        code: "unavailable",
        provider: "modal",
        sandboxId: "sb-n",
      }),
    );

    const owned = await readAppJournal(at.apps);

    expect(owned.map((app) => app.allocations.map((entry) => entry.state))).toEqual([
      ["submitted"],
      ["submitted"],
      ["allocated"],
    ]);
    expect(owned[2]?.sandboxes).toEqual(["sb-n"]);

    // The billing view: a submitted create keeps the App's charge unattributable.
    const views = owned.map((app) =>
      ownedApps([{ ...app, sandboxes: ["sb-x"] }]).get("modal/sb-x"),
    );

    expect(views.map((view) => view?.ambiguous)).toEqual([1, 1, 0]);
  });

  it("journals the confirmed stop after destroy, and nothing when the stop was not confirmed", async () => {
    const at = await paths();
    const app = await prepareAttemptApp(at, modalLike([], at.apps), "rw-3-b0-s0-fat-same-modal");

    destroyTimings.set("modal/sb-stopped", {
      sandboxId: "sb-stopped",
      requestMs: 120,
      stoppedMs: 900,
    });
    destroyTimings.set("modal/sb-unconfirmed", {
      sandboxId: "sb-unconfirmed",
      requestMs: null,
      stoppedMs: null,
    });
    await app.destroyed("sb-stopped");
    await app.destroyed("sb-unconfirmed");
    await app.destroyed("sb-never-destroyed");

    const stops = await readStops(at.stops);

    expect([...stops.keys()]).toEqual(["modal/sb-stopped"]);
    expect(Number.isFinite(Date.parse(stops.get("modal/sb-stopped") ?? ""))).toBe(true);
    expect(destroyTimings.has("modal/sb-stopped")).toBe(false);
  });

  it("reads a missing journal and missing stops as empty", async () => {
    expect(await readAppJournal(join(root, "absent.jsonl"))).toEqual([]);
    expect((await readStops(join(root, "absent-stops.jsonl"))).size).toBe(0);
  });

  it("prepares the App before the attempt starts, labels the create, journals outcome and stop", async () => {
    const log: string[] = [];
    const records: AttemptRecord[] = [];

    const tracked: AttemptApp = {
      labels: {},
      created: async (id) => {
        log.push(`created:${id}`);
      },
      failed: async () => {
        log.push("failed");
      },
      destroyed: async (id) => {
        log.push(`destroyed:${id}`);
      },
    };

    const entry: SlotProvider = {
      name: "modal",
      provider: memory(),
      attribution: attributionFor("modal").attribution,
      settlementMs: null,
      paddingMs: 0,
      beforeAttempt: async (attemptId) => {
        log.push(`before:${attemptId}`);

        return { ...tracked, labels: { [appLabel]: realisticAttemptApp(attemptId) } };
      },
    };

    await runBatch({
      runId: "rw-apps",
      batch: 0,
      seed: 20261105,
      manifest: fixture.manifest,
      manifestSha256: null,
      slots: [slot],
      providers: [entry],
      clock: systemClock,
      blobs: fixture.blobs,
      prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
      onRecord: async (record) => {
        records.push(record);
      },
      attempt: async (plan, environment) => {
        log.push(`attempt:${plan.attemptId}:${plan.labels?.[appLabel] ?? "no label"}`);
        await environment.onSandbox?.(plan.provider.name, "sb-9");
        await environment.onCreateFailed?.(plan.provider.name, new Error("second create"));
        await environment.afterDestroy?.(plan.provider.name, "sb-9");

        const record = emptyRecord(
          { ...plan, provider: plan.provider.name },
          "error",
          "",
          Date.now(),
          environment.attribution,
        );

        record.completion = { kind: "completed" };
        record.sandboxIds = ["sb-9"];

        return { record, trace: new ProviderTrace(systemClock) };
      },
    });

    const attemptId = records[0]?.attemptId ?? "";

    expect(log).toEqual([
      `before:${attemptId}`,
      `attempt:${attemptId}:${realisticAttemptApp(attemptId)}`,
      "created:sb-9",
      "failed",
      "destroyed:sb-9",
    ]);
  });

  it("records an attempt whose App cannot be prepared as an error with no sandbox", async () => {
    const records: AttemptRecord[] = [];
    let attempted = false;

    await runBatch({
      runId: "rw-apps-fail",
      batch: 0,
      seed: 20261105,
      manifest: fixture.manifest,
      manifestSha256: null,
      slots: [slot],
      providers: [
        {
          name: "modal",
          provider: memory(),
          attribution: attributionFor("modal").attribution,
          settlementMs: null,
          paddingMs: 0,
          beforeAttempt: async () => {
            throw new Error("App sandbox-bench-x could not be created");
          },
        },
      ],
      clock: systemClock,
      blobs: fixture.blobs,
      prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
      onRecord: async (record) => {
        records.push(record);
      },
      attempt: async () => {
        attempted = true;
        throw new Error("unreachable");
      },
    });

    expect(attempted).toBe(false);
    expect(records[0]).toMatchObject({
      completion: { kind: "incomplete", reason: "error" },
      sandboxIds: [],
    });
  });

  it("bounds a stalled App lookup by the slot deadline and records it as our side, outside the attempt", async () => {
    const records: AttemptRecord[] = [];
    let attempted = false;
    let lookupSignal: AbortSignal | undefined;
    // The lookup stalls; the clock passes the slot deadline while it waits.
    let offset = 0;
    const clock = { ...systemClock, now: () => Date.now() + offset };

    const started = Date.now();

    await runBatch({
      runId: "rw-apps-stall",
      batch: 0,
      seed: 20261105,
      manifest: fixture.manifest,
      manifestSha256: null,
      slots: [slot],
      providers: [
        {
          name: "modal",
          provider: memory(),
          attribution: attributionFor("modal").attribution,
          settlementMs: null,
          paddingMs: 0,
          beforeAttempt: (_, signal) => {
            lookupSignal = signal;
            offset = 24 * 3600_000;

            return new Promise<never>(() => {});
          },
        },
      ],
      clock,
      blobs: fixture.blobs,
      prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
      onRecord: async (record) => {
        records.push(record);
      },
      attempt: async () => {
        attempted = true;
        throw new Error("unreachable");
      },
    });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(attempted).toBe(false);
    expect(lookupSignal?.aborted).toBe(true);
    expect(records[0]).toMatchObject({
      completion: {
        kind: "incomplete",
        reason: "error",
        detail: expect.stringMatching(/^Our side/),
      },
      sandboxIds: [],
      phases: [],
    });
  });

  it("journals no create when the App lookup returns after its deadline", async () => {
    const at = await paths();
    const controller = new AbortController();
    const log: string[] = [];
    // Modal returns the App only after the attempt's deadline has passed.
    const provider = Object.assign(modalLike(log, at.apps), {
      prepareApp: async (name: string) => {
        controller.abort(new Error("deadline"));

        return { name, appId: "ap-late" };
      },
    });

    await expect(
      prepareAttemptApp(at, provider, "rw-late-b0-s0-fat-same-modal", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/deadline/);

    const [latest] = await readAppJournal(at.apps);

    expect(latest?.allocations).toEqual([]);
  });

  it("prepares journaled Apps, reconciles listed and pending sandboxes, removes them, persists", async () => {
    const at = await paths();
    const log: string[] = [];
    const run = "rw-sweep";

    const lost: JournalApp = {
      ...journalApp("modal", "sandbox-bench-rw-a"),
      appId: "ap-a",
      allocations: [{ id: "alloc-a", state: "submitted" }],
    };

    const other: JournalApp = { ...journalApp("e2b", "sandbox-bench-rw-c"), appId: "ap-c" };

    for (const app of [lost, journalApp("modal", "sandbox-bench-rw-b"), other])
      await appendFile(at.apps, JSON.stringify(app) + "\n");

    const provider = modalLike(log, null, {
      listed: [
        {
          id: "sb-lost",
          labels: { "sandbox-bench-run": run, [appLabel]: lost.name, [allocationLabel]: "alloc-a" },
        },
      ],
      pending: [
        { id: "sb-pending", labels: { "sandbox-bench-run": run, "sandbox-sdk": "pending" } },
      ],
    });

    const notes: object[] = [];

    await sweepProviders(
      run,
      [
        {
          name: "modal",
          provider,
          attribution: attributionFor("modal").attribution,
          settlementMs: null,
          paddingMs: 0,
        },
      ],
      async (entry) => {
        notes.push(entry);
      },
      at.dir,
    );

    expect(log).toEqual([
      "prepare:sandbox-bench-rw-a:false:journaled=0",
      "prepare:sandbox-bench-rw-b:false:journaled=0",
      `list:{"sandbox-bench-run":"${run}"}`,
      "pending",
      "destroy:sb-lost",
      "destroy:sb-pending",
    ]);
    expect(notes).toContainEqual({ kind: "swept", provider: "modal", found: 2 });

    const reconciled = (await readAppJournal(at.apps)).find((app) => app.name === lost.name);

    expect(reconciled).toMatchObject({
      sandboxes: ["sb-lost"],
      allocations: [{ id: "alloc-a", state: "allocated", sandboxId: "sb-lost" }],
    });
  });
});

describe("realistic Modal budget reserve", () => {
  const hour = 3_600_000;

  it("reserves the bursting default track at 8 CPU / 16 GiB, at the pinned region's rate", () => {
    const previous = process.env.BENCH_REGION_MODAL;
    process.env.BENCH_REGION_MODAL = "us-east";

    try {
      const setup = providerSetup("modal");
      const defaultTrack = attemptBudget(setup, "default", hour);
      const sameMachine = attemptBudget(setup, "same-machine", hour);

      expect(defaultTrack).toBeCloseTo(
        estimateCost("modal", hour, { cpu: 8, memoryGiB: 16, diskGiB: 0 }, "us-east") ?? 0,
        9,
      );
      // 8 x $0.1419 + 16 x $0.024 per hour, at 1.75x for us-east.
      expect(defaultTrack).toBeCloseTo((8 * 0.1419 + 16 * 0.024) * 1.75, 2);
      expect(sameMachine).toBeCloseTo((4 * 0.1419 + 8 * 0.024) * 1.75, 2);
    } finally {
      if (previous === undefined) delete process.env.BENCH_REGION_MODAL;
      else process.env.BENCH_REGION_MODAL = previous;
    }
  });
});
