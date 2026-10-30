import { Readable } from "node:stream";
import { afterEach, describe, test, expect, vi } from "vitest";
import {
  apiUrl,
  cleanupMock,
  failure,
  guest,
  mockState,
  MockDaytona,
  MockSandbox,
  requests,
  toolboxFor,
} from "./daytona-mock.js";
import { workspaceCommand } from "../src/providers/daytona/exec.js";
import { daytona } from "../src/providers/daytona/index.js";
import { createSandbox, connectSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const factory = () => daytona({ apiKey: "offline-test-key" });
// live:true authorizes this explicitly mocked cloud transport. Every request goes to the local
// HTTP mock; no cloud calls run, and every conformance case remains enabled.
runConformance(factory, { live: true });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupMock();
});
test("commands without stdin need no directory or empty-file upload", async () => {
  const box = await createSandbox(factory());
  const mkdir = vi.spyOn(guest(box.id).fs, "createFolder");
  const upload = vi.spyOn(guest(box.id).fs, "uploadFiles");
  expect(await box.run("true")).toMatchObject({ ok: true, exitCode: 0 });
  expect(mkdir).not.toHaveBeenCalled();
  expect(upload).not.toHaveBeenCalled();
  expect((await box.run("cat", { stdin: "exact input" })).stdout).toBe("exact input");
  expect(upload).toHaveBeenCalledTimes(1);
});
describe("Daytona mappings", () => {
  test("lazy client, configuration and typed native object", async () => {
    // The deprecated apiUrl alias wins over the environment, which points nowhere here.
    vi.stubEnv("DAYTONA_API_URL", "http://127.0.0.1:9/api");
    const provider = daytona({ apiKey: "key", apiUrl, target: "us", requestTimeoutMs: 1234 });
    expect(requests).toHaveLength(0);
    const box = await createSandbox(provider);
    expect(box.native.sandboxId).toBe(box.id);
    const create = requests.find(
      (request) => request.method === "POST" && request.url === "/api/sandbox",
    );
    expect(create?.headers.authorization).toBe("Bearer key");
    expect(JSON.parse(create?.body.toString() ?? "{}")).toMatchObject({ target: "us" });
    // requestTimeoutMs bounds each control-plane call.
    vi.spyOn(MockDaytona.prototype, "get").mockImplementationOnce(() => new Promise(() => {}));
    const started = Date.now();
    await expect(provider.connect(box.id)).rejects.toMatchObject({
      code: "timeout",
      provider: "daytona",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1200);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  test("environment configuration, missing auth, and sanitized provider errors", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "");
    await expect(createSandbox(daytona())).rejects.toMatchObject({ code: "auth" });
    vi.stubEnv("DAYTONA_API_KEY", "env-key");
    vi.stubEnv("DAYTONA_API_URL", apiUrl);
    vi.stubEnv("DAYTONA_TARGET", "eu");
    const provider = daytona();
    await createSandbox(provider);
    const create = requests.find(
      (request) => request.method === "POST" && request.url === "/api/sandbox",
    );
    expect(create?.headers.authorization).toBe("Bearer env-key");
    expect(JSON.parse(create?.body.toString() ?? "{}")).toMatchObject({ target: "eu" });
    for (const [statusCode, code] of [
      [401, "auth"],
      [403, "auth"],
      [404, "not_found"],
      [429, "quota"],
      [503, "unavailable"],
      [408, "timeout"],
      [400, "invalid_argument"],
    ] as const) {
      // Retried statuses (429, 503) fail on every attempt.
      const get = vi
        .spyOn(MockDaytona.prototype, "get")
        .mockRejectedValue(failure(statusCode, "env-key must not leak"));
      await expect(provider.connect("missing")).rejects.toMatchObject({
        code,
        provider: "daytona",
      });
      get.mockRestore();
    }
    vi.spyOn(MockDaytona.prototype, "get").mockRejectedValueOnce(
      failure(401, "env-key must not leak"),
    );
    try {
      await provider.connect("missing");
    } catch (error) {
      expect(String(error)).not.toContain("env-key");
    }
  });
  test("size, network, labels and native minute timeouts", async () => {
    const provider = daytona({ apiKey: "key", image: "node:22-bookworm" });
    const box = await createSandbox(provider, {
      key: "customer:123",
      size: "medium",
      network: { allow: ["registry.npmjs.org"] },
      idleTimeoutMs: 90_000,
      timeoutMs: 150_000,
    });
    expect(mockState.creates[0]).toMatchObject({
      buildInfo: { dockerfileContent: "FROM node:22-bookworm\n" },
      cpu: 2,
      memory: 4,
      disk: 10,
      domainAllowList: "registry.npmjs.org",
      networkBlockAll: false,
      autoStopInterval: 2,
      ttlMinutes: 2,
      labels: { "sandbox-sdk": "1", "sandbox-sdk-key": "customer:123" },
    });
    expect((await box.preview(3000)).headers).toEqual({
      "X-Daytona-Preview-Token": "mock-preview-token",
    });
    expect((await box.preview(3000)).expiresAt).toBeUndefined();
  });
  test("default snapshots resize before returning and snapshots restore files", async () => {
    const provider = factory();
    const box = await createSandbox(provider, { size: "small", network: "none" });
    expect(await box.native.request("GET", "/sandbox/{sandboxId}")).toMatchObject({
      cpu: 1,
      memory: 1,
      disk: 10,
    });
    expect(mockState.creates[0]).toMatchObject({ networkBlockAll: true });
    expect(box.capabilities.has("pause")).toBe(false);
    expect("pause" in box).toBe(false);
    await box.files.write("retained", "hello");
    const snapshot = await box.snapshot();
    const copy = await createSandbox(provider, { from: snapshot.id });
    expect(await copy.files.read("retained")).toBe("hello");
    const fresh = await connectSandbox(factory(), box.id);
    expect(await fresh.files.read("retained")).toBe("hello");
  });
  test("from restores a snapshot even when the provider has a default image", async () => {
    const provider = daytona({ apiKey: "key", image: "node:22-bookworm" });
    const box = await createSandbox(provider);
    await box.files.write("saved", "snapshot");
    const snapshot = await box.snapshot();
    const restored = await createSandbox(provider, { from: snapshot.id });
    expect(await restored.files.read("saved")).toBe("snapshot");
    expect(mockState.creates[1]).toMatchObject({ snapshot: snapshot.id });
  });
  test("user labels cannot forge SDK keys", async () => {
    const provider = factory();
    await createSandbox(provider, {
      labels: { "sandbox-sdk-key": "forged", "sandbox-sdk": "wrong" },
    });
    expect(await provider.find("forged")).toBeUndefined();
    expect(mockState.creates[0]?.labels).toEqual({
      "sandbox-sdk": "1",
      "code-toolbox-language": "python",
      "sandbox-sdk-create": expect.any(String),
    });
  });
  test("unsupported size, disk shrink, network expressions and sub-minute lifetime fail closed", async () => {
    const provider = factory();
    for (const options of [
      { size: { cpu: 1, memoryMb: 512, diskGb: 10 } },
      { size: { cpu: 1, memoryMb: 1024, diskGb: 1 } },
      { network: { allow: ["example.com,evil.test"] } },
      { timeoutMs: 1000 },
    ])
      await expect(createSandbox(provider, options)).rejects.toMatchObject({ code: "unsupported" });
    expect(mockState.boxes.size).toBe(0);
  });
  test("timeout and abort kill descendants, including delayed launch", async () => {
    const box = await createSandbox(factory());
    mockState.launchDelayMs = 60;
    expect(
      await box.run("(sleep 1; echo leaked > leaked) & wait", { timeoutMs: 20 }),
    ).toMatchObject({ timedOut: true, exitCode: null });
    mockState.launchDelayMs = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await box.files.exists("leaked")).toBe(false);
    const abort = new AbortController();
    abort.abort();
    expect(await box.run("echo bad > preabort", { signal: abort.signal })).toMatchObject({
      timedOut: true,
    });
    expect(await box.files.exists("preabort")).toBe(false);
  });
  test("native monitors survive transport failures and close leaves durable work alive", async () => {
    const provider = factory();
    const box = await createSandbox(provider);
    const hook = await provider.startProcess?.(box.id, {
      command: "sleep .2; echo alive > persisted",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });
    mockState.failStatus = true;
    await new Promise((resolve) => setTimeout(resolve, 300));
    mockState.failStatus = false;
    await expect.poll(() => box.files.read("persisted"), { timeout: 10_000 }).toBe("alive\n");
    await hook?.wait();
    const process = await box.start("sleep .2; echo detached > detached", { name: "durable" });
    await box.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fresh = await connectSandbox(factory(), box.id);
    await expect.poll(() => fresh.files.read("detached"), { timeout: 10_000 }).toBe("detached\n");
    expect((await fresh.process("durable").wait()).exitCode).toBe(0);
    void process;
  });
  test("native stop kills TERM-ignoring descendants after the leader exits", async () => {
    const provider = factory();
    const box = await createSandbox(provider);
    // The descendant outlives the stop's two kill requests even on a loaded machine.
    const hook = await provider.startProcess?.(box.id, {
      command: "(trap '' TERM; sleep 2; echo survived > stubborn) >/dev/null 2>&1 & wait",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await hook?.stop({ graceMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(await box.files.exists("stubborn")).toBe(false);
  });
  test("a failed native stop can be retried", async () => {
    const provider = factory();
    const box = await createSandbox(provider);
    const hook = await provider.startProcess?.(box.id, {
      command: "sleep 2; echo survived > retry-stop",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });
    // A POST is never retried, so one transient failure reaches stop().
    vi.spyOn(guest(box.id).process, "executeCommand").mockRejectedValueOnce(
      failure(503, "transient"),
    );
    await expect(hook?.stop({ graceMs: 10 })).rejects.toMatchObject({ code: "unavailable" });
    await hook?.stop({ graceMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(await box.files.exists("retry-stop")).toBe(false);
  });
  test("cleanup failure preserves the confirmed durable exit record", async () => {
    const box = await createSandbox(factory());
    const proc = await box.start("echo READY; sleep 5; exit 0", {
      name: "cleanup",
      ready: { log: /READY/ },
    });
    vi.spyOn(guest(box.id).process, "deleteSession").mockRejectedValue(
      failure(503, "cleanup unavailable"),
    );
    await proc.wait();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await box.files.read("/tmp/.sandbox-sdk/procs/cleanup/exit")).toBe("0");
    expect((await proc.wait()).exitCode).toBe(0);
  });
  test("stream failures kill the command and map errors", async () => {
    const box = await createSandbox(factory());
    mockState.failLogs = true;
    await expect(
      (async () => {
        // The follow is a GET, so the client retries it twice before giving up: give the command longer than that.
        for await (const chunk of box.run("sleep 2; echo bad > stream-leak")) {
          void chunk;
        }
      })(),
    ).rejects.toMatchObject({ code: "unavailable", provider: "daytona" });
    mockState.failLogs = false;
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    expect(await box.files.exists("stream-leak")).toBe(false);
  });
});

test("session log failures do not affect awaited buffered commands", async () => {
  const box = await createSandbox(factory());
  mockState.failLogs = true;
  const logs = vi.spyOn(guest(box.id).process, "getSessionCommandLogs");
  expect(await box.run("printf buffered")).toMatchObject({
    ok: true,
    exitCode: 0,
    stdout: "buffered",
  });
  expect(logs).not.toHaveBeenCalled();
});

test("creation provisions workspace when the native filesystem cannot create root directories", async () => {
  const create = MockSandbox.create.bind(MockSandbox);
  vi.spyOn(MockSandbox, "create").mockImplementationOnce(async (params) => {
    const guest = await create(params);
    const mkdir = guest.fs.createFolder;
    vi.spyOn(guest.fs, "createFolder").mockImplementation(async (path, mode) => {
      if (path === "/workspace")
        throw failure(400, "bad request: mkdir /workspace: permission denied", {
          code: "BAD_REQUEST",
        });
      return mkdir(path, mode);
    });
    return guest;
  });
  const box = await createSandbox(factory());
  await box.files.write("app/file", "writable");
  expect(await box.files.read("app/file")).toBe("writable");
  expect((await box.run("git init repo")).ok).toBe(true);
});

test("session output preserves exact bytes through newline-normalized native logs", async () => {
  const box = await createSandbox(factory());
  const logs = guest(box.id).process.getSessionCommandLogs;
  vi.spyOn(guest(box.id).process, "getSessionCommandLogs").mockImplementation(
    (session, command, stdout, stderr) =>
      logs(
        session,
        command,
        (text) => stdout(text.endsWith("\n") ? text : text + "\n"),
        (text) => stderr(text.endsWith("\n") ? text : text + "\n"),
      ),
  );
  expect(await box.run("printf exact; printf error >&2")).toMatchObject({
    stdout: "exact",
    stderr: "error",
  });
  expect((await box.run("printf 'retained\\n'")).stdout).toBe("retained\n");
});

test("destroy coalesces overlapping native deletions from separate handles", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  const second = await connectSandbox(provider, box.id);
  const remove = guest(box.id).delete.bind(guest(box.id));
  let active = false;
  const spy = vi.spyOn(guest(box.id), "delete").mockImplementation(async () => {
    if (active) throw failure(409, "Sandbox state change in progress");
    active = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await remove();
  });
  await Promise.all([box.destroy(), second.destroy()]);
  expect(spy).toHaveBeenCalledTimes(1);
});

test("destroy waits for native deletion completion", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  // Daytona answers the DELETE while the sandbox is still `destroying`.
  mockState.deleteDelayMs = 300;
  await box.destroy();
  await expect(provider.connect(box.id)).rejects.toMatchObject({ code: "not_found" });
});

test("framed output retains a leading UTF-8 BOM", async () => {
  const box = await createSandbox(factory());
  expect(
    (await box.run("python3 -c 'import sys; sys.stdout.buffer.write(bytes([239,187,191,120]))'"))
      .stdout,
  ).toBe("\uFEFFx");
});

test("incomplete base64 output fails closed", async () => {
  const box = await createSandbox(factory());
  vi.spyOn(guest(box.id).process, "getSessionCommandLogs").mockImplementation(
    async (_session, _command, stdout) => {
      stdout("O:Y\n");
    },
  );
  await expect(
    (async () => {
      for await (const chunk of box.run("sleep .1")) {
        void chunk;
      }
    })(),
  ).rejects.toMatchObject({ code: "provider" });
});

test("malformed output arriving during exit status lookup cannot report success", async () => {
  const box = await createSandbox(factory());
  const launch = guest(box.id).process.executeSessionCommand;
  vi.spyOn(guest(box.id).process, "executeSessionCommand").mockImplementation(
    async (session, request) => {
      const response = await launch(session, request);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return response;
    },
  );
  let emit = (_text: string) => {};
  let finish = () => {};
  vi.spyOn(guest(box.id).process, "getSessionCommandLogs").mockImplementation(
    async (_session, _command, stdout) => {
      emit = stdout;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  );
  const status = guest(box.id).process.getSessionCommand;
  vi.spyOn(guest(box.id).process, "getSessionCommand").mockImplementation(
    async (session, command) => {
      const result = await status(session, command);
      emit("O:Y\n");
      finish();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { ...result, exitCode: 0 };
    },
  );
  await expect(
    (async () => {
      for await (const chunk of box.run("sleep .2")) {
        void chunk;
      }
    })(),
  ).rejects.toMatchObject({ code: "provider" });
});

test("snapshot waits within snapshotTimeoutMs and exposes its recovery name on failure", async () => {
  const box = await createSandbox(daytona({ apiKey: "key", snapshotTimeoutMs: 1000 }));
  const snapshot = vi.spyOn(guest(box.id), "createSnapshot");
  // Daytona answers at once and reports `snapshotting` until the snapshot is done.
  mockState.snapshotMs = 300;
  const result = await box.snapshot();
  expect(snapshot).toHaveBeenLastCalledWith(result.id);
  mockState.snapshotMs = 5_000;
  for (const [setup, code] of [
    [() => {}, "timeout"],
    [
      () => {
        snapshot.mockRejectedValueOnce(failure(400, "private-native-body"));
      },
      "invalid_argument",
    ],
  ] as const) {
    setup();
    try {
      await box.snapshot();
      throw new Error("expected a failure");
    } catch (error) {
      const name = snapshot.mock.calls.at(-1)?.[0] ?? "";
      expect(name).toMatch(/^sdk-/);
      expect(error).toMatchObject({ code, retryable: false });
      expect(String(error)).toContain(name);
      expect(String(error)).not.toContain("private-native-body");
    }
  }
});

test("the snapshot wait is not bounded by requestTimeoutMs", async () => {
  const box = await createSandbox(daytona({ apiKey: "key", requestTimeoutMs: 200 }));
  try {
    mockState.snapshotMs = 700;
    const snapshot = vi.spyOn(guest(box.id), "createSnapshot");
    const result = await box.snapshot();
    expect(snapshot).toHaveBeenCalledWith(result.id);
  } finally {
    await box.destroy();
  }
});

// Force the core integration marker in this provider-owned test until the core
// writer's matching ExecInput/makeRun change is merged.
import { execute } from "../src/providers/daytona/exec.js";
const bufferedFactory = () => {
  const provider = factory();
  provider.exec = (id, input) => execute(toolboxFor(id), { ...input, streaming: false });
  return provider;
};
describe("Daytona buffered native commands", () => {
  test("one native request preserves exact streams, exit, env and cwd", async () => {
    const box = await createSandbox(bufferedFactory());
    const native = vi.spyOn(guest(box.id).process, "executeCommand");
    const session = vi.spyOn(guest(box.id).process, "createSession");
    expect(
      await box.run("printf '%s' \"$VALUE\"; printf error >&2; exit 7", {
        env: { VALUE: "\uFEFFexact\n" },
      }),
    ).toMatchObject({ stdout: "\uFEFFexact\n", stderr: "error", exitCode: 7, ok: false });
    expect(native).toHaveBeenCalledTimes(1);
    expect(session).not.toHaveBeenCalled();
    expect((await box.run("pwd")).stdout).toBe("/workspace\n");
    expect((await box.run("pwd", { cwd: "missing" })).exitCode).not.toBe(0);
    expect((await box.run("true")).ok).toBe(true);
  });
  test("large output streams the spill file and core retains bounded head and tail", async () => {
    const box = await createSandbox(bufferedFactory());
    const download = vi.spyOn(guest(box.id).fs, "downloadFileStream");
    const result = await box.run(
      'python3 -c \'import sys; sys.stdout.write("HEAD"+"x"*2097152+"TAIL")\'',
      { maxOutputBytes: 1024 },
    );
    expect(result).toMatchObject({ exitCode: 0, truncated: true });
    expect(result.stdout.startsWith("HEAD")).toBe(true);
    expect(result.stdout.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1100);
    expect(download).toHaveBeenCalledTimes(1);
  });
  test("timeout and abort retain partial output and kill descendants", async () => {
    const box = await createSandbox(bufferedFactory());
    // The deadline must leave time for the request to reach the guest and the command to print.
    expect(
      await box.run("printf partial; (sleep 1; echo leaked > buffered-leak) & wait", {
        timeoutMs: 500,
      }),
    ).toMatchObject({ timedOut: true, exitCode: null, stdout: "partial" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      expect(
        await box.run("printf partial; (sleep 1; echo leaked > buffered-abort) & wait", {
          signal: controller.signal,
        }),
      ).toMatchObject({ timedOut: true, exitCode: null, stdout: "partial" });
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await box.files.exists("buffered-leak")).toBe(false);
    expect(await box.files.exists("buffered-abort")).toBe(false);
  });
  test("stdin retains the session transport", async () => {
    const box = await createSandbox(bufferedFactory());
    const session = vi.spyOn(guest(box.id).process, "createSession");
    expect((await box.run("cat", { stdin: "exact" })).stdout).toBe("exact");
    expect(session).toHaveBeenCalledTimes(1);
  });
  test("streaming requests keep sessions and cancellation before native launch prevents side effects", async () => {
    const box = await createSandbox(bufferedFactory());
    const session = vi.spyOn(guest(box.id).process, "createSession");
    await execute(toolboxFor(box.id), {
      command: "true",
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      streaming: true,
      onChunk() {},
    });
    expect(session).toHaveBeenCalledTimes(1);
    const native = guest(box.id).process.executeCommand;
    vi.spyOn(guest(box.id).process, "executeCommand").mockImplementation(
      async (command, cwd, env, timeout) => {
        if (command.includes("python3 -u")) await new Promise((resolve) => setTimeout(resolve, 60));
        return native(command, cwd, env, timeout);
      },
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      expect(
        await box.run("echo bad > late-buffered", { signal: controller.signal }),
      ).toMatchObject({ timedOut: true, exitCode: null });
    } finally {
      clearTimeout(timer);
    }
    expect(await box.files.exists("late-buffered")).toBe(false);
  });
  test("large preset uses matching 4/8/10 snapshot without stop or resize", async () => {
    const resize = vi.spyOn(MockSandbox.prototype, "resize");
    const stop = vi.spyOn(MockSandbox.prototype, "stop");
    const box = await createSandbox(factory(), { size: "large" });
    expect(mockState.creates[0]).toMatchObject({ snapshot: "daytona-large", target: "us" });
    expect(await box.native.request("GET", "/sandbox/{sandboxId}")).toMatchObject({
      cpu: 4,
      memory: 8,
      disk: 10,
    });
    expect(resize).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });
  test("nested writes need only native upload", async () => {
    const box = await createSandbox(factory());
    const mkdir = vi.spyOn(guest(box.id).fs, "createFolder");
    await box.files.write("nested/a/file", "content");
    expect(await box.files.read("nested/a/file")).toBe("content");
    expect(mkdir).not.toHaveBeenCalled();
  });
});

test("completed session output does not wait for a log stream that remains open", async () => {
  const box = await createSandbox(factory());
  const logs = guest(box.id).process.getSessionCommandLogs;
  vi.spyOn(guest(box.id).process, "getSessionCommandLogs").mockImplementation(
    async (session, command, stdout, stderr) => {
      await logs(session, command, stdout, stderr);
      await new Promise<void>(() => {});
    },
  );
  expect(await box.run("printf exact; exit 7", { timeoutMs: 1000 })).toMatchObject({
    stdout: "exact",
    exitCode: 7,
    timedOut: false,
  });
});

test("a fresh sandbox remains discoverable while native listing catches up", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  vi.spyOn(MockDaytona.prototype, "list").mockImplementation(async function* () {});
  expect((await provider.list({})).map((value) => value.id)).toContain(box.id);
  await box.native.request("DELETE", "/sandbox/{sandboxId}");
  expect(await provider.list({})).toEqual([]);
});

test.each(["abort", "deadline"] as const)(
  "buffered spill download settles and destroys its stream on %s",
  async (mode) => {
    const box = await createSandbox(bufferedFactory());
    const controller = new AbortController();
    const stalled = new Readable({ read() {} });
    const download = vi
      .spyOn(guest(box.id).fs, "downloadFileStream")
      .mockImplementationOnce(async () => {
        if (mode === "abort") setTimeout(() => controller.abort(), 10);
        return stalled;
      });
    const pending = Promise.resolve(
      box.run("python3 -c 'print(\"x\"*100000)'", {
        signal: controller.signal,
        timeoutMs: mode === "deadline" ? 1000 : 2000,
      }),
    );
    let clearWatchdog = () => {};
    try {
      const result = await Promise.race([
        pending,
        new Promise<undefined>((resolve) => {
          const watchdog = setTimeout(resolve, mode === "deadline" ? 1500 : 500);
          clearWatchdog = () => clearTimeout(watchdog);
        }),
      ]);
      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      expect(download).toHaveBeenCalledTimes(1);
      // The client closed the download, so the guest's stream was torn down with it.
      await expect.poll(() => stalled.destroyed, { timeout: 2_000 }).toBe(true);
    } finally {
      clearWatchdog();
      stalled.destroy();
      await pending.catch(() => {});
    }
  },
);

test("activity survives shell exit until inherited pipes drain on both transports", async () => {
  const box = await createSandbox(factory());
  try {
    for (const streaming of [false, true]) {
      const active = `/tmp/.sandbox-sdk/runs/activity-${crypto.randomUUID()}`;
      const provider = factory();
      await provider.connect(box.id);
      let finished = false;
      const run = provider
        .exec(box.id, {
          command: "(sleep .3; printf tail) &",
          cwd: "/workspace",
          env: {},
          timeoutMs: 3000,
          streaming,
          activityPath: active,
          onChunk() {},
        })
        .finally(() => {
          finished = true;
        });
      await expect
        .poll(
          async () => {
            try {
              await provider.files.stat(box.id, active);
              return true;
            } catch {
              return false;
            }
          },
          { interval: 10, timeout: 2000 },
        )
        .toBe(true);
      expect(finished).toBe(false);
      expect(await run).toMatchObject({ exitCode: 0, timedOut: false });
      await expect(provider.files.stat(box.id, active)).rejects.toMatchObject({
        code: "file_not_found",
      });
    }
  } finally {
    await box.destroy();
  }
});

test("fresh workspace supports first file operations and reconnect before execution", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  try {
    expect((await box.files.stat(".")).type).toBe("directory");
    expect(await box.files.exists(".")).toBe(true);
    expect(await box.files.list(".")).toEqual([]);
    await box.files.write("nested/first.bin", new Uint8Array([0, 255, 10]));
    expect(await box.files.read("nested/first.bin", { as: "bytes" })).toEqual(
      new Uint8Array([0, 255, 10]),
    );
    const fresh = factory();
    await fresh.connect(box.id);
    expect(
      await fresh.exec(box.id, {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 3000,
        onChunk() {},
      }),
    ).toMatchObject({ exitCode: 0 });
  } finally {
    await box.destroy();
  }
});

test("aborted first execution keeps workspace preparation for the next call", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  try {
    expect(
      await provider.exec(box.id, {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 3000,
        signal: AbortSignal.abort(),
        onChunk() {},
      }),
    ).toMatchObject({ timedOut: true });
    expect(
      await provider.exec(box.id, {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 3000,
        onChunk() {},
      }),
    ).toMatchObject({ exitCode: 0 });
  } finally {
    await box.destroy();
  }
});

test("first mkdir prepares nested paths and removing a fresh workspace stays removed", async () => {
  const provider = factory();
  const first = await createSandbox(provider);
  const second = await createSandbox(provider);
  try {
    await provider.files.mkdir(first.id, "/workspace/nested/dir");
    expect((await first.files.stat("nested/dir")).type).toBe("directory");
    await second.files.remove(".", { recursive: true });
    expect(await second.files.exists(".")).toBe(false);
  } finally {
    await first.destroy();
    await second.destroy();
  }
});

test("fresh workspace handles verified missing-path HTTP 400 without swallowing other bad requests", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  try {
    const missing = () =>
      failure(400, "open /workspace: no such file or directory", { code: "BAD_REQUEST" });
    vi.spyOn(guest(box.id).fs, "listFiles").mockRejectedValue(missing());
    vi.spyOn(guest(box.id).fs, "getFileDetails").mockRejectedValue(missing());
    expect(await box.files.list(".")).toEqual([]);
    expect((await box.files.stat(".")).type).toBe("directory");
    expect(await box.files.exists(".")).toBe(true);
    vi.spyOn(guest(box.id).fs, "deleteFile").mockRejectedValue(missing());
    await box.files.remove(".", { recursive: true });
    expect(await box.files.exists(".")).toBe(false);
    vi.mocked(guest(box.id).fs.listFiles).mockRejectedValue(
      failure(400, "invalid path argument", { code: "BAD_REQUEST" }),
    );
    await expect(box.files.list(".")).rejects.toMatchObject({ code: "invalid_argument" });
  } finally {
    await box.destroy();
  }
});

test("failed first session setup is retried before the next command", async () => {
  const box = await createSandbox(factory());
  const native = guest(box.id);
  const execute = native.process.executeSessionCommand.bind(native.process);
  vi.spyOn(native.process, "executeSessionCommand").mockImplementationOnce((id, input) =>
    execute(id, { ...input, command: input.command.replace(workspaceCommand, "false") }),
  );
  expect((await box.run("true", { stdin: "" })).exitCode).toBe(1);
  expect(await box.run("pwd")).toMatchObject({ ok: true, stdout: "/workspace\n" });
});

test("successful session setup survives a nonzero user command", async () => {
  const box = await createSandbox(factory());
  expect((await box.run("exit 7", { stdin: "" })).exitCode).toBe(7);
  await box.native.request("DELETE", "/files", {
    plane: "toolbox",
    query: { path: "/workspace", recursive: true },
  });
  expect((await box.run("true", { stdin: "", cwd: "/" })).ok).toBe(true);
  expect(await box.files.exists("/workspace")).toBe(false);
});
