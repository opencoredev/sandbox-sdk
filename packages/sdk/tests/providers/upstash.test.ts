import { describe, expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, string>();
const deleted = mock(async () => {});
const commands: string[] = [];
const hangingStream = {
  id: "stream-1",
  cancel: mock(() => new Promise<void>(() => {})),
  [Symbol.asyncIterator]() {
    return {
      next: () => new Promise<IteratorResult<never>>(() => {}),
    };
  },
};

class NativeUpstashBox {
  static create = mock(async () => new NativeUpstashBox());
  id = "upstash-test";
  cwd = "/workspace/home";
  files = {
    write: async ({ path, content }: { path: string; content: string }) => {
      files.set(path, content);
    },
    read: async (path: string) => files.get(path)!,
    list: async () => [],
  };
  exec = {
    command: async (command: string) => {
      commands.push(command);
      const timeout = command.includes("sleep 2");
      const nonzero = command.includes("printf out") && command.includes("exit 7");
      return {
        id: "run-1",
        result:
          command.includes("node") && command.includes("--version")
            ? "v24.0.0"
            : nonzero
              ? command.endsWith("2>&1")
                ? "outerr"
                : "err"
              : "",
        exitCode: timeout ? 124 : nonzero ? 7 : 0,
        status: timeout || nonzero ? "failed" : "completed",
      };
    },
    stream: async () => hangingStream,
  };
  delete = deleted;
}

mock.module("@upstash/box", () => ({ Box: NativeUpstashBox }));

describe("Upstash adapter", () => {
  test("maps official SDK operations and combines command output", async () => {
    const { upstash } = await import("../../src/providers/upstash");
    const sandbox = await createSandbox({ provider: upstash() });
    await sandbox.files.write("file.txt", "value");
    expect(await sandbox.files.text("file.txt")).toBe("value");
    expect(files.has("/workspace/home/file.txt")).toBe(true);
    expect(await sandbox.run({ command: "node", args: ["--version"] })).toMatchObject({
      stdout: "v24.0.0",
      success: true,
    });
    expect(await sandbox.run("printf out; printf err >&2; exit 7")).toMatchObject({
      stdout: "outerr",
      stderr: "",
      exitCode: 7,
      success: false,
    });
    expect(commands.at(-1)).toEndWith("2>&1");
    await sandbox.stop();
    expect(sandbox.raw.id).toBe("upstash-test");
    expect(deleted).toHaveBeenCalled();
  });

  test("normalizes shell timeout exit 124", async () => {
    const { upstash } = await import("../../src/providers/upstash");
    const sandbox = await createSandbox({ provider: upstash() });
    await expect(sandbox.run("sleep 2", { timeout: 20 })).rejects.toMatchObject({
      code: "timeout",
      provider: "upstash",
      operation: "process.run",
    });
    await sandbox.stop();
  });

  test("reports unsupported cancellation instead of claiming a remote process was killed", async () => {
    const { upstash } = await import("../../src/providers/upstash");
    const sandbox = await createSandbox({ provider: upstash() });
    const process = await sandbox.processes.start("sleep 30");
    await expect(process.kill()).rejects.toMatchObject({
      code: "unsupported",
      provider: "upstash",
    });
    expect(await process.status()).toBe("running");
    expect(sandbox.capabilities["process.cancel"]).toBe(false);
    await sandbox.stop();
  });
});
