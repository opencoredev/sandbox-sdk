import { expect, test } from "bun:test";
import { createSandbox, SandboxError, withSandbox } from "../../src";
import { defineCapabilities } from "../../src/core/capabilities";
import type { SandboxProvider } from "../../src/core/provider";
import { memory } from "../../src/providers/memory";
import { unsupportedSnapshots } from "../../src/internal/provider-utils";

test("files keep 0.2 write/read/list/mkdir/remove/exists behavior", async () => {
  await using sandbox = await memory().create();
  await sandbox.files.write("note.txt", "hello");
  expect(await sandbox.files.text("note.txt")).toBe("hello");
  await sandbox.files.mkdir("nested");
  await sandbox.files.write("nested/item.txt", "item");
  expect((await sandbox.files.list("nested")).map((entry) => entry.name)).toContain("item.txt");
  expect(await sandbox.files.exists("nested/item.txt")).toBe(true);
  await sandbox.files.remove("nested");
  expect(await sandbox.files.exists("nested/item.txt")).toBe(false);
});

test("path traversal is rejected before a provider call", async () => {
  await using sandbox = await memory().create();
  await expect(sandbox.files.read("../escape")).rejects.toMatchObject({
    code: "invalid_input",
    operation: "path",
  });
});

test("commands keep 0.2 success, stdout, and nonzero-exit shapes", async () => {
  await using sandbox = await memory().create();
  const ok = await sandbox.run("true");
  expect(ok).toMatchObject({ exitCode: 0, success: true });
  expect((await sandbox.run("printf stdout")).stdout).toContain("stdout");
  expect((await sandbox.run("exit 2")).success).toBe(false);
  expect((await sandbox.run("exit 2")).exitCode).toBe(2);
});

test("withSandbox stops after success and after a thrown callback", async () => {
  let stops = 0;
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({ "process.run": "in-process" }),
    async create() {
      return {
        id: "cleanup",
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
        async stop() {
          stops += 1;
        },
      };
    },
  };
  await withSandbox({ provider }, async () => "ok");
  expect(stops).toBe(1);
  await expect(
    withSandbox({ provider }, async () => {
      throw new Error("callback failed");
    }),
  ).rejects.toThrow("callback failed");
  expect(stops).toBe(2);
});

test("capability-gated methods fail before the runtime is called", async () => {
  let exposed = 0;
  const provider: SandboxProvider<{}> = {
    id: "local",
    capabilities: defineCapabilities({}),
    async create() {
      return {
        id: "gated",
        raw: {},
        capabilities: defineCapabilities({}),
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
          throw new Error("start should not run");
        },
        async expose() {
          exposed += 1;
          return {
            port: 3000,
            url: "http://example.invalid",
            public: true,
            authenticated: false,
            toJSON() {
              return { port: 3000, url: "http://example.invalid", public: true, authenticated: false };
            },
          };
        },
        snapshots: {
          async create() {
            throw new Error("snapshot create should not run");
          },
          async delete() {
            throw new Error("snapshot delete should not run");
          },
          async restore() {
            throw new Error("snapshot restore should not run");
          },
        },
        async stop() {},
      };
    },
  };
  await using sandbox = await createSandbox({ provider });
  await expect(sandbox.run("true")).rejects.toMatchObject({
    code: "unsupported",
    operation: "process.run",
  });
  await expect(sandbox.ports.expose(3000)).rejects.toBeInstanceOf(SandboxError);
  await expect(sandbox.processes.start("true")).rejects.toMatchObject({
    code: "unsupported",
  });
  await expect(sandbox.snapshots.create()).rejects.toMatchObject({ code: "unsupported" });
  expect(exposed).toBe(0);
});
