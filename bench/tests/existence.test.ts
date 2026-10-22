import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {memory} from "@opencoredev/sandbox-sdk/memory";
import {lookupError, lookupSandbox, nativeModules} from "../src/existence.js";
const native = vi.hoisted(() => ({get: vi.fn(), status: vi.fn()}));
beforeEach(() => {
 vi.spyOn(nativeModules, "load").mockImplementation(async name => {
  if (name === "@tenkicloud/sandbox") return {TenkiSandbox: class {get = native.get;}};
  if (name === "@upstash/box") return {Box: {get: native.get}};
  throw new Error("Unexpected native SDK import");
 });
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); native.get.mockReset(); native.status.mockReset();});
it.each([401, 403, 408, 429, 500, 503])("never interprets native HTTP %d as absence", status => {
 expect(lookupError(Object.assign(new Error("not found"), {status}), "upstash", "get").result).toBe("unavailable");
});
it("accepts exact HTTP404 and Tenki gRPC5, rejecting contradictory and transient evidence", () => {
 expect(lookupError(Object.assign(new Error("opaque"), {statusCode: 404}), "upstash", "get")).toMatchObject({result: "not-found", httpStatus: 404});
 expect(lookupError(new Error("native wrapper", {cause: {code: 5}}), "tenki", "get")).toMatchObject({result: "not-found", nativeCode: "5"});
 expect(lookupError(new Error("not found", {cause: {code: 14}}), "tenki", "get").result).toBe("unavailable");
 expect(lookupError(Object.assign(new Error("opaque", {cause: {code: 5}}), {code: 14}), "tenki", "get").result).toBe("unavailable");
 expect(lookupError(Object.assign(new Error("opaque"), {status: 503, statusCode: 404}), "upstash", "get").result).toBe("unavailable");
 expect(lookupError(Object.assign(new Error("metadata missing"), {code: "not_found"}), "upstash", "get").result).toBe("unavailable");
});
it.each(["TERMINATED", "deleted", "destroyed", "PAUSED", "TERMINATING", "FAILED"])("reads exact Tenki native %s state without guest attachment", async state => {
 vi.stubEnv("TENKI_API_KEY", "offline");
 native.get.mockResolvedValue({id: "target", state});
 const result = await lookupSandbox({...memory(), name: "tenki"}, "target", 100);
 expect(native.get).toHaveBeenCalledWith("target");
 expect(result).toMatchObject({result: ["TERMINATED", "deleted", "destroyed"].includes(state) ? "terminal" : "present", nativeState: state});
});
it("does not accept a terminal state returned for a different ID", async () => {
 vi.stubEnv("TENKI_API_KEY", "offline"); native.get.mockResolvedValue({id: "foreign", state: "TERMINATED"});
 expect((await lookupSandbox({...memory(), name: "tenki"}, "target", 100)).result).toBe("unavailable");
});
it("Upstash uses exact native get/status and preserves definitive404, not transient500", async () => {
 vi.stubEnv("UPSTASH_BOX_API_KEY", "offline");
 native.get.mockResolvedValue({getStatus: native.status}); native.status.mockResolvedValue({status: "deleted"});
 expect((await lookupSandbox({...memory(), name: "upstash"}, "target", 100)).result).toBe("terminal");
 expect(native.get).toHaveBeenCalledWith("target");
 native.get.mockRejectedValue(Object.assign(new Error("native"), {statusCode: 404}));
 expect((await lookupSandbox({...memory(), name: "upstash"}, "target", 100)).result).toBe("not-found");
 native.get.mockRejectedValue(Object.assign(new Error("not found"), {statusCode: 500}));
 expect((await lookupSandbox({...memory(), name: "upstash"}, "target", 100)).result).toBe("unavailable");
});
it("Superserve performs GET, never its activating connect path", async () => {
 vi.stubEnv("SUPERSERVE_API_KEY", "offline");
 const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({id: "target", status: "deleted"})));
 vi.stubGlobal("fetch", fetcher);
 expect((await lookupSandbox({...memory(), name: "superserve"}, "target", 100)).result).toBe("terminal");
 expect(fetcher).toHaveBeenCalledWith("https://api.superserve.ai/sandboxes/target", expect.objectContaining({signal: expect.any(AbortSignal)}));
 expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("method", "POST");
});
it("an empty metadata listing cannot establish absence of a live memory sandbox", async () => {
 const backing = memory(); const info = await backing.create({labels: {}});
 expect((await lookupSandbox({...backing, list: async () => []}, info.id, 100)).result).toBe("present");
 await backing.destroy(info.id);
 expect((await lookupSandbox(backing, info.id, 100)).result).toBe("not-found");
});
it.each(["e2b", "daytona", "boxd", "freestyle", "boat"])("uses only %s's read-only native exact get", async name => {
 vi.stubEnv(`${name.toUpperCase()}_API_KEY`, "offline");
 native.get.mockResolvedValue(name === "boat" ? {sandbox: {id: "target", state: "deleted"}} : {id: "target", state: "deleted"});
 vi.mocked(nativeModules.load).mockResolvedValue({
  Sandbox: {getInfo: native.get},
  Daytona: class {get = native.get;},
  Boxd: class {machines = {get: native.get};},
  Freestyle: class {vms = {get: native.get};},
  Configuration: class {}, BoatApi: class {get = native.get;},
 });
 expect((await lookupSandbox({...memory(), name}, "target", 100)).result).toBe("terminal");
 expect(native.get).toHaveBeenCalledTimes(1);
});
it("accepts E2B's actual native SandboxNotFoundError type, never a name or message alone", async () => {
 vi.stubEnv("E2B_API_KEY", "offline");
 class NativeNotFound extends Error {}
 vi.mocked(nativeModules.load).mockResolvedValue({Sandbox: {getInfo: native.get}, SandboxNotFoundError: NativeNotFound});
 native.get.mockRejectedValue(new NativeNotFound());
 expect((await lookupSandbox({...memory(), name: "e2b"}, "target", 100)).result).toBe("not-found");
 native.get.mockRejectedValue(Object.assign(new Error("not found"), {name: "SandboxNotFoundError"}));
 expect((await lookupSandbox({...memory(), name: "e2b"}, "target", 100)).result).toBe("unavailable");
});
