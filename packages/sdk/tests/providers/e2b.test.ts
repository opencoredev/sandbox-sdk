import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, Uint8Array>();
const makeDir = mock(async () => true);
class NativeE2B {
  static create = mock(async () => new NativeE2B());
  static deleteSnapshot = mock(async () => true);
  sandboxId = "e2b-test";
  trafficAccessToken = undefined;
  files = {
    write: async (path: string, value: ArrayBuffer) => {
      files.set(path, new Uint8Array(value));
    },
    read: async (path: string) => files.get(path)!,
    list: async () => [],
    makeDir,
    remove: async (path: string) => {
      files.delete(path);
    },
    exists: async (path: string) => files.has(path),
  };
  commands = { run: async () => ({ stdout: "e2b", stderr: "", exitCode: 0 }) };
  getHost(port: number) {
    return `${port}.example.test`;
  }
  createSnapshot = async () => ({ snapshotId: "snapshot", names: ["snapshot"] });
  kill = mock(async () => true);
}
mock.module("e2b", () => ({ Sandbox: NativeE2B }));

test("E2B adapter maps official SDK operations", async () => {
  const { e2b } = await import("../../src/providers/e2b");
  const sandbox = await createSandbox({ provider: e2b() });
  expect(makeDir).toHaveBeenCalledWith("/workspace");
  await sandbox.files.write("file.txt", "value");
  expect(await sandbox.files.text("file.txt")).toBe("value");
  expect(await sandbox.run("command")).toMatchObject({ stdout: "e2b", success: true });
  await sandbox.stop();
  expect(sandbox.raw).toBeInstanceOf(NativeE2B);
});
