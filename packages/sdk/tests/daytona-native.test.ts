import { afterEach, describe, expect, expectTypeOf, test, vi } from "vitest";
import { createSandbox, SandboxError, type NativeApi } from "../src/index.js";
import { daytona, type DaytonaNative, type DaytonaPlane } from "../src/providers/daytona/index.js";
import { apiUrl, cleanupMock, guest, requests } from "./daytona-mock.js";
import { fakeServer } from "./http-fake.js";

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupMock();
});

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);

    return error as SandboxError;
  }

  throw new Error("expected a rejection");
}

// A stand-in for @daytonaio/sdk with the shape native.sdk() needs.
class FakeSandbox {
  constructor(
    readonly id: string,
    readonly config: object,
  ) {}
}

class FakeDaytona {
  constructor(readonly config: { apiKey?: string; apiUrl?: string; target?: string }) {}
  async get(id: string) {
    return new FakeSandbox(id, this.config);
  }
}

const fakeModule = { Daytona: FakeDaytona, version: "0.0.0-test" };

describe("box.native", () => {
  test("request on the control plane fills {sandboxId}; the toolbox plane is scoped to the sandbox", async () => {
    const box = await createSandbox(daytona({ apiKey: "native-key" }));
    expectTypeOf(box.native).toEqualTypeOf<DaytonaNative>();
    expect(box.native.sandboxId).toBe(box.id);
    expect(
      await box.native.request<{ id: string; state: string }>("GET", "/sandbox/{sandboxId}"),
    ).toMatchObject({ id: box.id, state: "started" });
    await box.files.write("listed.txt", "x");

    const files = await box.native.request<{ name: string }[]>("GET", "/files", {
      plane: "toolbox",
      query: { path: "/workspace" },
    });

    expect(files.map((file) => file.name)).toContain("listed.txt");
    expect(requests.at(-1)?.url).toBe(`/toolbox/${box.id}/files?path=%2Fworkspace`);
    expect(requests.at(-1)?.headers.authorization).toBe("Bearer native-key");
    // @ts-expect-error not one of Daytona's planes; JavaScript callers get invalid_argument
    expect((await failure(box.native.request("GET", "/files", { plane: "data" }))).code).toBe(
      "invalid_argument",
    );
  });

  test("fetch returns the raw Response: Daytona's multipart download, unparsed", async () => {
    const box = await createSandbox(daytona({ apiKey: "native-key" }));
    await box.files.write("raw.txt", "raw bytes");

    const response = await box.native.fetch("POST", "/files/bulk-download", {
      plane: "toolbox",
      body: { paths: ["/workspace/raw.txt"] },
    });

    expect(response.headers.get("content-type")).toContain("multipart/form-data");
    expect(await response.text()).toContain("raw bytes");
  });

  test("other placeholders must be in params, before any request is sent", async () => {
    const box = await createSandbox(daytona({ apiKey: "native-key" }));
    const before = requests.length;

    const error = await failure(
      box.native.request("GET", "/sandbox/{sandboxId}/ports/{port}/preview-url"),
    );

    expect(error.code).toBe("invalid_argument");
    expect(requests).toHaveLength(before);
    expect(
      await box.native.request("GET", "/sandbox/{sandboxId}/ports/{port}/preview-url", {
        params: { port: 3000 },
      }),
    ).toMatchObject({ token: "mock-preview-token" });
  });

  test("an unknown endpoint is a SandboxError with the provider's scrubbed message", async () => {
    const box = await createSandbox(daytona({ apiKey: "native-key" }));

    const error = await failure(
      box.native.request("POST", "/no/such/endpoint", { body: { a: 1 } }),
    );

    expect(error).toMatchObject({ code: "not_found", provider: "daytona", sandboxId: box.id });
    expect(error.message).toContain("fake server has no route");
    expect(error.message).not.toContain("native-key");
  });

  test("credentials go only to Daytona's own origins, never to an absolute URL elsewhere", async () => {
    const elsewhere = await fakeServer();

    try {
      elsewhere.on("GET /probe", { json: { ok: true } });
      const box = await createSandbox(daytona({ apiKey: "native-key" }));
      expect(await box.native.request("GET", `${elsewhere.url}/probe`)).toEqual({ ok: true });
      expect(elsewhere.requests[0]?.headers.authorization).toBeUndefined();
    } finally {
      await elsewhere.close();
    }
  });

  test("sdk(load) connects the module you pass, with the adapter's credentials, URL and target", async () => {
    const box = await createSandbox(daytona({ apiKey: "native-key", target: "eu" }));
    const sandbox = await box.native.sdk(() => Promise.resolve(fakeModule));
    expectTypeOf(sandbox).toEqualTypeOf<FakeSandbox>();
    expect(sandbox).toBeInstanceOf(FakeSandbox);
    expect(sandbox).toMatchObject({
      id: box.id,
      config: { apiKey: "native-key", apiUrl, target: "eu" },
    });
  });

  test("sdk(load) rejects a module without Daytona, and a missing package with the install hint", async () => {
    const box = await createSandbox(daytona({ apiKey: "native-key" }));
    // @ts-expect-error not the @daytonaio/sdk shape; JavaScript callers get invalid_argument
    expect((await failure(box.native.sdk(() => Promise.resolve({ Other: class {} })))).code).toBe(
      "invalid_argument",
    );

    const missing = Object.assign(new Error("Cannot find package '@daytonaio/sdk'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    expect(await failure(box.native.sdk(() => Promise.reject(missing)))).toMatchObject({
      code: "unavailable",
      hint: "npm i @daytonaio/sdk",
    });
  });

  test("a destroyed sandbox has no native API", async () => {
    const provider = daytona({ apiKey: "native-key" });
    const box = await createSandbox(provider);
    await box.destroy();
    expect(() => provider.native(box.id)).toThrow(SandboxError);
  });

  test("the official SDK's module type fits sdk(load), and the result is its Sandbox", () => {
    // Compile-time only: the import below is never evaluated.
    const typed = async (native: DaytonaNative) => {
      const sandbox = await native.sdk(() => import("@daytonaio/sdk"));
      expectTypeOf(sandbox).toEqualTypeOf<import("@daytonaio/sdk").Sandbox>();
      const client = await daytona().api.sdk(() => import("@daytonaio/sdk"));
      expectTypeOf(client).toEqualTypeOf<import("@daytonaio/sdk").Daytona>();
    };

    expect(typed).toBeTypeOf("function");
    // Any provider's native API fits the plain NativeApi.
    expectTypeOf<DaytonaNative>().toMatchTypeOf<NativeApi>();
    expectTypeOf<DaytonaPlane>().toEqualTypeOf<"api" | "toolbox">();
  });
});

describe("provider.api", () => {
  test("account-level requests need explicit sandbox params, and the toolbox plane needs a sandbox", async () => {
    const provider = daytona({ apiKey: "native-key" });
    const box = await createSandbox(provider, { labels: { app: "api-list" } });
    expect(provider.api.sandboxId).toBeUndefined();

    const listed = await provider.api.request<{ items: { id: string }[] }>("GET", "/sandbox", {
      query: { labels: JSON.stringify({ app: "api-list" }) },
    });

    expect(listed.items.map((item) => item.id)).toEqual([box.id]);
    expect((await failure(provider.api.request("GET", "/sandbox/{sandboxId}"))).code).toBe(
      "invalid_argument",
    );
    expect(
      await provider.api.request("GET", "/sandbox/{sandboxId}", { params: { sandboxId: box.id } }),
    ).toMatchObject({ id: box.id });
    expect((await failure(provider.api.request("GET", "/files", { plane: "toolbox" }))).code).toBe(
      "invalid_argument",
    );
    expect(guest(box.id)).toBeDefined();
  });

  test("api.sdk(load) returns the client, not a sandbox", async () => {
    const client = await daytona({ apiKey: "native-key" }).api.sdk(() =>
      Promise.resolve(fakeModule),
    );

    expectTypeOf(client).toEqualTypeOf<FakeDaytona>();
    expect(client).toBeInstanceOf(FakeDaytona);
  });

  test("missing credentials fail as auth before any request", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "");
    const before = requests.length;
    expect((await failure(daytona().api.request("GET", "/sandbox"))).code).toBe("auth");
    expect(requests).toHaveLength(before);
    vi.unstubAllEnvs();
  });
});
