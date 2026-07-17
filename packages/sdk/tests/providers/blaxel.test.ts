import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, Uint8Array>();
const initialize = mock(() => undefined);
let createError: Error | undefined;
const create = mock(async (configuration: unknown) => {
  if (createError) {
    const error = createError;
    createError = undefined;
    throw error;
  }
  return new NativeBlaxel(configuration);
});
const deleteByName = mock(async () => ({}));
const mkdir = mock(async () => ({ message: "created" }));
const deleted = mock(async () => ({}));
let statusError: Error | undefined;
let streamFailure: Error | undefined;
const waitForProcess = mock(async () => processResult(0));

class NativeBlaxel {
  static create = create;
  static delete = deleteByName;
  metadata = { name: "sandbox-test" };
  fs = {
    mkdir,
    async writeBinary(path: string, value: Uint8Array) {
      files.set(path, new Uint8Array(value));
      return { message: "written" };
    },
    async readBinary(path: string) {
      return new Blob([files.get(path)!.slice().buffer as ArrayBuffer]);
    },
    async ls(path: string) {
      return {
        name: path.split("/").at(-1) ?? "",
        path,
        files: [...files]
          .filter(([file]) => file.startsWith(`${path}/`))
          .map(([file, value]) => ({
            name: file.split("/").at(-1)!,
            path: file,
            size: value.byteLength,
          })),
        subdirectories: [],
      };
    },
    async rm(path: string) {
      files.delete(path);
      return { message: "removed" };
    },
  };
  process = {
    async exec(request: { command: string; waitForCompletion?: boolean }) {
      if (request.command.startsWith("test -e ")) {
        const path = request.command.slice("test -e ".length).replaceAll("'", "");
        return processResult(files.has(path) ? 0 : 1);
      }
      if (request.command === "timeout") throw new Error("process timed out after 1 seconds");
      return processResult(0);
    },
    streamLogs(
      _pid: string,
      options: { onStdout?: (value: string) => void; onError?: (error: Error) => void },
    ) {
      options.onStdout?.("streamed");
      return {
        close() {},
        async wait() {
          if (streamFailure) options.onError?.(streamFailure);
        },
      };
    },
    wait: waitForProcess,
    async get() {
      if (statusError) throw statusError;
      return processResult(0);
    },
    async kill() {
      return {};
    },
  };
  previews = {
    async createIfNotExists() {
      return {
        spec: { url: "https://preview.example.test" },
        tokens: {
          async create() {
            return { value: "private-token" };
          },
        },
      };
    },
  };
  delete = deleted;
  wait = mock(async () => this);

  constructor(readonly configuration: unknown) {}
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function processResult(exitCode: number) {
  return {
    command: "printf blaxel",
    completedAt: new Date().toISOString(),
    exitCode,
    logs: "blaxel",
    maxRestarts: 0,
    name: "process",
    pid: "process-1",
    restartCount: 0,
    restartOnFailure: false,
    startedAt: new Date().toISOString(),
    status: exitCode === 0 ? ("completed" as const) : ("failed" as const),
    stderr: "",
    stdout: "blaxel",
    workingDir: "/workspace",
  };
}

mock.module("@blaxel/core", () => ({ SandboxInstance: NativeBlaxel, initialize }));

test("Blaxel adapter maps official SDK operations", async () => {
  const { blaxel } = await import("../../src/providers/blaxel");
  const previousApiKey = process.env.BL_API_KEY;
  const previousWorkspace = process.env.BL_WORKSPACE;
  process.env.BL_API_KEY = "key";
  process.env.BL_WORKSPACE = "workspace";
  const sandbox = await createSandbox({
    provider: blaxel({ image: "blaxel/node:latest" }),
    env: { TEST_ENV: "value" },
  }).finally(() => {
    restoreEnv("BL_API_KEY", previousApiKey);
    restoreEnv("BL_WORKSPACE", previousWorkspace);
  });

  expect(initialize).toHaveBeenCalledWith({ apiKey: "key", workspace: "workspace" });
  expect(create).toHaveBeenCalledWith({
    image: "blaxel/node:latest",
    name: expect.stringMatching(/^sandbox-sdk-[a-f0-9]{12}$/),
    envs: [{ name: "TEST_ENV", value: "value" }],
  });
  expect(mkdir).toHaveBeenCalledWith("/workspace");

  await sandbox.files.write("file.bin", new Uint8Array([0, 1, 255]));
  expect(await sandbox.files.read("file.bin")).toEqual(new Uint8Array([0, 1, 255]));
  expect(await sandbox.files.exists("file.bin")).toBe(true);
  expect(await sandbox.run("printf blaxel")).toMatchObject({
    stdout: "blaxel",
    stderr: "",
    exitCode: 0,
    success: true,
  });

  const backgroundProcess = await sandbox.processes.start("printf streamed");
  const output = [];
  for await (const event of backgroundProcess.output()) output.push(event.data);
  expect(output).toEqual(["streamed"]);
  expect(await backgroundProcess.wait()).toEqual({ exitCode: 0 });
  expect(waitForProcess).not.toHaveBeenCalled();

  const preview = await sandbox.ports.expose(3000);
  expect(preview).toMatchObject({
    port: 3000,
    url: "https://preview.example.test",
    public: false,
    authenticated: true,
  });
  expect(preview.request).toBeFunction();
  await expect(preview.request!("https://attacker.example")).rejects.toMatchObject({
    code: "invalid_input",
  });

  await expect(sandbox.run("timeout", { timeout: 5 })).rejects.toMatchObject({ code: "timeout" });

  expect(sandbox.raw).toBeInstanceOf(NativeBlaxel);
  await sandbox.stop();
  expect(deleted).toHaveBeenCalled();

  await expect(
    createSandbox({ provider: blaxel({ apiKey: "other", workspace: "other" }) }),
  ).rejects.toMatchObject({ code: "invalid_input" });
});

test("Blaxel managed sessions return authenticated private preview URLs", async () => {
  const { blaxel } = await import("../../src/providers/blaxel");
  const provider = blaxel();
  const session = await provider.managed!.create({
    sessionId: "managed-preview",
    ports: [3000],
  });
  try {
    const url = new URL(await session.getPortUrl({ port: 3000 }));
    expect(url.origin).toBe("https://preview.example.test");
    expect(url.searchParams.get("bl_preview_token")).toBe("private-token");
  } finally {
    await session.destroy();
  }
});

test("Blaxel adapter cleans up an ambiguous creation failure", async () => {
  const { blaxel } = await import("../../src/providers/blaxel");
  createError = new Error("gateway timeout");
  await expect(createSandbox({ provider: blaxel() })).rejects.toThrow("gateway timeout");
  expect(deleteByName).toHaveBeenCalledWith(expect.stringMatching(/^sandbox-sdk-[a-f0-9]{12}$/));
});

test("Blaxel adapter does not delete a caller-owned name after creation fails", async () => {
  const { blaxel } = await import("../../src/providers/blaxel");
  const deleteCalls = deleteByName.mock.calls.length;
  createError = new Error("already exists");
  await expect(createSandbox({ provider: blaxel({ name: "existing-sandbox" }) })).rejects.toThrow(
    "already exists",
  );
  expect(deleteByName.mock.calls).toHaveLength(deleteCalls);
});

test("Blaxel adapter terminates process output when the log stream fails", async () => {
  const { blaxel } = await import("../../src/providers/blaxel");
  const sandbox = await createSandbox({ provider: blaxel() });
  streamFailure = new Error("native stream failed");
  try {
    const process = await sandbox.processes.start("background");
    const output = (async () => {
      for await (const _event of process.output()) {
        // Drain until the terminal error.
      }
    })();
    const outputExpectation = expect(output).rejects.toThrow("native stream failed");
    const waitExpectation = expect(process.wait()).rejects.toThrow("native stream failed");
    await Promise.all([outputExpectation, waitExpectation]);
  } finally {
    streamFailure = undefined;
    await sandbox.stop();
  }
});

test("Blaxel adapter closes process output when final status lookup fails", async () => {
  const { blaxel } = await import("../../src/providers/blaxel");
  const sandbox = await createSandbox({ provider: blaxel() });
  statusError = new Error("native status failed");
  try {
    const process = await sandbox.processes.start("background");
    const output = (async () => {
      for await (const _event of process.output()) {
        // Drain until the terminal error.
      }
    })();
    const outputExpectation = expect(output).rejects.toThrow("native status failed");
    const waitExpectation = expect(process.wait()).rejects.toThrow("native status failed");
    await Promise.all([outputExpectation, waitExpectation]);
  } finally {
    statusError = undefined;
    await sandbox.stop();
  }
});
