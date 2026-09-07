import { expect, test } from "bun:test";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { withManagedSessions } from "../../src/internal/managed-provider";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

function fakeManagedProvider() {
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({ "process.run": "in-process" }),
    async create() {
      return {
        id: "managed",
        raw: {},
        capabilities: defineCapabilities({ "process.run": "in-process" }),
        files: {
          async write() {},
          async read() {
            return new Uint8Array();
          },
          async list() {
            return [];
          },
          async mkdir() {},
          async remove() {},
          async exists() {
            return false;
          },
        },
        async run() {
          return { stdout: "", stderr: "", exitCode: 0, success: true };
        },
        async start() {
          throw new Error("unused");
        },
        async expose() {
          throw new Error("unused");
        },
        snapshots: unsupportedSnapshots("local"),
        async stop() {},
      };
    },
  };
  return withManagedSessions(provider, [], {
    async stop() {},
    async resume(_sandbox, signal) {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    },
  });
}

test("managed resume honors an already-aborted signal", async () => {
  const provider = fakeManagedProvider();
  const session = await provider.managed!.create({ sessionId: "s1" });
  await session.stop();
  const signal = AbortSignal.abort(new Error("stop resume"));
  await expect(provider.managed!.resume({ sessionId: "s1", signal })).rejects.toThrow("stop resume");
  await session.destroy();
});
