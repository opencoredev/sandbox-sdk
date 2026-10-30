import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import {
  createDeadline,
  createHttpClient,
  parseErrorBody,
  type HttpClientOptions,
} from "../src/http.js";
import { ndjson, streamFault } from "../src/streams.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

let server: FakeServer;
let other: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
  other = await fakeServer();
});

afterEach(async () => {
  await server.close();
  await other.close();
});

const key = "sk-test-secret-123456";

function client(overrides: Partial<HttpClientOptions<"api" | "data">> = {}) {
  return createHttpClient<"api" | "data">({
    provider: "fake",
    label: "Fake",
    planes: {
      api: { baseUrl: `${server.url}/v1`, auth: () => ({ authorization: `Bearer ${key}` }) },
      data: {
        baseUrl: ({ sandboxId }) => `${other.url}/boxes/${sandboxId}`,
        auth: () => ({ "x-access-token": "data-token-987654" }),
      },
    },
    defaultPlane: "api",
    backoffMs: 1,
    timeoutMs: 2_000,
    secrets: () => [key],
    authHint: "Set FAKE_API_KEY.",
    ...overrides,
  });
}

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);

    return error as SandboxError;
  }

  throw new Error("expected a rejection");
}

const text = (error: SandboxError) => `${error.message} ${error.hint} ${String(error.cause)}`;

describe("requests", () => {
  test("joins the plane base URL, fills and encodes placeholders, adds query, auth and a JSON body", async () => {
    server.on("POST /v1/sandboxes/{id}/files", { json: { ok: true } });
    const http = client();

    const body = await http.json({
      method: "POST",
      path: "/sandboxes/{id}/files",
      params: { id: "a b/c" },
      query: { recursive: true, skip: undefined, n: 2 },
      body: { path: "/x" },
    });

    expect(body).toEqual({ ok: true });
    const [request] = server.requests;
    expect(request?.url).toBe("/v1/sandboxes/a%20b%2Fc/files?recursive=true&n=2");
    expect(request?.headers.authorization).toBe(`Bearer ${key}`);
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request!.body.toString())).toEqual({ path: "/x" });
  });

  test("a sandbox-scoped plane resolves its base URL per sandbox and sends its own credentials", async () => {
    other.on("GET /boxes/{id}/files", { json: [] });
    await client().json({ method: "GET", path: "/files", plane: "data", sandboxId: "sb-1" });
    expect(other.requests[0]?.url).toBe("/boxes/sb-1/files");
    expect(other.requests[0]?.headers["x-access-token"]).toBe("data-token-987654");
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("placeholder mistakes are invalid_argument before any request", async () => {
    const http = client();
    expect((await failure(http.json({ method: "GET", path: "/sandboxes/{id}" }))).code).toBe(
      "invalid_argument",
    );
    expect(
      (await failure(http.json({ method: "GET", path: "/sandboxes", params: { id: "x" } }))).code,
    ).toBe("invalid_argument");
    expect(
      (await failure(http.json({ method: "GET", path: "/sandboxes/{id}", params: { id: ".." } })))
        .code,
    ).toBe("invalid_argument");
    expect((await failure(http.json({ method: "GET", path: "/a/../b" }))).code).toBe(
      "invalid_argument",
    );
    expect((await failure(http.json({ method: "GET", path: "relative" }))).code).toBe(
      "invalid_argument",
    );
    expect(
      (await failure(http.json({ method: "GET", path: "/x", plane: "nope" as "api" }))).code,
    ).toBe("invalid_argument");
    expect((await failure(http.json({ method: "GET", path: "/x", body: { a: 1 } }))).code).toBe(
      "invalid_argument",
    );
    expect(server.requests).toHaveLength(0);
  });

  test("204 and empty bodies are undefined; a non-JSON 2xx body is a provider error", async () => {
    server.on("DELETE /v1/x", { status: 204 }).on("GET /v1/html", { body: "<html>" });
    expect(await client().json({ method: "DELETE", path: "/x" })).toBeUndefined();
    const error = await failure(client().json({ method: "GET", path: "/html" }));
    expect(error.code).toBe("provider");
    expect(error.message).toContain("not JSON");
  });

  test("a buffered body over maxBytes is unsupported", async () => {
    server.on("GET /v1/big", { body: "x".repeat(10_000) });
    expect(
      (await failure(client().request({ method: "GET", path: "/big", maxBytes: 1000 }))).code,
    ).toBe("unsupported");
  });
});

describe("retries", () => {
  test("a GET retries 503 and honours Retry-After", async () => {
    server.on("GET /v1/x", { status: 503, headers: { "retry-after": "0" } }, { json: { ok: 1 } });
    expect(await client().json({ method: "GET", path: "/x" })).toEqual({ ok: 1 });
    expect(server.calls("GET /v1/x")).toHaveLength(2);
  });

  test("gives up after two retries with the mapped error", async () => {
    server.on("GET /v1/x", { status: 502 });
    const error = await failure(client().json({ method: "GET", path: "/x" }));
    expect(error).toMatchObject({ code: "unavailable", retryable: true, provider: "fake" });
    expect(server.calls("GET /v1/x")).toHaveLength(3);
  });

  test("a Retry-After over 20 s is not waited for", async () => {
    server.on("GET /v1/x", { status: 429, headers: { "retry-after": "60" } });
    const error = await failure(client().json({ method: "GET", path: "/x" }));
    expect(error).toMatchObject({ code: "quota", retryable: true });
    expect(server.requests).toHaveLength(1);
  });

  test("a Retry-After past the deadline is not waited for", async () => {
    server.on("GET /v1/x", { status: 503, headers: { "retry-after": "5" } });
    const started = Date.now();
    expect(
      (await failure(client().json({ method: "GET", path: "/x", timeoutMs: 1_000 }))).code,
    ).toBe("unavailable");
    // It answers at once instead of sleeping 5 s first.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(server.requests).toHaveLength(1);
  });

  test("a POST is never retried without an idempotency key", async () => {
    server.on("POST /v1/x", { status: 503 });
    expect((await failure(client().json({ method: "POST", path: "/x", body: {} }))).code).toBe(
      "unavailable",
    );
    expect(server.requests).toHaveLength(1);
  });

  test("a POST with an idempotency key retries with the same key", async () => {
    server.on("POST /v1/x", { status: 503 }, { json: { id: "sb" } });
    const http = client({ idempotencyHeader: "Idempotency-Key" });
    expect(
      await http.json({ method: "POST", path: "/x", body: { a: 1 }, idempotencyKey: "k-1" }),
    ).toEqual({ id: "sb" });
    expect(server.requests.map((request) => request.headers["idempotency-key"])).toEqual([
      "k-1",
      "k-1",
    ]);
    expect(server.requests.map((request) => request.body.toString())).toEqual([
      '{"a":1}',
      '{"a":1}',
    ]);
  });

  test("a streamed request body is sent with duplex half and never retried", async () => {
    server.on("PUT /v1/upload", { status: 503 });

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello "));
        controller.enqueue(new TextEncoder().encode("world"));
        controller.close();
      },
    });

    expect((await failure(client().request({ method: "PUT", path: "/upload", body }))).code).toBe(
      "unavailable",
    );
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.body.toString()).toBe("hello world");
  });

  test("a streamed upload succeeds", async () => {
    server.on("PUT /v1/upload", { status: 201 });
    const parts = ["a".repeat(70_000), "b".repeat(70_000)];

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
        controller.close();
      },
    });

    expect((await client().request({ method: "PUT", path: "/upload", body })).status).toBe(201);
    expect(server.requests[0]?.body.toString()).toBe(parts.join(""));
  });
});

describe("unknown outcomes", () => {
  test("a POST whose connection drops after sending is outcome_unknown and not retried", async () => {
    server.on("POST /v1/sandboxes", { drop: true });

    const error = await failure(
      client({ idempotencyHeader: undefined }).json({
        method: "POST",
        path: "/sandboxes",
        body: {},
      }),
    );

    expect(error).toMatchObject({ code: "outcome_unknown", retryable: false });
    expect(server.requests).toHaveLength(1);
  });

  test("a GET whose connection drops is retried, then unavailable", async () => {
    server.on("GET /v1/x", { drop: true });
    expect((await failure(client().json({ method: "GET", path: "/x" }))).code).toBe("unavailable");
    expect(server.requests).toHaveLength(3);
  });

  test("a POST to a closed port was never sent: unavailable", async () => {
    const closed = await fakeServer();
    const url = closed.url;
    await closed.close();

    const http = createHttpClient({
      provider: "fake",
      label: "Fake",
      planes: { api: { baseUrl: url } },
      defaultPlane: "api",
      backoffMs: 1,
    });

    expect((await failure(http.json({ method: "POST", path: "/x", body: {} }))).code).toBe(
      "unavailable",
    );
  });

  test("a POST that times out is outcome_unknown; a GET is timeout", async () => {
    server.on("POST /v1/x", { hang: true }).on("GET /v1/x", { hang: true });
    expect(
      (await failure(client().json({ method: "POST", path: "/x", body: {}, timeoutMs: 100 }))).code,
    ).toBe("outcome_unknown");
    expect((await failure(client().json({ method: "GET", path: "/x", timeoutMs: 100 }))).code).toBe(
      "timeout",
    );
  });

  test("a 504 on a POST is outcome_unknown; a readOnly POST maps like a GET", async () => {
    server.on("POST /v1/x", { status: 504 });
    expect((await failure(client().json({ method: "POST", path: "/x", body: {} }))).code).toBe(
      "outcome_unknown",
    );
    expect(
      (await failure(client().json({ method: "POST", path: "/x", body: {}, readOnly: true }))).code,
    ).toBe("timeout");
  });

  test("a POST whose 2xx body is cut is outcome_unknown", async () => {
    server.on("POST /v1/x", { stream: ['{"id":'], cut: true });
    expect((await failure(client().json({ method: "POST", path: "/x", body: {} }))).code).toBe(
      "outcome_unknown",
    );
  });

  test("the caller's signal aborts with aborted", async () => {
    server.on("GET /v1/x", { hang: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(
      (await failure(client().json({ method: "GET", path: "/x", signal: controller.signal }))).code,
    ).toBe("aborted");
  });

  test("one deadline covers several calls", async () => {
    // The first call fits; the second needs as long again and only 400 ms are left, with room for a loaded machine.
    server.on("GET /v1/x", { json: {}, delayMs: 600 });
    const deadline = createDeadline(1_000);
    await client().json({ method: "GET", path: "/x", deadline });
    expect((await failure(client().json({ method: "GET", path: "/x", deadline }))).code).toBe(
      "timeout",
    );
  });

  test("cleanup ignores the aborted caller signal and has its own bound", async () => {
    server.on("DELETE /v1/sandboxes/{id}", { status: 204 });
    const controller = new AbortController();
    controller.abort();
    await client().cleanup({
      method: "DELETE",
      path: "/sandboxes/{id}",
      params: { id: "sb" },
      signal: controller.signal,
    });
    expect(server.requests).toHaveLength(1);
  });
});

describe("credentials stay on their origin", () => {
  test("an absolute URL on another origin gets no credentials; on the plane origin it does", async () => {
    other.on("PUT /signed", { status: 200 });
    server.on("GET /v1/poll", { json: {} });
    const http = client();
    await http.request({ method: "PUT", path: `${other.url}/signed?sig=abc`, body: "data" });
    await http.request({ method: "GET", path: `${server.url}/v1/poll` });
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${key}`);
  });

  test("auth: false sends none, even to the plane origin", async () => {
    server.on("GET /v1/x", { json: {} });
    await client().request({ method: "GET", path: "/x", auth: false });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  test("a cross-origin redirect drops credentials; 303 turns a POST into a GET", async () => {
    server.on("POST /v1/x", { status: 303, headers: { location: `${other.url}/result` } });
    other.on("GET /result", { json: { done: true } });
    expect(await client().json({ method: "POST", path: "/x", body: { a: 1 } })).toEqual({
      done: true,
    });
    expect(other.requests[0]?.headers.authorization).toBeUndefined();
    expect(other.requests[0]?.method).toBe("GET");
  });

  test("a same-origin 307 keeps method, body and credentials", async () => {
    server
      .on("PUT /v1/x", { status: 307, headers: { location: "/v1/y" } })
      .on("PUT /v1/y", { status: 200 });
    await client().request({ method: "PUT", path: "/x", body: "payload" });
    expect(server.calls("PUT /v1/y")[0]?.body.toString()).toBe("payload");
    expect(server.calls("PUT /v1/y")[0]?.headers.authorization).toBe(`Bearer ${key}`);
  });

  test("a 401 refreshes credentials once, shared by concurrent requests", async () => {
    let token = "old";
    let refreshes = 0;
    other.on("GET /boxes/{id}/x", (request, response) => {
      response
        .writeHead(request.headers["x-access-token"] === "new" ? 200 : 401, {
          "content-type": "application/json",
        })
        .end("{}");
    });

    const http = createHttpClient({
      provider: "fake",
      label: "Fake",
      defaultPlane: "data",
      backoffMs: 1,
      planes: {
        data: {
          baseUrl: `${other.url}/boxes/sb`,
          auth: () => ({ "x-access-token": token }),
          refresh: async () => {
            refreshes++;
            await new Promise((resolve) => setTimeout(resolve, 30));
            token = "new";
          },
        },
      },
    });

    await Promise.all([1, 2, 3].map(() => http.json({ method: "GET", path: "/x" })));
    expect(refreshes).toBe(1);
  });
});

describe("errors are redacted and bounded", () => {
  test("adapter calls keep status and provider code, never the response text", async () => {
    server.on("GET /v1/sandboxes/{id}", {
      status: 404,
      json: { code: "sandbox_not_found", message: `echo ${key} private command text` },
      headers: { "x-request-id": "req_123" },
    });

    const error = await failure(
      client().json({
        method: "GET",
        path: "/sandboxes/{id}",
        params: { id: "sb-1" },
        sandboxId: "sb-1",
      }),
    );

    expect(error).toMatchObject({ code: "not_found", sandboxId: "sb-1", provider: "fake" });
    expect(error.message).toBe("Fake GET /sandboxes/{id} failed (HTTP 404 sandbox_not_found).");
    expect(error.cause).toBe("HTTP 404 sandbox_not_found (request req_123)");
    expect(text(error)).not.toContain("private command");
  });

  test("native calls keep the message, with secrets, tokens and URLs scrubbed", async () => {
    server.on("POST /v1/x", {
      status: 400,
      json: {
        error: {
          code: "bad_input",
          message: `key ${key} token=abc123 see https://x.test/?sig=zzz Bearer qqq`,
        },
      },
    });

    const error = await failure(
      client().json({ method: "POST", path: "/x", body: {}, detail: "message" }),
    );

    expect(error.code).toBe("invalid_argument");
    expect(error.message).toContain("bad_input");
    expect(text(error)).not.toMatch(/sk-test|abc123|sig=zzz|qqq/);
  });

  test("an auth failure uses the provider's hint and never shows the credential", async () => {
    server.on("GET /v1/x", { status: 401, body: `invalid key ${key}` });
    const error = await failure(client().json({ method: "GET", path: "/x", detail: "message" }));
    expect(error).toMatchObject({ code: "auth", hint: "Set FAKE_API_KEY." });
    expect(text(error)).not.toContain(key);
  });

  test("a network failure keeps a scrubbed native detail", async () => {
    const http = client({
      fetch: async () => {
        throw new TypeError(`fetch failed for ${key}`);
      },
    });

    const error = await failure(http.json({ method: "GET", path: "/x" }));
    expect(error.code).toBe("unavailable");
    expect(String(error.cause)).toContain("TypeError: fetch failed for [REDACTED]");
  });

  test("the provider hook refines the shared mapping", async () => {
    server.on("GET /v1/files", {
      status: 404,
      json: { message: "open /x: no such file or directory" },
    });

    const http = client({
      mapError: (failed, request) =>
        failed.kind === "status" &&
        failed.status === 404 &&
        request.operation === "GET /files" &&
        /no such file/.test(failed.body.message ?? "")
          ? "file_not_found"
          : undefined,
    });

    expect((await failure(http.json({ method: "GET", path: "/files" }))).code).toBe(
      "file_not_found",
    );
  });

  test("a huge error body is read only up to 64 KB", async () => {
    server.on("GET /v1/x", {
      status: 400,
      stream: ['{"message":"', "y".repeat(200_000), '"}'],
      hold: true,
    });
    // The server never ends the body; reading stops at 64 KB instead of waiting for the 10 s deadline.
    const started = Date.now();
    expect(
      (await failure(client({ timeoutMs: 10_000 }).json({ method: "GET", path: "/x" }))).code,
    ).toBe("invalid_argument");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("parseErrorBody reads the common shapes", () => {
    expect(parseErrorBody('{"code":"a","message":"b"}')).toMatchObject({ code: "a", message: "b" });
    expect(parseErrorBody('{"error":{"code":"c","message":"d"}}')).toMatchObject({
      code: "c",
      message: "d",
    });
    expect(parseErrorBody('{"error":"not_found"}')).toMatchObject({
      code: "not_found",
      message: "not_found",
    });
    expect(parseErrorBody('{"title":"Bad","detail":"why","type":"about:blank"}')).toMatchObject({
      message: "why",
    });
    expect(parseErrorBody("plain text")).toMatchObject({ message: "plain text", json: undefined });
  });
});

describe("streams", () => {
  test("a streamed body arrives chunk by chunk and parses across boundaries", async () => {
    server.on("POST /v1/exec", { stream: ['{"out":"h', 'é"}\n{"exit"', ":0}\n"] });
    const response = await client().stream({ method: "POST", path: "/exec", body: {} });
    const frames: unknown[] = [];

    for await (const frame of ndjson(response.body!, { provider: "fake" })) frames.push(frame);
    expect(frames).toEqual([{ out: "hé" }, { exit: 0 }]);
  });

  test("a mid-stream disconnect is a disconnected fault; a write's result is unconfirmed, a read's is retryable", async () => {
    const read = async (request: { method: "POST" | "GET"; readOnly?: boolean }) => {
      const response = await client().stream({
        path: "/exec",
        ...request,
        ...(request.method === "POST" ? { body: {} } : undefined),
      });

      const frames: unknown[] = [];
      let caught: unknown;

      try {
        for await (const frame of ndjson(response.body!, { provider: "fake" })) frames.push(frame);
      } catch (error) {
        caught = error;
      }

      expect(frames).toEqual([{ out: 1 }]);
      expect(caught).toBeInstanceOf(SandboxError);
      expect(streamFault(caught)).toBe("disconnected");

      return caught as SandboxError;
    };

    server.on("POST /v1/exec", { stream: ['{"out":1}\n', '{"out"'], cut: true });
    server.on("GET /v1/exec", { stream: ['{"out":1}\n', '{"out"'], cut: true });
    // An exec whose headers arrived but whose result was cut off may or may not have finished.
    expect(await read({ method: "POST" })).toMatchObject({
      code: "outcome_unknown",
      retryable: false,
    });
    expect(await read({ method: "POST", readOnly: true })).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    expect(await read({ method: "GET" })).toMatchObject({ code: "unavailable", retryable: true });
  });

  test("an idle timeout on a write stream is outcome_unknown; on a read it is a timeout", async () => {
    server.on("POST /v1/exec", { stream: ["a"], hold: true });
    server.on("GET /v1/logs", { stream: ["a"], hold: true });

    const idle = async (request: { method: "POST" | "GET"; path: string }) => {
      const response = await client().stream({
        ...request,
        ...(request.method === "POST" ? { body: {} } : undefined),
        idleTimeoutMs: 100,
      });

      const reader = response.body!.getReader();
      await reader.read();

      return failure(reader.read());
    };

    expect(await idle({ method: "POST", path: "/exec" })).toMatchObject({
      code: "outcome_unknown",
      retryable: false,
    });
    expect(await idle({ method: "GET", path: "/logs" })).toMatchObject({
      code: "timeout",
      retryable: true,
    });
  });

  test("the startup timeout covers time to headers", async () => {
    server.on("GET /v1/logs", { hang: true });
    expect(
      (await failure(client().stream({ method: "GET", path: "/logs", startupTimeoutMs: 100 })))
        .code,
    ).toBe("timeout");
  });

  test("the idle timeout fires between chunks, not over the whole stream", async () => {
    // Gaps of 50 ms stay under the 1 s idle timeout; the held-open end trips it.
    server.on("GET /v1/logs", { stream: ["a", "b", "c"], intervalMs: 50, hold: true });
    const response = await client().stream({ method: "GET", path: "/logs", idleTimeoutMs: 1_000 });
    const reader = response.body!.getReader();
    const seen: string[] = [];
    let caught: unknown;

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) break;
        seen.push(new TextDecoder().decode(value));
      }
    } catch (error) {
      caught = error;
    }

    expect(seen.join("")).toBe("abc");
    expect((caught as SandboxError).code).toBe("timeout");
  });

  test("cancelling the body closes the connection", async () => {
    server.on("GET /v1/logs", { stream: ["a"], hold: true });
    const response = await client().stream({ method: "GET", path: "/logs" });
    const closed = server.closed();
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await closed;
  });

  test("the caller's signal aborts a stream mid-body", async () => {
    server.on("GET /v1/logs", { stream: ["a"], hold: true });
    const controller = new AbortController();

    const response = await client().stream({
      method: "GET",
      path: "/logs",
      signal: controller.signal,
    });

    const reader = response.body!.getReader();
    await reader.read();
    setTimeout(() => controller.abort(), 20);
    const error = await failure(reader.read());
    expect(error.code).toBe("aborted");
  });

  test("a non-2xx stream response rejects before the body is handed over", async () => {
    server.on("GET /v1/logs", { status: 404, json: { code: "gone" } });
    expect((await failure(client().stream({ method: "GET", path: "/logs" }))).code).toBe(
      "not_found",
    );
  });
});
