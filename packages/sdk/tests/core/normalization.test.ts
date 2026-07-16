import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

test("normalizes errors from every public runtime surface", async () => {
  const fail = async (): Promise<never> => {
    throw new Error("provider unavailable");
  };
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return {
        id: "fake",
        raw: {},
        capabilities: defineCapabilities({}),
        files: { write: fail, read: fail, list: fail, mkdir: fail, remove: fail, exists: fail },
        run: fail,
        start: fail,
        expose: fail,
        snapshots: unsupportedSnapshots("local"),
        stop: async () => {},
      };
    },
  };
  const sandbox = await createSandbox({ provider });
  await expect(sandbox.files.read("file")).rejects.toMatchObject({
    provider: "local",
    operation: "files.read",
  });
  await expect(sandbox.run("command")).rejects.toMatchObject({
    provider: "local",
    operation: "process.run",
  });
  await expect(sandbox.ports.expose(3000)).rejects.toMatchObject({
    provider: "local",
    operation: "ports.expose",
  });
  await expect(sandbox.snapshots.create()).rejects.toMatchObject({
    code: "unsupported",
    operation: "snapshot.create",
  });
  await sandbox.stop();
});
