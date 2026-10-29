import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { createSandbox, SandboxError, type NativeApi, type ProviderSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import { createHttpClient, createNativeApi, sdkCall, sdkConstruct, type HttpClient, type NativeSdkBinding, type Provider } from "../src/provider.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

// The worked example of the structural-constraint pattern a converted provider follows for `sdk(load)`.
// The provider never imports its SDK's types. It states the module shape it needs, and the result type
// is read off the caller's own module, so `box.native.sdk(() => import("@acme/sdk"))` is fully typed
// when @acme/sdk is installed, and nothing in this package's declarations mentions @acme/sdk.
interface AcmeConfig { apiKey?: string; apiUrl?: string }
/** What the adapter needs from the module: a client class whose `get(id)` resolves to the SDK's sandbox. */
type AcmeModule = { Acme: new (config: AcmeConfig) => { get(id: string): Promise<unknown> } };
/** `box.native.sdk`: the module's own sandbox type comes back. */
type AcmeSandboxSdk = <M extends AcmeModule>(load: () => Promise<M>) => Promise<Awaited<ReturnType<InstanceType<M["Acme"]>["get"]>>>;
/** `provider.api.sdk`: the module's client instance comes back. */
type AcmeClientSdk = <M extends AcmeModule>(load: () => Promise<M>) => Promise<InstanceType<M["Acme"]>>;
type AcmePlane = "api" | "toolbox";
type AcmeNative = NativeApi<AcmePlane, AcmeSandboxSdk>;

// A stand-in for the official SDK, as a user would import it.
class AcmeSandbox { constructor(readonly id: string, readonly apiKey: string | undefined) {} async exec(command: string) { return `ran ${command}`; } }
class Acme { constructor(readonly config: AcmeConfig) {} async get(id: string) { return new AcmeSandbox(id, this.config.apiKey); } }
const acmeModule = { Acme, version: "1.2.3" };

let server: FakeServer;
let toolbox: FakeServer;
beforeEach(async () => { server = await fakeServer(); toolbox = await fakeServer(); });
afterEach(async () => { await server.close(); await toolbox.close(); });

function acme() {
  const http = createHttpClient<AcmePlane>({
    provider: "acme", label: "Acme", defaultPlane: "api", backoffMs: 1, timeoutMs: 2_000, secrets: () => ["acme-key-123456"],
    planes: {
      api: { baseUrl: `${server.url}/api`, auth: () => ({ authorization: "Bearer acme-key-123456" }) },
      toolbox: { baseUrl: ({ sandboxId }) => { if (!sandboxId) throw new SandboxError("The toolbox plane needs a sandbox. Use box.native.", { code: "invalid_argument", provider: "acme" }); return `${toolbox.url}/proxy/${sandboxId}`; }, auth: () => ({ authorization: "Bearer acme-key-123456" }) },
    },
  });
  const sdk: NativeSdkBinding = {
    package: "@acme/sdk",
    async connect(module, sandboxId) {
      const client = sdkConstruct(module, "Acme", [{ apiKey: "acme-key-123456", apiUrl: `${server.url}/api` }], "@acme/sdk");
      return sandboxId === undefined ? client : await sdkCall(client, "get", [sandboxId], "@acme/sdk");
    },
  };
  return {
    native: (id: string) => createNativeApi<AcmePlane, AcmeSandboxSdk>({ http, placeholder: "sandboxId", sandboxId: id, sdk }),
    /** The same binding without the module constraint, to hand it wrong modules at runtime as JavaScript callers can. */
    loose: (id: string) => createNativeApi<AcmePlane>({ http, placeholder: "sandboxId", sandboxId: id, sdk }),
    api: createNativeApi<AcmePlane, AcmeClientSdk>({ http, placeholder: "sandboxId", sdk }),
  };
}
async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try { await promise; } catch (error) { expect(error).toBeInstanceOf(SandboxError); return error as SandboxError; }
  throw new Error("expected a rejection");
}

describe("request and fetch", () => {
  test("box.native fills {sandboxId}; provider.api does not and fails before any request", async () => {
    server.on("GET /api/sandbox/{id}", { json: { id: "sb-1", state: "started" } });
    const { native, api } = acme();
    const box = native("sb-1");
    expect(box.sandboxId).toBe("sb-1");
    expect(await box.request<{ state: string }>("GET", "/sandbox/{sandboxId}")).toEqual({ id: "sb-1", state: "started" });
    expect(server.requests[0]?.url).toBe("/api/sandbox/sb-1");
    expect(api.sandboxId).toBeUndefined();
    const error = await failure(api.request("GET", "/sandbox/{sandboxId}"));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toContain("params.sandboxId");
    expect(server.requests).toHaveLength(1);
    expect(await api.request("GET", "/sandbox/{sandboxId}", { params: { sandboxId: "sb-1" } })).toMatchObject({ id: "sb-1" });
  });

  test("explicit params win over the bound sandbox; other placeholders must be given", async () => {
    server.on("GET /api/sandbox/{id}/ports/{port}", { json: {} });
    const box = acme().native("sb-1");
    await box.request("GET", "/sandbox/{sandboxId}/ports/{port}", { params: { sandboxId: "sb-2", port: 3000 } });
    expect(server.requests[0]?.url).toBe("/api/sandbox/sb-2/ports/3000");
    expect((await failure(box.request("GET", "/sandbox/{sandboxId}/ports/{port}"))).code).toBe("invalid_argument");
    expect(server.requests).toHaveLength(1);
  });

  test("planes route to their own base URL and credentials", async () => {
    toolbox.on("GET /proxy/{id}/files", { json: [{ name: "a.txt" }] });
    const box = acme().native("sb-9");
    expect(await box.request("GET", "/files", { plane: "toolbox", query: { path: "/workspace" } })).toEqual([{ name: "a.txt" }]);
    expect(toolbox.requests[0]?.url).toBe("/proxy/sb-9/files?path=%2Fworkspace");
    expect(toolbox.requests[0]?.headers.authorization).toBe("Bearer acme-key-123456");
    expect((await failure(acme().api.request("GET", "/files", { plane: "toolbox" }))).code).toBe("invalid_argument");
    // @ts-expect-error not one of Acme's planes; JavaScript callers get invalid_argument
    expect((await failure(box.request("GET", "/files", { plane: "data" }))).code).toBe("invalid_argument");
  });

  test("an unknown endpoint is a SandboxError that keeps the provider's scrubbed message", async () => {
    const box = acme().native("sb-1");
    const error = await failure(box.request("POST", "/no/such/endpoint", { body: { a: 1 } }));
    expect(error).toMatchObject({ code: "not_found", provider: "acme", sandboxId: "sb-1" });
    expect(error.message).toContain("no_route");
    expect(error.message).toContain("fake server has no route");
    expect(error.message).not.toContain("acme-key-123456");
  });

  test("fetch returns the raw Response for bytes and streams; non-2xx still rejects", async () => {
    server.on("GET /api/logs", { stream: ["line 1\n", "line 2\n"] }).on("GET /api/missing", { status: 404, json: { code: "gone" } });
    const box = acme().native("sb-1");
    const response = await box.fetch("GET", "/logs");
    expect(response).toBeInstanceOf(Response);
    expect(await response.text()).toBe("line 1\nline 2\n");
    expect((await failure(box.fetch("GET", "/missing"))).code).toBe("not_found");
  });

  test("request sends bytes as is and returns undefined for 204", async () => {
    server.on("PUT /api/files", { status: 204 });
    expect(await acme().native("sb-1").request("PUT", "/files", { body: new Uint8Array([1, 2, 3]) })).toBeUndefined();
    expect([...server.requests[0]!.body]).toEqual([1, 2, 3]);
  });

  test("a bad method from JavaScript is invalid_argument", async () => {
    // @ts-expect-error not an HttpMethod
    expect((await failure(acme().native("sb-1").request("TRACE", "/x"))).code).toBe("invalid_argument");
  });
});

describe("sdk(load)", () => {
  test("box.native.sdk returns the SDK's sandbox, typed from the caller's module", async () => {
    const sandbox = await acme().native("sb-1").sdk(async () => acmeModule);
    expectTypeOf(sandbox).toEqualTypeOf<AcmeSandbox>();
    expect(sandbox).toBeInstanceOf(AcmeSandbox);
    expect(sandbox.id).toBe("sb-1");
    expect(await sandbox.exec("ls")).toBe("ran ls");
  });

  test("provider.api.sdk returns the SDK's client", async () => {
    const client = await acme().api.sdk(async () => acmeModule);
    expectTypeOf(client).toEqualTypeOf<Acme>();
    expect(client.config.apiKey).toBe("acme-key-123456");
  });

  test("a CommonJS namespace with only default works", async () => {
    const sandbox = await acme().native("sb-1").sdk(async () => ({ default: acmeModule, Acme }));
    expect(sandbox.id).toBe("sb-1");
  });

  test("a module without the expected export is invalid_argument naming the package", async () => {
    const error = await failure(acme().loose("sb-1").sdk(async () => ({ Other: Acme })));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).toContain('import("@acme/sdk")');
  });

  test("a missing install is unavailable with the install command", async () => {
    const error = await failure(acme().loose("sb-1").sdk(() => Promise.reject(Object.assign(new Error("Cannot find package '@acme/sdk'"), { code: "ERR_MODULE_NOT_FOUND" }))));
    expect(error).toMatchObject({ code: "unavailable", hint: "npm i @acme/sdk" });
  });

  test("an SDK failure is a provider SandboxError with a redacted detail", async () => {
    class Broken extends Acme { override async get(): Promise<AcmeSandbox> { throw new Error("401 for key acme-key-123456"); } }
    const error = await failure(acme().native("sb-1").sdk(async () => ({ Acme: Broken })));
    expect(error.code).toBe("provider");
    expect(error.message).not.toContain("acme-key-123456");
  });

  test("a provider without a binding rejects with unsupported", async () => {
    const http = createHttpClient({ provider: "plain", label: "Plain", planes: { api: { baseUrl: server.url } }, defaultPlane: "api" });
    expect((await failure(createNativeApi({ http, placeholder: "id", sandboxId: "x" }).sdk(async () => acmeModule))).code).toBe("unsupported");
  });
});

describe("types", () => {
  test("a provider whose native is a NativeApi types box.native through createSandbox", async () => {
    const { native } = acme();
    const provider: Provider<AcmeNative> = { ...memory(), name: "acme", native };
    const box = await createSandbox(provider);
    expectTypeOf(box.native).toEqualTypeOf<AcmeNative>();
    expectTypeOf<ProviderSandbox<typeof provider>["native"]>().toEqualTypeOf<AcmeNative>();
    expectTypeOf(box.native.request<{ id: string }>).returns.toEqualTypeOf<Promise<{ id: string }>>();
    expect(box.native.sandboxId).toBe(box.id);
    await box.destroy();
  });

  test("the provider factory carries api on its own return type", () => {
    type Factory = () => Omit<Provider<AcmeNative>, "native"> & { native(id: string): AcmeNative; readonly api: NativeApi<AcmePlane, AcmeClientSdk> };
    expectTypeOf<ReturnType<Factory>["api"]["sdk"]>().toEqualTypeOf<AcmeClientSdk>();
  });

  test("createHttpClient infers plane names from planes, not from defaultPlane", () => {
    const http = createHttpClient({ provider: "p", label: "P", defaultPlane: "api", planes: { api: { baseUrl: "https://a.test" }, toolbox: { baseUrl: "https://b.test" } } });
    expectTypeOf(http).toEqualTypeOf<HttpClient<"api" | "toolbox">>();
    // oxlint-disable-next-line no-constant-condition -- compile-time negative API checks never execute.
    if (false) {
      // @ts-expect-error the default plane must be one of the planes
      createHttpClient({ provider: "p", label: "P", defaultPlane: "nope", planes: { api: { baseUrl: "https://a.test" } } });
    }
  });

  test("misuse is a compile error", () => {
    const box: AcmeNative = acme().native("sb-1");
    // oxlint-disable-next-line no-constant-condition -- compile-time negative API checks never execute.
    if (false) {
      // @ts-expect-error the module lacks the Acme class
      void box.sdk(async () => ({ Other: Acme }));
      // @ts-expect-error Acme.get must return a promise
      void box.sdk(async () => ({ Acme: class { get() { return 1; } } }));
      // @ts-expect-error sdk takes a loader function, not the module
      void box.sdk(acmeModule);
      // @ts-expect-error not an HTTP method
      void box.request("CONNECT", "/x");
      // @ts-expect-error not a plane of this provider
      void box.fetch("GET", "/x", { plane: "data" });
      // @ts-expect-error unknown request option
      void box.request("GET", "/x", { retry: true });
      // @ts-expect-error params values are strings or numbers
      void box.request("GET", "/x/{a}", { params: { a: true } });
      // @ts-expect-error sandboxId is read-only
      box.sandboxId = "other";
    }
    expect(box.sandboxId).toBe("sb-1");
  });

  test("any provider's native API is a plain NativeApi, whose sdk() cannot be called without the provider's type", () => {
    const any: NativeApi = acme().native("sb-1");
    const accounts: NativeApi<string> = acme().api;
    expect(any.sandboxId).toBe("sb-1");
    expect(accounts.sandboxId).toBeUndefined();
    // oxlint-disable-next-line no-constant-condition -- compile-time negative API checks never execute.
    if (false) {
      // @ts-expect-error a plain NativeApi does not know which module its provider needs
      void any.sdk(async () => acmeModule);
    }
  });

  test("an adapter without an SDK description accepts any module and returns unknown", async () => {
    const http = createHttpClient({ provider: "plain", label: "Plain", planes: { api: { baseUrl: server.url } }, defaultPlane: "api" });
    const plain = createNativeApi({ http, placeholder: "id", sdk: { package: "plain", connect: module => module } });
    const result = await plain.sdk(async () => ({ anything: 1 }));
    expectTypeOf(result).toEqualTypeOf<unknown>();
    expect(result).toEqual({ anything: 1 });
  });
});
