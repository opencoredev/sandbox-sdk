import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

function disposableProvider(onStop: () => void): SandboxProvider<{}> {
  const unsupported = async (): Promise<never> => {
    throw new Error("not used");
  };

  return {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return {
        id: "disposable",
        raw: {},
        capabilities: defineCapabilities({}),
        files: {
          write: unsupported,
          read: unsupported,
          list: unsupported,
          mkdir: unsupported,
          remove: unsupported,
          exists: unsupported,
        },
        run: unsupported,
        start: unsupported,
        expose: unsupported,
        snapshots: unsupportedSnapshots("local"),
        stop: async () => onStop(),
      };
    },
  };
}

test("await using stops a sandbox when its scope exits", async () => {
  let stops = 0;

  {
    await using sandbox = await createSandbox({
      provider: disposableProvider(() => stops++),
    });
    expect(sandbox.id).toBe("disposable");
    expect(stops).toBe(0);
  }

  expect(stops).toBe(1);
});

test("await using stops a sandbox when its scope throws", async () => {
  let stops = 0;
  const failure = new Error("scope failed");

  const run = async () => {
    await using sandbox = await createSandbox({
      provider: disposableProvider(() => stops++),
    });
    expect(sandbox.id).toBe("disposable");
    throw failure;
  };

  await expect(run()).rejects.toBe(failure);
  expect(stops).toBe(1);
});

test("explicit stop and async disposal share idempotent cleanup", async () => {
  let stops = 0;

  {
    await using sandbox = await createSandbox({
      provider: disposableProvider(() => stops++),
    });
    await sandbox.stop();
    expect(stops).toBe(1);
  }

  expect(stops).toBe(1);
});

test("async disposal normalizes cleanup failures", async () => {
  const run = async () => {
    await using sandbox = await createSandbox({
      provider: disposableProvider(() => {
        throw new Error("cleanup failed");
      }),
    });
    expect(sandbox.id).toBe("disposable");
  };

  await expect(run()).rejects.toMatchObject({
    provider: "local",
    operation: "sandbox.stop",
  });
});
