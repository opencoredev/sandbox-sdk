import { describe, expect, it } from "vitest";
import { isPeerError, loadPeer, peerModule } from "../src/peer.js";
import { rejection } from "./rejection.js";

describe("loadPeer", () => {
  it("names the package when an optional peer is not installed", async () => {
    // A computed specifier keeps Vite from resolving the missing package at transform time.
    const name = ["sandbox-sdk", "missing-peer"].join("-");

    const failure = await rejection(loadPeer(name, "example", () => import(name)));
    expect(failure).toMatchObject({ code: "unavailable", provider: "example" });
    expect(String(failure)).toContain(`Install ${name}`);
  });

  it("passes through failures that are not the peer itself going missing", async () => {
    const inner = Object.assign(new Error("Cannot find package 'some-transitive-dep'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });

    await expect(loadPeer("e2b", "e2b", () => Promise.reject(inner))).rejects.toBe(inner);
    const thrown = new Error("boom");
    await expect(loadPeer("e2b", "e2b", () => Promise.reject(thrown))).rejects.toBe(thrown);
  });

  it("matches a peer error class exported through a getter, as bundled namespaces do", async () => {
    class PeerFailure extends Error {}

    // esbuild's __export defines each namespace export as an enumerable getter.
    const namespace = Object.defineProperty({}, "PeerFailure", {
      get: () => PeerFailure,
      enumerable: true,
    });

    await loadPeer("getter-peer", "example", async () => namespace);
    expect(isPeerError(new PeerFailure("x"), "getter-peer", "PeerFailure")).toBe(true);
    expect(isPeerError(new Error("x"), "getter-peer", "PeerFailure")).toBe(false);
  });

  it("returns the loaded module", async () => {
    const path = await loadPeer("node:path", "example", () => import("node:path"));
    expect(path.join).toBeTypeOf("function");
  });

  it("fills named exports from default when a bundle wraps a CommonJS peer", async () => {
    // esbuild with splitting turns import() of a CommonJS package into this namespace shape.
    class BoatApi {}

    const wrapped = { default: { BoatApi, Configuration: class {} } };
    const loaded = await loadPeer("@boatdev/sdk", "boat", () => Promise.resolve(wrapped));
    expect(loaded).toMatchObject({ BoatApi, default: wrapped.default });
    expect(loaded).toHaveProperty("Configuration", expect.any(Function));
  });
});

describe("peerModule", () => {
  it("returns a namespace that already has every export unchanged", () => {
    const namespace = { BoatApi: class {}, default: { BoatApi: class {} } };
    expect(peerModule(namespace)).toBe(namespace);
    const fn = { default: () => {} };
    expect(peerModule(fn)).toBe(fn);
    const plain = { Sandbox: class {} };
    expect(peerModule(plain)).toBe(plain);
  });

  it("keeps exports the namespace has over the default's", () => {
    const own = class {};
    const merged = peerModule({ Own: own, default: { Own: class {}, Missing: 1 } });
    expect(merged).toMatchObject({ Own: own, Missing: 1 });
  });
});
