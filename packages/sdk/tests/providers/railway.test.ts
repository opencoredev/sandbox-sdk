import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, Uint8Array>();
const destroy = mock(async () => undefined);
const deleteCheckpoint = mock(async () => undefined);

class NativeExecHandle implements PromiseLike<NativeExecResult> {
  readonly sessionName = Promise.resolve("session-test");
  private readonly promise: Promise<NativeExecResult>;

  constructor(result: NativeExecResult, options?: NativeExecOptions) {
    this.promise = Promise.resolve().then(() => {
      options?.onStdout?.(result.stdout);
      options?.onStderr?.(result.stderr);
      return result;
    });
  }

  // oxlint-disable-next-line unicorn/no-thenable -- Railway's official ExecHandle implements Promise.
  then<TResult1 = NativeExecResult, TResult2 = never>(
    onfulfilled?: ((value: NativeExecResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ) {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null) {
    return this.promise.finally(onfinally ?? undefined);
  }

  async kill() {
    return true;
  }
}

interface NativeExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

interface NativeExecOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

class NativeRailwaySandbox {
  static create = mock(async () => new NativeRailwaySandbox());
  static deleteCheckpoint = deleteCheckpoint;
  id = "railway-test";
  files = {
    mkdir: async () => undefined,
    write: async (path: string, value: string | Uint8Array | ArrayBuffer | Blob) => {
      const bytes =
        typeof value === "string"
          ? new TextEncoder().encode(value)
          : value instanceof Uint8Array
            ? value
            : value instanceof ArrayBuffer
              ? new Uint8Array(value)
              : new Uint8Array(await value.arrayBuffer());
      files.set(path, bytes);
    },
    read: async (path: string) => files.get(path)!,
    list: async () => [],
    exists: async (path: string) => files.has(path),
  };
  exec(command: string, options?: NativeExecOptions) {
    const result = command.includes("printf railway") ? nativeResult("railway") : nativeResult("");
    return new NativeExecHandle(result, options);
  }
  checkpoint = async (name: string) => ({
    id: "checkpoint-test",
    key: name,
    createdAt: "2026-07-16T00:00:00.000Z",
  });
  destroy = destroy;
}

function nativeResult(stdout: string): NativeExecResult {
  return { stdout, stderr: "", exitCode: 0, truncated: false, timedOut: false };
}

mock.module("railway", () => ({ Sandbox: NativeRailwaySandbox }));

test("Railway adapter maps files, durable exec, checkpoints, and teardown", async () => {
  const { railway } = await import("../../src/providers/railway");
  const sandbox = await createSandbox({
    provider: railway({ token: "railway_test", environmentId: "env_test" }),
  });

  await sandbox.files.write("file.txt", "value");
  expect(await sandbox.files.text("file.txt")).toBe("value");
  expect(await sandbox.run("printf railway")).toMatchObject({ stdout: "railway", success: true });

  const process = await sandbox.processes.start("printf railway");
  const events = process.output()[Symbol.asyncIterator]();
  expect((await events.next()).value?.data).toBe("railway");
  expect(await process.wait()).toEqual({ exitCode: 0 });

  const checkpoint = await sandbox.snapshots.create({ name: "base" });
  expect(checkpoint).toMatchObject({ id: "checkpoint-test", name: "base" });
  await sandbox.snapshots.delete(checkpoint);
  expect(deleteCheckpoint).toHaveBeenCalledWith("checkpoint-test", {
    token: "railway_test",
    environmentId: "env_test",
  });

  await expect(sandbox.ports.expose(3000)).rejects.toMatchObject({ code: "unsupported" });
  await sandbox.stop();
  expect(destroy).toHaveBeenCalled();
});
