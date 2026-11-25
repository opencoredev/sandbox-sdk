// Regressions for the review of 76f32af: each test names the finding it pins.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { pricedResources } from "../src/billed-resources.js";
import { estimateCost } from "../src/pricing.js";
import { reapRun } from "../src/recovery.js";
import { deleteProvenSnapshot, ownedBuddySnapshots, snapshotCleaner } from "../src/snapshots.js";
import { parseV2 } from "../src/v2-config.js";
import { fingerprintOf } from "../src/connections.js";
import { bound } from "./native-fakes.js";

const dirs: string[] = [];

/** A Buddy adapter instance bound to the stubbed connection, as `loadProvider` binds the bench's own. */
const buddyProvider = () => bound({ ...memory(), name: "buddy" });

/** The connection fingerprints a run journals, which a reap through the same connection matches. */
const buddyFingerprints = async () => ({ buddy: await fingerprintOf(buddyProvider()) });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Buddy pricing", () => {
  it("bills a decimal-MB size the adapter accepts as its native tier", () => {
    const priced = pricedResources("buddy", null, { cpu: 3, memoryMb: 6000, diskGb: 50 });

    expect(priced?.resources).toMatchObject({ cpu: 3, memoryGiB: 6 });
    expect(priced?.bound).toBe("exact");
    // One minute of 3 vCPU and 6 GB: nine units at $0.00024.
    expect(estimateCost("buddy", 60_000, priced?.resources ?? null)).toBeCloseTo(9 * 0.00024, 9);
    expect(
      pricedResources("buddy", null, { cpu: 3, memoryMb: 6144, diskGb: 50 })?.resources,
    ).toMatchObject({ cpu: 3, memoryGiB: 6 });
  });
});

describe("Buddy snapshot ownership", () => {
  const expected = "bench-test-abcd1234";

  it("matches a confirmed entry only by its ID and journaled name, and a pending one only when unique", () => {
    const confirmed = [{ id: "snapshot", name: expected }];
    const pending = [{ id: expected, pendingSave: { name: expected } }];

    expect(ownedBuddySnapshots([{ id: "snapshot", name: "different-name" }], confirmed)).toEqual(
      [],
    );
    expect(ownedBuddySnapshots([{ id: "snapshot", name: expected }], confirmed)).toEqual([
      { id: "snapshot", name: expected },
    ]);
    expect(ownedBuddySnapshots([{ id: "snapshot" }], [{ id: "snapshot" }])).toEqual([]);
    expect(
      ownedBuddySnapshots(
        [
          { id: "snapshot", name: expected },
          { id: "unrelated", name: expected },
        ],
        pending,
      ),
    ).toEqual([]);
    expect(ownedBuddySnapshots([{ id: "snapshot", name: expected }], pending)).toEqual([
      { id: "snapshot", name: expected },
    ]);
  });

  const resultsSchema = z.looseObject({
    cleanupReview: z.array(z.looseObject({ id: z.string() })),
  });

  const journalSchema = z.looseObject({ resources: z.array(z.looseObject({ id: z.string() })) });

  type Mode = "renamed" | "duplicate pending name" | "re-keyed" | "workspace list lags";

  /** Reaps one run whose journal holds a Buddy source and one snapshot, against a scripted API. */
  async function reap(mode: Mode) {
    const out = await mkdtemp(join(tmpdir(), "buddy-review-"));

    dirs.push(out);
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const deletes: string[] = [];
    const source = "src-1";
    const pending = mode === "duplicate pending name" || mode === "re-keyed";

    const snap = (id: string, name: string) => ({
      id,
      name,
      status: "CREATED",
      url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/${id}`,
    });

    const listed =
      mode === "renamed"
        ? [snap("snapshot", "different-name")]
        : mode === "duplicate pending name"
          ? [snap("snapshot", expected), snap("unrelated", expected)]
          : [snap("snapshot", expected)];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        const id = path.split("/").at(-1) ?? "";

        deletes.push(id);
        const index = listed.findIndex((s) => s.id === id);

        if (index >= 0) listed.splice(index, 1);

        return new Response(null, { status: 204 });
      }

      // The workspace list lags the source's: the snapshot shows only on the source.
      if (mode === "workspace list lags" && path.endsWith("/ws/sandboxes/snapshots"))
        return Response.json({ snapshots: [] });

      if (path.endsWith("/snapshots")) return Response.json({ snapshots: listed });
      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          { provider: "buddy", id: source, kind: "snapshot-source", parent: null, snapshotProof },
          {
            provider: "buddy",
            id: pending ? expected : "snapshot",
            kind: "snapshot",
            parent: source,
            snapshotProof,
            ...(pending
              ? { pendingSave: { name: expected, journaledAt: new Date().toISOString() } }
              : { name: expected }),
          },
        ],
      }),
    );

    if (mode === "re-keyed")
      await writeFile(
        join(out, "results.json"),
        JSON.stringify({
          cleanupReview: [
            {
              provider: "buddy",
              id: expected,
              kind: "snapshot",
              reason: "Snapshot save did not settle",
            },
          ],
        }),
      );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const unresolved = await reapRun(
      [
        {
          kind: "ready",
          name: "buddy",
          cloud: true,
          region: null,
          provider: buddyProvider(),
        },
      ],
      parseV2(["--providers", "buddy", "--run", "test", "--out", out]),
      (s) => s,
    );

    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(out, "ownership.json"), "utf8")),
    );

    const results = await readFile(join(out, "results.json"), "utf8").then(
      (text) => resultsSchema.parse(JSON.parse(text)),
      () => undefined,
    );

    return { deletes, unresolved, journal, results };
  }

  it("never deletes a confirmed snapshot whose live name differs from the journaled one", async () => {
    const { deletes, unresolved, journal } = await reap("renamed");

    expect(deletes).toEqual([]);
    expect(unresolved).toBe(true);
    expect(journal.resources.map((r) => r.id)).toContain("snapshot");
  });

  it("never deletes on a pending name that several snapshots carry", async () => {
    const { deletes, unresolved, results } = await reap("duplicate pending name");

    expect(deletes).toEqual([]);
    expect(unresolved).toBe(true);
    expect(results?.cleanupReview.map((r) => r.id)).toContain(expected);
  });

  it("clears the review under the pending name once the re-keyed snapshot is deleted", async () => {
    const { deletes, unresolved, journal, results } = await reap("re-keyed");

    expect(deletes).toEqual(["snapshot"]);
    expect(unresolved).toBe(false);
    expect(results?.cleanupReview).toEqual([]);
    expect(journal.resources).toEqual([]);
  });

  it("never erases a journal entry on a workspace-list miss the source's list contradicts", async () => {
    const { deletes, journal } = await reap("workspace list lags");

    // Either the snapshot was deleted by its exact ID, or the entry stays for recovery.
    expect(deletes.includes("snapshot") || journal.resources.some((r) => r.id === "snapshot")).toBe(
      true,
    );
    expect(deletes).toEqual(["snapshot"]);
  });

  it("never deletes when a pending name has one match on the source and two in the workspace", async () => {
    const out = await mkdtemp(join(tmpdir(), "buddy-review-"));

    dirs.push(out);
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const deletes: string[] = [];
    const source = "src-1";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`))
        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: expected,
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
          ],
        });

      if (path.endsWith("/ws/sandboxes/snapshots"))
        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: expected,
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
            {
              id: "snapshot-b",
              name: expected,
              status: "CREATED",
              url: "http://fake.invalid/workspaces/ws/sandboxes/snapshots/snapshot-b",
            },
          ],
        });

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          { provider: "buddy", id: source, kind: "snapshot-source", parent: null, snapshotProof },
          {
            provider: "buddy",
            id: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
            pendingSave: { name: expected, journaledAt: new Date().toISOString() },
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const unresolved = await reapRun(
      [
        {
          kind: "ready",
          name: "buddy",
          cloud: true,
          region: null,
          provider: buddyProvider(),
        },
      ],
      parseV2(["--providers", "buddy", "--run", "test", "--out", out]),
      (s) => s,
    );

    expect(deletes).toEqual([]);
    expect(unresolved).toBe(true);
  });

  it("never deletes a confirmed workspace record lacking source provenance while the live source omits it", async () => {
    const out = await mkdtemp(join(tmpdir(), "buddy-review-"));

    dirs.push(out);
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const deletes: string[] = [];
    const source = "src-1";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`)) return Response.json({ snapshots: [] });

      if (path.endsWith("/ws/sandboxes/snapshots"))
        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: expected,
              status: "CREATED",
              url: "http://fake.invalid/workspaces/ws/sandboxes/snapshots/snapshot-a",
            },
          ],
        });

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          { provider: "buddy", id: source, kind: "snapshot-source", parent: null, snapshotProof },
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const unresolved = await reapRun(
      [
        {
          kind: "ready",
          name: "buddy",
          cloud: true,
          region: null,
          provider: buddyProvider(),
        },
      ],
      parseV2(["--providers", "buddy", "--run", "test", "--out", out]),
      (s) => s,
    );

    expect(deletes).toEqual([]);
    expect(unresolved).toBe(true);
  });

  it("clears both pending-name and native-ID reviews on a second reap after an earlier delete failed", async () => {
    const out = await mkdtemp(join(tmpdir(), "buddy-review-"));

    dirs.push(out);
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const source = "src-1";
    let failDelete = true;

    const listed = [
      {
        id: "snapshot-a",
        name: expected,
        status: "CREATED",
        url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
      },
    ];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        if (failDelete) return new Response(null, { status: 503 });
        listed.length = 0;

        return new Response(null, { status: 204 });
      }

      if (path.endsWith("/snapshots")) return Response.json({ snapshots: listed });
      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
            pendingSave: { name: expected, journaledAt: new Date().toISOString() },
          },
        ],
      }),
    );

    await writeFile(
      join(out, "results.json"),
      JSON.stringify({
        cleanupReview: [
          {
            provider: "buddy",
            id: expected,
            kind: "snapshot",
            reason: "Earlier cleanup unresolved",
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const first = await reapRun(providers, cfg, (s) => s);

    expect(first).toBe(true);

    failDelete = false;
    const second = await reapRun(providers, cfg, (s) => s);

    const settled = journalSchema.parse(
      JSON.parse(await readFile(join(out, "ownership.json"), "utf8")),
    );

    const results = resultsSchema.parse(
      JSON.parse(await readFile(join(out, "results.json"), "utf8")),
    );

    expect(second).toBe(false);
    expect(settled.resources).toEqual([]);
    expect(results.cleanupReview).toEqual([]);
  });

  it("never issues a DELETE after the snapshot cleanup deadline expires", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const source = "src-1";
    const deletes: string[] = [];
    let releaseList!: (response: Response) => void;

    const lateList = new Promise<Response>((resolve) => {
      releaseList = resolve;
    });

    let workspaceReads = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`))
        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: expected,
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
          ],
        });

      if (path.endsWith("/ws/sandboxes/snapshots")) {
        workspaceReads++;

        if (workspaceReads === 1) return lateList;

        return Response.json({ snapshots: [] });
      }

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const proof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1" as const,
      verifiedAt: new Date().toISOString(),
    };

    try {
      await expect(
        deleteProvenSnapshot(
          "buddy",
          buddyProvider(),
          "snapshot-a",
          source,
          proof,
          "test",
          50,
          undefined,
          expected,
        ),
      ).rejects.toThrow();

      releaseList(
        Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: "renamed-after-timeout",
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
          ],
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(deletes).toEqual([]);
    } finally {
      releaseList(Response.json({ snapshots: [] }));
    }
  });

  it("refuses deletion when a cleaner created without expectedName sees a renamed or foreign workspace record", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const source = "src-1";
    const deletes: string[] = [];

    let workspaceRecord = {
      id: "snapshot-a",
      name: "renamed-in-workspace",
      status: "CREATED",
      url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
    };

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`))
        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: expected,
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
          ],
        });

      if (path.endsWith("/ws/sandboxes/snapshots"))
        return Response.json({ snapshots: [workspaceRecord] });

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const provider = buddyProvider();
    const runnerCleaner = await snapshotCleaner("buddy", provider, source);

    const proof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1" as const,
      verifiedAt: new Date().toISOString(),
    };

    await expect(
      deleteProvenSnapshot(
        "buddy",
        provider,
        "snapshot-a",
        source,
        proof,
        "test",
        5000,
        runnerCleaner,
        expected,
      ),
    ).rejects.toThrow(/name differs/);

    workspaceRecord = {
      id: "snapshot-a",
      name: expected,
      status: "CREATED",
      url: "http://fake.invalid/workspaces/ws/sandboxes/other-src/snapshots/snapshot-a",
    };

    await expect(
      deleteProvenSnapshot(
        "buddy",
        provider,
        "snapshot-a",
        source,
        proof,
        "test",
        5000,
        runnerCleaner,
        expected,
      ),
    ).rejects.toThrow(/source differs/);

    expect(deletes).toEqual([]);
  });

  it("refuses deletion when a parent recovery signal is already aborted", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const source = "src-1";
    const deletes: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      return Response.json({
        snapshots: [
          {
            id: "snapshot-a",
            name: expected,
            status: "CREATED",
            url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
          },
        ],
      });
    });

    const provider = buddyProvider();

    const proof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1" as const,
      verifiedAt: new Date().toISOString(),
    };

    const parent = new AbortController();

    parent.abort();

    await expect(
      deleteProvenSnapshot(
        "buddy",
        provider,
        "snapshot-a",
        source,
        proof,
        "test",
        5000,
        undefined,
        expected,
        parent.signal,
      ),
    ).rejects.toThrow(/budget exhausted|timed out/);

    expect(deletes).toEqual([]);
  });

  it("keeps a confirmed snapshot journaled when the source is gone and the workspace list misses it", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const out = await mkdtemp(join(tmpdir(), "buddy-review-transient-miss-"));

    dirs.push(out);
    const source = "src-gone";
    const deletes: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`))
        return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

      if (path.endsWith("/ws/sandboxes/snapshots")) return Response.json({ snapshots: [] });

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const leftovers = await reapRun(providers, cfg, (s) => s);

    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(out, "ownership.json"), "utf8")),
    );

    expect(leftovers).toBe(true);
    expect(deletes).toEqual([]);
    expect(journal.resources).toHaveLength(1);
    expect(journal.resources[0]?.id).toBe("snapshot-a");
  });

  it("checks the exact-ID snapshot route when both source and workspace lists omit a live snapshot", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const out = await mkdtemp(join(tmpdir(), "buddy-review-stale-lists-"));

    dirs.push(out);
    const source = "src-live";
    const deletes: string[] = [];
    let exactReads = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`)) return Response.json({ snapshots: [] });

      if (path.endsWith("/ws/sandboxes/snapshots")) return Response.json({ snapshots: [] });

      if (path.endsWith(`/sandboxes/${source}/snapshots/snapshot-a`)) {
        exactReads++;

        return Response.json({
          id: "snapshot-a",
          name: expected,
          status: "CREATED",
          url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
        });
      }

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const leftovers = await reapRun(providers, cfg, (s) => s);

    expect(leftovers).toBe(false);
    expect(exactReads).toBe(1);
    expect(deletes).toEqual(["/workspaces/ws/sandboxes/snapshots/snapshot-a"]);
  });

  it("recovers cleanly after a lost DELETE response once the source is gone", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const out = await mkdtemp(join(tmpdir(), "buddy-review-lost-delete-"));

    dirs.push(out);
    const source = "src-gone";
    let exists = true;
    let deleteAttempts = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deleteAttempts++;

        if (deleteAttempts === 1) {
          exists = false;
          throw new Error("connection reset after delete");
        }

        if (!exists)
          return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

        exists = false;

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`))
        return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

      if (path.endsWith("/ws/sandboxes/snapshots"))
        return Response.json({
          snapshots: exists
            ? [
                {
                  id: "snapshot-a",
                  name: expected,
                  status: "CREATED",
                  url: "http://fake.invalid/workspaces/ws/sandboxes/snapshots/snapshot-a",
                },
              ]
            : [],
        });

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const first = await reapRun(providers, cfg, (s) => s);

    expect(first).toBe(true);
    expect(deleteAttempts).toBe(1);

    const second = await reapRun(providers, cfg, (s) => s);

    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(out, "ownership.json"), "utf8")),
    );

    expect(second).toBe(false);
    expect(deleteAttempts).toBe(2);
    expect(journal.resources).toEqual([]);
  });

  it("does not persist deleteVerified when the cleaner rejects a renamed snapshot", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const out = await mkdtemp(join(tmpdir(), "buddy-review-rejected-no-marker-"));

    dirs.push(out);
    const source = "src-1";
    let sourceGone = false;
    let workspaceEmpty = false;
    const deletes: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`)) {
        if (sourceGone)
          return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: expected,
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
          ],
        });
      }

      if (path.endsWith("/ws/sandboxes/snapshots")) {
        if (workspaceEmpty) return Response.json({ snapshots: [] });

        return Response.json({
          snapshots: [
            {
              id: "snapshot-a",
              name: "renamed-elsewhere",
              status: "CREATED",
              url: `http://fake.invalid/workspaces/ws/sandboxes/${source}/snapshots/snapshot-a`,
            },
          ],
        });
      }

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const first = await reapRun(providers, cfg, (s) => s);

    expect(first).toBe(true);
    expect(deletes).toEqual([]);

    // Source disappears and workspace list temporarily misses it: must STILL NOT delete.
    sourceGone = true;
    workspaceEmpty = true;

    const second = await reapRun(providers, cfg, (s) => s);

    expect(second).toBe(true);
    expect(deletes).toEqual([]);
  });

  it("retains the journal entry when the source disappears before the exact-ID snapshot GET", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const out = await mkdtemp(join(tmpdir(), "buddy-review-source-vanished-"));

    dirs.push(out);
    const source = "src-vanishing";
    let sourceReads = 0;
    const deletes: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return new Response(null, { status: 204 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`)) {
        sourceReads++;

        // First read sees the live source (omitting the snapshot); after the exact GET 404,
        // the source has vanished so the recheck gets 404 Resource not found.
        if (sourceReads === 1) return Response.json({ snapshots: [] });

        return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });
      }

      if (path.endsWith("/ws/sandboxes/snapshots")) return Response.json({ snapshots: [] });

      if (path.endsWith(`/sandboxes/${source}/snapshots/snapshot-a`))
        return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const leftovers = await reapRun(providers, cfg, (s) => s);

    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(out, "ownership.json"), "utf8")),
    );

    expect(leftovers).toBe(true);
    expect(sourceReads).toBe(2);
    expect(deletes).toEqual([]);
    expect(journal.resources).toHaveLength(1);
    expect(journal.resources[0]?.id).toBe("snapshot-a");
  });

  it("preserves deleteVerified when source discovery replaces a confirmed Buddy snapshot entry", async () => {
    vi.stubEnv("BUDDY_TOKEN", "fake");
    vi.stubEnv("BUDDY_WORKSPACE", "ws");
    vi.stubEnv("BUDDY_API_URL", "http://fake.invalid");

    const out = await mkdtemp(join(tmpdir(), "buddy-review-preserve-verified-"));

    dirs.push(out);
    const source = "src-gone";
    let workspaceReads = 0;
    const deletes: string[] = [];

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;

      if (init?.method === "DELETE") {
        deletes.push(path);

        return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });
      }

      if (path.endsWith(`/sandboxes/${source}/snapshots`))
        return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

      if (path.endsWith("/ws/sandboxes/snapshots")) {
        workspaceReads++;

        // First read (during source discovery) briefly returns the already-deleted snapshot;
        // subsequent reads omit it. deleteVerified must survive replacement so DELETE settles it.
        if (workspaceReads === 1)
          return Response.json({
            snapshots: [
              {
                id: "snapshot-a",
                name: expected,
                status: "CREATED",
                url: "http://fake.invalid/workspaces/ws/sandboxes/snapshots/snapshot-a",
              },
            ],
          });

        return Response.json({ snapshots: [] });
      }

      throw new Error(`Unexpected fake request: ${path}`);
    });

    const snapshotProof = {
      sourceId: source,
      runLabel: "test",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    };

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "test",
        connectionFingerprints: await buddyFingerprints(),
        resources: [
          {
            provider: "buddy",
            id: source,
            kind: "snapshot-source",
            parent: null,
            snapshotProof,
          },
          {
            provider: "buddy",
            id: "snapshot-a",
            name: expected,
            kind: "snapshot",
            parent: source,
            snapshotProof,
            deleteVerified: true,
          },
        ],
      }),
    );

    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const providers = [
      {
        kind: "ready" as const,
        name: "buddy",
        cloud: true,
        region: null,
        provider: buddyProvider(),
      },
    ];

    const cfg = parseV2(["--providers", "buddy", "--run", "test", "--out", out]);
    const leftovers = await reapRun(providers, cfg, (s) => s);

    const journal = journalSchema.parse(
      JSON.parse(await readFile(join(out, "ownership.json"), "utf8")),
    );

    expect(leftovers).toBe(false);
    expect(deletes).toEqual(["/workspaces/ws/sandboxes/snapshots/snapshot-a"]);
    expect(journal.resources).toEqual([]);
  });
});
