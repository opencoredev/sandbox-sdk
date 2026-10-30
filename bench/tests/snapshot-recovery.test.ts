import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { snapshotProvenanceSchema } from "../src/ownership.js";
import * as snapshots from "../src/snapshots.js";
import { fakeNativeModules } from "./native-fakes.js";
import { reapRun } from "../src/recovery.js";
import { parseV2 } from "../src/v2-config.js";

const dirs: string[] = [];

const proof = (sourceId: string) =>
  snapshotProvenanceSchema.parse({
    sourceId,
    runLabel: "snapshot-run",
    sdkLabel: "1",
    verifiedAt: new Date().toISOString(),
  });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((out) => rm(out, { recursive: true, force: true })));
});

async function directory() {
  const out = await mkdtemp(join(tmpdir(), "bench-snapshot-proof-"));
  dirs.push(out);

  return out;
}

it.each(["missing", "other-run", "other-source", "live-other-source"])(
  "refuses snapshot deletion with %s provenance",
  async (mode) => {
    const inspect = vi
      .spyOn(snapshots.snapshotMetadata, "inspect")
      .mockResolvedValue({ exists: true, sourceId: "foreign" });

    const remove = vi.fn(async () => {});

    const source = proof("source");

    const recorded =
      mode === "missing"
        ? undefined
        : mode === "other-run"
          ? { ...source, runLabel: "foreign" }
          : mode === "other-source"
            ? { ...source, sourceId: "foreign" }
            : source;

    await expect(
      snapshots.deleteProvenSnapshot(
        "e2b",
        memory(),
        "snapshot",
        "source",
        recorded,
        "snapshot-run",
        100,
        remove,
      ),
    ).rejects.toThrow(/provenance/);
    expect(remove).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledTimes(mode === "live-other-source" ? 1 : 0);
  },
);

it("retries only an in-use snapshot conflict within a bounded budget, rechecking native metadata", async () => {
  vi.useFakeTimers();

  const inspect = vi
    .spyOn(snapshots.snapshotMetadata, "inspect")
    .mockResolvedValue({ exists: true, sourceId: "source" });

  const conflict = Object.assign(new Error("Snapshot has running sandboxes"), { statusCode: 400 });

  const remove = vi
    .fn<(id: string) => Promise<void>>()
    .mockRejectedValueOnce(conflict)
    .mockRejectedValueOnce(conflict)
    .mockResolvedValue(undefined);

  const task = snapshots.deleteProvenSnapshot(
    "e2b",
    memory(),
    "snapshot",
    "source",
    proof("source"),
    "snapshot-run",
    1000,
    remove,
  );

  await vi.runAllTimersAsync();
  await task;
  expect(remove).toHaveBeenCalledTimes(3);
  expect(inspect).toHaveBeenCalledTimes(3);
  remove.mockReset().mockRejectedValue(conflict);

  const stuck = expect(
    snapshots.deleteProvenSnapshot(
      "e2b",
      memory(),
      "snapshot",
      "source",
      proof("source"),
      "snapshot-run",
      250,
      remove,
    ),
  ).rejects.toThrow(/budget/);

  await vi.runAllTimersAsync();
  await stuck;
  expect(remove.mock.calls.length).toBeLessThanOrEqual(3);
});

it.each([400, 401, 503])("does not retry an unrelated HTTP %i error", async (status) => {
  vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({ exists: true });

  const remove = vi.fn(async () => {
    throw Object.assign(new Error("Metadata or authorization unavailable"), { status });
  });

  await expect(
    snapshots.deleteProvenSnapshot(
      "e2b",
      memory(),
      "snapshot",
      "source",
      proof("source"),
      "snapshot-run",
      1000,
      remove,
    ),
  ).rejects.toThrow("unavailable");
  expect(remove).toHaveBeenCalledTimes(1);
});

it.each(["e2b", "daytona", "boxd", "tenki", "freestyle", "superserve"])(
  "reads %s snapshot identity/source without a live parent",
  async (name) => {
    // One record carrying every provider's source field; each provider reads its own.
    const get = vi.fn().mockResolvedValue({
      id: "snapshot",
      sourceSandboxId: "source",
      sessionId: "source",
      sourceVmId: "source",
      sandboxId: "source",
    });

    const provider = {
      ...memory(),
      native: () => {
        throw new Error("parent gone");
      },
    };

    const page = {
      hasNext: false,
      nextItems: vi.fn().mockResolvedValue([{ snapshotId: "snapshot" }]),
    };

    fakeNativeModules({
      e2b: {
        Sandbox: { listSnapshots: () => page, getInfo: vi.fn(), deleteSnapshot: vi.fn() },
        SandboxNotFoundError: class extends Error {},
      },
      "@daytonaio/sdk": {
        Daytona: class {
          snapshot = { get, list: vi.fn(), delete: vi.fn() };
          get = vi.fn();
        },
      },
      "@boxd-sh/sdk": {
        Boxd: class {
          machines = { get: vi.fn() };
          snapshots = { get, delete: vi.fn() };
        },
      },
      "@tenkicloud/sandbox": {
        TenkiSandbox: class {
          get = vi.fn();
          getSnapshot = get;
          deleteSnapshot = vi.fn();
        },
      },
      freestyle: {
        Freestyle: class {
          vms = { get: vi.fn(), snapshots: { get, delete: vi.fn() } };
        },
      },
      "@superserve/sdk": { Snapshot: { get, list: vi.fn(), deleteById: vi.fn() } },
    });
    expect(await snapshots.inspectSnapshot(name, provider, "source", "snapshot")).toEqual(
      name === "e2b" ? { exists: true } : { exists: true, sourceId: "source" },
    );
  },
);

it("does not mistake a missing E2B list entry for definitive absence", async () => {
  fakeNativeModules({
    e2b: {
      Sandbox: {
        listSnapshots: () => ({ hasNext: false, nextItems: async () => [] }),
        getInfo: vi.fn(),
        deleteSnapshot: vi.fn(),
      },
      SandboxNotFoundError: class extends Error {},
    },
  });
  await expect(snapshots.inspectSnapshot("e2b", memory(), "source", "snapshot")).rejects.toThrow(
    "absence unproven",
  );
});

it.each([true, false])(
  "reap handles a gone parent with recorded provenance=%s",
  async (recorded) => {
    const out = await directory();
    const provider = memory();
    const remove = vi.fn().mockResolvedValue(undefined);

    const inspect = vi
      .spyOn(snapshots.snapshotMetadata, "inspect")
      .mockResolvedValue({ exists: true, sourceId: "gone-source" });

    vi.spyOn(snapshots, "snapshotCleaner").mockResolvedValue(remove);
    // Production cleanup uses the native loader; both paths share the same exact-ID guard.
    fakeNativeModules({
      e2b: {
        Sandbox: { deleteSnapshot: remove, getInfo: vi.fn(), listSnapshots: vi.fn() },
        SandboxNotFoundError: class extends Error {},
      },
    });
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "snapshot-run",
        resources: [
          {
            provider: "e2b",
            id: "snapshot",
            kind: "snapshot",
            parent: "gone-source",
            // JSON.stringify drops an undefined proof, as an unrecorded journal would.
            snapshotProof: recorded ? proof("gone-source") : undefined,
          },
        ],
      }),
    );
    await writeFile(
      join(out, "results.json"),
      JSON.stringify({
        cleanupReview: [
          { provider: "e2b", id: "snapshot", kind: "snapshot", reason: "parent gone" },
        ],
      }),
    );

    const failed = await reapRun(
      [{ kind: "ready", name: "e2b", cloud: false, region: null, provider }],
      parseV2(["--providers", "e2b", "--run", "snapshot-run", "--out", out]),
      (s) => s,
    );

    expect(failed).toBe(!recorded);
    expect(remove).toHaveBeenCalledTimes(recorded ? 1 : 0);
    expect(inspect).toHaveBeenCalledTimes(recorded ? 1 : 0);
    expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toHaveLength(
      recorded ? 0 : 1,
    );
    expect(
      JSON.parse(await readFile(join(out, "results.json"), "utf8")).cleanupReview,
    ).toHaveLength(recorded ? 0 : 1);
  },
);

it("reap removes a restored sandbox, then its proven snapshot, then the source", async () => {
  const out = await directory();
  const backing = memory();
  const events: string[] = [];
  const source = await createSandbox(backing, { labels: { "sandbox-bench-run": "snapshot-run" } });
  const restore = await createSandbox(backing, { labels: { "sandbox-bench-run": "snapshot-run" } });

  const provider = {
    ...backing,
    destroy: async (id: string) => {
      events.push(id === source.id ? "source" : "restore");
      await backing.destroy(id);
    },
  };

  vi.spyOn(snapshots.snapshotMetadata, "inspect").mockResolvedValue({
    exists: true,
    sourceId: source.id,
  });
  fakeNativeModules({
    e2b: {
      Sandbox: {
        deleteSnapshot: async () => {
          expect((await backing.list({})).map((info) => info.id)).toEqual([source.id]);
          events.push("snapshot");

          return true;
        },
        getInfo: vi.fn(),
        listSnapshots: vi.fn(),
      },
      SandboxNotFoundError: class extends Error {},
    },
  });
  await writeFile(
    join(out, "ownership.json"),
    JSON.stringify({
      runId: "snapshot-run",
      resources: [
        { provider: "e2b", id: source.id, kind: "sandbox", parent: null },
        { provider: "e2b", id: restore.id, kind: "sandbox", parent: null },
        {
          provider: "e2b",
          id: "snapshot",
          kind: "snapshot",
          parent: source.id,
          snapshotProof: proof(source.id),
        },
      ],
    }),
  );
  expect(
    await reapRun(
      [{ kind: "ready", name: "e2b", cloud: false, region: null, provider }],
      parseV2(["--providers", "e2b", "--run", "snapshot-run", "--out", out]),
      (s) => s,
    ),
  ).toBe(false);
  expect(events).toEqual(["restore", "snapshot", "source"]);
  expect(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")).resources).toEqual([]);
});
