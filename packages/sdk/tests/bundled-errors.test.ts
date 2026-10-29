import { inspect } from "node:util";
import { expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import { isPeerError, loadPeer } from "../src/peer.js";
import { railwayError } from "../src/providers/railway/errors.js";
import { daytonaError } from "../src/providers/daytona/errors.js";
import { boxdError } from "../src/providers/boxd/errors.js";
import { freestyleError } from "../src/providers/freestyle/errors.js";
import { vercelError } from "../src/providers/vercel/errors.js";

// A bundler renames classes: esbuild appends a digit on a collision, a minifier picks a letter.
// The SDK's `new.target.name` then follows the new name, so each case renames both.
function renamed<T extends Error>(error: T, name: string): T {
  Object.defineProperty(error, "name", { value: name });
  return error;
}

test("railway and daytona match the classes the adapter loaded, whatever they are named", async () => {
  const railway = await loadPeer("railway", "railway", () => import("railway"));
  const daytona = await loadPeer("@daytonaio/sdk", "daytona", () => import("@daytonaio/sdk"));
  expect(railwayError(renamed(new railway.SandboxFileNotFoundError({ operation: "read", path: "/x", message: "m" }), "Nce"), "box").code).toBe("file_not_found");
  expect(railwayError(renamed(new railway.SandboxNotFoundError({ id: "box", environmentId: "env" }), "Lce"), "box").code).toBe("not_found");
  // ExecNotStartedError extends RailwayConnectionError: the more specific class wins.
  expect(railwayError(renamed(new railway.ExecNotStartedError({ message: "m" }), "qce"), "box").code).toBe("unavailable");
  expect(railwayError(renamed(new railway.ExecInterruptedError({ reason: "closed", stdout: "", stderr: "" }), "e"), "box").code).toBe("outcome_unknown");
  expect(daytonaError(renamed(new daytona.DaytonaConnectionError("down"), "L1"), "box").code).toBe("unavailable");
  expect(daytonaError(renamed(new daytona.DaytonaConnectionTimeoutError("slow"), "t"), "box").code).toBe("timeout");
  expect(daytonaError(renamed(new daytona.DaytonaInvalidArgumentError("bad"), "x"), "box").code).toBe("invalid_argument");
  expect(isPeerError(new Error("x"), "railway", "RailwayError")).toBe(false);
  expect(isPeerError(new railway.RailwayError("x"), "never-loaded", "RailwayError")).toBe(false);
});

test("daytona names a module its SDK could not load in a bundle, with the fix", () => {
  const native = new Error(`Uploading files is not supported:  Module "form-data" is not available in the "node" runtime: Cannot find module 'form-data'`);
  const error = daytonaError(native, "box", true);
  expect(error).toMatchObject({ code: "unavailable", provider: "daytona", sandboxId: "box" });
  expect(error.message).toContain(`could not load "form-data"`);
  expect(error.message).toContain("Cannot find module 'form-data'");
  expect(error.hint).toContain("serverExternalPackages");
});

test("an ESM bundle without require names the module and the fix", async () => {
  const failing = loadPeer("e2b", "e2b", () => Promise.reject(new Error(`Dynamic require of "node:fs" is not supported`)));
  await expect(failing).rejects.toMatchObject({ code: "unavailable", provider: "e2b", message: expect.stringContaining(`Dynamic require of "node:fs" is not supported`) });
  await expect(failing).rejects.toHaveProperty("hint", expect.stringContaining("createRequire banner"));
  // Any other load failure is the adapter's to map.
  const other = new Error("boom");
  await expect(loadPeer("e2b", "e2b", () => Promise.reject(other))).rejects.toBe(other);
});

test("boxd and Freestyle tell a missing guest path from a missing sandbox", () => {
  const boxdFile = boxdError(Object.assign(new Error("no such file on sbxsdk-1: /workspace/private.txt"), { name: "NotFoundError", grpcCode: 5 }), "box");
  expect(boxdFile).toMatchObject({ code: "file_not_found", sandboxId: "box" });
  expect(`${boxdFile.message} ${String(boxdFile.cause)}`).not.toContain("private");
  expect(boxdError(Object.assign(new Error("VM not found"), { name: "NotFoundError", grpcCode: 5 }), "box").code).toBe("not_found");
  const freestyleFile = freestyleError(Object.assign(new Error("not found: /workspace/private.txt: No such file or directory (os error 2)"), { status: 404, code: "NOT_FOUND" }), "vm");
  expect(freestyleFile).toMatchObject({ code: "file_not_found", sandboxId: "vm" });
  expect(`${freestyleFile.message} ${String(freestyleFile.cause)}`).not.toContain("private");
  expect(freestyleError(Object.assign(new Error("vm not found"), { status: 404, code: "NOT_FOUND" }), "vm").code).toBe("not_found");
});

test("Vercel maps snapshot_not_found to not_found", () => {
  const native = Object.assign(new Error("Status code 404 is not ok"), { response: new Response(null, { status: 404 }), json: { error: { code: "snapshot_not_found", message: "private" } } });
  const error = vercelError(native);
  expect(error).toMatchObject({ code: "not_found", provider: "vercel", message: expect.stringContaining("snapshot not found") });
  expect(error.message).not.toContain("private");
  // The same code on a 400 (a session that cannot resume) is still not_found, not invalid_argument.
  expect(vercelError(Object.assign(new Error("x"), { response: new Response(null, { status: 400 }), json: native.json })).code).toBe("not_found");
});

test("a SandboxError prints its code, message and fields even when the class is minified", () => {
  expect(SandboxError.name).toBe("SandboxError");
  const printed = inspect(new SandboxError("File does not exist. Check the path.", { code: "file_not_found", provider: "e2b", sandboxId: "box", cause: "FileNotFoundError" }));
  expect(printed.split("\n")[0]).toBe("SandboxError [file_not_found]: File does not exist. Check the path.");
  expect(printed).toMatch(/\n {4}at /);
  expect(printed).toContain("provider: 'e2b'");
  expect(printed).toContain("cause: 'FileNotFoundError'");
});
