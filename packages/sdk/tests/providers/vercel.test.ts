import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, Uint8Array>();
const native = {
  name: "vercel-test",
  status: "running",
  routes: [],
  fs: {
    mkdir: async () => undefined,
    writeFile: async (path: string, value: Uint8Array) => {
      files.set(path, value);
    },
    readFile: async (path: string) => Buffer.from(files.get(path)!),
    readdir: async () => [],
    rm: async (path: string) => {
      files.delete(path);
    },
    exists: async (path: string) => files.has(path),
  },
  runCommand: async () => ({
    stdout: async () => "vercel",
    stderr: async () => "",
    exitCode: 0,
    durationMs: 1,
  }),
  update: async () => {},
  domain: () => "https://vercel.test",
  stop: mock(async () => {}),
};
class NativeVercel {
  static create = mock(async () => native);
}
class NativeSnapshot {
  static get = mock(async () => ({ delete: async () => {} }));
}
mock.module("@vercel/sandbox", () => ({ Sandbox: NativeVercel, Snapshot: NativeSnapshot }));

test("Vercel adapter maps official SDK operations", async () => {
  const { vercel } = await import("../../src/providers/vercel");
  const sandbox = await createSandbox({ provider: vercel() });
  await sandbox.files.write("file.txt", "value");
  expect(await sandbox.files.text("file.txt")).toBe("value");
  expect(await sandbox.run({ command: "node", args: ["--version"] })).toMatchObject({
    stdout: "vercel",
    success: true,
  });
  await sandbox.stop();
  expect(sandbox.raw.name).toBe("vercel-test");
});
