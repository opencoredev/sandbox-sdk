import { expect, test } from "bun:test";
import { cloudflare, type CloudflareSandboxClient } from "../../src/providers/cloudflare";

function mockClient(overrides: Partial<CloudflareSandboxClient> = {}): CloudflareSandboxClient & {
  destroyed: boolean;
  keepAlive: boolean | undefined;
  files: Map<string, string>;
} {
  const files = new Map<string, string>([["/workspace/hello.txt", "hi"]]);
  const client = {
    destroyed: false,
    keepAlive: undefined as boolean | undefined,
    files,
    async exec(command: string) {
      if (command.includes("ls")) {
        return { stdout: "hello.txt\nnotes/\n", stderr: "", exitCode: 0, success: true };
      }
      if (command.includes("node --version")) {
        return { stdout: "v22.0.0\n", stderr: "", exitCode: 0, success: true };
      }
      return { stdout: "", stderr: `unmocked: ${command}`, exitCode: 1, success: false };
    },
    async writeFile(path: string, content: string) {
      files.set(path, content);
    },
    async readFile(path: string) {
      const content = files.get(path);
      if (content === undefined) return { content: "" };
      return { content };
    },
    async exists(path: string) {
      return files.has(path);
    },
    async mkdir() {},
    async deleteFile(path: string) {
      files.delete(path);
    },
    async exposePort(port: number) {
      return `https://example.workers.dev/${port}?token=secret`;
    },
    async setKeepAlive(keepAlive: boolean) {
      client.keepAlive = keepAlive;
    },
    async destroy() {
      client.destroyed = true;
    },
    ...overrides,
  };
  return client;
}

function adapter(client = mockClient()) {
  return {
    client,
    adapter: cloudflare({
      namespace: { binding: true },
      getSandbox: () => client,
      id: "cf-test",
    }),
  };
}

test("cloudflare create wraps getSandbox and does not invent a Node create path", async () => {
  const { adapter: provider, client } = adapter();
  await using sandbox = await provider.create();
  expect(sandbox.provider).toBe("cloudflare");
  expect(sandbox.id).toBe("cf-test");
  expect(sandbox.raw).toBe(client);
  await sandbox.files.write("/workspace/app.ts", "export {}");
  expect(await sandbox.files.text("/workspace/app.ts")).toBe("export {}");
  expect(await sandbox.files.list("/workspace")).toEqual([
    { name: "hello.txt", path: "/workspace/hello.txt", type: "file" },
    { name: "notes", path: "/workspace/notes", type: "directory" },
  ]);
  expect((await sandbox.run("node --version")).stdout).toContain("v22.0.0");
});

test("cloudflare stop does not destroy and snapshots stay unsupported", async () => {
  const { adapter: provider, client } = adapter();
  const sandbox = await provider.create();
  await sandbox.stop();
  expect(client.destroyed).toBe(false);
  expect(client.keepAlive).toBe(false);
  await expect(sandbox.snapshots.create()).rejects.toMatchObject({ code: "unsupported" });
  await expect(sandbox.processes.start("sleep 1")).rejects.toMatchObject({ code: "unsupported" });
  const port = await sandbox.ports.expose(8787);
  expect(port.url).toContain("8787");
  expect(JSON.stringify(port)).not.toContain("secret");
  await sandbox.destroy();
  expect(client.destroyed).toBe(true);
});

test("cloudflare create aborts before getSandbox", async () => {
  const signal = AbortSignal.abort(new Error("cancel create"));
  await expect(
    cloudflare({
      namespace: {},
      getSandbox: () => {
        throw new Error("should not open");
      },
    }).create({ signal }),
  ).rejects.toThrow("cancel create");
});

test("cloudflare create destroys a container when aborted after getSandbox", async () => {
  const client = mockClient();
  const controller = new AbortController();
  await expect(
    cloudflare({
      namespace: {},
      getSandbox: () => {
        controller.abort(new Error("cancel after open"));
        return client;
      },
    }).create({ signal: controller.signal }),
  ).rejects.toThrow("cancel after open");
  expect(client.destroyed).toBe(true);
});

test("cloudflare() rejects a missing Worker binding", () => {
  expect(() =>
    cloudflare({
      namespace: null,
      getSandbox: () => mockClient(),
    }),
  ).toThrow("Worker Sandbox binding");
});
