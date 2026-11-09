import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { appLabel, realisticAttemptApp, type JournalApp } from "../../src/modal-apps.js";
import { estimateCost } from "../../src/pricing.js";
import { prepareAttemptApp, readAppJournal } from "../../src/realistic/apps.js";
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

let dir: string;
let fixture: Fixture;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rw-modal-apps-"));
  fixture = await buildFixture();
});

afterAll(async () => {
  await fixture.cleanup();
  await rm(dir, { recursive: true, force: true });
});

/** A memory provider named modal with Modal's `prepareApp`, recording every call in `log`. */
function modalLike(log: string[], journal?: string, appId: string | null = "ap-1"): Provider {
  const base = memory();

  return Object.assign(Object.create(base), {
    name: "modal",
    prepareApp: async (name: string, options?: { createIfMissing?: boolean }) => {
      // The journal line must already exist when Modal is asked for the App.
      const lines = journal ? (await readFile(journal, "utf8")).trim().split("\n") : [];
      log.push(`prepare:${name}:${options?.createIfMissing ?? true}:journaled=${lines.length}`);

      return appId === null ? null : { name, appId };
    },
    list: async (labels?: Record<string, string>) => {
      log.push(`list:${JSON.stringify(labels ?? {})}`);

      return [];
    },
  });
}

describe("realistic per-attempt Modal Apps", () => {
  it("journals the App before resolving it, then its ID, then each sandbox", async () => {
    const journal = join(dir, "journal-order.jsonl");
    const log: string[] = [];

    const app = await prepareAttemptApp(
      journal,
      modalLike(log, journal),
      "rw-1-b0-s0-fat-same-modal",
    );

    const name = realisticAttemptApp("rw-1-b0-s0-fat-same-modal");

    expect(log).toEqual([`prepare:${name}:true:journaled=1`]);
    expect(app.labels).toEqual({ [appLabel]: name });
    await app.created("sb-1");

    const lines = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines).toEqual([
      { provider: "modal", name, appId: null, sandboxes: [] },
      { provider: "modal", name, appId: "ap-1", sandboxes: [] },
      { provider: "modal", name, appId: "ap-1", sandboxes: ["sb-1"] },
    ]);
    expect(await readAppJournal(journal)).toEqual([
      { provider: "modal", name, appId: "ap-1", sandboxes: ["sb-1"] },
    ]);
  });

  it("fails before allocation when Modal returns no App, leaving the journaled name", async () => {
    const journal = join(dir, "journal-null.jsonl");

    await expect(
      prepareAttemptApp(journal, modalLike([], journal, null), "rw-1-b0-s1-build-same-modal"),
    ).rejects.toThrow(/could not be created/);
    expect(await readAppJournal(journal)).toEqual([
      {
        provider: "modal",
        name: realisticAttemptApp("rw-1-b0-s1-build-same-modal"),
        appId: null,
        sandboxes: [],
      },
    ]);
  });

  it("reads a missing journal as no Apps", async () => {
    expect(await readAppJournal(join(dir, "absent.jsonl"))).toEqual([]);
  });

  it("prepares the App before the attempt starts, labels the create and journals the sandbox", async () => {
    const log: string[] = [];
    const records: AttemptRecord[] = [];
    const created: string[] = [];

    const entry: SlotProvider = {
      name: "modal",
      provider: memory(),
      attribution: attributionFor("modal").attribution,
      settlementMs: null,
      paddingMs: 0,
      beforeAttempt: async (attemptId) => {
        log.push(`before:${attemptId}`);

        return {
          labels: { [appLabel]: realisticAttemptApp(attemptId) },
          created: async (id) => {
            created.push(id);
          },
        };
      },
    };

    const report = await runBatch({
      runId: "rw-apps",
      batch: 0,
      seed: 20261105,
      manifest: fixture.manifest,
      manifestSha256: null,
      slots: [
        { id: "fat-same", profile: "fix-and-test", track: "same-machine", variant: "headline" },
      ],
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

    expect(report).toBeDefined();
    expect(log).toEqual([
      `before:${attemptId}`,
      `attempt:${attemptId}:${realisticAttemptApp(attemptId)}`,
    ]);
    expect(created).toEqual(["sb-9"]);
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
      slots: [
        { id: "fat-same", profile: "fix-and-test", track: "same-machine", variant: "headline" },
      ],
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

  it("prepares every journaled App, without creating any, before the sweep lists", async () => {
    const log: string[] = [];
    const provider = modalLike(log);

    const apps: JournalApp[] = [
      { provider: "modal", name: "sandbox-bench-rw-a", appId: "ap-a", sandboxes: ["sb-a"] },
      { provider: "modal", name: "sandbox-bench-rw-b", appId: null, sandboxes: [] },
      { provider: "e2b", name: "sandbox-bench-rw-c", appId: "ap-c", sandboxes: ["sb-c"] },
    ];

    await sweepProviders(
      "rw-sweep",
      [
        {
          name: "modal",
          provider,
          attribution: attributionFor("modal").attribution,
          settlementMs: null,
          paddingMs: 0,
        },
      ],
      async () => {},
      apps,
    );

    expect(log).toEqual([
      "prepare:sandbox-bench-rw-a:false:journaled=0",
      "prepare:sandbox-bench-rw-b:false:journaled=0",
      'list:{"sandbox-bench-run":"rw-sweep"}',
    ]);
  });
});

describe("realistic Modal budget reserve", () => {
  const hour = 3_600_000;

  it("reserves the bursting default track at 8 CPU / 16 GiB, at the pinned region's rate", () => {
    const previous = process.env.MODAL_SANDBOX_REGION;
    process.env.MODAL_SANDBOX_REGION = "us-east";

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
      if (previous === undefined) delete process.env.MODAL_SANDBOX_REGION;
      else process.env.MODAL_SANDBOX_REGION = previous;
    }
  });
});
