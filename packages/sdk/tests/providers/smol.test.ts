import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Machine } from "smolmachines";
import { capabilityNames, createSandbox, supports } from "../../src";
import { smol } from "../../src/providers/smol";

const files = new Map<string, Uint8Array>();
const calls: Array<{ args: string[]; options: unknown }> = [];
let deleted = 0;
const encoder = new TextEncoder();

const fake = {
  id: "test-vm",
  async exec(args: string[], options: unknown) {
    calls.push({ args, options });
    if (args[0] === "find") {
      const entries = encoder.encode(["/workspace/file.txt", "/workspace/nested", ""].join("\0"));
      return {
        success: true,
        exitCode: 0,
        stdout: "",
        stdoutBytes: entries,
        stderr: "",
        stdoutTruncated: false,
      };
    }
    if (args[0] === "stat") {
      return {
        success: true,
        exitCode: 0,
        stdout: "81a4 5\n41ed 0\n",
        stderr: "",
        stdoutTruncated: false,
      };
    }
    if (args[0] === "test") {
      return {
        success: files.has(args[2]!),
        exitCode: files.has(args[2]!) ? 0 : 1,
        stdout: "",
        stderr: "",
      };
    }
    return { success: true, exitCode: 0, stdout: args[0] === "sh" ? "hello" : "", stderr: "" };
  },
  async writeFile(path: string, value: Uint8Array) {
    files.set(path, value);
  },
  async readFile(path: string) {
    return files.get(path) ?? new Uint8Array();
  },
  async delete() {
    deleted += 1;
  },
  endpoint(port: number) {
    return { httpUrl: `http://127.0.0.1:${port}`, headers: {} };
  },
};

afterEach(() => {
  mock.restore();
  files.clear();
  calls.length = 0;
  deleted = 0;
});

test("Smol cloud creates a VM with explicit target and byte-exact files", async () => {
  const create = spyOn(Machine, "create").mockResolvedValue(fake as unknown as Machine);
  const provider = smol({
    target: "cloud",
    image: "node:22",
    apiKey: "secret",
    resources: { cpus: 2 },
  });
  expect(provider.capabilities["process.background"]).toBe(false);
  expect(provider.capabilities["process.cancel"]).toBe(false);
  for (const name of capabilityNames) expect(provider.capabilities[name]).toBeDefined();
  expect(supports({ capabilities: provider.capabilities }, "ports.expose")).toBe(false);
  expect(supports({ capabilities: provider.capabilities }, "process.background")).toBe(false);
  const sandbox = await createSandbox({ provider, env: { FOO: "bar" } });
  try {
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ image: "node:22", env: { FOO: "bar" }, resources: { cpus: 2 } }),
      expect.objectContaining({ target: "cloud", apiKey: "secret" }),
    );
    await sandbox.files.write("nested/file.txt", new Uint8Array([0, 255, 1]));
    expect(await sandbox.files.read("nested/file.txt")).toEqual(new Uint8Array([0, 255, 1]));
    expect(await sandbox.files.exists("nested/file.txt")).toBe(true);
    expect(await sandbox.files.exists("missing.txt")).toBe(false);
    expect((await sandbox.run("echo hello", { env: { BAR: "baz" }, timeout: 1500 })).stdout).toBe(
      "hello",
    );
    expect(calls.at(-1)).toEqual({
      args: ["sh", "-lc", "echo hello"],
      options: expect.objectContaining({
        workdir: "/workspace",
        timeout: 2,
        env: { FOO: "bar", BAR: "baz" },
      }),
    });
    expect((await sandbox.files.list()).map((entry) => entry.name)).toEqual(["file.txt", "nested"]);
    await expect(sandbox.processes.start("sleep 60")).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(sandbox.ports.expose(3000)).rejects.toMatchObject({ code: "unsupported" });
    await expect(sandbox.snapshots.restore("ckpt-1")).rejects.toMatchObject({
      code: "unsupported",
    });
  } finally {
    await sandbox.stop();
  }
  expect(deleted).toBe(1);
});

test("Smol cleans up a created VM when setting up the working directory fails", async () => {
  const broken = {
    ...fake,
    async exec() {
      return { success: false, exitCode: 1, stdout: "", stderr: "permission denied" };
    },
  };
  spyOn(Machine, "create").mockResolvedValue(broken as unknown as Machine);
  await expect(createSandbox({ provider: smol() })).rejects.toThrow("permission denied");
  expect(deleted).toBe(1);
});

test("Smol local ports are available only when prepublished", async () => {
  spyOn(Machine, "create").mockResolvedValue(fake as unknown as Machine);
  const provider = smol({ machine: { ports: [{ host: 8901, guest: 3000 }] } });
  expect(provider.capabilities["ports.expose"]).toBe("localhost");
  for (const name of capabilityNames) expect(provider.capabilities[name]).toBeDefined();
  expect(supports({ capabilities: provider.capabilities }, "process.stdin")).toBe(false);
  const sandbox = await createSandbox({ provider });
  try {
    expect((await sandbox.ports.expose(3000)).url).toBe("http://127.0.0.1:3000");
    await expect(sandbox.ports.expose(3001)).rejects.toMatchObject({ code: "unsupported" });
  } finally {
    await sandbox.stop();
  }
});

test("Smol local stream failures reject wait and output", async () => {
  const broken = {
    ...fake,
    async *execStream() {
      yield { kind: "stdout" as const, data: "before" };
      throw new Error("stream lost");
    },
  };
  spyOn(Machine, "create").mockResolvedValue(broken as unknown as Machine);
  const sandbox = await createSandbox({ provider: smol() });
  try {
    const process = await sandbox.processes.start("echo before");
    await expect(process.wait()).rejects.toThrow("stream lost");
    const chunks: string[] = [];
    try {
      for await (const event of process.output()) chunks.push(String(event.data));
      throw new Error("stream error was swallowed");
    } catch (error) {
      expect(String(error)).toContain("stream lost");
    }
    expect(chunks).toEqual(["before"]);
  } finally {
    await sandbox.stop();
  }
});

test("Smol output readers each receive every event, including trailing output after kill", async () => {
  const streaming = {
    ...fake,
    async *execStream(_args: string[], options: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { kind: "stdout" as const, data: "shutdown" };
      yield { kind: "exit" as const, exitCode: 0 };
    },
  };
  spyOn(Machine, "create").mockResolvedValue(streaming as unknown as Machine);
  const sandbox = await createSandbox({ provider: smol() });
  try {
    const process = await sandbox.processes.start("wait");
    const first = process.output()[Symbol.asyncIterator]();
    const second = process.output()[Symbol.asyncIterator]();
    const firstChunk = first.next();
    const secondChunk = second.next();
    await process.kill();
    expect((await firstChunk).value?.data).toBe("shutdown");
    expect((await secondChunk).value?.data).toBe("shutdown");
    expect((await first.next()).done).toBe(true);
    expect((await second.next()).done).toBe(true);
  } finally {
    await sandbox.stop();
  }
});

test("Smol aborts during working-directory setup and deletes the VM", async () => {
  let setupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    setupStarted = resolve;
  });
  const stalled = {
    ...fake,
    async exec(_args: string[], options: { signal: AbortSignal }) {
      setupStarted();
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
  };
  spyOn(Machine, "create").mockResolvedValue(stalled as unknown as Machine);
  const controller = new AbortController();
  const creation = createSandbox({ provider: smol(), signal: controller.signal });
  await started;
  controller.abort(new Error("Canceled during setup"));
  await expect(creation).rejects.toThrow("Canceled during setup");
  expect(deleted).toBe(1);
});

test("Smol creation timeout includes working-directory setup", async () => {
  const stalled = {
    ...fake,
    async exec(_args: string[], options: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { success: true, exitCode: 0, stdout: "", stderr: "" };
    },
  };
  spyOn(Machine, "create").mockResolvedValue(stalled as unknown as Machine);
  await expect(createSandbox({ provider: smol(), timeout: 20 })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(deleted).toBe(1);
});

test("Smol run reports truncated stdout and stderr", async () => {
  for (const field of ["stdoutTruncated", "stderrTruncated"] as const) {
    const truncated = {
      ...fake,
      async exec(args: string[], options: unknown) {
        const result = await fake.exec(args, options);
        return args[0] === "sh" ? { ...result, [field]: true } : result;
      },
    };
    spyOn(Machine, "create").mockResolvedValue(truncated as unknown as Machine);
    const sandbox = await createSandbox({ provider: smol() });
    try {
      await expect(sandbox.run("printf test")).rejects.toMatchObject({ code: "process_failed" });
    } finally {
      await sandbox.stop();
    }
  }
});

test("Smol reports output buffer overflow instead of silently dropping events", async () => {
  const streaming = {
    ...fake,
    async *execStream() {
      for (let i = 0; i < 1025; i++) yield { kind: "stdout" as const, data: `${i}` };
      yield { kind: "exit" as const, exitCode: 0 };
    },
  };
  spyOn(Machine, "create").mockResolvedValue(streaming as unknown as Machine);
  const sandbox = await createSandbox({ provider: smol() });
  try {
    const process = await sandbox.processes.start("produce output");
    await expect(process.wait()).resolves.toEqual({ exitCode: 0 });
    await expect(async () => {
      for await (const _event of process.output()) {
        /* consume all output */
      }
    }).toThrow("earlier output was lost");
  } finally {
    await sandbox.stop();
  }
});

test("Smol propagates caller abort to a local process", async () => {
  const streaming = {
    ...fake,
    async *execStream(_args: string[], options: { signal: AbortSignal }) {
      await new Promise<void>((resolve) =>
        options.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield { kind: "stderr" as const, data: "stopped" };
      yield { kind: "exit" as const, exitCode: 137 };
    },
  };
  spyOn(Machine, "create").mockResolvedValue(streaming as unknown as Machine);
  const sandbox = await createSandbox({ provider: smol() });
  try {
    const controller = new AbortController();
    const process = await sandbox.processes.start("wait", { signal: controller.signal });
    controller.abort();
    expect(await process.wait()).toEqual({ exitCode: 137 });
    expect(await process.status()).toBe("killed");
    const output = [];
    for await (const event of process.output()) output.push(event.data);
    expect(output).toEqual(["stopped"]);
  } finally {
    await sandbox.stop();
  }
});

test("Smol lists unusual filenames and large directories without losing metadata", async () => {
  let statCalls = 0;
  const listing = {
    ...fake,
    async exec(args: string[], options: unknown) {
      if (args[0] === "find") {
        const paths = [
          "/workspace/odd\n name",
          ...Array.from({ length: 63 }, (_, i) => `/workspace/f${i}`),
          "/workspace/alias",
        ];
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stdoutBytes: encoder.encode(`${paths.join("\0")}\0`),
          stderr: "",
          stdoutTruncated: false,
        };
      }
      if (args[0] === "stat") {
        statCalls++;
        const paths = args.slice(4);
        return {
          success: true,
          exitCode: 0,
          stdout: `${paths.map((path) => (path.endsWith("/alias") ? "a1ff 4" : "81a4 5")).join("\n")}\n`,
          stderr: "",
          stdoutTruncated: false,
        };
      }
      return fake.exec(args, options);
    },
  };
  spyOn(Machine, "create").mockResolvedValue(listing as unknown as Machine);
  const sandbox = await createSandbox({ provider: smol() });
  try {
    const entries = await sandbox.files.list();
    expect(entries).toHaveLength(65);
    expect(entries[0]).toEqual({
      name: "odd\n name",
      path: "/workspace/odd\n name",
      type: "file",
      size: 5,
    });
    expect(entries.at(-1)).toEqual({
      name: "alias",
      path: "/workspace/alias",
      type: "symlink",
      size: undefined,
    });
    expect(statCalls).toBe(2);
  } finally {
    await sandbox.stop();
  }
});

test("Smol Cloud rejects ambiguous file paths without writing another path", async () => {
  spyOn(Machine, "create").mockResolvedValue(fake as unknown as Machine);
  const write = spyOn(fake, "writeFile");
  const sandbox = await createSandbox({ provider: smol({ target: "cloud" }) });
  try {
    for (const path of ["line\n break.txt", "fragment#name.txt", "query?name.txt", "percent%20name.txt"]) {
      await expect(sandbox.files.write(path, "contents")).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(sandbox.files.read(path)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    expect(write).not.toHaveBeenCalled();
  } finally {
    await sandbox.stop();
  }
});
