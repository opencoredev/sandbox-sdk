import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { spawnSync } from "node:child_process";
import { lookupError, lookupSandbox } from "../src/existence.js";
import { fakeNativeModules } from "./native-fakes.js";

const native = vi.hoisted(() => ({ get: vi.fn(), status: vi.fn() }));

beforeEach(() => {
  fakeNativeModules({
    "@tenkicloud/sandbox": {
      TenkiSandbox: class {
        get = native.get;
        getSnapshot = vi.fn();
        deleteSnapshot = vi.fn();
      },
    },
    "@upstash/box": { Box: { get: native.get, deleteSnapshots: vi.fn() } },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  native.get.mockReset();
  native.status.mockReset();
});

it.each([401, 403, 408, 429, 500, 503])("never interprets native HTTP %d as absence", (status) => {
  expect(
    lookupError(Object.assign(new Error("not found"), { status }), "upstash", "get").result,
  ).toBe("unavailable");
});

it("accepts exact HTTP404 and Tenki gRPC5, rejecting contradictory and transient evidence", () => {
  expect(
    lookupError(Object.assign(new Error("opaque"), { statusCode: 404 }), "upstash", "get"),
  ).toMatchObject({ result: "not-found", httpStatus: 404 });
  expect(
    lookupError(new Error("native wrapper", { cause: { code: 5 } }), "tenki", "get"),
  ).toMatchObject({ result: "not-found", nativeCode: "5" });
  expect(lookupError(new Error("not found", { cause: { code: 14 } }), "tenki", "get").result).toBe(
    "unavailable",
  );
  expect(
    lookupError(
      Object.assign(new Error("opaque", { cause: { code: 5 } }), { code: 14 }),
      "tenki",
      "get",
    ).result,
  ).toBe("unavailable");
  expect(
    lookupError(
      Object.assign(new Error("opaque"), { status: 503, statusCode: 404 }),
      "upstash",
      "get",
    ).result,
  ).toBe("unavailable");
  expect(
    lookupError(
      Object.assign(new Error("metadata missing"), { code: "not_found" }),
      "upstash",
      "get",
    ).result,
  ).toBe("unavailable");
});

it("retains only allowlisted lookup evidence and redacts known secrets", () => {
  vi.stubEnv("TEST_NATIVE_TOKEN", "native-secret");

  const error = Object.assign(new Error("body native-secret"), {
    statusCode: 404,
    code: "native-secret",
    body: "private body",
    headers: { authorization: "native-secret" },
  });

  const result = lookupError(error, "upstash", "get");
  expect(result).toMatchObject({ result: "not-found", httpStatus: 404, nativeCode: "[REDACTED]" });
  expect(JSON.stringify(result)).not.toMatch(/native-secret|private body|authorization/);
});

it.each(["TERMINATED", "deleted", "destroyed", "PAUSED", "TERMINATING", "FAILED"])(
  "reads exact Tenki native %s state without guest attachment",
  async (state) => {
    vi.stubEnv("TENKI_API_KEY", "offline");
    native.get.mockResolvedValue({ id: "target", state });
    const result = await lookupSandbox({ ...memory(), name: "tenki" }, "target", 100);
    expect(native.get).toHaveBeenCalledWith("target");
    expect(result).toMatchObject({
      result: ["TERMINATED", "deleted", "destroyed"].includes(state) ? "terminal" : "present",
      nativeState: state,
    });
  },
);

it("does not accept a terminal state returned for a different ID", async () => {
  vi.stubEnv("TENKI_API_KEY", "offline");
  native.get.mockResolvedValue({ id: "foreign", state: "TERMINATED" });
  expect((await lookupSandbox({ ...memory(), name: "tenki" }, "target", 100)).result).toBe(
    "unavailable",
  );
});

it("Upstash uses exact native get/status and preserves definitive404, not transient500", async () => {
  vi.stubEnv("UPSTASH_BOX_API_KEY", "offline");
  native.get.mockResolvedValue({ id: "target", getStatus: native.status });
  native.status.mockResolvedValue({ status: "deleted" });
  expect((await lookupSandbox({ ...memory(), name: "upstash" }, "target", 100)).result).toBe(
    "terminal",
  );
  expect(native.get).toHaveBeenCalledWith("target");
  native.get.mockRejectedValue(Object.assign(new Error("native"), { statusCode: 404 }));
  expect((await lookupSandbox({ ...memory(), name: "upstash" }, "target", 100)).result).toBe(
    "not-found",
  );
  native.get.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 500 }));
  expect((await lookupSandbox({ ...memory(), name: "upstash" }, "target", 100)).result).toBe(
    "unavailable",
  );
});

it("does not resolve an Upstash lookup that returns a different box ID", async () => {
  vi.stubEnv("UPSTASH_BOX_API_KEY", "offline");
  native.get.mockResolvedValue({ id: "foreign", getStatus: native.status });
  native.status.mockResolvedValue({ status: "deleted" });
  expect((await lookupSandbox({ ...memory(), name: "upstash" }, "target", 100)).result).toBe(
    "unavailable",
  );
  expect(native.status).not.toHaveBeenCalled();
});

it("Superserve performs GET, never its activating connect path", async () => {
  vi.stubEnv("SUPERSERVE_API_KEY", "offline");

  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ id: "target", status: "deleted" })));

  vi.stubGlobal("fetch", fetcher);
  expect((await lookupSandbox({ ...memory(), name: "superserve" }, "target", 100)).result).toBe(
    "terminal",
  );
  expect(fetcher).toHaveBeenCalledWith(
    "https://api.superserve.ai/sandboxes/target",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
});

it("an empty metadata listing cannot establish absence of a live memory sandbox", async () => {
  const backing = memory();
  const info = await backing.create({ labels: {} });
  expect((await lookupSandbox({ ...backing, list: async () => [] }, info.id, 100)).result).toBe(
    "present",
  );
  await backing.destroy(info.id);
  expect((await lookupSandbox(backing, info.id, 100)).result).toBe("not-found");
});

it.each(["e2b", "daytona", "boxd", "freestyle", "boat"])(
  "uses only %s's read-only native exact get",
  async (name) => {
    vi.stubEnv(`${name.toUpperCase()}_API_KEY`, "offline");
    native.get.mockResolvedValue(
      name === "boat"
        ? { sandbox: { id: "target", state: "deleted" } }
        : name === "daytona"
          ? { data: { id: "target", state: "deleted" } }
          : { id: "target", state: "deleted" },
    );
    fakeNativeModules({
      e2b: {
        Sandbox: { getInfo: native.get, listSnapshots: vi.fn(), deleteSnapshot: vi.fn() },
        SandboxNotFoundError: class extends Error {},
      },
      "@daytonaio/sdk": {
        Daytona: class {
          sandboxApi = { getSandbox: native.get };
          snapshot = { get: vi.fn(), list: vi.fn(), delete: vi.fn() };
          get = vi.fn();
        },
      },
      "@boxd-sh/sdk": {
        Boxd: class {
          machines = { get: native.get };
          snapshots = { get: vi.fn(), delete: vi.fn() };
        },
      },
      freestyle: {
        Freestyle: class {
          vms = { get: native.get, snapshots: { get: vi.fn(), delete: vi.fn() } };
        },
      },
      "@boatdev/sdk": {
        Configuration: vi.fn(),
        BoatApi: class {
          get = native.get;
        },
      },
    });
    expect((await lookupSandbox({ ...memory(), name }, "target", 100)).result).toBe("terminal");
    expect(native.get).toHaveBeenCalledTimes(1);
  },
);

it("accepts E2B's actual native SandboxNotFoundError type, never a name or message alone", async () => {
  vi.stubEnv("E2B_API_KEY", "offline");

  class NativeNotFound extends Error {}

  fakeNativeModules({
    e2b: {
      Sandbox: { getInfo: native.get, listSnapshots: vi.fn(), deleteSnapshot: vi.fn() },
      SandboxNotFoundError: NativeNotFound,
    },
  });
  native.get.mockRejectedValue(new NativeNotFound());
  expect((await lookupSandbox({ ...memory(), name: "e2b" }, "target", 100)).result).toBe(
    "not-found",
  );
  native.get.mockRejectedValue(
    Object.assign(new Error("not found"), { name: "SandboxNotFoundError" }),
  );
  expect((await lookupSandbox({ ...memory(), name: "e2b" }, "target", 100)).result).toBe(
    "unavailable",
  );
});

it("loads all eight installed native SDKs with Bun's import conditions and no network", () => {
  const moduleURL = new URL("../src/existence.ts", import.meta.url).href;

  const source = `globalThis.fetch=async()=>{throw new Error("Network forbidden")};
 const {nativeModules}=await import(${JSON.stringify(moduleURL)});
 for(const name of ["e2b","@daytonaio/sdk","@upstash/box","@boatdev/sdk","@boxd-sh/sdk","freestyle","@tenkicloud/sandbox","@superserve/sdk"]){await nativeModules.load(name); console.log(name);}`;

  const output = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 10000 });
  expect(output.status, output.stderr).toBe(0);
  expect(output.stdout.trim().split("\n")).toHaveLength(8);
});

it("uses the installed Daytona sandbox API without toolbox hydration", () => {
  const moduleURL = new URL("../src/existence.ts", import.meta.url).href;

  const source = `import assert from "node:assert/strict";
 globalThis.fetch=async()=>{throw new Error("Network forbidden")};
 const {lookupSandbox,nativeModules}=await import(${JSON.stringify(moduleURL)});
 const mod=await nativeModules.load("@daytonaio/sdk"), load=nativeModules.load;
 let calls=[], status=200, returnedId="target";
 class OfflineDaytona extends mod.Daytona {
  constructor(){super({apiKey:"offline",otelEnabled:false}); this.sandboxApi={
   getSandbox:async(id)=>{calls.push(id); if(status!==200) throw Object.assign(new Error("sandbox response"),{response:{status}}); return {data:{id:returnedId,state:"started"}};},
   getToolboxProxyUrl:async()=>{throw Object.assign(new Error("toolbox missing"),{response:{status:404}});}
  };}
 }
 nativeModules.load=async name=>name==="@daytonaio/sdk"?{...mod,Daytona:OfflineDaytona}:load(name);
 process.env.DAYTONA_API_KEY="offline";
 const provider={name:"daytona"};
 assert.equal((await lookupSandbox(provider,"target",1000)).result,"present");
 assert.deepEqual(calls,["target"]);
 for(const [http,result] of [[404,"not-found"],[401,"unavailable"],[403,"unavailable"],[500,"unavailable"]]){
  status=http; assert.equal((await lookupSandbox(provider,"target",1000)).result,result);
 }
 status=200; returnedId="foreign";
 assert.equal((await lookupSandbox(provider,"target",1000)).result,"unavailable");`;

  const output = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 10000 });
  expect(output.status, output.stderr).toBe(0);
});

it("recognizes installed boxd NotFoundError grpcCode5 without accepting auth, quota, transport or forged errors", () => {
  const moduleURL = new URL("../src/existence.ts", import.meta.url).href;

  const source = `import assert from "node:assert/strict";
 globalThis.fetch=async()=>{throw new Error("Network forbidden")};
 const {lookupError,lookupSandbox,nativeModules}=await import(${JSON.stringify(moduleURL)});
 const mod=await nativeModules.load("@boxd-sh/sdk"), load=nativeModules.load;
 let failure=new mod.NotFoundError("missing",5);
 class OfflineBoxd extends mod.Boxd {
  constructor(){super({apiKey:"offline"}); this.machines={get:async(id)=>{assert.equal(id,"target"); throw failure;}};}
 }
 nativeModules.load=async name=>name==="@boxd-sh/sdk"?{...mod,Boxd:OfflineBoxd}:load(name);
 process.env.BOXD_API_KEY="offline";
 assert.equal(lookupError(failure,"boxd","get").result,"not-found");
 assert.deepEqual(Object.keys(lookupError(failure,"boxd","get")).sort(),["checkedAt","method","nativeCode","result"]);
 assert.equal(lookupError(failure,"boxd","get").nativeCode,"5");
 assert.equal((await lookupSandbox({name:"boxd"},"target",1000)).result,"not-found");
 for(const error of [new mod.AuthenticationError("auth",16),new mod.PermissionDeniedError("denied",7),
  new mod.RateLimitError("quota",8),new mod.APIConnectionError("transport",14),new mod.APIStatusError("unknown",2),
  new mod.NotFoundError("wrong code",14),Object.assign(new Error("forged"),{name:"NotFoundError",grpcCode:5}),
  Object.assign(new mod.NotFoundError("conflicting",5),{status:503}),new mod.AuthenticationError("wrong type",5),
  Object.assign(new mod.APIConnectionError("contradictory HTTP",14),{status:404})]){
  failure=error;
  assert.equal(lookupError(error,"boxd","get").result,"unavailable");
  assert.equal((await lookupSandbox({name:"boxd"},"target",1000)).result,"unavailable");
 }
 assert.equal(lookupError(new mod.NotFoundError("wrong provider",5),"upstash","get").result,"unavailable");`;

  const output = spawnSync("bun", ["-e", source], { encoding: "utf8", timeout: 10000 });
  expect(output.status, output.stderr).toBe(0);
});
