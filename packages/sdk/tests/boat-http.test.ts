// Boat and Sandboxer over plain HTTP: the command stream's protocol faults, lifecycle faults, the
// idempotency key, the delete confirmation headers, and the native API. Everything runs against
// http-fake, so each fault is scripted rather than timed.
import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import type { BoatApi } from "@boatdev/sdk";
import { SandboxError } from "../src/index.js";
import type { ExecInput } from "../src/provider.js";
import { boat } from "../src/providers/boat/index.js";
import { sandboxer } from "../src/providers/sandboxer/index.js";
import {
  followCommand,
  type CommandFrame,
  type FollowTiming,
} from "../src/providers/boat-api/follow.js";
import { boatHttp } from "../src/providers/boat-api/transport.js";
import { fakeServer, pieces, type FakeServer } from "./http-fake.js";

let server: FakeServer;
beforeEach(async () => {
  server = await fakeServer();
});
afterEach(async () => {
  await server.close();
});

const line = (frame: object) => JSON.stringify(frame) + "\n";
const attached = (stdoutOffset = 0, stderrOffset = 0) =>
  line({ type: "attached", processId: 7, stdoutOffset, stderrOffset });
const out = (data: string, nextOffset: number, stream: "stdout" | "stderr" = "stdout") =>
  line({ type: stream, data, nextOffset });
const exit = (exitCode = 0) => line({ type: "exit", status: "exited", exitCode, signal: null });
const streamRoute = "GET /sandboxes/{id}/commands/{pid}/stream";
const fast: FollowTiming = { idleMs: 2_000, retryWindowMs: 2_000, retryDelayMs: 10 };

function client() {
  return boatHttp({
    provider: "boat",
    label: "Boat",
    keyEnv: "BOAT_API_KEY",
    baseUrl: () => server.url,
    credentials: () => "boat-key-123456",
    secrets: () => ["boat-key-123456"],
    timeoutMs: 5_000,
    retries: 0,
  });
}
async function follow(options: { timing?: FollowTiming; signal?: AbortSignal } = {}) {
  const frames: CommandFrame[] = [];
  for await (const frame of followCommand(client(), "bx_1", 7, {
    signal: options.signal ?? new AbortController().signal,
    timing: options.timing ?? fast,
  }))
    frames.push(frame);
  const text = (stream: "stdout" | "stderr") =>
    frames.flatMap((frame) => (frame.type === stream ? [frame.data] : [])).join("");
  return { frames, stdout: text("stdout"), stderr: text("stderr"), last: frames.at(-1) };
}
const offsets = (index: number) => {
  const url = new URL(server.calls(streamRoute)[index]?.url ?? "/", server.url);
  return [url.searchParams.get("stdoutOffset"), url.searchParams.get("stderrOffset")];
};
async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    if (error instanceof SandboxError) return error;
  }
  throw new Error("expected a SandboxError rejection");
}

describe("command stream", () => {
  test("a forced reconnect frame reopens at its offsets at once, with no gap and no repeat", async () => {
    server.on(
      streamRoute,
      // The connection stays open after `reconnect`, and failure retries are slow: only an immediate rotation is fast.
      {
        stream: [
          attached(),
          out("a", 1),
          out("e", 1, "stderr"),
          line({ type: "reconnect", stdoutOffset: 1, stderrOffset: 1 }),
        ],
        hold: true,
      },
      { stream: [attached(1, 1), out("b", 2), exit()] },
    );
    const started = Date.now();
    const result = await follow({
      timing: { idleMs: 5_000, retryWindowMs: 10_000, retryDelayMs: 5_000 },
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result).toMatchObject({
      stdout: "ab",
      stderr: "e",
      last: { type: "exit", exitCode: 0 },
    });
    expect([offsets(0), offsets(1)]).toEqual([
      ["0", "0"],
      ["1", "1"],
    ]);
    expect(server.calls(streamRoute)[0]?.headers.authorization).toBe("Bearer boat-key-123456");
  });

  test("a mid-stream cut resumes from the last offsets and drops a replayed chunk", async () => {
    server.on(
      streamRoute,
      { stream: [attached(), out("a", 1), out("b", 2)], cut: true },
      // The server replays "b" although it was asked for offset 2.
      { stream: [attached(2, 0), out("b", 2), out("c", 3), exit(3)] },
    );
    const result = await follow();
    expect(result).toMatchObject({ stdout: "abc", last: { type: "exit", exitCode: 3 } });
    expect(offsets(1)).toEqual(["2", "0"]);
  });

  test("an attached offset of 0 after a reconnect is a replaced log: its output is kept, as the SDK does", async () => {
    server.on(
      streamRoute,
      {
        stream: [
          attached(),
          out("old", 3),
          line({ type: "reconnect", stdoutOffset: 3, stderrOffset: 0 }),
        ],
      },
      { stream: [attached(0, 0), out("new", 3), exit()] },
    );
    expect((await follow()).stdout).toBe("oldnew");
    expect(offsets(1)).toEqual(["3", "0"]);
  });

  test("an exit frame without an exit code is outcome_unknown", async () => {
    server.on(streamRoute, { stream: [attached(), line({ type: "exit", status: "exited" })] });
    expect((await failure(follow())).code).toBe("outcome_unknown");
  });

  test("a cut inside a JSON line resumes without a partial frame", async () => {
    const third = out("c", 3);
    server.on(
      streamRoute,
      { stream: [attached(), out("ab", 2), third.slice(0, 9)], cut: true },
      { stream: [attached(2, 0), third, exit()] },
    );
    expect((await follow()).stdout).toBe("abc");
    expect(offsets(1)).toEqual(["2", "0"]);
  });

  test("a body that ends without exit or reconnect is reattached", async () => {
    server.on(
      streamRoute,
      { stream: [attached(), out("a", 1)] },
      { stream: [attached(1, 0), exit()] },
    );
    expect((await follow()).stdout).toBe("a");
    expect(server.calls(streamRoute)).toHaveLength(2);
  });

  test("the idle watchdog drops a silent connection and reattaches", async () => {
    server.on(
      streamRoute,
      { stream: [attached()], hold: true },
      { stream: [attached(), out("x", 1), exit()] },
    );
    const result = await follow({
      timing: { idleMs: 150, retryWindowMs: 2_000, retryDelayMs: 10 },
    });
    expect(result.stdout).toBe("x");
    expect(server.calls(streamRoute)).toHaveLength(2);
  });

  test("heartbeats keep a quiet connection open", async () => {
    server.on(streamRoute, {
      stream: [
        attached(),
        line({ type: "heartbeat", stdoutOffset: 0, stderrOffset: 0 }),
        line({ type: "heartbeat" }),
        out("late", 4),
        exit(),
      ],
      intervalMs: 80,
    });
    const result = await follow({
      timing: { idleMs: 150, retryWindowMs: 2_000, retryDelayMs: 10 },
    });
    expect(result.stdout).toBe("late");
    expect(server.calls(streamRoute)).toHaveLength(1);
  });

  test("UTF-8 and frames split across chunks reassemble", async () => {
    const text = "雪 ☃ 𝄞 done";
    server.on(streamRoute, {
      stream: pieces(attached() + out(text, Buffer.byteLength(text)) + exit(), 3),
      intervalMs: 1,
    });
    expect((await follow()).stdout).toBe(text);
  });

  test("an error frame ends the stream", async () => {
    server.on(streamRoute, {
      stream: [
        attached(),
        out("a", 1),
        line({ type: "error", error: "lost", message: "agent restarted" }),
      ],
    });
    expect((await follow()).last).toEqual({ type: "error" });
  });

  test("the first attach is not retried, so a missing stream fails fast", async () => {
    server.on(streamRoute, { status: 503, json: { ok: false, code: "unavailable" } });
    expect((await failure(follow())).code).toBe("unavailable");
    expect(server.calls(streamRoute)).toHaveLength(1);
  });

  test("a status error after a good connection is retried only for 5xx", async () => {
    server.on(
      streamRoute,
      { stream: [attached(), out("a", 1)], cut: true },
      { status: 404, json: { ok: false, code: "not_found" } },
    );
    expect((await failure(follow())).code).toBe("not_found");
    expect(server.calls(streamRoute)).toHaveLength(2);
  });

  test("failing reconnects give up after the retry window", async () => {
    server.on(streamRoute, { stream: [attached(), out("a", 1)], cut: true }, { drop: true });
    const error = await failure(
      follow({ timing: { idleMs: 2_000, retryWindowMs: 200, retryDelayMs: 20 } }),
    );
    expect(error.code).toBe("unavailable");
    expect(server.calls(streamRoute).length).toBeGreaterThan(2);
  });

  test("a malformed frame fails without a retry", async () => {
    server.on(streamRoute, { stream: [attached(), line({ type: "stdout" })] });
    expect((await failure(follow())).code).toBe("provider");
    expect(server.calls(streamRoute)).toHaveLength(1);
  });

  test("an abort during startup rejects with aborted and closes the request", async () => {
    server.on(streamRoute, { hang: true });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 30);
    const started = Date.now();
    expect((await failure(follow({ signal: abort.signal }))).code).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

/** A Boat API on http-fake that keeps sandboxes in memory. Names echo, so the metadata rename sticks. */
function boatApiRoutes() {
  const sandbox = (id: string, name = "") => ({
    id,
    name,
    state: "ready",
    createdAt: "2026-10-29T00:00:00Z",
  });
  let names = new Map<string, string>();
  server.on("PATCH /sandboxes/{id}", (request, response) => {
    const id = request.url.split("/")[2] ?? "";
    const name: unknown = JSON.parse(request.body.toString()).name;
    if (typeof name === "string") names.set(id, name);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ ok: true, sandbox: sandbox(id, names.get(id)) }));
  });
  server.on("DELETE /sandboxes/{id}", {
    status: 202,
    json: {
      ok: true,
      operation: { id: "delete", kind: "sandbox", targetId: "bx_1", status: "completed" },
    },
  });
  return {
    sandbox,
    reset: () => {
      names = new Map();
    },
  };
}
const execInput = (overrides: Partial<ExecInput> = {}): ExecInput => ({
  command: "echo hi",
  cwd: "/workspace",
  env: {},
  timeoutMs: 10_000,
  onChunk: () => {},
  ...overrides,
});

describe("adapter over HTTP", () => {
  test("create keeps one idempotency key and body across lost and failed attempts", async () => {
    const { sandbox } = boatApiRoutes();
    server.on(
      "POST /sandboxes",
      { drop: true },
      { status: 500, json: { ok: false, code: "internal" } },
      { status: 202, json: { ok: true, sandbox: sandbox("bx_1") } },
    );
    const created = await boat({ apiKey: "k", baseUrl: server.url }).create({
      labels: { app: "x" },
    });
    expect(created).toMatchObject({ id: "bx_1", state: "running", labels: { app: "x" } });
    const posts = server.calls("POST /sandboxes");
    expect(posts).toHaveLength(3);
    const key = posts[0]?.headers["idempotency-key"];
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    for (const post of posts) {
      expect(post.headers["idempotency-key"]).toBe(key);
      expect(post.body.toString()).toBe(posts[0]?.body.toString());
    }
    expect(JSON.parse(posts[0]?.body.toString() ?? "")).toEqual({ noEnv: true });
  });

  test("a create that lands after the caller aborted is destroyed, not leaked", async () => {
    const { sandbox } = boatApiRoutes();
    server.on("POST /sandboxes", {
      status: 202,
      json: { ok: true, sandbox: sandbox("bx_1") },
      delayMs: 150,
    });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 20);
    expect(
      (
        await failure(
          boat({ apiKey: "k", baseUrl: server.url }).create({ labels: {}, signal: abort.signal }),
        )
      ).code,
    ).toBe("aborted");
    expect(server.calls("DELETE /sandboxes/{id}")).toHaveLength(1);
    expect(server.calls("DELETE /sandboxes/{id}")[0]?.headers["x-ascii-confirm-delete"]).toBe(
      "bx_1",
    );
  });

  test("a launched command whose response is lost is outcome_unknown", async () => {
    server.on("POST /sandboxes/{id}/commands", { drop: true });
    const error = await failure(
      boat({ apiKey: "k", baseUrl: server.url }).exec("bx_1", execInput()),
    );
    expect(error.code).toBe("outcome_unknown");
    expect(server.calls("POST /sandboxes/{id}/commands")).toHaveLength(1);
  });

  test("exec streams through a forced reconnect and a cut with exactly-once output", async () => {
    server.on("POST /sandboxes/{id}/commands", {
      json: {
        ok: true,
        type: "command.started",
        success: true,
        processId: 7,
        pid: 7,
        command: "x",
        startedAt: "2026-10-29T00:00:00Z",
      },
    });
    server.on(
      streamRoute,
      {
        stream: [
          attached(),
          out("one\n", 4),
          line({ type: "reconnect", stdoutOffset: 4, stderrOffset: 0 }),
        ],
      },
      { stream: [attached(4, 0), out("two\n", 8)], cut: true },
      // The server replays "two" although it was asked for offset 8.
      { stream: [attached(8, 0), out("two\n", 8), out("three\n", 14), exit()] },
    );
    const chunks: string[] = [];
    const result = await boat({ apiKey: "k", baseUrl: server.url }).exec(
      "bx_1",
      execInput({ onChunk: (chunk) => chunks.push(chunk.text) }),
    );
    expect(result).toEqual({ exitCode: 0, timedOut: false });
    expect(chunks.join("")).toBe("one\ntwo\nthree\n");
    expect([offsets(1), offsets(2)]).toEqual([
      ["4", "0"],
      ["8", "0"],
    ]);
  });

  test("Sandboxer deletes with its confirmation header and waits for the operation", async () => {
    server.on("DELETE /sandboxes/{id}", {
      status: 202,
      json: {
        ok: true,
        operation: { id: "op_1", kind: "sandbox", targetId: "sb_1", status: "processing" },
      },
    });
    server.on(
      "GET /deletion-operations/{id}",
      { json: { operation: { id: "op_1", targetId: "sb_1", status: "processing" } } },
      { json: { operation: { id: "op_1", targetId: "sb_1", status: "completed" } } },
    );
    await sandboxer({ apiKey: "k", baseUrl: server.url }).destroy("sb_1");
    const deletion = server.calls("DELETE /sandboxes/{id}")[0];
    expect(deletion?.headers).toMatchObject({
      "x-sandboxer-confirm-delete": "sb_1",
      "x-ascii-confirm-delete": "sb_1",
    });
    expect(server.calls("GET /deletion-operations/{id}")).toHaveLength(2);
  });

  test("Sandboxer sends its region in the create body and reports placement on native", async () => {
    const { sandbox } = boatApiRoutes();
    server.on("POST /sandboxes", {
      status: 202,
      json: {
        ok: true,
        sandbox: { ...sandbox("sb_1"), region: "eu-central", regionSource: "requested" },
      },
    });
    const provider = sandboxer({ apiKey: "k", baseUrl: server.url, region: "eu-central" });
    await provider.create({ labels: {} });
    expect(JSON.parse(server.calls("POST /sandboxes")[0]?.body.toString() ?? "")).toMatchObject({
      region: "eu-central",
      noEnv: true,
    });
    expect(provider.native("sb_1")).toMatchObject({
      sandboxId: "sb_1",
      region: "eu-central",
      regionSource: "requested",
    });
  });
});

describe("native API", () => {
  test("box.native fills {sandboxId} and sends the key only to the API origin", async () => {
    server.on("GET /sandboxes/{id}", { json: { ok: true, sandbox: { id: "bx_1" } } });
    const native = boat({ apiKey: "boat-key-123456", baseUrl: server.url }).native("bx_1");
    expect(native.sandboxId).toBe("bx_1");
    expect(
      await native.request<{ sandbox: { id: string } }>("GET", "/sandboxes/{sandboxId}"),
    ).toEqual({ ok: true, sandbox: { id: "bx_1" } });
    expect(server.calls("GET /sandboxes/{id}")[0]).toMatchObject({
      url: "/sandboxes/bx_1",
      headers: { authorization: "Bearer boat-key-123456" },
    });
  });

  test("provider.api is account-scoped: {sandboxId} must be passed", async () => {
    server.on("GET /limits", { json: { ok: true, limits: {} } });
    const { api } = boat({ apiKey: "k", baseUrl: server.url });
    expect(api.sandboxId).toBeUndefined();
    expect(await api.request("GET", "/limits")).toEqual({ ok: true, limits: {} });
    expect((await failure(api.request("GET", "/sandboxes/{sandboxId}"))).code).toBe(
      "invalid_argument",
    );
    expect(server.calls("GET /sandboxes/{id}")).toHaveLength(0);
  });

  test("fetch returns the raw stream; errors keep the provider message without the key", async () => {
    server.on(streamRoute, { stream: [attached(), exit()] }).on("GET /sandboxes/{id}/nope", {
      status: 404,
      json: { code: "not_found", message: "no route for boat-key-123456" },
    });
    const native = boat({ apiKey: "boat-key-123456", baseUrl: server.url }).native("bx_1");
    const response = await native.fetch(
      "GET",
      "/sandboxes/{sandboxId}/commands/{processId}/stream",
      { params: { processId: 7 } },
    );
    expect(await response.text()).toBe(attached() + exit());
    const error = await failure(native.request("GET", "/sandboxes/{sandboxId}/nope"));
    expect(error).toMatchObject({ code: "not_found", provider: "boat", sandboxId: "bx_1" });
    expect(error.message).toContain("no route for");
    expect(error.message).not.toContain("boat-key-123456");
  });

  test("a missing key fails native calls with auth before any request", async () => {
    const previous = process.env.BOAT_API_KEY;
    delete process.env.BOAT_API_KEY;
    try {
      expect(
        (await failure(boat({ baseUrl: server.url }).api.request("GET", "/limits"))).code,
      ).toBe("auth");
      expect(server.calls("GET /limits")).toHaveLength(0);
    } finally {
      if (previous !== undefined) process.env.BOAT_API_KEY = previous;
    }
  });

  test("sdk(load) builds the caller's BoatApi with this base URL and key", async () => {
    server.on("GET /sandboxes/{id}", {
      json: { ok: true, type: "sandbox.info", sandbox: { id: "bx_1", name: "n", state: "ready" } },
    });
    const provider = boat({ apiKey: "boat-key-123456", baseUrl: server.url });
    const { client, sandbox } = await provider.native("bx_1").sdk(() => import("@boatdev/sdk"));
    expectTypeOf(client).toEqualTypeOf<BoatApi>();
    expect(sandbox).toMatchObject({ id: "bx_1", state: "ready" });
    expect(server.calls("GET /sandboxes/{id}")[0]).toMatchObject({
      url: "/sandboxes/bx_1",
      headers: { authorization: "Bearer boat-key-123456" },
    });
    const account = await provider.api.sdk(() => import("@boatdev/sdk"));
    expectTypeOf(account).toEqualTypeOf<BoatApi>();
    expect(typeof account.sandboxes).toBe("function");
  });

  test("sdk(load) with a module that is not @boatdev/sdk is invalid_argument", async () => {
    const native = boat({ apiKey: "k", baseUrl: server.url }).native("bx_1");
    // @ts-expect-error the module lacks Configuration and BoatApi
    const error = await failure(native.sdk(async () => ({ Other: class {} })));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toContain('import("@boatdev/sdk")');
  });

  test("Sandboxer's sdk(load) client sends Sandboxer's delete confirmation", async () => {
    server.on("DELETE /sandboxes/{id}", {
      status: 202,
      json: {
        ok: true,
        type: "sandbox.deleting",
        operation: { id: "op_1", kind: "sandbox", targetId: "sb_1", status: "completed" },
      },
    });
    const { client } = await sandboxer({ apiKey: "k", baseUrl: server.url })
      .native("sb_1")
      .sdk(async () => {
        const module = await import("@boatdev/sdk");
        // native.sdk() fetches the sandbox first.
        server.on("GET /sandboxes/{id}", { json: { ok: true, sandbox: { id: "sb_1" } } });
        return module;
      });
    await client.deleteSandbox({ sandboxId: "sb_1", xAsciiConfirmDelete: "sb_1" });
    expect(server.calls("DELETE /sandboxes/{id}")[0]?.headers).toMatchObject({
      "x-sandboxer-confirm-delete": "sb_1",
      authorization: "Bearer k",
    });
  });
});

describe("create shares one deadline across its attempts (SBX-74 review)", () => {
  test.each([
    ["boat", () => boat({ apiKey: "boat-key-123456", apiUrl: server.url, requestTimeoutMs: 150 })],
    [
      "sandboxer",
      () => sandboxer({ apiKey: "boat-key-123456", baseUrl: server.url, requestTimeoutMs: 150 }),
    ],
  ] as const)(
    "%s: immediate 503s stop at requestTimeoutMs, not after three fresh timeouts and the full backoff",
    async (_name, factory) => {
      server.on("POST /sandboxes", { status: 503, json: { message: "busy" } });
      const started = Date.now();
      await expect(factory().create({ labels: {} })).rejects.toMatchObject({
        code: "outcome_unknown",
      });
      // Before the fix: three attempts and 250 + 500 ms of backoff, about 760 ms. The first backoff no longer fits.
      expect(Date.now() - started).toBeLessThan(400);
      expect(server.calls("POST /sandboxes")).toHaveLength(1);
    },
  );

  test("a slow create leaves the rename only what remains of the same deadline", async () => {
    server.on("POST /sandboxes", {
      json: {
        sandbox: { id: "bx_1", name: "", state: "running", createdAt: new Date().toISOString() },
      },
      delayMs: 400,
    });
    server.on("PATCH /sandboxes/{id}", { hang: true });
    server.on("DELETE /sandboxes/{id}", { status: 204 });
    const started = Date.now();
    await expect(
      boat({ apiKey: "boat-key-123456", apiUrl: server.url, requestTimeoutMs: 600 }).create({
        labels: {},
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    // The PATCH gets about 200 ms, not a fresh 600 ms (1000 ms in all), and the half-made VM is destroyed.
    expect(Date.now() - started).toBeLessThan(850);
    expect(server.calls("DELETE /sandboxes/{id}").length).toBeGreaterThan(0);
  });
});
