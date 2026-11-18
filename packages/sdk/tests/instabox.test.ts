import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import { instabox } from "../src/providers/instabox/index.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
});

afterEach(async () => {
  await server.close();
});

const machine = (state = "running", metadata: Record<string, string> = {}) => ({
  id: "m_abc123",
  name: "sbx-test",
  state,
  metadata,
  createdAt: "2026-11-18T12:00:00Z",
});

const op = (state: string, extra: { error?: { code: string; message?: string } } = {}) => ({
  id: "op_1",
  machineId: "m_abc123",
  state,
  ...extra,
});

const sse = (...events: [string, object][]) =>
  events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const provider = () =>
  instabox({ apiKey: "ibk_test_key", baseUrl: server.url, operationTimeoutMs: 5_000 });

/** The JSON evidence an adapter error carries as its cause. */
function evidence(error: SandboxError) {
  if (!(error.cause instanceof Error)) throw new Error("expected an evidence cause");

  return JSON.parse(error.cause.message);
}

async function rejection(promise: Promise<unknown>): Promise<SandboxError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  if (!(error instanceof SandboxError)) throw new Error("expected a SandboxError");

  return error;
}

describe("instabox create", () => {
  test("sends size, labels and key, waits for the operation, then prepares /workspace", async () => {
    server
      .on("POST /v1/machines", { status: 202, json: op("pending") })
      .on("GET /v1/operations/{id}", { json: op("succeeded") })
      .on("POST /v1/machines/{id}/exec", { stream: sse(["exit", { exitCode: 0 }]) })
      .on("GET /v1/machines/{id}", {
        json: machine("running", { team: "a", "sandbox-sdk-key": "k1" }),
      });

    const info = await provider().create({
      labels: { team: "a" },
      key: "k1",
      size: { cpu: 4, memoryMb: 8192 },
      timeoutMs: 120_000,
    });

    expect(info).toEqual({
      id: "m_abc123",
      key: "k1",
      labels: { team: "a" },
      state: "running",
      createdAt: Date.parse("2026-11-18T12:00:00Z"),
    });
    const [create] = server.calls("POST /v1/machines");
    const body = JSON.parse(create!.body.toString());
    expect(body).toMatchObject({
      metadata: { team: "a", "sandbox-sdk-key": "k1" },
      vcpus: 4,
      memMiB: 8192,
      deleteAfterSeconds: 120,
    });
    expect(create!.headers["x-api-key"]).toBe("ibk_test_key");
    expect(create!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const setup = JSON.parse(server.calls("POST /v1/machines/{id}/exec")[0]!.body.toString());
    expect(setup.argv.join(" ")).toContain("/data/workspace");
  });

  test("presets map to Instabox sizes; disk sizes are refused", async () => {
    server
      .on("POST /v1/machines", { status: 202, json: op("succeeded") })
      .on("POST /v1/machines/{id}/exec", { stream: sse(["exit", { exitCode: 0 }]) })
      .on("GET /v1/machines/{id}", { json: machine() });

    await provider().create({ labels: {}, size: "small" });
    expect(JSON.parse(server.calls("POST /v1/machines")[0]!.body.toString())).toMatchObject({
      vcpus: 2,
      memMiB: 4096,
    });

    const refused = await rejection(
      provider().create({ labels: {}, size: { cpu: 4, memoryMb: 8192, diskGb: 50 } }),
    );

    expect(refused.code).toBe("unsupported");
  });

  test("a failed setup deletes the machine and marks the error as admitted by this call", async () => {
    server
      .on("POST /v1/machines", { status: 202, json: op("succeeded") })
      .on("POST /v1/machines/{id}/exec", {
        stream: sse(["stderr", { data: "no python3" }], ["exit", { exitCode: 1 }]),
      })
      .on("DELETE /v1/machines/{id}", { status: 202, json: op("succeeded") });

    const error = await rejection(provider().create({ labels: {} }));

    expect(error.sandboxId).toBe("m_abc123");
    expect(server.calls("DELETE /v1/machines/{id}")).toHaveLength(1);
    expect(server.calls("DELETE /v1/machines/{id}")[0]!.headers["x-confirm-delete"]).toBe(
      "m_abc123",
    );
    const cause = evidence(error);
    expect(cause).toMatchObject({
      operation: "create",
      admittedByThisCall: true,
      stage: "prepare",
      sandboxId: "m_abc123",
    });
    expect(cause.cleanupCode).toBeUndefined();
  });

  test("a failed cleanup is recorded with the admission evidence", async () => {
    server
      .on("POST /v1/machines", { status: 202, json: op("pending") })
      .on("GET /v1/operations/{id}", {
        json: op("failed", { error: { code: "no_capacity", message: "host h-17 full" } }),
      })
      .on("DELETE /v1/machines/{id}", {
        status: 403,
        json: { error: { code: "permission_denied", message: "nope" } },
      });

    const error = await rejection(provider().create({ labels: {} }));

    expect(error.code).toBe("quota");
    expect(error.message).not.toContain("h-17");
    expect(evidence(error)).toMatchObject({
      admittedByThisCall: true,
      stage: "operation",
      cleanupCode: "auth",
    });
  });
});

describe("instabox errors", () => {
  test("keep Instabox's code and status, never its message", async () => {
    server.on("GET /v1/machines/{id}", {
      status: 404,
      json: {
        error: { code: "not_found", message: "machine /secret/path missing", requestId: "r1" },
      },
    });

    const error = await rejection(provider().connect("m_missing"));

    expect(error.code).toBe("not_found");
    expect(error.message).not.toContain("/secret/path");
    expect(evidence(error)).toEqual({
      operation: "connect",
      status: 404,
      providerCode: "not_found",
      requestId: "r1",
    });
  });

  test("429s are retried after Retry-After", async () => {
    server.on(
      "GET /v1/machines/{id}",
      { status: 429, headers: { "retry-after": "0" }, json: { error: { code: "rate_limited" } } },
      { json: machine("suspended") },
    );

    expect((await provider().connect("m_abc123")).state).toBe("paused");
    expect(server.calls("GET /v1/machines/{id}")).toHaveLength(2);
  });

  test("auth codes map to auth", async () => {
    server.on("GET /v1/machines/{id}", {
      status: 401,
      json: { error: { code: "revoked_key", message: "key ibk_x revoked" } },
    });

    expect((await rejection(provider().connect("m_abc123"))).code).toBe("auth");
  });
});

describe("instabox exec", () => {
  test("streams stdout and stderr chunks and returns the exit code", async () => {
    server.on("POST /v1/machines/{id}/exec", {
      stream: sse(
        ["stdout", { data: "hello " }],
        ["stderr", { data: "warn" }],
        ["stdout", { data: "world" }],
        ["exit", { exitCode: 3 }],
      ),
    });

    const chunks: string[] = [];

    const result = await provider().exec("m_abc123", {
      command: "echo hi",
      cwd: "/workspace",
      env: { A: "1" },
      timeoutMs: 10_000,
      onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
    });

    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(chunks).toEqual(["stdout:hello ", "stderr:warn", "stdout:world"]);
    const body = JSON.parse(server.calls("POST /v1/machines/{id}/exec")[0]!.body.toString());
    expect(body).toMatchObject({ cmd: "echo hi", cwd: "/workspace", envs: { A: "1" } });
    expect(body.timeoutSeconds).toBe(11);
  });

  test("a server timeout is reported as timed out with no exit code", async () => {
    server.on("POST /v1/machines/{id}/exec", {
      stream: sse(["exit", { exitCode: 137, timedOut: true }]),
    });

    const result = await provider().exec("m_abc123", {
      command: "sleep 100",
      cwd: "/workspace",
      env: {},
      timeoutMs: 1_000,
      onChunk: () => undefined,
    });

    expect(result).toEqual({ exitCode: null, timedOut: true });
  });

  test("an error event keeps its code only", async () => {
    server.on("POST /v1/machines/{id}/exec", {
      stream: sse(["error", { code: "quota_exceeded", message: "32 execs at /x" }]),
    });

    const error = await rejection(
      provider().exec("m_abc123", {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 5_000,
        onChunk: () => undefined,
      }),
    );

    expect(error.code).toBe("quota");
    expect(error.message).not.toContain("/x");
  });
});

describe("instabox list, files and lifecycle", () => {
  test("list follows cursors and filters by exact label", async () => {
    server.on(
      "GET /v1/machines",
      {
        json: {
          machines: [
            machine("running", { run: "r1" }),
            { ...machine("deleting", { run: "r1" }), id: "m_gone" },
          ],
          nextCursor: "c2",
        },
      },
      { json: { machines: [{ ...machine("stopped", { run: "r10" }), id: "m_other" }] } },
    );

    const listed = await provider().list({ run: "r1" });

    expect(listed.map((m) => m.id)).toEqual(["m_abc123"]);
    const urls = server.calls("GET /v1/machines").map((r) => r.url);
    expect(urls[0]).toContain("metadata=run%3Ar1");
    expect(urls[1]).toContain("cursor=c2");
  });

  test("files: read 404 is file_not_found, write sends mode and parents", async () => {
    server
      .on("GET /v1/machines/{id}/files/content", {
        status: 404,
        json: { error: { code: "not_found" } },
      })
      .on("PUT /v1/machines/{id}/files", { status: 204 });

    const p = provider();
    expect((await rejection(p.files.read("m_abc123", "/workspace/none"))).code).toBe(
      "file_not_found",
    );
    await p.files.write("m_abc123", "/workspace/a.sh", new TextEncoder().encode("x"), {
      mode: 0o755,
    });
    const url = server.calls("PUT /v1/machines/{id}/files")[0]!.url;
    expect(url).toContain("mode=0755");
    expect(url).toContain("parents=true");
  });

  test("pause suspends; resume starts a stopped machine", async () => {
    server
      .on("POST /v1/machines/{id}/suspend", { status: 202, json: op("succeeded") })
      .on("GET /v1/machines/{id}", { json: machine("stopped") })
      .on("POST /v1/machines/{id}/start", { status: 202, json: op("succeeded") });

    const p = provider();
    await p.pause!("m_abc123");
    await p.resume!("m_abc123");
    expect(server.calls("POST /v1/machines/{id}/suspend")).toHaveLength(1);
    expect(server.calls("POST /v1/machines/{id}/start")).toHaveLength(1);
  });

  test("destroy of a machine already gone succeeds", async () => {
    server.on("DELETE /v1/machines/{id}", { status: 404, json: { error: { code: "not_found" } } });
    await expect(provider().destroy("m_abc123")).resolves.toBeUndefined();
  });
});
