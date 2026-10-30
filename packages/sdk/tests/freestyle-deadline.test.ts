import { isObject, isString } from "../src/shared/narrow.js";
import { afterEach, expect, test, vi } from "vitest";

// The adapter speaks HTTP itself; loading the SDK would be a regression.
vi.mock("freestyle", () => {
  throw new Error("The freestyle SDK must not be loaded");
});

import { freestyle } from "../src/providers/freestyle/index.js";
import { background, freestyleClient } from "../src/providers/freestyle/client.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const pathOf = (url: string | URL | Request) =>
  new URL(url instanceof Request ? url.url : url).pathname;

const headerOf = (init: RequestInit | undefined, name: string) =>
  new Headers(init?.headers).get(name);

test("the overall deadline stops HTTP 202 polling without another network request", async () => {
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      requests++;

      if (requests > 1) return new Response(JSON.stringify({ vms: [], totalCount: 0 }));

      return new Response(
        JSON.stringify({ requestId: "offline", resultUrl: "/v5/background-requests/offline" }),
        { status: 202 },
      );
    }),
  );

  const provider = freestyle({
    baseUrl: "http://offline.invalid",
    apiKey: "mock",
    requestTimeoutMs: 20,
  });

  const start = Date.now();
  await expect(provider.list({})).rejects.toMatchObject({ code: "timeout" });
  expect(Date.now() - start).toBeLessThan(500);
  expect(requests).toBe(1);
  // Polls are two seconds apart. The next one must see the deadline before fetching, not retry for five minutes.
  await new Promise((resolve) => setTimeout(resolve, 2100));
  expect(requests).toBe(1);
}, 5000);

test("every awaited native operation is bounded and aborts its fetch", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;

          if (!signal) throw new Error("Missing deadline signal");
          signals.push(signal);
          const abort = () => reject(new DOMException("stopped", "AbortError"));
          signal.addEventListener("abort", abort, { once: true });

          if (signal.aborted) abort();
        }),
    ),
  );
  const p = freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock", requestTimeoutMs: 20 });

  const operations = [
    () => p.create({ labels: {} }),
    () => p.connect("offline"),
    () => p.list({}),
    () => p.destroy("offline"),
    () => p.pause?.("offline"),
    () => p.resume?.("offline"),
    () => p.snapshot?.("offline"),
    () => p.previewUrl("offline", 3000),
    () => p.files.read("offline", "/workspace/file"),
    () => p.files.readRange?.("offline", "/workspace/file", { offset: 0, length: 100000 }),
    () => p.files.write("offline", "/workspace/file", new Uint8Array([1])),
    () => p.files.stat("offline", "/workspace/file"),
    () => p.files.list("offline", "/workspace"),
    () => p.files.mkdir("offline", "/workspace/dir"),
    () => p.files.remove("offline", "/workspace/file", { recursive: false }),
  ];

  for (const [i, operation] of operations.entries()) {
    const start = Date.now();
    await expect(operation()).rejects.toMatchObject({
      code: i === 0 ? "outcome_unknown" : "timeout",
    });
    expect(Date.now() - start).toBeLessThan(500);
    expect(signals.at(-1)?.aborted).toBe(true);
  }
});

test("caller abort rejects a pending create at once, and a VM that lands afterwards is deleted", async () => {
  const c = new AbortController();
  const requests: string[] = [];
  let land: (response: Response) => void = () => {};
  let createSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      requests.push(`${init?.method} ${pathOf(url)}`);

      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      createSignal = init?.signal ?? undefined;

      return new Promise<Response>((resolve) => {
        land = resolve;
      });
    }),
  );

  const pending = freestyle({
    baseUrl: "http://offline.invalid",
    apiKey: "mock",
    requestTimeoutMs: 5000,
  }).create({ labels: {}, signal: c.signal });

  await vi.waitFor(() => expect(requests).toEqual(["POST /v5/vms"]));
  c.abort();
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  // Cutting the request would orphan a VM Freestyle may still allocate: only the response names it.
  expect(createSignal?.aborted).toBe(false);
  land(
    Response.json(
      {
        id: "late",
        state: "running",
        metadata: {},
        vpcs: [],
        createdAt: "2026-10-21T00:00:00Z",
        firewallRules: [],
        tlsRules: [],
      },
      { status: 201 },
    ),
  );
  await vi.waitFor(() => expect(requests).toEqual(["POST /v5/vms", "DELETE /v5/vms/late"]));
});

test("an already-aborted operation makes no native request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const c = new AbortController();
  c.abort();
  await expect(
    freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).create({
      labels: {},
      signal: c.signal,
    }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(fetch).not.toHaveBeenCalled();
});

test.each(["running", "starting"])(
  "cold create returns running after successful setup from a %s allocation without extra requests",
  async (state) => {
    const requests: { method?: string; path: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        const body: unknown = isString(init?.body) ? JSON.parse(init.body) : undefined;
        requests.push({ method: init?.method, path, body });

        if (path === "/v5/vms" && init?.method === "POST") {
          if (!body || !isObject(body) || !("metadata" in body))
            throw new Error("Missing metadata");

          return Response.json({
            id: "offline",
            state,
            metadata: body.metadata,
            resources: { cpu: 4, memory: 8192, storage: 32768 },
            vpcs: [],
            networks: [],
            createdAt: "2026-10-21T00:00:00Z",
            updatedAt: "2026-10-21T00:00:00Z",
            idleTimeoutSeconds: -1,
            firewallRules: [],
            tlsRules: [],
          });
        }

        if (path === "/v5/vms/offline/exec-await")
          return Response.json({ statusCode: 0, stdout: "", stderr: "" });
        throw new Error("Unexpected cold setup request");
      }),
    );

    const result = await freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).create({
      labels: { test: "cold" },
      network: "none",
      env: { TOKEN: "private-test-value" },
    });

    expect(result).toMatchObject({ id: "offline", labels: { test: "cold" }, state: "running" });
    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /v5/vms",
      "POST /v5/vms/offline/exec-await",
    ]);
    expect(requests[0]?.body).toMatchObject({
      snapshotId: "freestyle/ubuntu",
      firewall: { rules: [] },
      tls: { rules: [] },
      vpcs: [],
    });
    const setup = requests[1]?.body;

    if (
      !setup ||
      !isObject(setup) ||
      !("command" in setup) ||
      !("stdin" in setup) ||
      !isString(setup.stdin)
    )
      throw new Error("Missing setup exec");
    expect(String(setup.command)).not.toContain("private-test-value");
    expect(String(setup.command)).not.toMatch(/apt(-get)? |pip install|npm install/);
    expect(Buffer.from(setup.stdin, "base64").toString()).toContain("private-test-value");
  },
);

test("HTTP failures retain status, code, request ID and operation through public redaction", async () => {
  const { createSandbox } = await import("../src/index.js");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          code: "PAYLOAD_TOO_LARGE",
          message: "secret-response-body",
          authorization: "Bearer secret-key",
        },
        { status: 413, headers: { "x-request-id": "req-123", "set-cookie": "secret-cookie" } },
      ),
    ),
  );
  const p = freestyle({ baseUrl: "http://offline.invalid", apiKey: "secret-key" });
  await expect(p.files.read("private-vm", "/private/secret-file")).rejects.toMatchObject({
    code: "provider",
    cause: {
      status: 413,
      providerCode: "PAYLOAD_TOO_LARGE",
      requestId: "req-123",
      operation: "GET /v5/vms/:id/fs/read",
    },
  });

  try {
    await createSandbox(p);
    throw new Error("Expected failure");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(JSON.parse(String(error.cause))).toEqual({
      status: 413,
      providerCode: "PAYLOAD_TOO_LARGE",
      requestId: "req-123",
      operation: "POST /v5/vms",
    });
    expect(String(error) + JSON.stringify(error.cause)).not.toMatch(
      /secret-response-body|secret-key|secret-cookie|secret-file|private-vm/,
    );
  }
});

test("concurrent failures keep their own request IDs and reject unsafe header values", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      const first = path.includes("first");

      if (first) await new Promise((resolve) => setTimeout(resolve, 20));

      return Response.json(
        { code: first ? "FIRST_ERROR" : "SECOND_ERROR", message: "private" },
        {
          status: first ? 404 : 413,
          headers: { "x-request-id": first ? "req-first" : "Bearer unsafe-token" },
        },
      );
    }),
  );
  const provider = freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" });

  const results = await Promise.allSettled([
    provider.files.read("first", "/one"),
    provider.files.read("second", "/two"),
  ]);

  const errors = results.map((r) => {
    if (r.status !== "rejected") throw new Error("Expected failure");

    return r.reason;
  });

  expect(errors[0]).toMatchObject({
    cause: { requestId: "req-first", providerCode: "FIRST_ERROR" },
  });
  expect(errors[1]).toMatchObject({ cause: { providerCode: "SECOND_ERROR" } });
  expect(errors[1].cause.requestId).toBeUndefined();
});

test("configured credentials are excluded even from otherwise valid diagnostic identifiers", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { code: "PRIVATE_TOKEN", message: "private body" },
        {
          status: 413,
          headers: { "x-request-id": "req-PRIVATE_TOKEN" },
        },
      ),
    ),
  );

  try {
    await freestyle({ baseUrl: "http://offline.invalid", apiKey: "PRIVATE_TOKEN" }).files.read(
      "offline",
      "/file",
    );
    throw new Error("Expected failure");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toMatchObject({ status: 413, operation: "GET /v5/vms/:id/fs/read" });
    expect(String(error.cause)).not.toContain("PRIVATE_TOKEN");
  }
});

test("background failures retain the original operation and accepted request ID", async () => {
  let requests = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ++requests === 1
        ? Response.json(
            { resultUrl: "/v5/background-requests/bg-123" },
            { status: 202, headers: { "x-freestyle-background-request-id": "bg-123" } },
          )
        : Response.json(
            { code: "BACKGROUND_RESULT_UNSTORABLE", message: "private body" },
            { status: 413 },
          ),
    ),
  );
  await expect(
    freestyle({
      baseUrl: "http://offline.invalid",
      apiKey: "mock",
      requestTimeoutMs: 5000,
    }).pause?.("offline"),
  ).rejects.toMatchObject({
    cause: {
      status: 413,
      providerCode: "BACKGROUND_RESULT_UNSTORABLE",
      requestId: "bg-123",
      operation: "POST /v5/vms/:id/pause",
    },
  });
  expect(requests).toBe(2);
});

test.each(["vpc", "tls", "firewall", "limits", "setup"])(
  "unconfirmed %s in allocation response fails closed and deletes the VM",
  async (kind) => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const path = new URL(url instanceof Request ? url.url : url).pathname;
        requests.push(`${init?.method} ${path}`);

        if (init?.method === "DELETE") return new Response(null, { status: 204 });

        if (path.endsWith("/exec-await"))
          return Response.json({ statusCode: 1, stdout: "", stderr: "private" });
        const body: unknown = isString(init?.body) ? JSON.parse(init.body) : undefined;

        if (!body || !isObject(body) || !("metadata" in body))
          throw new Error("Missing create metadata");

        return Response.json({
          id: "offline",
          state: "running",
          metadata: body.metadata,
          resources: { cpu: 4, memory: 8192, storage: 32768 },
          networks: [],
          vpcs: kind === "vpc" ? ["unexpected"] : [],
          createdAt: "2026-10-21T00:00:00Z",
          updatedAt: "2026-10-21T00:00:00Z",
          ttlSeconds: kind === "limits" ? 999 : 180,
          firewallRules:
            kind === "firewall"
              ? [{ action: "allow", source: { vmId: "offline" }, destination: { public: true } }]
              : [],
          tlsRules: kind === "tls" ? [{ source: { vmId: "offline" } }] : [],
        });
      }),
    );
    await expect(
      freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).create({
        labels: {},
        network: "none",
        timeoutMs: 180000,
        ...(kind === "setup" ? { env: { SETUP: "required" } } : undefined),
      }),
    ).rejects.toMatchObject({ code: kind === "setup" ? "provider" : "unsupported" });
    expect(requests.at(-1)).toBe("DELETE /v5/vms/offline");
    expect(requests.filter((r) => r.startsWith("GET"))).toEqual([]);
  },
);

test("a later setup failure never inherits the allocation's background request ID", async () => {
  let metadata: unknown;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;

      if (init?.method === "DELETE") return new Response(null, { status: 204 });

      if (path.endsWith("/exec-await"))
        return Response.json({ code: "SETUP_FAILED", message: "private" }, { status: 413 });

      if (path === "/v5/vms") {
        const body: unknown = isString(init?.body) ? JSON.parse(init.body) : undefined;

        if (!body || !isObject(body) || !("metadata" in body)) throw new Error("Missing metadata");
        metadata = body.metadata;

        return Response.json(
          { resultUrl: "/v5/background-requests/allocation" },
          { status: 202, headers: { "x-freestyle-background-request-id": "allocation" } },
        );
      }

      return Response.json({
        id: "offline",
        state: "running",
        metadata,
        vpcs: [],
        firewallRules: [],
        tlsRules: [],
      });
    }),
  );

  try {
    await freestyle({
      baseUrl: "http://offline.invalid",
      apiKey: "mock",
      requestTimeoutMs: 5000,
    }).create({ labels: {}, network: "none", env: { SETUP: "required" } });
    throw new Error("Expected failure");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toMatchObject({
      status: 413,
      providerCode: "SETUP_FAILED",
      operation: "POST /v5/vms/:id/exec-await",
    });
    expect(String(error.cause)).not.toContain("allocation");
  }
});

test("requests go to global fetch with the key, the background window and the operation's deadline signal", async () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ vms: [], totalCount: 0 }),
  );

  vi.stubGlobal("fetch", fetch);
  expect(await freestyle({ apiKey: "mock" }).list({})).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.freestyle.sh/v5/vms?limit=100&offset=0");
  expect(headerOf(init, "authorization")).toBe("Bearer mock");
  expect(headerOf(init, "x-freestyle-background-after-secs")).toBe("5");
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});

/** A VM record the adapter accepts on connect, with native SDK metadata. */
function vmRecord(id: string) {
  const info = Buffer.from(JSON.stringify({ key: null, labels: {} })).toString("base64url");

  return {
    id,
    state: "running",
    metadata: { "sandbox-sdk": "1", "sandbox-sdk-info": "1", "sandbox-sdk-info-0": info },
    vpcs: [],
    createdAt: "2026-10-21T00:00:00Z",
  };
}

test("a 202 is polled at its resultUrl every interval until the stored result arrives", async () => {
  const requests: { method?: string; path: string; init?: RequestInit }[] = [];
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ method: init?.method, path: pathOf(url), init });

      if (pathOf(url) === "/v5/vms/vm-1/pause")
        return Response.json(
          { requestId: "bg-1", resultUrl: "/v5/background-requests/bg-1" },
          { status: 202 },
        );

      if (++polls < 3)
        return Response.json({ requestId: "bg-1", status: "pending" }, { status: 202 });

      return Response.json(vmRecord("vm-1"), {
        headers: { "x-freestyle-background-request-id": "bg-1" },
      });
    }),
  );
  const saved = background.pollMs;
  background.pollMs = 10;

  try {
    const start = Date.now();
    await freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).pause?.("vm-1");
    expect(Date.now() - start).toBeGreaterThanOrEqual(30);
  } finally {
    background.pollMs = saved;
  }

  expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
    "POST /v5/vms/vm-1/pause",
    ...Array(3).fill("GET /v5/background-requests/bg-1"),
  ]);
  // Polls carry the key; they never ask to be backgrounded themselves.
  expect(
    requests
      .slice(1)
      .every(
        (r) =>
          headerOf(r.init, "authorization") === "Bearer mock" &&
          headerOf(r.init, "x-freestyle-background-after-secs") === null,
      ),
  ).toBe(true);
});

test("a 202 with only the request ID header polls the background-requests route", async () => {
  const paths: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      paths.push(pathOf(url));

      if (paths.length === 1)
        return new Response(null, {
          status: 202,
          headers: { "x-freestyle-background-request-id": "bg/2" },
        });

      return Response.json({ snapshotId: "snap-1" });
    }),
  );
  const saved = background.pollMs;
  background.pollMs = 1;

  try {
    expect(
      await freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).snapshot?.("vm-1"),
    ).toEqual({ id: "snap-1" });
  } finally {
    background.pollMs = saved;
  }

  expect(paths).toEqual(["/v5/vms/vm-1/snapshot", "/v5/background-requests/bg%2F2"]);
});

test("a resultUrl on another origin is polled without the API key", async () => {
  const requests: { url: string; authorization: string | null }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, authorization: headerOf(init, "authorization") });

      if (requests.length === 1)
        return Response.json(
          { requestId: "bg-6", resultUrl: "https://results.elsewhere.test/bg-6" },
          { status: 202 },
        );

      return Response.json({ snapshotId: "snap-6" });
    }),
  );
  const saved = background.pollMs;
  background.pollMs = 1;

  try {
    expect(
      await freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).snapshot?.("vm-1"),
    ).toEqual({ id: "snap-6" });
  } finally {
    background.pollMs = saved;
  }

  expect(requests).toEqual([
    { url: "http://offline.invalid/v5/vms/vm-1/snapshot", authorization: "Bearer mock" },
    { url: "https://results.elsewhere.test/bg-6", authorization: null },
  ]);
});

test("a 202 without any request ID is a protocol error, not a silent success", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 202 })),
  );
  await expect(
    freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).pause?.("vm-1"),
  ).rejects.toMatchObject({
    code: "provider",
    cause: { providerCode: "BACKGROUND_PROTOCOL_ERROR", operation: "POST /v5/vms/:id/pause" },
  });
});

test("transient poll failures are retried; a stored error with the request ID is the result", async () => {
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (pathOf(url) === "/v5/vms/vm-1/start")
        return Response.json({ requestId: "bg-3" }, { status: 202 });
      polls++;

      if (polls === 1) throw new TypeError("fetch failed");

      if (polls === 2) return new Response("bad gateway", { status: 408 });

      return Response.json(
        { code: "VM_BROKEN", message: "private" },
        { status: 503, headers: { "x-freestyle-background-request-id": "bg-3" } },
      );
    }),
  );
  const saved = background.pollMs;
  background.pollMs = 1;

  try {
    await expect(
      freestyle({
        baseUrl: "http://offline.invalid",
        apiKey: "mock",
        requestTimeoutMs: 10_000,
      }).resume?.("vm-1"),
    ).rejects.toMatchObject({
      code: "unavailable",
      cause: {
        status: 503,
        providerCode: "VM_BROKEN",
        requestId: "bg-3",
        operation: "POST /v5/vms/:id/start",
      },
    });
  } finally {
    background.pollMs = saved;
  }

  // The network error and the bare 408 were retried by the poller. The stored 503 is a GET answer, so the client
  // reread it twice before the poller saw it as terminal; it never polled again after that.
  expect(polls).toBe(5);
});

test("polling gives up after five minutes of continuous failures", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let polls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (pathOf(url) === "/v5/vms/vm-1/pause")
        return Response.json({ requestId: "bg-4" }, { status: 202 });
      polls++;

      return new Response(null, { status: 408 });
    }),
  );

  const pending = freestyle({
    baseUrl: "http://offline.invalid",
    apiKey: "mock",
    requestTimeoutMs: 60 * 60_000,
  }).pause?.("vm-1");

  const settled = pending?.then(
    () => "resolved",
    (cause: unknown) => cause,
  );

  await vi.advanceTimersByTimeAsync(5 * 60_000 - 2_000);
  expect(polls).toBe(149);
  await vi.advanceTimersByTimeAsync(4_000);
  expect(await settled).toMatchObject({ code: "timeout", cause: { status: 408 } });
  expect(polls).toBe(151);
});

test("a GET whose background result was too large to store is fetched once directly", async () => {
  const calls: { path: string; backgrounded: boolean }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      const backgrounded = headerOf(init, "x-freestyle-background-after-secs") !== null;
      calls.push({ path, backgrounded });

      if (path === "/v5/vms" && backgrounded)
        return Response.json({ requestId: "bg-5" }, { status: 202 });

      if (path.startsWith("/v5/background-requests/"))
        return Response.json(
          { code: "BACKGROUND_RESULT_UNSTORABLE", message: "too large" },
          { status: 413, headers: { "x-freestyle-background-request-id": "bg-5" } },
        );

      return Response.json({ vms: [], totalCount: 0 });
    }),
  );
  const saved = background.pollMs;
  background.pollMs = 1;

  try {
    expect(await freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).list({})).toEqual(
      [],
    );
  } finally {
    background.pollMs = saved;
  }

  expect(calls).toEqual([
    { path: "/v5/vms", backgrounded: true },
    { path: "/v5/background-requests/bg-5", backgrounded: false },
    { path: "/v5/vms", backgrounded: false },
  ]);
});

test("file reads are never backgrounded and send a byte range", async () => {
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(new Uint8Array([1, 2, 3]), { status: 206 }),
  );

  vi.stubGlobal("fetch", fetch);
  expect([
    ...(await freestyle({ baseUrl: "http://offline.invalid", apiKey: "mock" }).files.readRange!(
      "vm-1",
      "/workspace/a",
      { offset: 10, length: 3 },
    )),
  ]).toEqual([1, 2, 3]);
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("http://offline.invalid/v5/vms/vm-1/fs/read?path=%2Fworkspace%2Fa");
  expect(headerOf(init, "range")).toBe("bytes=10-12");
  expect(headerOf(init, "x-freestyle-background-after-secs")).toBeNull();
});

test("writes over 8 MiB use an upload session, resume a chunk that landed, and commit", async () => {
  const size = 20 * 1024 * 1024;
  const bytes = new Uint8Array(size).fill(7);
  const calls: string[] = [];
  let received = 0;
  let failedOnce = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url);
      calls.push(
        `${init?.method} ${parsed.pathname}${parsed.searchParams.has("offset") ? `?offset=${parsed.searchParams.get("offset")}` : ""}`,
      );

      if (parsed.pathname === "/v5/vms/vm-1/fs/uploads") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          path: "/workspace/big",
          size,
          mode: 0o600,
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        });

        return Response.json({ uploadId: "up-1", path: "/workspace/big", size, receivedBytes: 0 });
      }

      if (parsed.pathname === "/v5/vms/vm-1/fs/uploads/up-1" && init?.method === "PUT") {
        const chunk = new Uint8Array(await new Response(init.body).arrayBuffer());
        expect(Number(parsed.searchParams.get("offset"))).toBe(received);
        received += chunk.byteLength;

        // The first chunk is stored, but its answer is lost.
        if (!failedOnce) {
          failedOnce = true;

          return new Response("lost", { status: 500 });
        }

        return Response.json({
          uploadId: "up-1",
          path: "/workspace/big",
          size,
          receivedBytes: received,
        });
      }

      if (parsed.pathname === "/v5/vms/vm-1/fs/uploads/up-1" && init?.method === "GET")
        return Response.json({
          uploadId: "up-1",
          path: "/workspace/big",
          size,
          receivedBytes: received,
        });

      if (parsed.pathname === "/v5/vms/vm-1/fs/uploads/up-1/commit")
        return new Response(null, { status: 204 });
      throw new Error(`Unexpected ${init?.method} ${parsed.pathname}`);
    }),
  );

  // files.write reaches this after the VM's first command; the client is the part under test.
  const client = freestyleClient({
    baseUrl: "http://offline.invalid",
    apiKey: () => "mock",
    requestTimeoutMs: 20_000,
  });

  await client.writeFile("vm-1", "/workspace/big", bytes, 0o600);
  expect(calls).toEqual([
    "POST /v5/vms/vm-1/fs/uploads",
    "PUT /v5/vms/vm-1/fs/uploads/up-1?offset=0",
    "GET /v5/vms/vm-1/fs/uploads/up-1",
    "PUT /v5/vms/vm-1/fs/uploads/up-1?offset=16777216",
    "POST /v5/vms/vm-1/fs/uploads/up-1/commit",
  ]);
  expect(received).toBe(size);
}, 20_000);

test("a failed upload session is deleted and the original error is reported", async () => {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = pathOf(url);
      calls.push(`${init?.method} ${path}`);

      if (path === "/v5/vms/vm-1/fs/uploads")
        return Response.json({
          uploadId: "up-2",
          path: "/workspace/big",
          size: 9 * 1024 * 1024,
          receivedBytes: 0,
        });

      if (init?.method === "DELETE") return new Response(null, { status: 204 });

      return Response.json({ code: "TOO_BIG", message: "private" }, { status: 413 });
    }),
  );

  const client = freestyleClient({
    baseUrl: "http://offline.invalid",
    apiKey: () => "mock",
    requestTimeoutMs: 5_000,
  });

  await expect(
    client.writeFile("vm-1", "/workspace/big", new Uint8Array(9 * 1024 * 1024)),
  ).rejects.toMatchObject({ status: 413, code: "TOO_BIG" });
  expect(calls).toEqual([
    "POST /v5/vms/vm-1/fs/uploads",
    "PUT /v5/vms/vm-1/fs/uploads/up-2",
    "DELETE /v5/vms/vm-1/fs/uploads/up-2",
  ]);
});
