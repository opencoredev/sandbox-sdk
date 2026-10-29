import { afterEach, beforeEach, expect, expectTypeOf, test, vi } from "vitest";
import type { Freestyle, Vm } from "freestyle";
import { SandboxError, type NativeApi } from "../src/index.js";
import { freestyle, type FreestyleNative } from "../src/providers/freestyle/index.js";

const base = "http://freestyle.test";
const requests: { method: string; url: string; headers: Headers }[] = [];
const record = (id: string) => ({
  id, state: "running", createdAt: "2026-10-21T00:00:00Z", vpcs: [],
  metadata: { "sandbox-sdk": "1", "sandbox-sdk-info": "1", "sandbox-sdk-info-0": Buffer.from(JSON.stringify({ key: null, labels: {} })).toString("base64url") },
});
beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    requests.push({ method: init?.method ?? "GET", url: url.href, headers });
    if (url.origin !== base) return new Response("elsewhere");
    if (url.pathname === "/v5/vms/vm-1" || url.pathname === "/v5/vms/vm%2F2") return Response.json(record(decodeURIComponent(url.pathname.slice("/v5/vms/".length))));
    if (url.pathname === "/v5/vms/vm-1/fs/read") return url.searchParams.get("path") === "/missing"
      ? Response.json({ code: "NOT_FOUND", message: "not found: /missing: No such file or directory (os error 2)" }, { status: 404 })
      : new Response(new Uint8Array([104, 105]));
    if (url.pathname === "/v5/snapshots") return Response.json({ snapshots: [], totalCount: 0 });
    if (url.pathname === "/v5/vms/vm-1/exec-await") return Response.json({ statusCode: 0, stdout: "sdk\n", stderr: "" });
    return Response.json({ code: "NO_ROUTE", message: "no such route" }, { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

async function connected(): Promise<{ provider: ReturnType<typeof freestyle>; native: FreestyleNative }> {
  const provider = freestyle({ baseUrl: base, apiKey: "fs-key-123456" });
  await provider.connect("vm-1");
  return { provider, native: provider.native("vm-1") };
}
async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(SandboxError); return error as SandboxError; }
  throw new Error("expected a rejection");
}

test("box.native fills {vmId}, sends the key and returns JSON", async () => {
  const { native } = await connected();
  expect(native.sandboxId).toBe("vm-1");
  expect(await native.request<{ id: string }>("GET", "/v5/vms/{vmId}")).toMatchObject({ id: "vm-1" });
  expect(requests.at(-1)).toMatchObject({ method: "GET", url: `${base}/v5/vms/vm-1` });
  expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer fs-key-123456");
  // Native calls are not backgrounded unless the caller asks.
  expect(requests.at(-1)?.headers.get("x-freestyle-background-after-secs")).toBeNull();
  expectTypeOf(native).toMatchTypeOf<NativeApi>();
});

test("box.native needs a connected VM and is stable per VM", async () => {
  const provider = freestyle({ baseUrl: base, apiKey: "fs-key-123456" });
  expect(() => provider.native("vm-1")).toThrowError(expect.objectContaining({ code: "not_found" }));
  await provider.connect("vm-1");
  expect(provider.native("vm-1")).toBe(provider.native("vm-1"));
});

test("provider.api has no VM bound: placeholders need params, which are URI-encoded", async () => {
  const provider = freestyle({ baseUrl: base, apiKey: "fs-key-123456" });
  expect(provider.api.sandboxId).toBeUndefined();
  expect((await failure(provider.api.request("GET", "/v5/vms/{vmId}"))).code).toBe("invalid_argument");
  expect(requests).toHaveLength(0);
  expect(await provider.api.request("GET", "/v5/vms/{vmId}", { params: { vmId: "vm/2" } })).toMatchObject({ id: "vm/2" });
  expect(requests.at(-1)?.url).toBe(`${base}/v5/vms/vm%2F2`);
  expect(await provider.api.request("GET", "/v5/snapshots", { query: { limit: 5 } })).toEqual({ snapshots: [], totalCount: 0 });
  expect(requests.at(-1)?.url).toBe(`${base}/v5/snapshots?limit=5`);
});

test("fetch returns the raw Response for bytes; errors map like adapter calls and keep the scrubbed message", async () => {
  const { native } = await connected();
  const response = await native.fetch("GET", "/v5/vms/{vmId}/fs/read", { query: { path: "/workspace/a" } });
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("hi");
  const missing = await failure(native.fetch("GET", "/v5/vms/{vmId}/fs/read", { query: { path: "/missing" } }));
  expect(missing).toMatchObject({ code: "file_not_found", provider: "freestyle", sandboxId: "vm-1" });
  const unknown = await failure(native.request("POST", "/v5/nope", { body: {} }));
  expect(unknown.code).toBe("not_found");
  expect(unknown.message).toContain("NO_ROUTE");
  expect(`${unknown.message} ${String(unknown.cause)}`).not.toContain("fs-key-123456");
});

test("a provider message that echoes the API key keeps the message but not the key", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ code: "BAD_KEY", message: "key fs-key-123456 is revoked" }, { status: 403 })));
  const provider = freestyle({ baseUrl: base, apiKey: "fs-key-123456" });
  const error = await failure(provider.api.request("GET", "/v5/vms"));
  expect(error.code).toBe("auth");
  expect(error.message).toContain("is revoked");
  expect(`${error.message} ${String(error.cause)}`).not.toContain("fs-key-123456");
});

test("unknown planes are invalid_argument and other origins get no credentials", async () => {
  const { native } = await connected();
  // @ts-expect-error Freestyle has one plane
  expect((await failure(native.request("GET", "/v5/vms/{vmId}", { plane: "toolbox" }))).code).toBe("invalid_argument");
  await (await native.fetch("GET", "https://elsewhere.test/hook")).text();
  expect(requests.at(-1)?.url).toBe("https://elsewhere.test/hook");
  expect(requests.at(-1)?.headers.get("authorization")).toBeNull();
});

test("box.native.sdk connects the official SDK's Vm to the same VM, key and base URL", async () => {
  const { native } = await connected();
  const vm = await native.sdk(() => import("freestyle"));
  expectTypeOf(vm).toEqualTypeOf<Vm>();
  expect(vm.id).toBe("vm-1");
  expect((await vm.exec({ command: "echo sdk" })).stdout).toBe("sdk\n");
  expect(requests.at(-1)).toMatchObject({ method: "POST", url: `${base}/v5/vms/vm-1/exec-await` });
  expect(requests.at(-1)?.headers.get("authorization")).toBe("Bearer fs-key-123456");
});

test("provider.api.sdk returns the official client", async () => {
  const client = await freestyle({ baseUrl: base, apiKey: "fs-key-123456" }).api.sdk(() => import("freestyle"));
  expectTypeOf(client).toEqualTypeOf<Freestyle>();
  expect((await client.vms.get("vm-1")).id).toBe("vm-1");
});

test("sdk(load) rejects a module without Freestyle, and a failed import, with the package name", async () => {
  const { native } = await connected();
  // @ts-expect-error not the freestyle module
  const wrong = await failure(native.sdk(async () => ({ Other: class {} })));
  expect(wrong.code).toBe("invalid_argument");
  expect(wrong.message).toContain('import("freestyle")');
  const missing = await failure(native.sdk(() => Promise.reject(Object.assign(new Error("Cannot find package 'freestyle'"), { code: "ERR_MODULE_NOT_FOUND" }))));
  expect(missing).toMatchObject({ code: "unavailable", hint: "npm i freestyle" });
});
