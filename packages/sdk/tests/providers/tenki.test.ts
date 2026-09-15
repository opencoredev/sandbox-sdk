import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface NativeExecOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface NativeExecResult {
  status: "SUCCEEDED" | "FAILED" | "TIMED_OUT";
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  durationMs: number;
  reason?: string;
}

const files = new Map<string, Uint8Array>();
const directories = new Set<string>();
const execCalls: Array<{ command: string; options?: NativeExecOptions }> = [];
const runCalls: Array<{ argv: string[]; options?: Record<string, unknown> }> = [];
const createCalls: Array<Record<string, unknown>> = [];
const signals: string[] = [];
let linkScriptExitCode = 0;
let createDelayMs = 0;

const closeIfOpen = mock(async () => undefined);
const pause = mock(async () => undefined);
const resume = mock(async () => undefined);
const waitResumed = mock(async () => undefined);
const waitPaused = mock(async () => undefined);
const exposePort = mock(async (port: number) => ({
  port,
  previewUrl: `https://preview-${port}.us.sb.tenki.sh`,
}));
const createSnapshotAndWait = mock(async (_sessionId: string, options?: { name?: string }) => ({
  id: "snapshot-test",
  name: options?.name ?? "",
  state: "READY",
  createdAt: new Date("2026-09-03T00:00:00.000Z"),
}));
const deleteSnapshot = mock(async () => ({ id: "snapshot-test", state: "DELETED" }));

class NativeNotFound extends Error {
  override name = "FileNotFoundError";
}

class NativeInvalidState extends Error {
  override name = "InvalidStateError";
}

function result(
  stdout: string,
  stderr = "",
  exitCode = 0,
  extra: Partial<NativeExecResult> = {},
): NativeExecResult {
  return {
    status: exitCode === 0 ? "SUCCEEDED" : "FAILED",
    exitCode,
    stdout: encoder.encode(stdout),
    stderr: encoder.encode(stderr),
    durationMs: 5,
    reason: "exit",
    ...extra,
  };
}

class NativeSession {
  id = "tenki-session-test";
  state = "RUNNING";
  closeIfOpen = closeIfOpen;
  pause = pause;
  resume = resume;
  waitResumed = waitResumed;
  waitPaused = waitPaused;
  exposePort = exposePort;

  async exec(command: string, options?: NativeExecOptions) {
    execCalls.push({ command, options });
    if (options?.env?.SANDBOX_SDK_CWD) {
      if (linkScriptExitCode !== 0)
        return result("", "sudo: a password is required", linkScriptExitCode);
      directories.add(options.env.SANDBOX_SDK_MIRROR!);
      return result("");
    }
    if (options?.cwd === "/missing") {
      return result("", "", -1, {
        reason: "cwd /missing: stat /missing: no such file or directory",
      });
    }
    if (options?.timeoutMs && options.args?.[1]?.includes("sleep")) {
      return result("", "", -1, { status: "TIMED_OUT", reason: "timeout" });
    }
    if (options?.args?.[1] === "printf tenki") return result("tenki");
    if (options?.args?.[1] === "printf $GREETING") return result(options.env?.GREETING ?? "");
    if (command === "printf") return result(options?.args?.join(" ") ?? "");
    if (options?.args?.[1] === "exit 3") return result("", "boom", 3);
    if (options?.args?.[1] === "throw")
      throw new NativeInvalidState("session not RUNNING (state=PAUSED)");
    return result("");
  }

  run(argv: string[], options?: Record<string, unknown>) {
    runCalls.push({ argv, options });
    const stdinChunks: Uint8Array[] = [];
    let finish!: (value: {
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      signal?: string;
      reason?: string;
    }) => void;
    const done = new Promise<{
      exitCode: number;
      stdout: Uint8Array;
      stderr: Uint8Array;
      signal?: string;
      reason?: string;
    }>((resolve) => (finish = resolve));
    let closeStdout!: () => void;
    let closeStderr!: () => void;
    let emitStdout!: (chunk: Uint8Array) => void;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        emitStdout = (chunk) => controller.enqueue(chunk);
        closeStdout = () => controller.close();
      },
    });
    const lingeringStderr = argv.at(-1) === "linger";
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("warn\n"));
        closeStderr = () => {
          if (!lingeringStderr) controller.close();
        };
      },
    });
    let exited = false;
    const exit = (exitCode: number, signal?: string, reason?: string) => {
      if (exited) return;
      exited = true;
      closeStdout();
      closeStderr();
      finish({ exitCode, stdout: new Uint8Array(), stderr: new Uint8Array(), signal, reason });
    };
    // The guest reports a failed launch as an exit with no `started` frame, so pid never settles.
    const launchFails = argv.at(-1) === "nolaunch";
    if (launchFails) {
      queueMicrotask(() =>
        exit(-1, undefined, "cwd /missing: stat /missing: no such file or directory"),
      );
    }
    const stdin = new WritableStream<Uint8Array>({
      write(chunk) {
        stdinChunks.push(chunk);
        emitStdout(chunk);
        if (argv.at(-1) === "cat") exit(0);
        if (argv.at(-1) === "cat2" && stdinChunks.length === 2) exit(0);
      },
    });
    return {
      pid: launchFails ? new Promise<number>(() => undefined) : Promise.resolve(4242),
      stdout,
      stderr,
      stdin,
      // oxlint-disable-next-line unicorn/no-thenable -- Tenki's ProcessRunHandle is awaitable.
      then: done.then.bind(done),
      signal: async (signal: string) => {
        signals.push(signal);
        if (argv.at(-1) === "trail") {
          setTimeout(() => {
            emitStdout(encoder.encode("trailing\n"));
            exit(-1, "terminated");
          }, 20);
          return;
        }
        exit(-1, "terminated");
      },
      kill: async () => {
        signals.push("KILL");
        exit(-1, "killed");
      },
    };
  }

  async writeFile(path: string, data: Uint8Array | string) {
    files.set(path, typeof data === "string" ? encoder.encode(data) : data);
  }
  async readFile(path: string) {
    const content = files.get(path);
    if (!content) throw new NativeNotFound(`[not_found] read file failed: ${path}`);
    return content;
  }
  async list(path: string) {
    const prefix = `${path.replace(/\/$/, "")}/`;
    const names = new Set<string>();
    for (const file of files.keys()) {
      if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
    }
    for (const directory of directories) {
      if (directory.startsWith(prefix)) names.add(directory.slice(prefix.length).split("/")[0]!);
    }
    return [...names].map((name) => ({
      path: name,
      size: BigInt(files.get(`${prefix}${name}`)?.length ?? 4096),
      mode: 420,
      isDir: !files.has(`${prefix}${name}`),
      modifiedUnixNs: BigInt(0),
    }));
  }
  async stat(path: string) {
    if (files.has(path) || directories.has(path)) {
      return {
        path,
        size: BigInt(0),
        mode: 420,
        isDir: directories.has(path),
        modifiedUnixNs: BigInt(0),
      };
    }
    throw new NativeNotFound(`no such file or directory: ${path}`);
  }
  async mkdir(path: string) {
    directories.add(path);
  }
  async remove(path: string) {
    files.delete(path);
    directories.delete(path);
    for (const file of files.keys()) if (file.startsWith(`${path}/`)) files.delete(file);
  }
}

class NativeTenkiSandbox {
  static instances: NativeTenkiSandbox[] = [];
  constructor(readonly options: Record<string, unknown>) {
    NativeTenkiSandbox.instances.push(this);
  }
  async create(options: Record<string, unknown>) {
    createCalls.push(options);
    if (createDelayMs) await Bun.sleep(createDelayMs);
    return new NativeSession();
  }
  createSnapshotAndWait = createSnapshotAndWait;
  deleteSnapshot = deleteSnapshot;
}

mock.module("@tenkicloud/sandbox", () => ({
  TenkiSandbox: NativeTenkiSandbox,
  stdoutText: (value: NativeExecResult) => decoder.decode(value.stdout),
  stderrText: (value: NativeExecResult) => decoder.decode(value.stderr),
}));

function reset() {
  files.clear();
  directories.clear();
  execCalls.length = 0;
  runCalls.length = 0;
  createCalls.length = 0;
  signals.length = 0;
  linkScriptExitCode = 0;
  createDelayMs = 0;
  closeIfOpen.mockClear();
}

test("Tenki adapter mirrors the working directory into /home/tenki and maps files", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({
    provider: tenki({
      authToken: "tk_test",
      name: "unit",
      cpuCores: 4,
      metadata: { owner: "sdk" },
    }),
    env: { GREETING: "hello" },
  });

  expect(createCalls[0]).toMatchObject({
    name: "unit",
    cpuCores: 4,
    metadata: { owner: "sdk" },
    env: { GREETING: "hello" },
    waitReady: true,
  });
  expect(NativeTenkiSandbox.instances.at(-1)?.options).toEqual({
    authToken: "tk_test",
    baseUrl: undefined,
  });
  expect(execCalls[0]?.options).toMatchObject({
    env: { SANDBOX_SDK_CWD: "/workspace", SANDBOX_SDK_MIRROR: "/home/tenki/workspace" },
  });
  expect(execCalls[0]?.options?.args?.[1]).toContain("sudo -n ln -s");

  await sandbox.files.write("file.txt", "value");
  expect(files.has("/home/tenki/workspace/file.txt")).toBe(true);
  expect(await sandbox.files.text("/workspace/file.txt")).toBe("value");
  await sandbox.files.mkdir("nested");
  await sandbox.files.write("nested/inner.bin", new Uint8Array([0, 1, 255]));
  expect(await sandbox.files.read("nested/inner.bin")).toEqual(new Uint8Array([0, 1, 255]));
  expect(await sandbox.files.list()).toEqual(
    expect.arrayContaining([
      { name: "file.txt", path: "/workspace/file.txt", type: "file", size: 5 },
      { name: "nested", path: "/workspace/nested", type: "directory", size: undefined },
    ]),
  );
  expect(await sandbox.files.list("nested")).toEqual([
    { name: "inner.bin", path: "/workspace/nested/inner.bin", type: "file", size: 3 },
  ]);
  expect(await sandbox.files.exists("nested/inner.bin")).toBe(true);
  expect(await sandbox.files.exists("missing.txt")).toBe(false);
  await sandbox.files.remove("nested");
  expect(await sandbox.files.exists("nested/inner.bin")).toBe(false);
  await sandbox.files.write("/home/tenki/direct.txt", "direct");
  expect(files.has("/home/tenki/direct.txt")).toBe(true);
  await expect(sandbox.files.read("missing.txt")).rejects.toMatchObject({
    code: "not_found",
    provider: "tenki",
    operation: "files.read",
  });

  expect(await sandbox.run("printf tenki")).toMatchObject({
    stdout: "tenki",
    stderr: "",
    exitCode: 0,
    success: true,
    durationMs: 5,
  });
  expect(execCalls.at(-1)).toMatchObject({
    command: "bash",
    options: { args: ["-c", "printf tenki"], cwd: "/workspace" },
  });
  expect(
    await sandbox.run("printf $GREETING", { env: { GREETING: "env" }, cwd: "sub" }),
  ).toMatchObject({
    stdout: "env",
  });
  expect(execCalls.at(-1)?.options).toMatchObject({
    cwd: "/workspace/sub",
    env: { GREETING: "env", PWD: "/workspace/sub" },
  });
  expect(await sandbox.run({ command: "printf", args: ["a b", "c"] })).toMatchObject({
    stdout: "a b c",
  });
  expect(execCalls.at(-1)).toMatchObject({ command: "printf", options: { args: ["a b", "c"] } });
  expect(await sandbox.run("exit 3")).toMatchObject({
    exitCode: 3,
    stderr: "boom",
    success: false,
  });
  expect(await sandbox.run("pwd", { cwd: "/missing" })).toMatchObject({
    exitCode: -1,
    success: false,
    stderr: "cwd /missing: stat /missing: no such file or directory",
  });
  await expect(sandbox.run("sleep 5", { timeout: 1_000 })).rejects.toMatchObject({
    code: "timeout",
    provider: "tenki",
  });
  await expect(sandbox.run("throw")).rejects.toMatchObject({
    code: "conflict",
    provider: "tenki",
    operation: "process.run",
  });

  const process = await sandbox.processes.start("cat", { cwd: "/workspace" });
  expect(runCalls.at(-1)).toMatchObject({
    argv: ["bash", "-c", "cat"],
    options: { cwd: "/workspace" },
  });
  expect(process.id).toBe("4242");
  expect(await process.status()).toBe("running");
  await process.write("from-stdin\n");
  const events: Array<{ stream: string; data: string | Uint8Array }> = [];
  for await (const event of process.output()) events.push(event);
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stream: "stderr", data: "warn\n" }),
      expect.objectContaining({ stream: "stdout", data: "from-stdin\n" }),
    ]),
  );
  expect(await process.wait()).toEqual({ exitCode: 0 });
  expect(await process.status()).toBe("exited");

  const daemon = await sandbox.processes.start({ command: "sleep", args: ["30"] });
  expect(runCalls.at(-1)?.argv).toEqual(["sleep", "30"]);
  await daemon.kill();
  expect(signals).toEqual(["SIGTERM"]);
  expect(await daemon.status()).toBe("killed");
  expect(await daemon.wait()).toEqual({ exitCode: -1 });

  const preview = await sandbox.ports.expose(3000);
  expect(preview).toMatchObject({
    port: 3000,
    url: "https://preview-3000.us.sb.tenki.sh",
    public: true,
    authenticated: false,
  });
  expect(exposePort).toHaveBeenCalledWith(3000);

  const snapshot = await sandbox.snapshots.create({ name: "base" });
  expect(snapshot).toEqual({
    id: "snapshot-test",
    name: "base",
    mode: "memory",
    createdAt: new Date("2026-09-03T00:00:00.000Z"),
  });
  expect(createSnapshotAndWait).toHaveBeenCalledWith("tenki-session-test", { name: "base" });
  await sandbox.snapshots.delete(snapshot);
  expect(deleteSnapshot).toHaveBeenCalledWith("snapshot-test");
  await expect(sandbox.snapshots.restore(snapshot)).rejects.toMatchObject({ code: "unsupported" });

  await sandbox.stop();
  await sandbox.stop();
  expect(closeIfOpen).toHaveBeenCalledTimes(1);
});

test("Tenki adapter uses the file API directly for working directories under /home/tenki", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({ provider: tenki(), cwd: "/home/tenki/project" });
  expect(execCalls).toHaveLength(0);
  expect(directories.has("/home/tenki/project")).toBe(true);
  await sandbox.files.write("a.txt", "a");
  expect(files.has("/home/tenki/project/a.txt")).toBe(true);
  expect(await sandbox.files.list()).toEqual([
    { name: "a.txt", path: "/home/tenki/project/a.txt", type: "file", size: 1 },
  ]);
  await sandbox.stop();
});

test("Tenki adapter terminates the session when the working directory cannot be mapped", async () => {
  reset();
  linkScriptExitCode = 1;
  const { tenki } = await import("../../src/providers/tenki");
  await expect(createSandbox({ provider: tenki(), cwd: "/srv/app" })).rejects.toMatchObject({
    code: "invalid_input",
    provider: "tenki",
    message: expect.stringContaining("sudo: a password is required"),
  });
  expect(closeIfOpen).toHaveBeenCalledTimes(1);
});

test("Tenki adapter closes sessions that finish creating after the caller aborted", async () => {
  reset();
  createDelayMs = 30;
  const { tenki } = await import("../../src/providers/tenki");
  const controller = new AbortController();
  const pending = createSandbox({ provider: tenki(), signal: controller.signal });
  controller.abort(new Error("caller gave up"));
  await expect(pending).rejects.toThrow("caller gave up");
  await Bun.sleep(60);
  expect(closeIfOpen).toHaveBeenCalledTimes(1);

  await expect(createSandbox({ provider: tenki(), timeout: 5 })).rejects.toThrow(
    "Sandbox creation timed out after 5ms",
  );
  await Bun.sleep(60);
  expect(closeIfOpen).toHaveBeenCalledTimes(2);
});

test("Tenki managed sessions pause, resume, and terminate", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const provider = tenki();
  const session = await provider.managed!.create({ sessionId: "tenki-managed" });
  await session.stop();
  expect(pause).toHaveBeenCalledTimes(1);
  expect(waitPaused).toHaveBeenCalledTimes(1);
  await session.resume();
  expect(resume).toHaveBeenCalledTimes(1);
  expect(waitResumed).toHaveBeenCalledTimes(1);
  await session.destroy();
  expect(closeIfOpen).toHaveBeenCalledTimes(1);
});

test("Tenki adapter serializes concurrent stdin writes on one writer", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({ provider: tenki() });
  const process = await sandbox.processes.start({ command: "cat2" });
  await Promise.all([process.write("one\n"), process.write("two\n")]);
  expect(await process.wait()).toEqual({ exitCode: 0 });
  const events: string[] = [];
  for await (const event of process.output())
    if (event.stream === "stdout") events.push(String(event.data));
  expect(events).toEqual(["one\n", "two\n"]);
  await sandbox.stop();
});

test("Tenki adapter reports exit even when a process pipe never closes", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({ provider: tenki() });
  const process = await sandbox.processes.start({ command: "linger" });
  const started = performance.now();
  await process.kill();
  expect(await process.wait()).toEqual({ exitCode: -1 });
  expect(performance.now() - started).toBeLessThan(3_000);
  expect(await process.status()).toBe("killed");
  await sandbox.stop();
});

test("Tenki adapter fails start() when the guest exits without launching the process", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({ provider: tenki() });
  const started = performance.now();
  await expect(sandbox.processes.start({ command: "nolaunch" })).rejects.toMatchObject({
    name: "SandboxError",
    code: "process_failed",
    operation: "process.start",
    message:
      "Process exited with code -1 before it started: cwd /missing: stat /missing: no such file or directory",
  });
  expect(performance.now() - started).toBeLessThan(3_000);
});

test("Tenki adapter keeps output() open for frames that arrive after kill()", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({ provider: tenki() });
  const process = await sandbox.processes.start({ command: "trail" });
  const collected: string[] = [];
  const consumer = (async () => {
    for await (const event of process.output()) collected.push(String(event.data));
  })();
  await process.kill();
  await consumer;
  expect(collected).toContain("trailing\n");
  expect(await process.status()).toBe("killed");
  expect(await process.wait()).toEqual({ exitCode: -1 });
});

test("Tenki adapter rejects file paths the guest file API cannot reach", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  const sandbox = await createSandbox({ provider: tenki() });
  await expect(sandbox.files.write("/tmp/result", "x")).rejects.toMatchObject({
    code: "invalid_input",
    provider: "tenki",
    operation: "files.write",
    message: expect.stringContaining("/tmp/result"),
  });
  await expect(sandbox.files.exists("/etc/hostname")).rejects.toMatchObject({
    code: "invalid_input",
    operation: "files.exists",
  });
  await sandbox.files.write("/home/tenki/shared.txt", "ok");
  expect(await sandbox.files.text("/home/tenki/shared.txt")).toBe("ok");
});

test("Tenki adapter rejects / as a working directory", async () => {
  reset();
  const { tenki } = await import("../../src/providers/tenki");
  await expect(createSandbox({ provider: tenki(), cwd: "/" })).rejects.toMatchObject({
    code: "invalid_input",
    message: expect.stringContaining("cannot use / as the working directory"),
  });
  expect(closeIfOpen).toHaveBeenCalledTimes(1);
  expect(execCalls).toHaveLength(0);
});
