// The E2B adapter on the wire, against a scripted server: error mapping, retries, the native API, sdk(load),
// and the Connect stream faults (truncation, missing end frame, split frames, disconnect and reconnect,
// cancellation during startup). E2B_API_URL and E2B_SANDBOX_URL point both planes at the server.
import { isObject } from "../src/shared/narrow.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";
import type { E2B, Sandbox } from "e2b";
import { SandboxError } from "../src/errors.js";
import { connectEnvelope, streamFault } from "../src/streams.js";
import { e2b } from "../src/providers/e2b/index.js";
import { e2bError, mapE2BError } from "../src/providers/e2b/errors.js";
import { fakeServer, pieces, type FakeServer, type RecordedRequest } from "./http-fake.js";

let server: FakeServer;
const saved = { api: process.env.E2B_API_URL, sandbox: process.env.E2B_SANDBOX_URL };

beforeAll(() => {
  delete process.env.E2B_API_URL;
  delete process.env.E2B_SANDBOX_URL;
});

beforeEach(async () => {
  server = await fakeServer();
  process.env.E2B_API_URL = server.url;
  process.env.E2B_SANDBOX_URL = server.url;
});

afterEach(async () => {
  await server.close();
});

afterAll(() => {
  for (const [name, value] of [
    ["E2B_API_URL", saved.api],
    ["E2B_SANDBOX_URL", saved.sandbox],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

const key = "e2b_secret_key_123456";
const token = "envd-token-abcdef123456";
const frame = (message: unknown, end = false) => connectEnvelope(message, end);
const start = (pid: number) => frame({ event: { start: { pid } } });

const out = (text: string, stream: "stdout" | "stderr" = "stdout") =>
  frame({ event: { data: { [stream]: Buffer.from(text).toString("base64") } } });

const exit = (code?: number) =>
  frame({ event: { end: code ? { exitCode: code, exited: true } : { exited: true } } });

const done = frame({}, true);
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts);

const connectStream = (
  parts: (string | Uint8Array)[],
  extra: { cut?: boolean; hold?: boolean; intervalMs?: number } = {},
) => ({ stream: parts, headers: { "content-type": "application/connect+json" }, ...extra });

const envelopeOf = (request: RecordedRequest): Record<string, unknown> =>
  JSON.parse(request.body.subarray(5).toString());

const scriptOf = (request: RecordedRequest) => {
  const process = envelopeOf(request).process;

  return isObject(process) && process !== null && "args" in process && Array.isArray(process.args)
    ? String(process.args[2])
    : "";
};

const tagOf = (request: RecordedRequest) => String(envelopeOf(request).tag);

/** Scripts the calls `connect()` makes and returns a provider attached to sandbox `sb1`. */
async function attached(options: Parameters<typeof e2b>[0] = {}) {
  server
    .on("GET /sandboxes/{id}", {
      json: {
        sandboxID: "sb1",
        templateID: "base",
        metadata: { "sandbox-sdk": "1" },
        startedAt: new Date().toISOString(),
        endAt: new Date().toISOString(),
        state: "running",
        envdVersion: "0.10.0",
      },
    })
    .on("POST /v2/sandboxes/{id}/connect", {
      json: { sandboxID: "sb1", envdVersion: "0.10.0", envdAccessToken: token, domain: "e2b.test" },
    })
    .on("POST /filesystem.Filesystem/Stat", {
      json: {
        entry: { name: "workspace", path: "/workspace", type: "FILE_TYPE_DIRECTORY", size: "4096" },
      },
    })
    .on("POST /files", {
      json: [
        {
          name: ".sandbox-sdk-workspace-ready",
          type: "file",
          path: "/tmp/.sandbox-sdk-workspace-ready",
        },
      ],
    });
  const provider = e2b({ apiKey: key, ...options });
  await provider.connect("sb1");

  return provider;
}

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);

    // SAFETY: the call under test rejects only with a SandboxError.
    return error as SandboxError;
  }

  throw new Error("expected a rejection");
}

const exec = (provider: ReturnType<typeof e2b>, chunks: string[] = [], timeoutMs = 5_000) =>
  provider.exec("sb1", {
    command: "work",
    cwd: "/workspace",
    env: {},
    timeoutMs,
    onChunk: (chunk) => {
      chunks.push(chunk.text);
    },
  });

describe("errors", () => {
  test("status mapping uses statuses and Connect codes, never class names", () => {
    const status = (status: number, code?: string) => ({
      kind: "status" as const,
      status,
      headers: new Headers(),
      body: { text: "", json: undefined, ...(code === undefined ? undefined : { code }) },
    });

    const api = { method: "GET" as const, plane: "api", operation: "GET /sandboxes/{id}" };
    const files = { method: "GET" as const, plane: "envd", operation: "GET /files" };

    const stat = {
      method: "POST" as const,
      plane: "envd",
      operation: "POST /filesystem.Filesystem/Stat",
    };

    const signal = {
      method: "POST" as const,
      plane: "envd",
      operation: "POST /process.Process/SendSignal",
    };

    expect(mapE2BError(status(507), api)).toBe("quota");
    expect(mapE2BError(status(404), api)).toBeUndefined();
    expect(mapE2BError(status(404), files)).toBe("file_not_found");
    expect(mapE2BError(status(404, "not_found"), stat)).toBe("file_not_found");
    expect(mapE2BError(status(404, "not_found"), signal)).toBe("not_found");
    expect(mapE2BError(status(400, "invalid_argument"), signal)).toBe("invalid_argument");
    expect(mapE2BError(status(401, "unauthenticated"), signal)).toBe("auth");
    expect(mapE2BError(status(429, "resource_exhausted"), signal)).toBe("quota");
    expect(mapE2BError(status(408, "deadline_exceeded"), signal)).toBe("timeout");
    // A control-plane body code is not a Connect code.
    expect(mapE2BError(status(400, "not_found"), api)).toBeUndefined();
  });

  test("a local failure keeps only scrubbed text; an abort is aborted", () => {
    expect(e2bError(new Error("private"), "box")).toMatchObject({
      code: "provider",
      provider: "e2b",
      sandboxId: "box",
      cause: "Error: private",
    });
    expect(e2bError(new DOMException("private", "AbortError")).code).toBe("aborted");
    const known = new SandboxError("kept", { code: "quota" });
    expect(e2bError(known)).toBe(known);
  });

  test("a rejected key is auth with a hint, and neither the key nor the body text leaks", async () => {
    server.on("POST /v2/sandboxes", {
      status: 401,
      json: { code: 401, message: `secret-body-text ${key}` },
    });
    const error = await failure(e2b({ apiKey: key }).create({ labels: {} }));
    expect(error).toMatchObject({
      code: "auth",
      provider: "e2b",
      hint: "Check E2B_API_KEY and the E2B domain.",
    });
    expect(`${error.message} ${String(error.cause)}`).not.toMatch(
      /secret-body-text|e2b_secret_key/,
    );
    expect(server.requests[0]?.headers["x-api-key"]).toBe(key);
    expect(server.requests).toHaveLength(1);
  });

  test("a missing sandbox is not_found, a missing file file_not_found, a full disk quota", async () => {
    server.on("GET /sandboxes/{id}", {
      status: 404,
      json: { code: 404, message: "sandbox not found" },
    });
    expect((await failure(e2b({ apiKey: key }).connect("gone"))).code).toBe("not_found");
    const provider = await attached();
    server.on("GET /files", { status: 404, json: { code: 404, message: "file not found" } });
    expect((await failure(provider.files.read("sb1", "/nope"))).code).toBe("file_not_found");
    server.on("POST /filesystem.Filesystem/Stat", {
      status: 404,
      json: { code: "not_found", message: "no such file" },
    });
    expect((await failure(provider.files.stat("sb1", "/nope"))).code).toBe("file_not_found");
    server.on("POST /files", { status: 507, json: { code: 507, message: "no space left" } });
    expect((await failure(provider.files.write("sb1", "/tmp/x", new Uint8Array([1])))).code).toBe(
      "quota",
    );
  });

  test("the proxy's 502 for a killed sandbox is unavailable", async () => {
    const provider = await attached();
    server.on("POST /filesystem.Filesystem/ListDir", {
      status: 502,
      body: "The sandbox was not found",
      headers: { "content-type": "text/plain" },
    });
    expect(await failure(provider.files.list("sb1", "/tmp"))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  test("control-plane retries: GET and the replayable POSTs retry 503s, create does not", async () => {
    server.on(
      "GET /sandboxes/{id}",
      { status: 503, headers: { "retry-after": "0" } },
      {
        json: {
          sandboxID: "sb1",
          metadata: {},
          startedAt: new Date().toISOString(),
          state: "running",
          envdVersion: "0.10.0",
        },
      },
    );
    server.on(
      "POST /v2/sandboxes/{id}/connect",
      { status: 503, headers: { "retry-after": "0" } },
      { json: { sandboxID: "sb1", envdVersion: "0.10.0", envdAccessToken: token } },
    );
    server
      .on("POST /filesystem.Filesystem/Stat", {
        json: { entry: { path: "/workspace", type: "FILE_TYPE_DIRECTORY" } },
      })
      .on("POST /files", { json: [{}] });
    await e2b({ apiKey: key }).connect("sb1");
    expect(server.calls("GET /sandboxes/{id}")).toHaveLength(2);
    expect(server.calls("POST /v2/sandboxes/{id}/connect")).toHaveLength(2);
    server.on("POST /v2/sandboxes", { status: 503, headers: { "retry-after": "0" } });
    expect((await failure(e2b({ apiKey: key }).create({ labels: {} }))).code).toBe("unavailable");
    expect(server.calls("POST /v2/sandboxes")).toHaveLength(1);
  });
});

describe("command streams", () => {
  test("split frames, split UTF-8 and split base64 reassemble; a clean exit has no exitCode field", async () => {
    const provider = await attached();
    const body = concat(start(7), out("h€"), out("😀\n"), out("err", "stderr"), exit(), done);
    server.on("POST /process.Process/Start", connectStream(pieces(body, 3), { intervalMs: 1 }));
    const chunks: string[] = [];
    expect(await exec(provider, chunks)).toEqual({ exitCode: 0, timedOut: false });
    expect(chunks.join("")).toBe("h€😀\nerr");
    const request = server.calls("POST /process.Process/Start")[0]!;
    expect(request.headers).toMatchObject({
      "content-type": "application/connect+json",
      "connect-protocol-version": "1",
      "keepalive-ping-interval": "50",
      "x-access-token": token,
      "e2b-sandbox-id": "sb1",
      authorization: `Basic ${Buffer.from("root:").toString("base64")}`,
    });
    expect(request.headers).not.toHaveProperty("connect-timeout-ms");
    expect(request.headers).not.toHaveProperty("x-api-key");
    expect(tagOf(request)).toMatch(/^sandbox-sdk-/);
  });

  test("a non-zero exit code and envd's -1 for a signal come through", async () => {
    const provider = await attached();
    server.on("POST /process.Process/Start", connectStream([concat(start(7), exit(3), done)]));
    expect(await exec(provider)).toEqual({ exitCode: 3, timedOut: false });
    server.on(
      "POST /process.Process/Start",
      connectStream([
        concat(
          start(7),
          frame({ event: { end: { exitCode: -1, exited: false, status: "signal: killed" } } }),
          done,
        ),
      ]),
    );
    expect(await exec(provider)).toEqual({ exitCode: -1, timedOut: false });
  });

  test("a body cut inside a frame is truncated", async () => {
    const provider = await attached();
    const data = out("partial output");
    server.on(
      "POST /process.Process/Start",
      connectStream([concat(start(7), data.subarray(0, 9))]),
    );
    const error = await failure(exec(provider));
    expect(error.code).toBe("unavailable");
    expect(streamFault(error)).toBe("truncated");
  });

  test("a stream without its end frame is truncated, even after the end event", async () => {
    const provider = await attached();
    server.on("POST /process.Process/Start", connectStream([concat(start(7), out("ok"), exit())]));
    expect(streamFault(await failure(exec(provider)))).toBe("truncated");
  });

  test("an end frame error before start is envd rejecting the call: mapped, and nothing to clean up", async () => {
    const provider = await attached();
    server.on(
      "POST /process.Process/Start",
      connectStream([
        frame({ error: { code: "invalid_argument", message: "cwd /nope: secret detail" } }, true),
      ]),
    );
    const error = await failure(exec(provider));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).not.toContain("secret detail");
    expect(server.calls("POST /process.Process/List")).toHaveLength(0);
  });

  test("an end frame error after start rejects the run with its code", async () => {
    const provider = await attached();
    server.on(
      "POST /process.Process/Start",
      connectStream([
        concat(
          start(7),
          out("x"),
          frame({ error: { code: "deadline_exceeded", message: "deadline" } }, true),
        ),
      ]),
    );
    expect((await failure(exec(provider))).code).toBe("timeout");
  });

  test("a response that is not a Connect stream is a provider error", async () => {
    const provider = await attached();
    server.on("POST /process.Process/Start", {
      body: "<html>proxy</html>",
      headers: { "content-type": "text/html" },
    });
    expect((await failure(exec(provider))).code).toBe("provider");
  });

  test("a mid-stream disconnect reconnects by pid without replaying output", async () => {
    const provider = await attached();
    server
      .on(
        "POST /process.Process/Start",
        connectStream([concat(start(42), out("before\n"))], { cut: true }),
      )
      .on(
        "POST /process.Process/Connect",
        connectStream([concat(start(42), out("after\n"), exit(5), done)]),
      );
    const chunks: string[] = [];

    const process = await provider.startProcess!("sb1", {
      command: "work",
      cwd: "/workspace",
      env: {},
      onChunk: (chunk) => {
        chunks.push(chunk.text);
      },
    });

    expect(process.pid).toBe(42);
    expect(await process.wait()).toEqual({ exitCode: 5, signal: null });
    expect(chunks).toEqual(["before\n"]);
    const connect = server.calls("POST /process.Process/Connect")[0]!;
    expect(envelopeOf(connect)).toEqual({ process: { pid: 42 } });
    expect(connect.headers).not.toHaveProperty("authorization");
  });

  test("cancellation during startup stops the tagged process and its group", async () => {
    const provider = await attached();
    let tag = "";
    server
      .on("POST /process.Process/Start", (request, response) => {
        if (scriptOf(request).startsWith("kill -")) {
          response
            .writeHead(200, { "content-type": "application/connect+json" })
            .end(concat(start(99), exit(), done));

          return;
        }

        tag = tagOf(request); // envd started it, but the start event never arrives
      })
      .on("POST /process.Process/SendSignal", { json: {} });
    server.on("POST /process.Process/List", (_request, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ processes: [{ pid: 42, tag, config: { cmd: "/bin/bash" } }] }));
    });
    expect(await exec(provider, [], 100)).toEqual({ exitCode: null, timedOut: true });
    expect(
      server
        .calls("POST /process.Process/SendSignal")
        .map((request) => JSON.parse(request.body.toString())),
    ).toEqual([{ process: { pid: 42 }, signal: "SIGNAL_SIGKILL" }]);
    expect(server.calls("POST /process.Process/Start").map(scriptOf).at(-1)).toBe(
      "kill -KILL -- -42 2>/dev/null || true",
    );
  });

  test("a Start whose response is lost is outcome_unknown, and a process that never started is signalled by tag", async () => {
    const provider = await attached();
    server
      .on("POST /process.Process/Start", { drop: true })
      .on("POST /process.Process/List", { json: {} })
      .on("POST /process.Process/SendSignal", {
        status: 404,
        json: { code: "not_found", message: "no process" },
      });
    expect((await failure(exec(provider))).code).toBe("outcome_unknown");
    const tag = tagOf(server.calls("POST /process.Process/Start")[0]!);
    expect(
      server
        .calls("POST /process.Process/SendSignal")
        .map((request) => JSON.parse(request.body.toString())),
    ).toEqual([{ process: { tag }, signal: "SIGNAL_SIGKILL" }]);
  });
});

describe("native API", () => {
  test("box.native fills {sandboxId} on the control plane; envd gets the access token, not the API key", async () => {
    const provider = await attached();
    const native = provider.native("sb1");
    expect(native).toBe(provider.native("sb1"));
    expect(await native.request("GET", "/sandboxes/{sandboxId}")).toMatchObject({
      sandboxID: "sb1",
    });
    expect(server.calls("GET /sandboxes/{id}").at(-1)?.url).toBe("/sandboxes/sb1");
    server.on("GET /health", { status: 204 });
    expect(await native.request("GET", "/health", { plane: "envd" })).toBeUndefined();
    const health = server.calls("GET /health")[0]!;
    expect(health.headers).toMatchObject({
      "x-access-token": token,
      "e2b-sandbox-id": "sb1",
      "e2b-sandbox-port": "49983",
    });
    expect(health.headers).not.toHaveProperty("x-api-key");
  });

  test("native.fetch returns the raw Response; errors keep envd's scrubbed message", async () => {
    const provider = await attached();
    server.on("GET /files", {
      body: new Uint8Array([0, 1, 2, 255]),
      headers: { "content-type": "application/octet-stream" },
    });

    const response = await provider
      .native("sb1")
      .fetch("GET", "/files", { plane: "envd", query: { path: "/bin/x", username: "root" } });

    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 1, 2, 255]);
    server.on("POST /process.Process/SendSignal", {
      status: 404,
      json: { code: "not_found", message: `process 9 not found (token ${token})` },
    });

    const error = await failure(
      provider.native("sb1").request("POST", "/process.Process/SendSignal", {
        plane: "envd",
        body: { process: { pid: 9 } },
      }),
    );

    expect(error).toMatchObject({ code: "not_found", sandboxId: "sb1" });
    expect(error.message).toContain("process 9 not found");
    expect(error.message).not.toContain(token);
  });

  test("provider.api is account scope: the API key, no sandbox, and no envd plane", async () => {
    const provider = e2b({ apiKey: key });
    server.on("GET /templates", { json: [{ templateID: "base" }] });
    expect(provider.api.sandboxId).toBeUndefined();
    expect(await provider.api.request("GET", "/templates")).toEqual([{ templateID: "base" }]);
    expect(server.requests[0]?.headers["x-api-key"]).toBe(key);
    expect((await failure(provider.api.request("GET", "/sandboxes/{sandboxId}"))).code).toBe(
      "invalid_argument",
    );
    expect((await failure(provider.api.request("GET", "/health", { plane: "envd" }))).code).toBe(
      "invalid_argument",
    );
    expect(server.requests).toHaveLength(1);
  });

  test("a detached sandbox has no native API", async () => {
    const provider = await attached();
    await provider.close!("sb1");
    expect(() => provider.native("sb1")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  test("sdk(load) builds the official SDK's objects from this connection, with no API call", async () => {
    const provider = await attached();
    const before = server.requests.length;
    const sandbox = await provider.native("sb1").sdk(() => import("e2b"));
    expectTypeOf(sandbox).toEqualTypeOf<Sandbox>();
    expect(sandbox).toMatchObject({ sandboxId: "sb1", sandboxDomain: "e2b.test" });
    expect(Reflect.get(sandbox, "envdAccessToken")).toBe(token);
    const client = await provider.api.sdk(() => import("e2b"));
    expectTypeOf(client).toEqualTypeOf<E2B>();
    expect(typeof client.Sandbox.create).toBe("function");
    expect(server.requests.length).toBe(before);
  });

  test("sdk(load) with a module missing the export is invalid_argument naming the package", async () => {
    const provider = await attached();
    // @ts-expect-error the module has no Sandbox class
    const error = await failure(provider.native("sb1").sdk(async () => ({ Other: class {} })));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toContain('import("e2b")');
  });
});
