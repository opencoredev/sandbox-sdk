import { afterEach, expect, test, vi } from "vitest";
import { freestyle } from "../src/providers/freestyle/index.js";
import { FreestyleApiError } from "freestyle";

afterEach(() => vi.unstubAllGlobals());

test("overall deadline stops the real SDK's HTTP 202 polling without another network request", async () => {
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
  const provider = freestyle({ apiKey: "mock", requestTimeoutMs: 20 });
  const start = Date.now();
  await expect(provider.list({})).rejects.toMatchObject({ code: "timeout" });
  expect(Date.now() - start).toBeLessThan(500);
  expect(requests).toBe(1);
  // 0.2.20 sleeps two seconds between background polls. Its next iteration
  // must see a terminal SDK error before fetching, not retry for five minutes.
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
  const p = freestyle({ apiKey: "mock", requestTimeoutMs: 20 });
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

test("caller abort interrupts a pending native create and its HTTP request", async () => {
  const c = new AbortController();
  let fetchSignal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchSignal?.addEventListener(
            "abort",
            () => reject(new FreestyleApiError(408, { code: "STOPPED", message: "stopped" })),
            { once: true },
          );
          c.abort();
        }),
    ),
  );
  await expect(
    freestyle({ apiKey: "mock", requestTimeoutMs: 1000 }).create({ labels: {}, signal: c.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(fetchSignal?.aborted).toBe(true);
});

test("an already-aborted operation makes no native request", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const c = new AbortController();
  c.abort();
  await expect(
    freestyle({ apiKey: "mock" }).create({ labels: {}, signal: c.signal }),
  ).rejects.toMatchObject({ code: "aborted" });
  expect(fetch).not.toHaveBeenCalled();
});

test("cold create validates allocation response and initializes with one private stdin exec", async () => {
  const requests: { method?: string; path: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method: init?.method, path, body });
    if (path === "/v5/vms" && init?.method === "POST") {
      if (!body || typeof body !== "object" || !("metadata" in body)) throw new Error("Missing metadata");
      return Response.json({
        id: "offline", state: "running", metadata: body.metadata,
        resources: { cpu: 4, memory: 8192, storage: 32768 }, vpcs: [], networks: [],
        createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
        idleTimeoutSeconds: -1, firewallRules: [], tlsRules: [],
      });
    }
    if (path === "/v5/vms/offline/exec-await") return Response.json({ statusCode: 0, stdout: "", stderr: "" });
    throw new Error("Unexpected cold setup request");
  }));
  const result = await freestyle({ apiKey: "mock" }).create({ labels: { test: "cold" }, network: "none", env: { TOKEN: "private-test-value" } });
  expect(result).toMatchObject({ id: "offline", labels: { test: "cold" }, state: "running" });
  expect(requests.map(r => `${r.method} ${r.path}`)).toEqual(["POST /v5/vms", "POST /v5/vms/offline/exec-await"]);
  expect(requests[0]?.body).toMatchObject({ snapshotId: "freestyle/ubuntu", firewall: { rules: [] }, tls: { rules: [] }, vpcs: [] });
  const setup = requests[1]?.body;
  if (!setup || typeof setup !== "object" || !("command" in setup) || !("stdin" in setup) || typeof setup.stdin !== "string") throw new Error("Missing setup exec");
  expect(String(setup.command)).not.toContain("private-test-value");
  expect(String(setup.command)).not.toMatch(/apt(-get)? |pip install|npm install/);
  expect(Buffer.from(setup.stdin, "base64").toString()).toContain("private-test-value");
});

test("HTTP failures retain status, code, request ID and operation through public redaction", async () => {
  const { createSandbox } = await import("../src/index.js");
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    code: "PAYLOAD_TOO_LARGE", message: "secret-response-body", authorization: "Bearer secret-key",
  }, { status: 413, headers: { "x-request-id": "req-123", "set-cookie": "secret-cookie" } })));
  const p = freestyle({ apiKey: "secret-key" });
  await expect(p.files.read("private-vm", "/private/secret-file")).rejects.toMatchObject({
    code: "provider", cause: { status: 413, providerCode: "PAYLOAD_TOO_LARGE", requestId: "req-123", operation: "GET /v5/vms/:id/fs/read" },
  });
  try {
    await createSandbox(p);
    throw new Error("Expected failure");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(JSON.parse(String(error.cause))).toEqual({ status: 413, providerCode: "PAYLOAD_TOO_LARGE", requestId: "req-123", operation: "POST /v5/vms" });
    expect(String(error) + JSON.stringify(error.cause)).not.toMatch(/secret-response-body|secret-key|secret-cookie|secret-file|private-vm/);
  }
});

test("concurrent failures keep their own request IDs and reject unsafe header values", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    const first = path.includes("first");
    if (first) await new Promise(resolve => setTimeout(resolve, 20));
    return Response.json({ code: first ? "FIRST_ERROR" : "SECOND_ERROR", message: "private" }, {
      status: first ? 404 : 413, headers: { "x-request-id": first ? "req-first" : "Bearer unsafe-token" },
    });
  }));
  const provider = freestyle({ apiKey: "mock" });
  const results = await Promise.allSettled([provider.files.read("first", "/one"), provider.files.read("second", "/two")]);
  const errors = results.map(r => { if (r.status !== "rejected") throw new Error("Expected failure"); return r.reason; });
  expect(errors[0]).toMatchObject({ cause: { requestId: "req-first", providerCode: "FIRST_ERROR" } });
  expect(errors[1]).toMatchObject({ cause: { providerCode: "SECOND_ERROR" } });
  expect(errors[1].cause.requestId).toBeUndefined();
});

test("configured credentials are excluded even from otherwise valid diagnostic identifiers", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "PRIVATE_TOKEN", message: "private body" }, {
    status: 413, headers: { "x-request-id": "req-PRIVATE_TOKEN" },
  })));
  try {
    await freestyle({ apiKey: "PRIVATE_TOKEN" }).files.read("offline", "/file");
    throw new Error("Expected failure");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toMatchObject({ status: 413, operation: "GET /v5/vms/:id/fs/read" });
    expect(String(error.cause)).not.toContain("PRIVATE_TOKEN");
  }
});

test("background failures retain the original operation and accepted request ID", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async () => ++requests === 1
    ? Response.json({ resultUrl: "/v5/background-requests/bg-123" }, { status: 202, headers: { "x-freestyle-background-request-id": "bg-123" } })
    : Response.json({ code: "BACKGROUND_RESULT_UNSTORABLE", message: "private body" }, { status: 413 })));
  await expect(freestyle({ apiKey: "mock", requestTimeoutMs: 5000 }).pause?.("offline")).rejects.toMatchObject({
    cause: { status: 413, providerCode: "BACKGROUND_RESULT_UNSTORABLE", requestId: "bg-123", operation: "POST /v5/vms/:id/pause" },
  });
  expect(requests).toBe(2);
});

test.each(["vpc", "tls", "firewall", "limits", "setup"])("unconfirmed %s in allocation response fails closed and deletes the VM", async kind => {
  const requests: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    requests.push(`${init?.method} ${path}`);
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/exec-await")) return Response.json({ statusCode: 1, stdout: "", stderr: "private" });
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (!body || typeof body !== "object" || !("metadata" in body)) throw new Error("Missing create metadata");
    return Response.json({
      id: "offline", state: "running", metadata: body.metadata,
      resources: { cpu: 4, memory: 8192, storage: 32768 }, networks: [],
      vpcs: kind === "vpc" ? ["unexpected"] : [],
      createdAt: "2026-10-21T00:00:00Z", updatedAt: "2026-10-21T00:00:00Z",
      ttlSeconds: kind === "limits" ? 999 : 180,
      firewallRules: kind === "firewall" ? [{ action: "allow", source: { vmId: "offline" }, destination: { public: true } }] : [],
      tlsRules: kind === "tls" ? [{ source: { vmId: "offline" } }] : [],
    });
  }));
  await expect(freestyle({ apiKey: "mock" }).create({ labels: {}, network: "none", timeoutMs: 180000 })).rejects.toMatchObject({ code: kind === "setup" ? "provider" : "unsupported" });
  expect(requests.at(-1)).toBe("DELETE /v5/vms/offline");
  expect(requests.filter(r => r.startsWith("GET"))).toEqual([]);
});

test("a later setup failure never inherits the allocation's background request ID", async () => {
  let metadata: unknown;
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(url instanceof Request ? url.url : url).pathname;
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (path.endsWith("/exec-await")) return Response.json({ code: "SETUP_FAILED", message: "private" }, { status: 413 });
    if (path === "/v5/vms") {
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (!body || typeof body !== "object" || !("metadata" in body)) throw new Error("Missing metadata");
      metadata = body.metadata;
      return Response.json({ resultUrl: "/v5/background-requests/allocation" }, { status: 202, headers: { "x-freestyle-background-request-id": "allocation" } });
    }
    return Response.json({ id: "offline", state: "running", metadata, vpcs: [], firewallRules: [], tlsRules: [] });
  }));
  try {
    await freestyle({ apiKey: "mock", requestTimeoutMs: 5000 }).create({ labels: {}, network: "none" });
    throw new Error("Expected failure");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.cause).toMatchObject({ status: 413, providerCode: "SETUP_FAILED", operation: "POST /v5/vms/:id/exec-await" });
    expect(String(error.cause)).not.toContain("allocation");
  }
});
