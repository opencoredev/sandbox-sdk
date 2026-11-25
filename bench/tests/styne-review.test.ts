/**
 * Regressions from the Sol review of 5027098: a Styne save journals its idempotency key and is settled
 * before its entry is forgotten, only Styne's own error codes decide absence or an ended sandbox, and
 * no Styne read follows a redirect.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { z } from "zod";
import { fingerprintOf } from "../src/connections.js";
import { lookupSandbox } from "../src/existence.js";
import { reapRun } from "../src/recovery.js";
import { inspectSnapshot, snapshotCleaner, snapshotsFromSource } from "../src/snapshots.js";
import { parseV2 } from "../src/v2-config.js";
import { bound, boundFake } from "./native-fakes.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const sourceId = "vmReview";
const name = "bench-styne-review-12345678";
const run = "styne-review";
const notFound = { error_code: "not_found" };

interface Call {
  method: string;
  path: string;
  key: string | null;
  redirect: RequestRedirect | undefined;
}

/** A fake Styne API: `answer` decides each request; every request is kept. */
function styneApi(answer: (call: Call) => Response) {
  const calls: Call[] = [];

  vi.stubEnv("STYNE_API_URL", "https://review.invalid");
  vi.stubEnv("STYNE_API_KEY", "review-placeholder");
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call = {
      method: init.method ?? "GET",
      path: decodeURIComponent(new URL(url).pathname),
      key: new Headers(init.headers).get("idempotency-key"),
      redirect: init.redirect,
    };

    calls.push(call);

    return answer(call);
  });

  return calls;
}

const styneProvider = () => bound({ ...memory(), name: "styne" });

const proof = {
  sourceId,
  runLabel: run,
  sdkLabel: "1",
  verifiedAt: "2026-11-25T05:00:00.000Z",
};

/** An offline reap of a journal holding one Styne save whose answer was lost, under its key. */
async function reapPendingSave(answer: (call: Call) => Response) {
  const out = await mkdtemp(join(tmpdir(), "styne-review-"));
  const calls = styneApi(answer);
  const provider = styneProvider();

  try {
    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: run,
        connectionFingerprints: { styne: await fingerprintOf(provider) },
        resources: [
          {
            provider: "styne",
            kind: "snapshot",
            id: name,
            parent: sourceId,
            snapshotProof: proof,
            idempotencyKey: "save-key-1",
          },
        ],
      }),
    );
    await reapRun(
      [{ kind: "ready", name: "styne", cloud: false, region: null, provider }],
      parseV2(["--providers", "styne", "--run", run, "--out", out, "--timeout-ms", "3000"]),
      (value) => value,
    ).catch(() => {});

    return { calls, journal: await readFile(join(out, "ownership.json"), "utf8") };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

describe("finding 2: a Styne save is settled with its journaled key before it is forgotten", () => {
  it("replays the save under its key, finds the late snapshot and deletes it", async () => {
    let visible = false;
    let deleted = false;

    const { calls, journal } = await reapPendingSave((call) => {
      if (call.method === "POST" && call.path === `/sandboxes/${sourceId}/snapshots`) {
        visible = true;

        return Response.json({ name, sandboxID: sourceId }, { status: 201 });
      }

      if (call.path === `/snapshots/${name}` && call.method === "DELETE") {
        deleted = true;
        visible = false;

        return new Response(null, { status: 204 });
      }

      if (call.path === `/snapshots/${name}` && visible)
        return Response.json({ name, sandboxID: sourceId });

      return Response.json(notFound, { status: 404 });
    });

    const replays = calls.filter((c) => c.method === "POST");
    expect(replays.length).toBeGreaterThan(0);
    expect(replays.every((c) => c.key === "save-key-1")).toBe(true);
    expect(deleted).toBe(true);
    expect(journal).not.toContain(name);
  });

  it("keeps the entry while the save is unsettled: not_found reads with no refused replay", async () => {
    const { calls, journal } = await reapPendingSave((call) =>
      call.method === "POST"
        ? Response.json({ error_code: "internal" }, { status: 503 })
        : Response.json(notFound, { status: 404 }),
    );

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(journal).toContain(name);
    expect(journal).toContain("save-key-1");
  });

  it("drops the entry without a delete only when the replay refused the save", async () => {
    const { calls, journal } = await reapPendingSave((call) =>
      call.method === "POST"
        ? Response.json({ error_code: "sandbox_ended" }, { status: 410 })
        : Response.json(notFound, { status: 404 }),
    );

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(journal).not.toContain(name);
  });

  it("runV2 journals the save key before the request and settles a lost answer with it", async () => {
    const { runV2 } = await import("../src/v2-runner.js");
    const out = await mkdtemp(join(tmpdir(), "styne-review-run-"));
    const journalPath = join(out, "ownership.json");
    const saves: { key: string | null; journaled: string }[] = [];
    let saved: { name: string; sandboxID: string } | undefined;
    let deleted = false;

    vi.stubEnv("STYNE_API_URL", "https://review.invalid");
    vi.stubEnv("STYNE_API_KEY", "review-placeholder");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = decodeURIComponent(new URL(url).pathname);

      if (method === "POST" && /^\/sandboxes\/[^/]+\/snapshots$/.test(path)) {
        saves.push({
          key: new Headers(init.headers).get("idempotency-key"),
          journaled: await readFile(journalPath, "utf8"),
        });

        // The first answer is lost; the replay under the same key returns the save.
        if (saves.length === 1) throw new TypeError("fetch failed");
        const body = z.object({ name: z.string() }).parse(JSON.parse(String(init.body ?? "{}")));
        saved = { name: body.name, sandboxID: path.split("/")[2] ?? "" };

        return Response.json(saved, { status: 201 });
      }

      if (saved && path === `/snapshots/${saved.name}`) {
        if (method === "DELETE") {
          deleted = true;

          return new Response(null, { status: 204 });
        }

        return deleted ? Response.json(notFound, { status: 404 }) : Response.json(saved);
      }

      return Response.json(notFound, { status: 404 });
    });

    const base = memory();

    try {
      await runV2(
        [
          {
            kind: "ready",
            name: "styne",
            cloud: true,
            region: null,
            provider: boundFake({
              ...base,
              name: "styne",
              capabilities: new Set([...base.capabilities, "snapshot"]),
              async snapshot() {
                throw new Error("unused for named Styne snapshots");
              },
            }),
          },
        ],
        parseV2([
          "--providers",
          "styne",
          "--scenarios",
          "snapshot",
          "--runs",
          "1",
          "--bursts",
          "",
          "--timeout-ms",
          "5000",
          "--run",
          run,
          "--out",
          out,
        ]),
        async () => {},
      ).catch(() => {});

      expect(saves.length).toBeGreaterThan(1);
      const key = saves[0]!.key;
      expect(key).toMatch(/^[0-9a-f-]{36}$/);
      expect(saves.every((save) => save.key === key)).toBe(true);
      // The key was on disk before the first request left.
      expect(saves[0]!.journaled).toContain(`"idempotencyKey": "${key}"`);
      expect(deleted).toBe(true);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("finding 3: only Styne's own codes decide", () => {
  it("a snapshot delete answered by a route-level or undecodable 404 fails", async () => {
    const answers = [
      Response.json({ error_code: "route_not_found" }, { status: 404 }),
      new Response("<html>not found</html>", { status: 404 }),
      Response.json(notFound, { status: 404 }),
    ];

    styneApi(() => answers.shift() ?? new Response(null, { status: 500 }));
    const clean = await snapshotCleaner("styne", styneProvider(), sourceId);

    await expect(clean(name)).rejects.toThrow(/delete failed/);
    await expect(clean(name)).rejects.toThrow(/delete failed/);
    await expect(clean(name)).resolves.toBeUndefined();
  });

  it("a snapshot read answered by a route-level 404 is unavailable, never absent", async () => {
    const answers = [
      Response.json({ error_code: "route_not_found" }, { status: 404 }),
      new Response(null, { status: 404 }),
      Response.json(notFound, { status: 404 }),
    ];

    styneApi(() => answers.shift() ?? new Response(null, { status: 500 }));
    const provider = styneProvider();

    await expect(inspectSnapshot("styne", provider, sourceId, name)).rejects.toThrow();
    await expect(inspectSnapshot("styne", provider, sourceId, name)).rejects.toThrow();
    expect(await inspectSnapshot("styne", provider, sourceId, name)).toEqual({ exists: false });
  });

  it("a 410 is an ended sandbox only with an ended code for this sandbox, a 404 only with not_found for it", async () => {
    const answers = [
      new Response(null, { status: 410 }),
      Response.json({ error_code: "gone" }, { status: 410 }),
      Response.json({ error_code: "sandbox_ended", sandboxID: "vmOther" }, { status: 410 }),
      Response.json({ error_code: "not_found", sandboxID: "vmOther" }, { status: 404 }),
      Response.json({ error_code: "agent_exit", sandboxID: "vm1" }, { status: 410 }),
      Response.json({ error_code: "sandbox_timeout" }, { status: 410 }),
    ];

    styneApi(() => answers.shift() ?? new Response(null, { status: 500 }));
    const provider = styneProvider();
    const results: string[] = [];

    for (let i = 0; i < 6; i++) results.push((await lookupSandbox(provider, "vm1", 1000)).result);

    expect(results).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "terminal",
      "terminal",
    ]);
  });
});

describe("Styne reads never follow a redirect", () => {
  it("the sandbox lookup and every snapshot read refuse redirects", async () => {
    const calls = styneApi((call) => {
      if (call.path === "/sandboxes/vm1")
        return Response.json({ sandboxID: "vm1", state: "running" });

      if (call.path === `/sandboxes/${sourceId}/snapshots`)
        return Response.json([{ name, sandboxID: sourceId }]);

      return Response.json({ name, sandboxID: sourceId });
    });

    const provider = styneProvider();

    expect((await lookupSandbox(provider, "vm1", 1000)).result).toBe("present");
    expect(await inspectSnapshot("styne", provider, sourceId, name)).toEqual({
      exists: true,
      sourceId,
    });
    expect(await snapshotsFromSource("styne", provider, sourceId, new Set([name]))).toEqual([
      { id: name, name },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.method === "GET" && call.redirect === "error")).toBe(true);
  });

  it("a redirected lookup is unavailable, never followed", async () => {
    vi.stubEnv("STYNE_API_KEY", "review-placeholder");
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit = {}) => {
      if (init.redirect === "error") throw new TypeError("fetch failed: redirect mode is error");

      return Response.json(notFound, { status: 404 });
    });

    expect((await lookupSandbox(styneProvider(), "vm1", 1000)).result).toBe("unavailable");
  });
});
