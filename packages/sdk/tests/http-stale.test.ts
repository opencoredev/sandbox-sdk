// The HTTP core's hooks for providers whose data plane can go stale in more ways than a 401 (Superserve, SBX-74).
import { afterEach, beforeEach, expect, test } from "vitest";
import { createHttpClient, httpStatus } from "../src/http.js";
import { SandboxError } from "../src/errors.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

let server: FakeServer;
beforeEach(async () => { server = await fakeServer(); });
afterEach(async () => { await server.close(); });

function client(options: { stale?: (status: number, code: string | undefined, credentials: Readonly<Record<string, string>>) => boolean; refresh?: () => Promise<void> } = {}) {
  let token = "old-token-123456";
  let refreshes = 0;
  const http = createHttpClient({
    provider: "acme", label: "Acme", defaultPlane: "data", backoffMs: 1, timeoutMs: 2_000,
    planes: {
      data: {
        baseUrl: server.url,
        auth: () => ({ "x-access-token": token }),
        refresh: options.refresh ?? (async () => { refreshes++; token = "new-token-654321"; }),
        ...(options.stale ? { stale: ({ status, body, credentials }) => options.stale!(status, body.code, credentials) } : {}),
      },
    },
  });
  return { http, refreshes: () => refreshes };
}

test("a stale hook turns a non-401 failure into one refresh and a resend, reusing the body it read", async () => {
  server.on("GET /files", { status: 404, json: { error: { code: "route_stale" } } }, { json: { ok: true } });
  const seen: unknown[] = [];
  const { http, refreshes } = client({ stale: (status, code, credentials) => { seen.push([status, code, credentials["x-access-token"]]); return code === "route_stale"; } });
  expect(await http.json({ method: "GET", path: "/files" })).toEqual({ ok: true });
  expect(refreshes()).toBe(1);
  expect(seen).toEqual([[404, "route_stale", "old-token-123456"]]);
  expect(server.requests.map(r => r.headers["x-access-token"])).toEqual(["old-token-123456", "new-token-654321"]);
});

test("a stale hook that says no keeps the shared mapping and the parsed body", async () => {
  server.on("GET /files", { status: 404, json: { error: { code: "file_missing", message: "nope" } } });
  const { http, refreshes } = client({ stale: () => false });
  const error = await http.json({ method: "GET", path: "/files" }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SandboxError);
  expect(error).toMatchObject({ code: "not_found" });
  expect(httpStatus(error)).toEqual({ status: 404, code: "file_missing" });
  expect(refreshes()).toBe(0);
});

test("without a stale hook a 503 is retried, not refreshed", async () => {
  server.on("GET /files", { status: 503, json: {} }, { json: { ok: 1 } });
  const { http, refreshes } = client();
  expect(await http.json({ method: "GET", path: "/files" })).toEqual({ ok: 1 });
  expect(refreshes()).toBe(0);
  expect(httpStatus(new Error("x"))).toBeUndefined();
});

test("a waiter whose signal fires stops waiting on a shared refresh; the others still get it", async () => {
  server.on("GET /files", { status: 401, json: {} }, { status: 401, json: {} }, { json: { ok: 1 } });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  let token = "old-token-123456";
  const http = createHttpClient({
    provider: "acme", label: "Acme", defaultPlane: "data", timeoutMs: 2_000,
    planes: { data: { baseUrl: server.url, auth: () => ({ "x-access-token": token }), refresh: async () => { await held; token = "new-token-654321"; } } },
  });
  const controller = new AbortController();
  const aborted = http.json({ method: "GET", path: "/files", signal: controller.signal });
  const kept = http.json({ method: "GET", path: "/files" });
  while (server.requests.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
  controller.abort();
  await expect(aborted).rejects.toMatchObject({ code: "aborted" });
  release();
  expect(await kept).toEqual({ ok: 1 });
});
