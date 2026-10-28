import { describe, expect, it } from "vitest";
import { SandboxError } from "../src/index.js";
import { loadPeer } from "../src/peer.js";

describe("loadPeer", () => {
  it("names the package when an optional peer is not installed", async () => {
    // A computed specifier keeps Vite from resolving the missing package at transform time.
    const name = ["sandbox-sdk", "missing-peer"].join("-");
    const failure = await loadPeer(name, "example", () => import(name)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxError);
    expect(failure).toMatchObject({ code: "unavailable", provider: "example" });
    expect(String(failure)).toContain(`Install ${name}`);
  });

  it("passes through failures that are not the peer itself going missing", async () => {
    const inner = Object.assign(new Error("Cannot find package 'some-transitive-dep'"), { code: "ERR_MODULE_NOT_FOUND" });
    await expect(loadPeer("e2b", "e2b", () => Promise.reject(inner))).rejects.toBe(inner);
    const thrown = new Error("boom");
    await expect(loadPeer("e2b", "e2b", () => Promise.reject(thrown))).rejects.toBe(thrown);
  });

  it("returns the loaded module", async () => {
    const path = await loadPeer("node:path", "example", () => import("node:path"));
    expect(typeof path.join).toBe("function");
  });
});
