// Regressions for the review of d422348: each test names the finding it pins.
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { decodeMaritime, type MaritimeInfo } from "../src/billing/providers.js";
import { createRawMaritime, rawOwnerLabel, type RawMaritimeBox } from "../src/maritime-raw.js";
import { journalFiles } from "../src/files.js";
import { snapshotProvenanceSchema } from "../src/ownership.js";
import { reapRun } from "../src/recovery.js";
import { inspectSnapshot, settleMaritimeSave, snapshotCleaner } from "../src/snapshots.js";
import { parseV2 } from "../src/v2-config.js";
import { sanitize } from "../src/v2-runner.js";

const dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);

  return dir;
}

/** A loopback HTTP server whose handler sees every request; `requests` records method and path. */
async function loopback(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const requests: string[] = [];

  const server = createServer((request, response) => {
    requests.push(`${request.method} ${new URL(request.url ?? "/", "http://x").pathname}`);
    request.resume();
    request.on("end", () => handler(request, response));
  });

  const port = await new Promise<number>((done) =>
    server.listen(0, "127.0.0.1", () =>
      done(z.object({ port: z.number() }).parse(server.address()).port),
    ),
  );

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const tokens = [
  "mk_live_accountkey0123456789",
  "mst_sandboxsecret0123456789",
  "mut_urltoken0123456789",
  "mut_inaquery0123456789",
];

describe("finding 1: credentials stay out of benchmark records", () => {
  it("sanitize removes Maritime token shapes and ?token= values that are not in the environment", () => {
    const text = `failed ${tokens[0]} ${tokens[1]} code=${tokens[2]} at /x?probe=1&token=${tokens[3]}`;
    const clean = sanitize(text);

    for (const token of tokens) expect(clean).not.toContain(token);
    expect(clean).toContain("probe=1");
  });

  it("a create error carrying tokens in its message, code and cause never reaches samples.ndjson or the merged output", async () => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { mergeSources, readSource } = await import("../src/merge.js");
    const { writeV2 } = await import("../src/v2-report.js");
    const out = await directory("sandbox-bench-leak-");
    const base = memory();

    const provider = {
      ...base,
      create: async () => {
        throw Object.assign(
          new Error(`Maritime create failed for ${tokens[1]} (preview /?token=${tokens[3]})`),
          {
            code: tokens[2],
            cause: `providerCode: ${tokens[1]} requestId: ${tokens[2]} stage: ${tokens[0]}`,
          },
        );
      },
    };

    const report = await runV2(
      [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
      parseV2([
        "--providers",
        "memory",
        "--runs",
        "1",
        "--max-sandboxes",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "cold",
        "--timeout-ms",
        "5000",
        "--out",
        out,
      ]),
      async () => {},
    );

    expect(report.samples.some((s) => s.outcome.kind === "failure")).toBe(true);
    await writeV2(report, report.config.out);
    const files = await readdir(out, { recursive: true });
    expect(files.some((file) => file.endsWith("samples.ndjson"))).toBe(true);

    const written = await Promise.all(
      files
        .filter((file) => /\.(ndjson|json)$/.test(file))
        .map((file) => readFile(join(out, file), "utf8")),
    );

    const merged = JSON.stringify(mergeSources([await readSource(report.config.out)]));

    for (const text of [...written, merged])
      for (const token of tokens) expect(text).not.toContain(token);
  }, 60_000);
});

describe("finding 4: Maritime snapshot provenance is its own sourceSandboxId", () => {
  it.each([
    ["null", { name: "snap-1", sourceSandboxId: null, sandboxId: "sbx-src" }],
    ["missing", { name: "snap-1", sandboxId: "sbx-src", sourceVmId: "sbx-src" }],
  ])(
    "a %s sourceSandboxId fails provenance even when another field names the source",
    async (_n, body) => {
      vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(body));

      await expect(
        // SAFETY: inspectSnapshot reads the provider only for local Docker; Maritime's case never touches it.
        inspectSnapshot("maritime", { name: "maritime" } as never, "sbx-src", "snap-1"),
      ).rejects.toThrow(/source metadata/);
    },
  );
});

describe("finding 5: a pending Maritime save is never lost or replayed after its delete", () => {
  it("a replay answered 401, then a 404 read, keeps the save unresolved instead of absent", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      new URL(String(input)).pathname.endsWith("/save")
        ? Response.json({ code: "unauthenticated" }, { status: 401 })
        : Response.json({ code: "snapshot_not_found" }, { status: 404 }),
    );

    await expect(
      settleMaritimeSave({
        sandboxId: "sbx-src",
        name: "snap-1",
        idempotencyKey: "key-1",
        timeoutMs: 1500,
      }),
    ).rejects.toThrow(/did not settle/);
  });

  it("a replay answered 503 still reads the snapshot, so a visible one is found", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      new URL(String(input)).pathname.endsWith("/save")
        ? Response.json({ code: "internal_error" }, { status: 503 })
        : Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" }),
    );

    await expect(
      settleMaritimeSave({
        sandboxId: "sbx-src",
        name: "snap-1",
        idempotencyKey: "key-1",
        timeoutMs: 1500,
      }),
    ).resolves.toBe("exists");
  });

  it("reapRun deletes a pending save's snapshot found from its source, clears the entry and never replays the save", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const out = await directory("bench-maritime-reap-");
    const calls: string[] = [];
    let deleted = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (url.pathname === "/v1/snapshots" && method === "GET")
        return Response.json({
          data: deleted ? [] : [{ name: "snap-1", sourceSandboxId: "sbx-src" }],
          nextCursor: null,
        });

      if (url.pathname === "/v1/snapshots/snap-1" && method === "DELETE") {
        deleted = true;

        return Response.json({ deleted: true });
      }

      if (url.pathname === "/v1/snapshots/snap-1")
        return deleted
          ? Response.json({ code: "snapshot_not_found" }, { status: 404 })
          : Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });

      // A replayed save after the delete would make the snapshot again.
      if (url.pathname.endsWith("/save")) {
        deleted = false;

        return Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });
      }

      return Response.json({ code: "resource_not_found" }, { status: 404 });
    });

    const proof = snapshotProvenanceSchema.parse({
      sourceId: "sbx-src",
      runLabel: "maritime-run",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "maritime-run",
        resources: [
          {
            provider: "maritime",
            id: "sbx-src",
            kind: "snapshot-source",
            parent: null,
            snapshotProof: proof,
          },
          {
            provider: "maritime",
            id: "snap-1",
            kind: "snapshot",
            parent: "sbx-src",
            snapshotProof: proof,
            idempotencyKey: "key-1",
          },
        ],
      }),
    );

    await reapRun(
      [{ kind: "ready", name: "maritime", cloud: true, region: null, provider: memory() }],
      parseV2(["--providers", "maritime", "--run", "maritime-run", "--out", out]),
      (s) => s,
    );

    expect(calls).toContain("DELETE /v1/snapshots/snap-1");
    expect(calls.filter((c) => c.endsWith("/save"))).toEqual([]);
    expect(deleted).toBe(true);
    const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    expect(journal.resources.filter((r: { kind: string }) => r.kind === "snapshot")).toEqual([]);
  }, 30_000);
});

describe("finding 6: sdk-overhead's raw Maritime create admits only its own sandbox", () => {
  it("an answer naming an operator's sandbox is refused, never admitted and never deleted", async () => {
    const server = await loopback((request, response) => {
      if (request.method === "POST")
        return response.writeHead(201, { "content-type": "application/json" }).end(
          JSON.stringify({
            id: "sbx-operator",
            state: "running",
            dataPlaneUrl: "http://127.0.0.1:1/dp",
            secret: "mst_operator_secret_0123456789",
            metadata: { owner: "operator", [rawOwnerLabel]: "someone-else" },
          }),
        );

      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });

    vi.stubEnv("MARITIME_API_URL", server.url);
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const admitted: RawMaritimeBox[] = [];

    try {
      await expect(
        createRawMaritime({
          template: "base",
          labels: { "sdk-overhead-run": "r1" },
          admit: (box) => admitted.push(box),
        }),
      ).rejects.toThrow(/did not make/);

      // The script's cleanup destroys every admitted box.
      for (const box of admitted) await box.destroy();

      expect(admitted).toEqual([]);
      expect(server.requests.filter((r) => r.startsWith("DELETE"))).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("finding 10: billing completeness follows the approved predicate", () => {
  const ended: MaritimeInfo = {
    id: "sbx-a",
    state: "ended",
    createdAt: "2026-11-23T20:46:00.339028Z",
    endedAt: "2026-11-23T20:46:07.487448Z",
    runningSeconds: 6,
    costSoFarUsd: null,
    storedBytes: 0,
  };

  it("an ended sandbox with closed, nonempty usage is complete even when /info has no costSoFarUsd", () => {
    const cost = decodeMaritime(
      ended,
      [
        {
          sandboxId: "sbx-a",
          startedAt: "2026-11-23T20:46:01.026450Z",
          endedAt: "2026-11-23T20:46:07.325116Z",
          costUsd: "0.000038",
        },
      ],
      "sbx-a",
    );

    expect(cost).toMatchObject({ kind: "metered", complete: true, confidence: "medium" });
  });
});

describe("re-review regressions on 6d6fea6", () => {
  it("sanitizes Maritime credentials prefixed with error_ or request_ in samples.ndjson and merged output", async () => {
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const { mergeSources, readSource } = await import("../src/merge.js");
    const { writeV2 } = await import("../src/v2-report.js");
    const wrappedSecret = "mst_wrapped_secret_123456789";
    const wrappedToken = "mut_wrapped_token_123456789";
    const out = await directory("sandbox-bench-wrapped-leak-");
    const base = memory();

    const provider = {
      ...base,
      create: async () => {
        throw Object.assign(
          new Error(`HTTP 400 error_${wrappedSecret} (request request_${wrappedToken})`),
          { code: `error_${wrappedSecret}` },
        );
      },
    };

    const report = await runV2(
      [{ kind: "ready", name: "memory", cloud: false, region: null, provider }],
      parseV2([
        "--providers",
        "memory",
        "--runs",
        "1",
        "--max-sandboxes",
        "1",
        "--bursts",
        "",
        "--scenarios",
        "cold",
        "--timeout-ms",
        "5000",
        "--out",
        out,
      ]),
      async () => {},
    );

    await writeV2(report, report.config.out);
    const files = await readdir(out, { recursive: true });

    const written = await Promise.all(
      files
        .filter((file) => /\.(ndjson|json)$/.test(file))
        .map((file) => readFile(join(out, file), "utf8")),
    );

    const merged = JSON.stringify(mergeSources([await readSource(report.config.out)]));

    for (const text of [...written, merged]) {
      expect(text).not.toContain(wrappedSecret);
      expect(text).not.toContain(wrappedToken);
    }
  }, 60_000);

  it("keeps looking when a route-level 404 resource_not_found on replay precedes late visibility", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    let reads = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));

      if (url.pathname.endsWith("/save"))
        return Response.json({ code: "resource_not_found" }, { status: 404 });

      reads += 1;

      return reads === 1
        ? Response.json({ code: "snapshot_not_found" }, { status: 404 })
        : Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });
    });

    await expect(
      settleMaritimeSave({
        sandboxId: "sbx-src",
        name: "snap-1",
        idempotencyKey: "key-1",
        timeoutMs: 3000,
      }),
    ).resolves.toBe("exists");
    expect(reads).toBe(2);
  });

  it("reapRun never replays a confirmed save after the delete response is lost", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const out = await directory("bench-maritime-reap-drop-");
    const calls: string[] = [];
    let deleted = false;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (url.pathname === "/v1/snapshots" && method === "GET")
        return Response.json({
          data: deleted ? [] : [{ name: "snap-1", sourceSandboxId: "sbx-src" }],
          nextCursor: null,
        });

      if (url.pathname === "/v1/snapshots/snap-1" && method === "DELETE") {
        deleted = true;
        throw new Error("connection closed after deletion");
      }

      if (url.pathname === "/v1/snapshots/snap-1")
        return deleted
          ? Response.json({ code: "snapshot_not_found" }, { status: 404 })
          : Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });

      if (url.pathname.endsWith("/save")) {
        deleted = false;

        return Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });
      }

      return Response.json({ code: "resource_not_found" }, { status: 404 });
    });

    const proof = snapshotProvenanceSchema.parse({
      sourceId: "sbx-src",
      runLabel: "maritime-run",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "maritime-run",
        resources: [
          {
            provider: "maritime",
            id: "sbx-src",
            kind: "snapshot-source",
            parent: null,
            snapshotProof: proof,
          },
          {
            provider: "maritime",
            id: "snap-1",
            kind: "snapshot",
            parent: "sbx-src",
            snapshotProof: proof,
            idempotencyKey: "key-1",
          },
        ],
      }),
    );

    await reapRun(
      [{ kind: "ready", name: "maritime", cloud: true, region: null, provider: memory() }],
      parseV2(["--providers", "maritime", "--run", "maritime-run", "--out", out]),
      (s) => s,
    );

    expect(calls).toContain("DELETE /v1/snapshots/snap-1");
    expect(calls.filter((c) => c.endsWith("/save"))).toEqual([]);
    expect(deleted).toBe(true);
    const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    expect(journal.resources.filter((r: { kind: string }) => r.kind === "snapshot")).toEqual([]);
  }, 30_000);

  it("reapRun strips the save key before DELETE when list omits the snapshot and exact GET confirms it", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const out = await directory("bench-maritime-reap-list-miss-");
    const calls: string[] = [];
    let deleted = false;
    let journalBeforeDelete = "";

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);

      if (url.pathname === "/v1/snapshots" && method === "GET")
        return Response.json({ data: [], nextCursor: null });

      if (url.pathname === "/v1/snapshots/snap-1" && method === "DELETE") {
        journalBeforeDelete = await readFile(join(out, "ownership.json"), "utf8");
        deleted = true;
        throw new Error("connection closed after deletion");
      }

      if (url.pathname === "/v1/snapshots/snap-1")
        return deleted
          ? Response.json({ code: "snapshot_not_found" }, { status: 404 })
          : Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });

      if (url.pathname.endsWith("/save")) {
        deleted = false;

        return Response.json({ name: "snap-1", sourceSandboxId: "sbx-src" });
      }

      return Response.json({ code: "resource_not_found" }, { status: 404 });
    });

    const proof = snapshotProvenanceSchema.parse({
      sourceId: "sbx-src",
      runLabel: "maritime-run",
      sdkLabel: "1",
      verifiedAt: new Date().toISOString(),
    });

    await writeFile(
      join(out, "ownership.json"),
      JSON.stringify({
        runId: "maritime-run",
        resources: [
          {
            provider: "maritime",
            id: "snap-1",
            kind: "snapshot",
            parent: "sbx-src",
            snapshotProof: proof,
            idempotencyKey: "key-1",
          },
        ],
      }),
    );

    const providers = [
      { kind: "ready" as const, name: "maritime", cloud: true, region: null, provider: memory() },
    ];

    const config = parseV2(["--providers", "maritime", "--run", "maritime-run", "--out", out]);

    // First reap settles via replay + GET, strips idempotencyKey before DELETE, then hits the lost DELETE answer.
    await reapRun(providers, config, (s) => s);
    expect(calls.filter((c) => c === "DELETE /v1/snapshots/snap-1")).toHaveLength(1);
    const saveCallsAfterFirst = calls.filter((c) => c.endsWith("/save")).length;
    expect(journalBeforeDelete).not.toContain("idempotencyKey");

    // Second reap must NOT replay POST /save; it confirms absence via GET and forgets the entry.
    await reapRun(providers, config, (s) => s);
    expect(calls.filter((c) => c.endsWith("/save"))).toHaveLength(saveCallsAfterFirst);
    expect(deleted).toBe(true);
    const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    expect(journal.resources.filter((r: { kind: string }) => r.kind === "snapshot")).toEqual([]);
  }, 30_000);

  it("route-level 404 resource_not_found never proves snapshot absence in settle, inspect, or delete", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const provider = memory();

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/save") && method === "POST")
        return Response.json({ code: "sandbox_ended" }, { status: 410 });

      return Response.json({ code: "resource_not_found" }, { status: 404 });
    });

    await expect(
      settleMaritimeSave({
        sandboxId: "sbx-src",
        name: "snap-1",
        idempotencyKey: "key-1",
        timeoutMs: 800,
      }),
    ).rejects.toThrow(/did not settle/);

    await expect(inspectSnapshot("maritime", provider, "sbx-src", "snap-1")).rejects.toThrow(
      /Snapshot metadata unavailable/,
    );

    const clean = await snapshotCleaner("maritime", provider, "sbx-src");
    await expect(clean("snap-1")).rejects.toThrow(/Maritime snapshot delete failed/);

    // Only explicit 404 snapshot_not_found proves absence.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ code: "snapshot_not_found" }, { status: 404 }),
    );

    await expect(inspectSnapshot("maritime", provider, "sbx-src", "snap-1")).resolves.toEqual({
      exists: false,
    });
    await expect(clean("snap-1")).resolves.toBeUndefined();
  });

  it("runV2 never sends DELETE if the confirmed keyless snapshot journal cannot be persisted", async () => {
    vi.stubEnv("MARITIME_API_KEY", "mk_test_key");
    const { memory } = await import("@opencoredev/sandbox-sdk/memory");
    const { runV2 } = await import("../src/v2-runner.js");
    const out = await directory("bench-maritime-journal-fail-");
    const journalPath = join(out, "ownership.json");
    const realRename = journalFiles.rename;
    const deleteJournals: string[] = [];
    let rejectedWrites = 0;
    let savedSnapshot: { name: string; sourceSandboxId: string } | null = null;

    vi.spyOn(journalFiles, "rename").mockImplementation(async (from, to) => {
      if (to === journalPath) {
        const next = await readFile(from, "utf8");

        if (
          savedSnapshot &&
          !next.includes("idempotencyKey") &&
          next.includes(savedSnapshot.name)
        ) {
          rejectedWrites += 1;
          throw new Error("confirmed journal rename failed");
        }
      }

      return realRename(from, to);
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/save") && method === "POST") {
        const sourceSandboxId = url.pathname.split("/")[3] ?? "";
        const body = z.object({ name: z.string() }).parse(JSON.parse(String(init?.body ?? "{}")));
        savedSnapshot = { name: body.name, sourceSandboxId };

        return Response.json(savedSnapshot);
      }

      if (savedSnapshot && url.pathname === `/v1/snapshots/${savedSnapshot.name}`) {
        if (method === "DELETE") {
          deleteJournals.push(await readFile(journalPath, "utf8"));

          return Response.json({ deleted: true });
        }

        return Response.json(savedSnapshot);
      }

      if (url.pathname === "/v1/snapshots" && method === "GET")
        return Response.json({ data: savedSnapshot ? [savedSnapshot] : [], nextCursor: null });

      return Response.json({ code: "resource_not_found" }, { status: 404 });
    });

    const base = memory();

    await runV2(
      [
        {
          kind: "ready",
          name: "maritime",
          cloud: true,
          region: null,
          provider: {
            ...base,
            capabilities: new Set([...base.capabilities, "snapshot"]),
            async snapshot() {
              throw new Error("unused for named Maritime snapshots");
            },
          },
        },
      ],
      parseV2([
        "--providers",
        "maritime",
        "--scenarios",
        "snapshot",
        "--runs",
        "1",
        "--bursts",
        "",
        "--timeout-ms",
        "5000",
        "--run",
        "snapshot-run",
        "--out",
        out,
      ]),
      async () => {},
    ).catch(() => {});

    expect(rejectedWrites).toBeGreaterThan(0);
    expect(await readFile(journalPath, "utf8")).toContain("idempotencyKey");
    expect(deleteJournals).toEqual([]);
  }, 30_000);
});
