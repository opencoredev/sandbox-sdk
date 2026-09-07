import { expect, test } from "bun:test";
import { createSandbox, defineAdapter, isSandboxAdapter } from "../../src";
import { memory } from "../../src/providers/memory";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

test("memory().create is the happy path", async () => {
  await using sandbox = await memory({ files: { "hello.txt": "hi" } }).create({
    cwd: "/workspace",
  });
  expect(sandbox.provider).toBe("memory");
  expect(await sandbox.files.text("hello.txt")).toBe("hi");
  expect((await sandbox.run("echo ready")).stdout).toContain("ready");
  const info = await sandbox.info();
  expect(info.id).toBe("memory");
  expect(info.provider).toBe("memory");
});

test("memory stop does not destroy files and destroy clears them", async () => {
  const adapter = memory({ files: { "keep.txt": "x" } });
  const sandbox = await adapter.create();
  await sandbox.files.write("keep.txt", "x");
  await sandbox.stop();
  expect(await sandbox.files.exists("keep.txt")).toBe(true);
  await sandbox.destroy();
  expect(await sandbox.files.exists("keep.txt")).toBe(false);
});

test("memory fails closed on ports, processes, metrics, and pty", async () => {
  await using sandbox = await memory().create();
  await expect(sandbox.ports.expose(3000)).rejects.toMatchObject({ code: "unsupported" });
  await expect(sandbox.processes.start("true")).rejects.toMatchObject({ code: "unsupported" });
  await expect(sandbox.metrics()).rejects.toMatchObject({ code: "unsupported" });
  await expect(sandbox.pty.create()).rejects.toMatchObject({ code: "unsupported" });
});

test("createSandbox still accepts a 0.2 runtime provider", async () => {
  const provider: SandboxProvider<{}> = {
    id: "community-fake",
    capabilities: defineCapabilities({
      "files.read": "memory",
      "files.write": "memory",
      "process.run": "in-process",
    }),
    async create() {
      const files = new Map<string, Uint8Array>();
      return {
        id: "community",
        raw: {},
        capabilities: defineCapabilities({
          "files.read": "memory",
          "files.write": "memory",
          "process.run": "in-process",
        }),
        files: {
          async write(path, value) {
            files.set(path, typeof value === "string" ? new TextEncoder().encode(value) : (value as Uint8Array));
          },
          async read(path) {
            return files.get(path) ?? new Uint8Array();
          },
          async list() {
            return [];
          },
          async mkdir() {},
          async remove(path) {
            files.delete(path);
          },
          async exists(path) {
            return files.has(path);
          },
        },
        async run() {
          return { stdout: "ok\n", stderr: "", exitCode: 0, success: true };
        },
        async start() {
          throw new Error("no");
        },
        async expose() {
          throw new Error("no");
        },
        snapshots: unsupportedSnapshots("community-fake"),
        async stop() {},
      };
    },
  };
  expect(isSandboxAdapter(provider)).toBe(false);
  const adapter = defineAdapter(provider);
  expect(isSandboxAdapter(adapter)).toBe(true);
  await using sandbox = await adapter.create();
  expect(sandbox.provider).toBe("community-fake");
  expect((await sandbox.run("true")).success).toBe(true);
  const bridged = await createSandbox({ provider });
  expect(bridged.provider).toBe("community-fake");
  await bridged.stop();
});

test("git.status parses porcelain output", async () => {
  const { createSandbox: create } = await import("../../src");
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({ "process.run": "in-process" }),
    async create() {
      return {
        id: "git",
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
        async run(command) {
          const text = typeof command === "string" ? command : command.command;
          if (text.includes("status")) {
            return {
              stdout: "## main...origin/main [ahead 1, behind 2]\n M src/index.ts\n?? new.ts\n",
              stderr: "",
              exitCode: 0,
              success: true,
            };
          }
          return { stdout: "", stderr: "", exitCode: 0, success: true };
        },
        async start() {
          throw new Error("no");
        },
        async expose() {
          throw new Error("no");
        },
        snapshots: unsupportedSnapshots("local"),
        async stop() {},
      };
    },
  };
  await using sandbox = await create({ provider });
  const status = await sandbox.git.status();
  expect(status.branch).toBe("main");
  expect(status.ahead).toBe(1);
  expect(status.behind).toBe(2);
  expect(status.dirty).toBe(true);
  expect(status.entries).toHaveLength(2);
});
