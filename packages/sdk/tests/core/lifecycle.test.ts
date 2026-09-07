import { expect, test } from "bun:test";
import { connectSandbox, createSandbox, listSandboxes } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider, SandboxRuntime } from "../../src/core/provider";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

function runtimeFor(id: string, extendTimeout?: (ms: number) => Promise<void>): SandboxRuntime<{}> {
  return {
    id,
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
    ...(extendTimeout ? { extendTimeout } : {}),
    async stop() {},
  };
}

test("connectSandbox reattaches through the provider and keeps the full surface", async () => {
  const connected: string[] = [];
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return runtimeFor("created");
    },
    async connect({ id, cwd }) {
      connected.push(`${id}:${cwd}`);
      return runtimeFor(id);
    },
  };
  await using sandbox = await connectSandbox({ provider, id: "sbx_123", cwd: "/project" });
  expect(sandbox.id).toBe("sbx_123");
  expect(connected).toEqual(["sbx_123:/project"]);
  expect(typeof sandbox.runCode).toBe("function");
  expect((await sandbox.run("true")).success).toBe(true);
});

test("connectSandbox preserves lifecycle hooks", async () => {
  const events: string[] = [];
  const provider: SandboxProvider<{}> = {
    id: "community",
    capabilities: defineCapabilities({ "sandbox.connect": "native" }),
    async create() {
      return runtimeFor("created");
    },
    async connect({ id }) {
      return runtimeFor(id);
    },
  };
  await using sandbox = await connectSandbox({
    provider,
    id: "sbx_hooks",
    hooks: {
      onRun: (event) => {
        if (event.operation) events.push(event.operation);
      },
      onStop: (event) => {
        if (event.operation) events.push(event.operation);
      },
    },
  });
  await sandbox.run("true");
  await sandbox.stop();
  expect(events).toEqual(["process.run", "sandbox.stop"]);
});

test("connectSandbox throws unsupported when the provider cannot reconnect", async () => {
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return runtimeFor("created");
    },
  };
  await expect(connectSandbox({ provider, id: "sbx_123" })).rejects.toMatchObject({
    code: "unsupported",
    operation: "sandbox.connect",
  });
});

test("listSandboxes returns provider summaries or throws unsupported", async () => {
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return runtimeFor("created");
    },
    async list() {
      return [{ id: "one", provider: "local", state: "running" }];
    },
  };
  expect(await listSandboxes(provider)).toEqual([
    { id: "one", provider: "local", state: "running" },
  ]);

  const bare: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return runtimeFor("created");
    },
  };
  await expect(listSandboxes(bare)).rejects.toMatchObject({
    code: "unsupported",
    operation: "sandbox.list",
  });
});

test("extendTimeout delegates to the runtime or throws unsupported", async () => {
  const extended: number[] = [];
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return runtimeFor("created", async (ms) => {
        extended.push(ms);
      });
    },
  };
  await using sandbox = await createSandbox({ provider });
  await sandbox.extendTimeout(60_000);
  expect(extended).toEqual([60_000]);

  const bare: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return runtimeFor("created");
    },
  };
  await using sandbox2 = await createSandbox({ provider: bare });
  await expect(sandbox2.extendTimeout(1_000)).rejects.toMatchObject({
    code: "unsupported",
    operation: "sandbox.timeout",
  });
});
