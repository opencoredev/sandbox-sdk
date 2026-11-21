import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SandboxError } from "../src/errors.js";
import { groundbox } from "../src/providers/groundbox/index.js";
import { stdinPieces } from "../src/providers/groundbox/stream.js";
import { fakeServer, type FakeServer, type RecordedRequest } from "./http-fake.js";

let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

const sandbox = (status = "running", metadata: Record<string, string> = {}) => ({
  id: "sbx_abc123def456",
  status,
  cpus: 4,
  memory_gb: 8,
  disk_gb: 20,
  metadata,
  created_at: "2026-11-20T12:00:00Z",
});

const exec = (exit_code = 0, stdout = "", stderr = "", timed_out = false) => ({
  exit_code,
  stdout,
  stderr,
  duration_ms: 3,
  timed_out,
});

const provider = (options: Parameters<typeof groundbox>[0] = {}) =>
  groundbox({
    apiKey: "gbx_test_key",
    baseUrl: `${server.url}/v1`,
    operationTimeoutMs: 5_000,
    ...options,
  });

const body = (request: RecordedRequest | undefined) => JSON.parse(request!.body.toString());

async function rejection(promise: Promise<unknown>): Promise<SandboxError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  if (!(error instanceof SandboxError)) throw new Error("expected a SandboxError");

  return error;
}

/** The JSON evidence an adapter error carries as its cause. */
function evidence(error: SandboxError) {
  if (!(error.cause instanceof Error)) throw new Error("expected an evidence cause");

  return JSON.parse(error.cause.message);
}

describe("groundbox create", () => {
  test("sends size, lifetime, idle pause, env, labels and key, then prepares /workspace", async () => {
    server
      .on("POST /v1/sandboxes", { status: 201, json: sandbox("running", { team: "a" }) })
      .on("POST /v1/sandboxes/{id}/exec", { json: exec() });

    const info = await provider().create({
      labels: { team: "a" },
      key: "k1",
      size: { cpu: 4, memoryMb: 8192, diskGb: 40 },
      timeoutMs: 90_000,
      idleTimeoutMs: 60_000,
      env: { NODE_ENV: "test" },
    });

    expect(info).toEqual({
      id: "sbx_abc123def456",
      labels: { team: "a" },
      state: "running",
      createdAt: Date.parse("2026-11-20T12:00:00Z"),
    });
    const [create] = server.calls("POST /v1/sandboxes");
    const sent = body(create);
    expect(sent).toEqual({
      cpus: 4,
      memory_gb: 8,
      disk_gb: 40,
      metadata: {
        team: "a",
        "sandbox-sdk-key": "k1",
        "sandbox-sdk-deadline": expect.stringMatching(/^\d+$/),
      },
      timeout_minutes: 2,
      idle_timeout_seconds: 60,
      // A wake would restart Groundbox's timeout, so only resume() wakes a sandbox with a lifetime.
      wake_on_request: false,
      env: { NODE_ENV: "test" },
    });
    expect(Number(sent.metadata["sandbox-sdk-deadline"])).toBeGreaterThan(Date.now() + 80_000);
    expect(create!.headers.authorization).toBe("Bearer gbx_test_key");
    expect(create!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(create!.headers["user-agent"]).toMatch(/^sandbox-sdk\//);
    const setup = body(server.calls("POST /v1/sandboxes/{id}/exec")[0]);
    expect(setup.cmd).toContain("mkdir -p /workspace");
  });

  test("presets map to 2 GiB per vCPU; sizes Groundbox can't take are refused", async () => {
    server
      .on("POST /v1/sandboxes", { status: 201, json: sandbox() })
      .on("POST /v1/sandboxes/{id}/exec", { json: exec() });

    await provider().create({ labels: {}, size: "large" });
    expect(body(server.calls("POST /v1/sandboxes")[0])).toMatchObject({ cpus: 8, memory_gb: 16 });

    const refused = await rejection(
      provider().create({ labels: {}, size: { cpu: 2, memoryMb: 3000 } }),
    );

    expect(refused.code).toBe("unsupported");
    expect(server.calls("POST /v1/sandboxes")).toHaveLength(1);
  });

  test("network none is an empty allowlist, and an allow list is sent as allow_hosts", async () => {
    server
      .on("POST /v1/sandboxes", { status: 201, json: sandbox() })
      .on("POST /v1/sandboxes/{id}/exec", { json: exec() });

    await provider().create({ labels: {}, network: "none" });
    await provider().create({ labels: {}, network: { allow: ["registry.npmjs.org"] } });
    const [none, allow] = server.calls("POST /v1/sandboxes").map(body);
    expect(none.allow_hosts).toEqual([]);
    expect(allow.allow_hosts).toEqual(["registry.npmjs.org"]);
  });

  test("a queued sandbox is polled until it runs; a snapshot sends no size", async () => {
    server
      .on("POST /v1/sandboxes", { status: 201, json: sandbox("queued") })
      .on("GET /v1/sandboxes/{id}", { json: sandbox("starting") }, { json: sandbox("running") })
      .on("POST /v1/sandboxes/{id}/exec", { json: exec() });

    const info = await provider().create({ labels: {}, from: "snap_abcdefgh1234" });

    expect(info.state).toBe("running");
    expect(server.calls("GET /v1/sandboxes/{id}")).toHaveLength(2);
    expect(body(server.calls("POST /v1/sandboxes")[0])).toEqual({
      metadata: {},
      snapshot_id: "snap_abcdefgh1234",
    });
  });

  test("a sandbox from a snapshot refuses a size: it keeps the snapshot's", async () => {
    const error = await rejection(
      provider().create({ labels: {}, from: "snap_abcdefgh1234", size: "small" }),
    );

    expect(error.code).toBe("unsupported");
    expect(server.requests).toHaveLength(0);
  });

  test("a failed setup deletes the sandbox and marks the error as admitted by this call", async () => {
    server
      .on("POST /v1/sandboxes", { status: 201, json: sandbox() })
      .on("POST /v1/sandboxes/{id}/exec", { json: exec(1, "", "no python3") })
      .on("DELETE /v1/sandboxes/{id}", { json: sandbox("stopped") });

    const error = await rejection(provider().create({ labels: {} }));

    expect(error.sandboxId).toBe("sbx_abc123def456");
    expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(1);
    expect(evidence(error)).toMatchObject({
      operation: "create",
      admittedByThisCall: true,
      stage: "prepare",
      sandboxId: "sbx_abc123def456",
    });
  });

  test("a sandbox that fails to start is deleted and reported", async () => {
    server
      .on("POST /v1/sandboxes", { status: 201, json: sandbox("queued") })
      .on("GET /v1/sandboxes/{id}", { json: sandbox("failed") })
      .on("DELETE /v1/sandboxes/{id}", { json: sandbox("stopped") });

    const error = await rejection(provider().create({ labels: {} }));

    expect(evidence(error)).toMatchObject({ stage: "start", admittedByThisCall: true });
    expect(server.calls("POST /v1/sandboxes/{id}/exec")).toHaveLength(0);
  });
});

describe("groundbox lookup", () => {
  test("list follows cursors, filters by label and leaves out ended sandboxes", async () => {
    server.on(
      "GET /v1/sandboxes",
      {
        json: {
          data: [
            sandbox("running", { team: "a" }),
            { ...sandbox("stopped", { team: "a" }), id: "sbx_old" },
          ],
          next_cursor: "c2",
        },
      },
      {
        json: {
          data: [{ ...sandbox("paused", { team: "b" }), id: "sbx_other" }],
          next_cursor: null,
        },
      },
    );

    const listed = await provider().list({ team: "a" });

    expect(listed.map((info) => [info.id, info.state])).toEqual([["sbx_abc123def456", "running"]]);

    const [first, second] = server
      .calls("GET /v1/sandboxes")
      .map((call) => new URL(call.url, server.url));

    expect(first!.searchParams.get("metadata[team]")).toBe("a");
    expect(first!.searchParams.get("live")).toBe("true");
    expect(second!.searchParams.get("cursor")).toBe("c2");
  });

  test("find reads the key label back as the key", async () => {
    server.on("GET /v1/sandboxes", {
      json: { data: [sandbox("paused", { "sandbox-sdk-key": "k1", app: "x" })], next_cursor: null },
    });

    expect(await provider().find("k1")).toMatchObject({
      key: "k1",
      labels: { app: "x" },
      state: "paused",
    });
    expect(
      new URL(server.requests[0]!.url, server.url).searchParams.get("metadata[sandbox-sdk-key]"),
    ).toBe("k1");
  });

  test("connect to a deleted sandbox is not_found; destroy of one gone succeeds", async () => {
    server
      .on("GET /v1/sandboxes/{id}", { json: sandbox("stopped") })
      .on("DELETE /v1/sandboxes/{id}", {
        status: 404,
        json: { error: { code: "not_found", message: "No sandbox sbx_abc123def456" } },
      });

    expect((await rejection(provider().connect("sbx_abc123def456"))).code).toBe("not_found");
    await expect(provider().destroy("sbx_abc123def456")).resolves.toBeUndefined();
  });
});

describe("groundbox exec", () => {
  const input = {
    command: "echo hi",
    cwd: "/workspace",
    env: { CI: "1" },
    timeoutMs: 10_000,
  };

  test("returns output and the exit code; a non-zero exit is a result", async () => {
    server.on("POST /v1/sandboxes/{id}/exec", { json: exec(3, "out\n", "err\n") });
    const chunks: string[] = [];

    const result = await provider().exec("sbx_abc123def456", {
      ...input,
      stdin: "y\n",
      onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
    });

    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(chunks).toEqual(["stdout:out\n", "stderr:err\n"]);
    const sent = body(server.calls("POST /v1/sandboxes/{id}/exec")[0]);
    expect(sent).toMatchObject({
      cwd: "/workspace",
      env: { CI: "1" },
      timeout_s: 11,
      stdin: "y\n",
    });
    expect(sent.cmd).toMatch(/^# sandbox-sdk [0-9a-f-]{36}\necho hi$/);
  });

  test("a server timeout has no exit code and keeps what the command printed", async () => {
    server.on("POST /v1/sandboxes/{id}/exec", { json: exec(137, "partial\n", "warn\n", true) });
    const chunks: string[] = [];

    expect(
      await provider().exec("sbx_abc123def456", {
        ...input,
        onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
      }),
    ).toEqual({ exitCode: null, timedOut: true });
    expect(chunks).toEqual(["stdout:partial\n", "stderr:warn\n"]);
  });

  test("an abort finds the command by its marker and kills it", async () => {
    server
      .on("POST /v1/sandboxes/{id}/exec", { hang: true })
      .on("GET /v1/sandboxes/{id}/commands", (request, response) => {
        const marker = body(server.calls("POST /v1/sandboxes/{id}/exec")[0]).cmd.split("\n")[0];
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            data: [
              {
                id: "ex_other0000000000000",
                cmd: "# sandbox-sdk someone-else\nsleep 1",
                state: "running",
              },
              { id: "ex_mine00000000000000", cmd: `${marker}\nsleep 60`, state: "running" },
            ],
            running: 2,
          }),
        );
      })
      .on("POST /v1/sandboxes/{id}/commands/{exec}/kill", {
        json: { id: "ex_mine00000000000000", cmd: "# sandbox-sdk", state: "exited" },
      })
      .on("GET /v1/sandboxes/{id}/commands/{exec}/output", {
        json: { stdout: "before the kill\n", stderr: "", seq: 16, more: false, done: true },
      });

    const controller = new AbortController();
    const chunks: string[] = [];

    const run = provider().exec("sbx_abc123def456", {
      ...input,
      signal: controller.signal,
      onChunk: (chunk) => chunks.push(chunk.text),
    });

    await expect.poll(() => server.calls("POST /v1/sandboxes/{id}/exec").length).toBe(1);
    controller.abort();
    expect(await run).toEqual({ exitCode: null, timedOut: true });
    // The output it printed before the kill is read back from the command log.
    expect(chunks).toEqual(["before the kill\n"]);
    const kills = server.calls("POST /v1/sandboxes/{id}/commands/{exec}/kill");
    expect(kills.map((call) => call.url)).toEqual([
      "/v1/sandboxes/sbx_abc123def456/commands/ex_mine00000000000000/kill",
    ]);
  });

  test("stdin over 512 KiB goes up as a file the command reads first", async () => {
    server
      .on("PUT /v1/sandboxes/{id}/files", { json: { path: "/tmp/x", size_bytes: 1 } })
      .on("POST /v1/sandboxes/{id}/exec", { json: exec(0, "600000\n") });

    await provider().exec("sbx_abc123def456", {
      ...input,
      stdin: "x".repeat(600_000),
      onChunk() {},
    });

    const [upload] = server.calls("PUT /v1/sandboxes/{id}/files");
    const staged = new URL(upload!.url, server.url).searchParams.get("path")!;
    expect(staged).toMatch(/^\/tmp\/\.sandbox-sdk\/stdin-/);
    expect(upload!.body.length).toBe(600_000);
    const sent = body(server.calls("POST /v1/sandboxes/{id}/exec")[0]);
    expect(sent.stdin).toBeUndefined();
    expect(sent.cmd).toContain(`exec < '${staged}'; rm -f '${staged}'`);
  });

  test("an abort during a large stdin upload returns the timeout result and removes the file", async () => {
    server
      .on("PUT /v1/sandboxes/{id}/files", { hang: true })
      .on("DELETE /v1/sandboxes/{id}/files", { json: { path: "/tmp/x", deleted: true } });

    const controller = new AbortController();

    const run = provider().exec("sbx_abc123def456", {
      ...input,
      stdin: "x".repeat(600_000),
      signal: controller.signal,
      onChunk() {},
    });

    await expect.poll(() => server.calls("PUT /v1/sandboxes/{id}/files").length).toBe(1);
    controller.abort();
    expect(await run).toEqual({ exitCode: null, timedOut: true });
    const staged = new URL(server.calls("PUT /v1/sandboxes/{id}/files")[0]!.url, server.url);
    const [removed] = server.calls("DELETE /v1/sandboxes/{id}/files");
    expect(new URL(removed!.url, server.url).searchParams.get("path")).toBe(
      staged.searchParams.get("path"),
    );
    expect(server.calls("POST /v1/sandboxes/{id}/exec")).toHaveLength(0);
  });

  test("an abort whose kill can't be confirmed is outcome_unknown", async () => {
    server
      .on("POST /v1/sandboxes/{id}/exec", { hang: true })
      .on("GET /v1/sandboxes/{id}/commands", {
        status: 500,
        json: { error: { code: "internal", message: "down" } },
      });

    const controller = new AbortController();

    const run = provider().exec("sbx_abc123def456", {
      ...input,
      signal: controller.signal,
      onChunk() {},
    });

    await expect.poll(() => server.calls("POST /v1/sandboxes/{id}/exec").length).toBe(1);
    controller.abort();
    expect((await rejection(run)).code).toBe("outcome_unknown");
  });

  test("an abort whose command is still running after the kill is outcome_unknown", async () => {
    server
      .on("POST /v1/sandboxes/{id}/exec", { hang: true })
      .on("GET /v1/sandboxes/{id}/commands", (_request, response) => {
        const marker = body(server.calls("POST /v1/sandboxes/{id}/exec")[0]).cmd.split("\n")[0];
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ data: [{ id: "ex_mine", cmd: marker, state: "running" }], running: 1 }),
        );
      })
      .on("POST /v1/sandboxes/{id}/commands/{exec}/kill", {
        json: { id: "ex_mine", cmd: "x", state: "running" },
      });

    const controller = new AbortController();

    const run = provider().exec("sbx_abc123def456", {
      ...input,
      signal: controller.signal,
      onChunk() {},
    });

    await expect.poll(() => server.calls("POST /v1/sandboxes/{id}/exec").length).toBe(1);
    controller.abort();
    expect((await rejection(run)).code).toBe("outcome_unknown");
  });

  test("commands over an hour are refused", async () => {
    const error = await rejection(
      provider().exec("sbx_abc123def456", { ...input, timeoutMs: 3_700_000, onChunk() {} }),
    );

    expect(error.code).toBe("unsupported");
  });
});

/** What the adapter sends on the exec stream, as far as these tests read it. */
interface Frame {
  type: string;
  cmd?: string;
  cwd?: string;
  stdin?: boolean;
}

/** A WebSocket double that plays Groundbox's exec stream: it answers `start` with `script`. */
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static CONNECTING = 0;
  static last: FakeSocket | undefined;
  static script: object[] = [];
  readyState = 0;
  sent: Frame[] = [];
  closedWith: number | undefined;

  constructor(
    readonly url: string,
    readonly init: { headers: Record<string, string> },
  ) {
    super();
    FakeSocket.last = this;
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    }, 1);
  }

  send(data: string) {
    const message = JSON.parse(data);
    this.sent.push(message);

    if (message.type === "start")
      for (const reply of FakeSocket.script)
        setTimeout(
          () => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(reply) })),
          2,
        );

    if (message.type === "kill")
      setTimeout(
        () =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "exit", exit_code: 137, duration_ms: 1 }),
            }),
          ),
        2,
      );
  }

  close(code?: number) {
    this.closedWith = code;
    this.readyState = 3;
  }
}

describe("groundbox exec stream", () => {
  const input = {
    command: "printf A; printf B >&2",
    cwd: "/workspace",
    env: {},
    timeoutMs: 10_000,
  };

  test("a streaming run gets chunks in arrival order over the WebSocket, with the key in its header", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.script = [
      { type: "stdout", data: "A" },
      { type: "heartbeat" },
      { type: "stderr", data: "B" },
      { type: "exit", exit_code: 0, duration_ms: 4 },
    ];
    const chunks: string[] = [];

    const result = await provider().exec("sbx_abc123def456", {
      ...input,
      stdin: "in",
      streaming: true,
      onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
    });

    expect(result).toEqual({ exitCode: 0, timedOut: false });
    expect(chunks).toEqual(["stdout:A", "stderr:B"]);
    const socket = FakeSocket.last!;
    expect(socket.url).toBe(
      `${server.url.replace(/^http/, "ws")}/v1/sandboxes/sbx_abc123def456/exec/stream`,
    );
    expect(socket.init.headers.Authorization).toBe("Bearer gbx_test_key");
    expect(socket.sent.map((message) => message.type)).toEqual(["start", "stdin", "stdin_end"]);
    expect(socket.sent[0]).toMatchObject({ cmd: input.command, cwd: "/workspace", stdin: true });
  });

  test("an abort sends kill and waits for the exit", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.script = [{ type: "stdout", data: "started" }];
    const controller = new AbortController();
    const chunks: string[] = [];

    const run = provider().exec("sbx_abc123def456", {
      ...input,
      streaming: true,
      signal: controller.signal,
      onChunk: (chunk) => {
        chunks.push(chunk.text);
        controller.abort();
      },
    });

    expect(await run).toEqual({ exitCode: null, timedOut: true });
    expect(chunks).toEqual(["started"]);
    expect(FakeSocket.last!.sent.map((message) => message.type)).toEqual(["start", "kill"]);
  });
});

describe("groundbox files", () => {
  test("a 404 for a path is file_not_found; one for the sandbox is not_found", async () => {
    server.on(
      "GET /v1/sandboxes/{id}/files",
      {
        status: 404,
        json: { error: { code: "not_found", message: "No such file or folder: /x" } },
      },
      {
        status: 404,
        json: { error: { code: "not_found", message: "No sandbox sbx_abc123def456" } },
      },
    );

    expect((await rejection(provider().files.read("sbx_abc123def456", "/x"))).code).toBe(
      "file_not_found",
    );
    expect((await rejection(provider().files.read("sbx_abc123def456", "/x"))).code).toBe(
      "not_found",
    );
  });

  test("write sends bytes; list, stat and remove map Groundbox's entries", async () => {
    const entry = {
      name: "a.ts",
      path: "/workspace/a.ts",
      type: "file",
      size_bytes: 5,
      modified_at: "2026-11-20T12:00:00Z",
    };

    server
      .on("PUT /v1/sandboxes/{id}/files", { json: { path: "/workspace/a.ts", size_bytes: 2 } })
      .on("GET /v1/sandboxes/{id}/files", {
        json: {
          dir: "/workspace",
          entries: [entry, { ...entry, name: "d", path: "/workspace/d", type: "dir" }],
        },
      })
      .on("GET /v1/sandboxes/{id}/files/stat", { json: entry })
      .on(
        "DELETE /v1/sandboxes/{id}/files",
        { json: { path: "/workspace/a.ts", deleted: true } },
        { json: { path: "/workspace/a.ts", deleted: false } },
      );

    const files = provider().files;
    await files.write("sbx_abc123def456", "/workspace/a.ts", new Uint8Array([0, 255]));
    expect([...server.calls("PUT /v1/sandboxes/{id}/files")[0]!.body]).toEqual([0, 255]);

    expect((await files.list("sbx_abc123def456", "/workspace")).map((info) => info.type)).toEqual([
      "file",
      "directory",
    ]);
    expect(await files.stat("sbx_abc123def456", "/workspace/a.ts")).toEqual({
      path: "/workspace/a.ts",
      type: "file",
      size: 5,
      modifiedAt: Date.parse("2026-11-20T12:00:00Z"),
    });
    await files.remove("sbx_abc123def456", "/workspace/a.ts", { recursive: true });
    expect(
      new URL(server.calls("DELETE /v1/sandboxes/{id}/files")[0]!.url, server.url).searchParams.get(
        "recursive",
      ),
    ).toBe("true");
    expect(
      (await rejection(files.remove("sbx_abc123def456", "/workspace/a.ts", { recursive: false })))
        .code,
    ).toBe("file_not_found");
  });
});

describe("groundbox previews, lifecycle and snapshots", () => {
  test("a private preview opens with its share token as a header, and is cached", async () => {
    server.on("POST /v1/sandboxes/{id}/previews", {
      json: {
        url: "https://abc-3000.groundbox.page/",
        share_url: "https://abc-3000.groundbox.page/?gb_token=gbp_token.sig",
        expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
        public: false,
      },
    });

    const groundboxProvider = provider();
    const preview = await groundboxProvider.previewUrl("sbx_abc123def456", 3000);

    expect(preview).toMatchObject({
      url: "https://abc-3000.groundbox.page/",
      headers: { "x-groundbox-preview-token": "gbp_token.sig" },
    });
    expect(preview.expiresAt).toBeGreaterThan(Date.now());
    await groundboxProvider.previewUrl("sbx_abc123def456", 3000);
    expect(server.calls("POST /v1/sandboxes/{id}/previews")).toHaveLength(1);
    expect(body(server.calls("POST /v1/sandboxes/{id}/previews")[0])).toEqual({ port: 3000 });
  });

  test("publicPreviews asks for a public preview with no token", async () => {
    server.on("POST /v1/sandboxes/{id}/previews", {
      json: {
        url: "https://abc-3000.groundbox.page/",
        share_url: null,
        expires_at: null,
        public: true,
      },
    });

    expect(await provider({ publicPreviews: true }).previewUrl("sbx_abc123def456", 3000)).toEqual({
      url: "https://abc-3000.groundbox.page/",
    });
    expect(body(server.calls("POST /v1/sandboxes/{id}/previews")[0])).toEqual({
      port: 3000,
      public: true,
    });
  });

  test("pause keeps memory and wakes on request; resume of a shut-down sandbox starts it", async () => {
    server
      .on("POST /v1/sandboxes/{id}/pause", { json: sandbox("pausing") })
      .on(
        "GET /v1/sandboxes/{id}",
        { json: sandbox("running") },
        { json: sandbox("paused") },
        { json: sandbox("shut_down") },
      )
      .on("POST /v1/sandboxes/{id}/start", { json: sandbox("running") });

    await provider().pause!("sbx_abc123def456");
    expect(body(server.calls("POST /v1/sandboxes/{id}/pause")[0])).toEqual({
      wake_on_request: true,
    });
    await provider().resume!("sbx_abc123def456");
    expect(server.calls("POST /v1/sandboxes/{id}/start")).toHaveLength(1);
    expect(server.calls("POST /v1/sandboxes/{id}/resume")).toHaveLength(0);
  });

  test("snapshot waits until ready; expiry is refused; deleteSnapshot tells gone from deleted", async () => {
    const snapshot = (status: string) => ({ id: "snap_abcdefgh1234", status });

    server
      .on("POST /v1/snapshots", { status: 201, json: snapshot("creating") })
      .on(
        "GET /v1/snapshots/{id}",
        { json: snapshot("ready") },
        { json: snapshot("ready") },
        { json: snapshot("deleted") },
        { status: 404, json: { error: { code: "not_found", message: "No snapshot" } } },
      )
      .on("DELETE /v1/snapshots/{id}", { json: snapshot("deleted") });

    const groundboxProvider = provider();
    expect(await groundboxProvider.snapshot!("sbx_abc123def456")).toEqual({
      id: "snap_abcdefgh1234",
    });
    expect(body(server.calls("POST /v1/snapshots")[0])).toEqual({ sandbox_id: "sbx_abc123def456" });
    expect(server.calls("POST /v1/snapshots")[0]!.headers["idempotency-key"]).toBeDefined();

    expect(
      (await rejection(groundboxProvider.snapshot!("sbx_abc123def456", { expiresInMs: 60_000 })))
        .code,
    ).toBe("unsupported");

    expect(await groundboxProvider.deleteSnapshot!("snap_abcdefgh1234")).toBe(true);
    expect(await groundboxProvider.deleteSnapshot!("snap_abcdefgh1234")).toBe(false);
    expect(await groundboxProvider.deleteSnapshot!("snap_abcdefgh1234")).toBe(false);
    expect(server.calls("DELETE /v1/snapshots/{id}")).toHaveLength(1);
  });

  test("snapshot refuses expiresInMs 0: Groundbox deletes snapshots after 30 days unused", async () => {
    expect(
      (await rejection(provider().snapshot!("sbx_abc123def456", { expiresInMs: 0 }))).code,
    ).toBe("unsupported");
    expect(server.requests).toHaveLength(0);
  });

  test("a snapshot that fails while polling is deleted; if that fails too, the error names it", async () => {
    const snapshot = (status: string) => ({ id: "snap_abcdefgh1234", status });

    server
      .on("POST /v1/snapshots", { status: 201, json: snapshot("creating") })
      .on("GET /v1/snapshots/{id}", { json: snapshot("failed") })
      .on(
        "DELETE /v1/snapshots/{id}",
        { json: snapshot("deleted") },
        { status: 500, json: { error: { code: "internal", message: "down" } } },
      );

    const first = await rejection(provider().snapshot!("sbx_abc123def456"));
    expect(first.message).not.toContain("could not be deleted");
    expect(server.calls("DELETE /v1/snapshots/{id}")).toHaveLength(1);

    const second = await rejection(provider().snapshot!("sbx_abc123def456"));
    expect(second.message).toContain("snap_abcdefgh1234 could not be deleted");
  });

  test("a sandbox with a hard lifetime pauses without wake, and resume sets what is left of it", async () => {
    const deadline = Date.now() + 30 * 60_000;
    const timed = (status: string) => sandbox(status, { "sandbox-sdk-deadline": String(deadline) });

    server
      .on("GET /v1/sandboxes/{id}", { json: timed("running") }, { json: timed("paused") })
      .on("POST /v1/sandboxes/{id}/pause", { json: timed("paused") })
      .on("POST /v1/sandboxes/{id}/resume", { json: timed("running") })
      .on("PATCH /v1/sandboxes/{id}", { json: timed("running") });

    await provider().pause!("sbx_abc123def456");
    expect(body(server.calls("POST /v1/sandboxes/{id}/pause")[0])).toEqual({
      wake_on_request: false,
    });
    await provider().resume!("sbx_abc123def456");
    expect(body(server.calls("PATCH /v1/sandboxes/{id}")[0])).toEqual({ timeout_minutes: 30 });
  });

  test("a sandbox past its hard lifetime is deleted on resume or connect, not woken", async () => {
    const late = sandbox("paused", { "sandbox-sdk-deadline": String(Date.now() - 1000) });

    server
      .on("GET /v1/sandboxes/{id}", { json: late })
      .on("DELETE /v1/sandboxes/{id}", { json: sandbox("stopped") });

    expect((await rejection(provider().resume!("sbx_abc123def456"))).code).toBe("not_found");
    expect((await rejection(provider().connect("sbx_abc123def456"))).code).toBe("not_found");
    expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(2);
    expect(server.calls("POST /v1/sandboxes/{id}/resume")).toHaveLength(0);
  });

  test("the deadline label stays out of the labels the SDK reports", async () => {
    server.on("GET /v1/sandboxes/{id}", {
      json: sandbox("running", { app: "x", "sandbox-sdk-deadline": String(Date.now() + 60_000) }),
    });

    expect((await provider().connect("sbx_abc123def456")).labels).toEqual({ app: "x" });
  });

  test("buildTemplate refuses sizes it would have to round", async () => {
    const error = await rejection(
      provider().buildTemplate!({ name: "x", size: { cpu: 2, memoryMb: 3000 } }, {}),
    );

    expect(error.code).toBe("unsupported");
    expect(server.requests).toHaveLength(0);
  });

  test("buildTemplate builds a new version when the name is taken and follows its log", async () => {
    server
      .on("POST /v1/templates", {
        status: 409,
        json: { error: { code: "conflict", message: "A template named node is there already" } },
      })
      .on("GET /v1/templates/{name}", {
        json: { id: "tpl_abcdefgh1234", name: "node", latest_build: null },
      })
      .on("POST /v1/templates/{name}/builds", {
        status: 201,
        json: { version: 2, status: "queued" },
      })
      .on(
        "GET /v1/templates/{id}/builds/{version}/logs",
        {
          json: {
            lines: [{ seq: 0, at: "2026-11-20T12:00:00Z", text: "step 1" }],
            next: 0,
            status: "building",
            done: false,
          },
        },
        {
          json: {
            lines: [{ seq: 1, at: "2026-11-20T12:00:01Z", text: "done" }],
            next: 1,
            status: "ready",
            done: true,
          },
        },
      );

    const lines: string[] = [];

    const built = await provider().buildTemplate!(
      {
        name: "node",
        image: "node:22-bookworm",
        run: ["npm i -g pnpm"],
        env: { A: "b c" },
        workdir: "/app",
      },
      { onLog: (line) => lines.push(line) },
    );

    // The ID pins the version built, so a later build doesn't change what it starts.
    expect(built).toEqual({ id: "tpl_abcdefgh1234:2", name: "node", buildId: "2" });
    expect(lines).toEqual(["step 1", "done"]);
    expect(body(server.calls("POST /v1/templates/{name}/builds")[0])).toEqual({
      image: "node:22-bookworm",
      run: ["export A='b c'\nmkdir -p '/app' && cd '/app' || exit 1\nnpm i -g pnpm"],
    });
  });
});

describe("groundbox errors", () => {
  test("Groundbox's codes map to SDK codes, and errors never carry its message or the key", async () => {
    server.on(
      "GET /v1/sandboxes/{id}",
      {
        status: 402,
        json: { error: { code: "spend_cap_reached", message: "secret path /home/x" } },
      },
      { status: 401, json: { error: { code: "unauthorized", message: "bad key gbx_test_key" } } },
    );

    const quota = await rejection(provider().connect("sbx_abc123def456"));
    expect(quota.code).toBe("quota");
    expect(quota.message).not.toContain("secret path");

    const auth = await rejection(provider().connect("sbx_abc123def456"));
    expect(auth.code).toBe("auth");
    expect(`${auth.message} ${String(auth.cause)}`).not.toContain("gbx_test_key");
  });

  test("a missing key fails before any request", async () => {
    vi.stubEnv("GROUNDBOX_API_KEY", "");

    const error = await rejection(
      groundbox({ baseUrl: `${server.url}/v1` }).connect("sbx_abc123def456"),
    );

    expect(error.code).toBe("auth");
    expect(server.requests).toHaveLength(0);
    vi.unstubAllEnvs();
  });
});

describe("groundbox labels", () => {
  test("labels Groundbox's metadata can't hold are refused before any request", async () => {
    const long = await rejection(provider().create({ labels: { app: "x".repeat(513) } }));
    const name = await rejection(provider().create({ labels: { ["n".repeat(65)]: "1" } }));

    expect([long.code, name.code]).toEqual(["unsupported", "unsupported"]);
    expect(server.requests).toHaveLength(0);
  });
});

describe("groundbox stream input and terminal", () => {
  test("stdin pieces never split a surrogate pair", () => {
    const input = `${"x".repeat(7)}😀${"y".repeat(3)}`;
    const pieces = stdinPieces(input, 8);

    expect(pieces.join("")).toBe(input);
    expect(pieces[0]).toBe("x".repeat(7));
    expect(pieces[1]!.startsWith("😀")).toBe(true);

    for (const piece of pieces) {
      const last = piece.charCodeAt(piece.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("a terminal whose shell exits closes its socket", async () => {
    vi.stubGlobal("WebSocket", FakeSocket);
    FakeSocket.script = [{ type: "exit", exit_code: 0, duration_ms: 1 }];

    const terminal = await provider().terminal!("sbx_abc123def456", { cols: 80, rows: 24 });

    expect(await terminal.wait!()).toEqual({ exitCode: 0 });
    expect(FakeSocket.last!.closedWith).toBe(1000);
    expect(FakeSocket.last!.sent[0]).toMatchObject({
      type: "start",
      tty: true,
      rows: 24,
      cols: 80,
    });
  });
});
