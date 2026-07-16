import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, Uint8Array>();
const destroy = mock(async () => {});
const mkdir = mock(async () => {});
const kill = mock(async () => {});
const execResult = {
  stdout: "railway",
  stderr: "",
  exitCode: 0,
  truncated: false,
  timedOut: false,
};

let hangExec = false;

class NativeRailway {
  static create = mock(async () => new NativeRailway());
  static connect = mock(async (id: string) => {
    const instance = new NativeRailway();
    instance.id = id;
    return instance;
  });
  id = "railway-test";
  exec() {
    if (hangExec) {
      return Object.assign(new Promise(() => {}), {
        sessionName: Promise.resolve("session-hang"),
        kill,
      });
    }
    return Object.assign(Promise.resolve(execResult), {
      sessionName: Promise.resolve("session-1"),
      kill,
    });
  }
  files = {
    write: async (path: string, value: Uint8Array) => {
      files.set(path, value);
    },
    read: async (path: string) => files.get(path)!,
    list: async () => [],
    mkdir,
    remove: async (path: string) => {
      files.delete(path);
    },
    exists: async (path: string) => files.has(path),
  };
  fork = mock(async () => {
    const forked = new NativeRailway();
    forked.id = "railway-fork";
    return forked;
  });
  destroy = destroy;
}

mock.module("railway", () => ({ Sandbox: NativeRailway }));

test("Railway adapter maps official SDK operations", async () => {
  hangExec = false;
  const { railway } = await import("../../src/providers/railway");
  const sandbox = await createSandbox({ provider: railway() });
  expect(NativeRailway.create).toHaveBeenCalled();
  expect(mkdir).toHaveBeenCalled();
  await sandbox.files.write("file.txt", "value");
  expect(await sandbox.files.text("file.txt")).toBe("value");
  expect(await sandbox.run("command")).toMatchObject({ stdout: "railway", success: true });
  const snapshot = await sandbox.snapshots.create({ name: "forked" });
  expect(snapshot).toMatchObject({ id: "railway-fork", mode: "fork" });
  await sandbox.snapshots.delete(snapshot);
  expect(NativeRailway.connect).toHaveBeenCalledWith(
    "railway-fork",
    expect.objectContaining({}),
  );
  await expect(sandbox.ports.expose(3000)).rejects.toMatchObject({
    code: "unsupported",
    provider: "railway",
  });
  await sandbox.stop();
  expect(destroy).toHaveBeenCalled();
  expect(sandbox.raw).toBeInstanceOf(NativeRailway);
});

test("Railway adapter kills in-flight commands when the abort signal fires", async () => {
  hangExec = true;
  kill.mockClear();
  const { railway } = await import("../../src/providers/railway");
  const sandbox = await createSandbox({ provider: railway() });
  const controller = new AbortController();
  const running = sandbox.run("sleep 30", { signal: controller.signal });
  controller.abort();
  await expect(running).rejects.toMatchObject({
    code: "terminated",
    provider: "railway",
    operation: "process.run",
  });
  expect(kill).toHaveBeenCalled();
  await sandbox.stop();
});

test("Railway process.output() ends after kill without hanging", async () => {
  hangExec = true;
  kill.mockClear();
  const { railway } = await import("../../src/providers/railway");
  const sandbox = await createSandbox({ provider: railway() });
  const process = await sandbox.processes.start("sleep 30");
  const drained = (async () => {
    for await (const _event of process.output()) {
      // no events expected from hanging mock
    }
  })();
  await process.kill();
  await Promise.race([
    drained,
    new Promise((_, reject) => setTimeout(() => reject(new Error("output hung after kill")), 500)),
  ]);
  expect(kill).toHaveBeenCalled();
  expect(await process.status()).toBe("exited");
  await sandbox.stop();
});
