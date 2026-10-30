// SBX-74 review fixes in the HTTP core: caller credentials stay on the plane's origin and are redacted, a
// refresh never resends a write that may have run, and hung credential or base-URL callbacks honour the deadline.
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import { createHttpClient, type StaleVerdict } from "../src/http.js";
import { createNativeApi } from "../src/native.js";
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

const text = (error: SandboxError) => `${error.message} ${error.hint} ${String(error.cause)}`;

const callerCredentials = {
  authorization: "Bearer caller-bearer-1111",
  cookie: "session=caller-cookie-2222",
  "proxy-authorization": "Basic caller-proxy-3333",
  "x-access-token": "caller-access-4444",
  "x-custom-key": "caller-custom-5555",
  "x-api-key": "caller-api-6666",
  "x-plane-auth": "caller-plane-7777",
};

function client() {
  return createHttpClient({
    provider: "fake",
    label: "Fake",
    defaultPlane: "api",
    backoffMs: 1,
    timeoutMs: 2_000,
    // `x-plane-auth` matches no shared pattern; it is a credential because the plane's auth returns it.
    planes: {
      api: { baseUrl: `${server.url}/v1`, auth: () => ({ "x-plane-auth": "adapter-plane-0000" }) },
    },
  });
}

describe("caller credential headers stay on the plane's origin", () => {
  test("a native call to an absolute URL elsewhere sends none of them; other headers still go", async () => {
    other.on("PUT /signed", { status: 200 });
    const http = client();
    // Learn the plane's auth header names first, as any earlier call would.
    server.on("GET /v1/warm", { json: {} });
    await http.json({ method: "GET", path: "/warm" });
    const native = createNativeApi({ http, placeholder: "sandboxId", sandboxId: "sb" });
    await (
      await native.fetch("PUT", `${other.url}/signed?sig=abc`, {
        body: "data",
        headers: { ...callerCredentials, "x-amz-acl": "private", "Idempotency-Key": "k-1" },
      })
    ).body?.cancel();
    const sent = other.requests[0]!.headers;

    for (const name of Object.keys(callerCredentials)) expect(sent[name], name).toBeUndefined();
    expect(sent["x-amz-acl"]).toBe("private");
    expect(sent["idempotency-key"]).toBe("k-1");
  });

  test("a redirect to another origin drops caller credentials; a same-origin call keeps them", async () => {
    server
      .on("GET /v1/x", { status: 302, headers: { location: `${other.url}/elsewhere` } })
      .on("GET /v1/same", { json: {} });
    other.on("GET /elsewhere", { json: { moved: true } });
    const http = client();
    expect(await http.json({ method: "GET", path: "/x", headers: callerCredentials })).toEqual({
      moved: true,
    });

    for (const name of Object.keys(callerCredentials))
      expect(other.requests[0]!.headers[name], name).toBeUndefined();
    await http.json({ method: "GET", path: "/same", headers: callerCredentials });
    const same = server.calls("GET /v1/same")[0]!.headers;
    expect(same.authorization).toBe("Bearer caller-bearer-1111");
    expect(same["x-plane-auth"]).toBe("caller-plane-7777");
  });
});

describe("caller credentials are redacted", () => {
  test("an error that echoes an overridden credential, bare or with its scheme, never shows it", async () => {
    server.on("POST /v1/x", {
      status: 400,
      json: {
        error: {
          code: "bad_auth",
          message:
            "rejected caller-bearer-1111, caller-custom-5555 and session=caller-cookie-2222 plus caller-plane-7777",
        },
      },
    });
    const native = createNativeApi({ http: client(), placeholder: "sandboxId", sandboxId: "sb" });

    const error = await failure(
      native.request("POST", "/x", {
        body: {},
        headers: {
          authorization: "Bearer caller-bearer-1111",
          "x-custom-key": "caller-custom-5555",
          cookie: "session=caller-cookie-2222",
          "x-plane-auth": "caller-plane-7777",
        },
      }),
    );

    expect(error.message).toContain("bad_auth");
    expect(text(error)).not.toMatch(/caller-(bearer|custom|cookie|plane)/);
  });
});

describe("a stale-credential refresh never resends a write that may have run", () => {
  function stale(verdict: StaleVerdict) {
    let token = "old-token-123456";
    let refreshes = 0;

    const http = createHttpClient({
      provider: "acme",
      label: "Acme",
      defaultPlane: "data",
      backoffMs: 1,
      timeoutMs: 2_000,
      idempotencyHeader: "Idempotency-Key",
      planes: {
        data: {
          baseUrl: server.url,
          auth: () => ({ "x-access-token": token }),
          refresh: async () => {
            refreshes++;
            token = "new-token-654321";
          },
          stale: ({ status }) => (status === 503 ? verdict : undefined),
        },
      },
    });

    return { http, refreshes: () => refreshes };
  }

  test("an unsure 503 on a POST refreshes but is not resent: outcome_unknown", async () => {
    server.on("POST /exec", { status: 503, json: {} }, { json: { ran: "twice" } });
    const { http, refreshes } = stale("unsure");

    const error = await failure(
      http.json({ method: "POST", path: "/exec", body: { command: "rm -rf build" } }),
    );

    expect(error).toMatchObject({ code: "outcome_unknown", retryable: false });
    expect(server.calls("POST /exec")).toHaveLength(1);
    expect(refreshes()).toBe(1);
    // The next call uses the refreshed credentials.
    server.on("GET /files", { json: [] });
    await http.json({ method: "GET", path: "/files" });
    expect(server.calls("GET /files")[0]?.headers["x-access-token"]).toBe("new-token-654321");
  });

  test("an unsure 503 on a readOnly POST maps like a GET and is not resent", async () => {
    server.on("POST /search", { status: 503, json: {} }, { json: [] });
    const { http } = stale("unsure");
    expect(
      (await failure(http.json({ method: "POST", path: "/search", body: {}, readOnly: true })))
        .code,
    ).toBe("unavailable");
    expect(server.calls("POST /search")).toHaveLength(1);
  });

  test("an unsure 503 is resent for a GET and for a POST with an idempotency key", async () => {
    server.on("GET /files", { status: 503, json: {} }, { json: { ok: 1 } });
    server.on("POST /snapshot", { status: 503, json: {} }, { json: { id: "snap" } });
    const { http, refreshes } = stale("unsure");
    expect(await http.json({ method: "GET", path: "/files" })).toEqual({ ok: 1 });
    expect(
      await http.json({ method: "POST", path: "/snapshot", body: {}, idempotencyKey: "k-1" }),
    ).toEqual({ id: "snap" });
    expect(refreshes()).toBe(2);
  });

  test("a refused answer and a 401 resend a POST: nothing ran", async () => {
    server.on("POST /exec", { status: 503, json: {} }, { json: { ok: 1 } });
    const { http } = stale("refused");
    expect(await http.json({ method: "POST", path: "/exec", body: {} })).toEqual({ ok: 1 });
    server.on("POST /upload", { status: 401, json: {} }, { json: { ok: 2 } });
    expect(await http.json({ method: "POST", path: "/upload", body: {} })).toEqual({ ok: 2 });
    expect(server.calls("POST /exec")).toHaveLength(2);
    expect(server.calls("POST /upload")).toHaveLength(2);
  });
});

describe("plane callbacks are bounded by the deadline", () => {
  const never = () => new Promise<never>(() => {});
  test("a credential callback that never settles times out", async () => {
    const http = createHttpClient({
      provider: "fake",
      label: "Fake",
      defaultPlane: "api",
      planes: { api: { baseUrl: server.url, auth: never } },
    });

    const started = Date.now();
    expect((await failure(http.json({ method: "GET", path: "/x", timeoutMs: 100 }))).code).toBe(
      "timeout",
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(server.requests).toHaveLength(0);
  });

  test("a base-URL callback that never settles stops on the caller's signal", async () => {
    const http = createHttpClient({
      provider: "fake",
      label: "Fake",
      defaultPlane: "api",
      planes: { api: { baseUrl: never } },
    });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(
      (
        await failure(
          http.json({ method: "GET", path: "/x", signal: controller.signal, timeoutMs: 60_000 }),
        )
      ).code,
    ).toBe("aborted");
    expect(server.requests).toHaveLength(0);
  });

  test("a stream's startup timeout bounds the callbacks too", async () => {
    const http = createHttpClient({
      provider: "fake",
      label: "Fake",
      defaultPlane: "api",
      planes: { api: { baseUrl: server.url, auth: never } },
    });

    expect(
      (await failure(http.stream({ method: "GET", path: "/logs", startupTimeoutMs: 100 }))).code,
    ).toBe("timeout");
    expect(server.requests).toHaveLength(0);
  });

  test("a call cancelled while its credentials resolve is not sent", async () => {
    const controller = new AbortController();

    // The callback settles, but only after the caller gave up.
    const http = createHttpClient({
      provider: "fake",
      label: "Fake",
      defaultPlane: "api",
      planes: {
        api: {
          baseUrl: server.url,
          auth: () => {
            controller.abort();

            return { authorization: "Bearer late-token-0000" };
          },
        },
      },
    });

    server.on("POST /x", { json: {} });
    expect(
      (
        await failure(
          http.json({ method: "POST", path: "/x", body: {}, signal: controller.signal }),
        )
      ).code,
    ).toBe("aborted");
    expect(server.requests).toHaveLength(0);
  });
});
