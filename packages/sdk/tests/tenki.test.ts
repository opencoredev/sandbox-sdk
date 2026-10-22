import type { ProcessRunResult } from "@tenkicloud/sandbox";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanupTenki, MockSession, MockTenki, tenkiState } from "./tenki-mock.js";
import { tenki } from "../src/providers/tenki/index.js";
import { createSandbox, connectSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
vi.mock("@tenkicloud/sandbox", async () => ({
  TenkiSandbox: (await import("./tenki-mock.js")).MockTenki,
}));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const factory = () => tenki({ authToken: "offline-test-key" });
runConformance(factory, { live: true });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupTenki();
});
describe("Tenki mappings", () => {
  test("concurrent handles share one VM termination", async () => {
    const provider = factory();
    const first = await createSandbox(provider);
    const second = await connectSandbox(provider, first.id);
    const current = tenkiState.boxes.get(first.id);
    if (!current) throw new Error("Missing mock session");
    const close = current.close.bind(current);
    let terminating = false;
    const terminate = vi.spyOn(current, "close").mockImplementation(async () => {
      if (terminating)
        throw Object.assign(new Error("already terminating"), { name: "InvalidStateError" });
      terminating = true;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await close();
    });
    await Promise.all([first.destroy(), second.destroy(), provider.destroy(first.id)]);
    expect(terminate).toHaveBeenCalledOnce();
    await provider.destroy(first.id);
  });
  test("command output preserves leading BOM, CRLF and trailing newlines", async () => {
    const box = await createSandbox(factory());
    const result = await box.run(
      'python3 -c "import os; os.write(1, bytes([239,187,191,65,13,10,10])); os.write(2, bytes([239,187,191,66,13,10]))"',
    );
    expect(result.stdout).toBe("\uFEFFA\r\n\n");
    expect(result.stderr).toBe("\uFEFFB\r\n");
  });
  test("lazy optional SDK, typed native session, resources, network and timeouts", async () => {
    const provider = tenki({
      authToken: "key",
      baseUrl: "https://api.example.test",
      image: "custom",
      requestTimeoutMs: 5000,
    });
    expect(tenkiState.configs).toHaveLength(0);
    const box = await createSandbox(provider, {
      key: "customer:42",
      size: "medium",
      timeoutMs: 150000,
      network: { allow: ["registry.npmjs.org"] },
    });
    expect(box.native.id).toBe(box.id);
    expect(tenkiState.configs[0]).toMatchObject({
      authToken: "key",
      baseUrl: "https://api.example.test",
    });
    expect(tenkiState.creates[0]).toMatchObject({
      cpuCores: 2,
      memoryMb: 4096,
      diskSizeGb: 20,
      maxDurationMs: 150000,
      sticky: false,
      allowDomains: ["registry.npmjs.org"],
      allowOutbound: true,
      image: "custom",
      metadata: { "sandbox-sdk": "1", "sandbox-sdk-key": "customer:42" },
    });
    expect((await box.preview(3000)).expiresAt).toBeGreaterThan(Date.now());
  });
  test("pause/resume preserves files and durable process records; snapshot restores", async () => {
    const provider = factory();
    const box = await createSandbox(provider);
    await box.files.write("retained", "hello");
    const proc = await box.start("sleep .3; echo complete", { name: "durable" });
    await box.pause();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await provider.connect(box.id)).state).toBe("paused");
    await box.resume();
    expect((await box.processes()).map((value) => value.name)).toContain("durable");
    expect((await box.process("durable").wait()).exitCode).toBe(0);
    expect((await proc.logs()).text).toContain("complete");
    const snapshot = await box.snapshot();
    const copy = await createSandbox(tenki({ authToken: "key", image: "ignored" }), {
      from: snapshot.id,
    });
    expect(await copy.files.read("retained")).toBe("hello");
    expect(tenkiState.creates[1]?.image).toBeUndefined();
    await box.close();
    const fresh = await connectSandbox(factory(), box.id);
    expect(await fresh.files.read("retained")).toBe("hello");
  });
  test("unsupported idle timeout, sizes and malformed allow lists fail before allocation", async () => {
    for (const input of [
      { idleTimeoutMs: 60000 },
      { size: { cpu: 1, memoryMb: 513, diskGb: 10 } },
      { network: { allow: ["https://example.com"] } },
    ])
      await expect(createSandbox(factory(), input)).rejects.toMatchObject({ code: "unsupported" });
    expect(tenkiState.creates).toHaveLength(0);
    await createSandbox(factory(), { network: { allow: [] } });
    expect(tenkiState.creates[0]?.allowOutbound).toBe(false);
  });
  test("reserved metadata cannot forge SDK keys or timestamps", async () => {
    const provider = factory();
    await createSandbox(provider, {
      labels: {
        "sandbox-sdk-key": "forged",
        "sandbox-sdk-created-at": "wrong",
        "sandbox-sdk": "wrong",
      },
    });
    expect(await provider.find("forged")).toBeUndefined();
    expect(Number(tenkiState.creates[0]?.metadata?.["sandbox-sdk-created-at"])).toBeGreaterThan(0);
  });
  test("request deadlines reject stalled creates and clean up late sessions", async () => {
    const close = vi.spyOn(MockSession.prototype, "close");
    vi.spyOn(MockTenki.prototype, "create").mockImplementationOnce(
      () => new Promise<MockSession>(() => {}),
    );
    const started = Date.now();
    await expect(
      createSandbox(tenki({ authToken: "key", requestTimeoutMs: 20 })),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(500);
    vi.spyOn(MockTenki.prototype, "create").mockImplementationOnce(async (params) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return MockSession.create(params ?? {});
    });
    await expect(
      createSandbox(tenki({ authToken: "key", requestTimeoutMs: 20 })),
    ).rejects.toMatchObject({ code: "timeout" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(close).toHaveBeenCalledOnce();
    expect(tenkiState.boxes.size).toBe(0);
  });
  test("control-plane methods and readiness waits enforce adapter deadlines", async () => {
    const provider = tenki({
      authToken: "key",
      requestTimeoutMs: 100,
      waitTimeoutMs: 20,
      resumeTimeoutMs: 100,
    });
    const box = await createSandbox(provider);
    const current = tenkiState.boxes.get(box.id);
    if (!current) throw new Error("Missing mock session");
    vi.spyOn(MockTenki.prototype, "list").mockImplementationOnce(() => new Promise(() => {}));
    await expect(provider.list({})).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(MockTenki.prototype, "get").mockImplementationOnce(() => new Promise(() => {}));
    await expect(provider.connect(box.id)).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(current, "pause").mockImplementationOnce(() => new Promise(() => {}));
    await expect(provider.pause?.(box.id)).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(current, "resume").mockImplementationOnce(() => new Promise(() => {}));
    await expect(provider.resume?.(box.id)).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(current, "exposePort").mockImplementationOnce(() => new Promise(() => {}));
    await expect(provider.previewUrl(box.id, 3000)).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(MockTenki.prototype, "createSnapshot").mockImplementationOnce(
      () => new Promise(() => {}),
    );
    await expect(provider.snapshot?.(box.id)).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(current, "close").mockImplementationOnce(() => new Promise(() => {}));
    await expect(provider.destroy(box.id)).rejects.toMatchObject({ code: "timeout" });
    vi.spyOn(MockSession.prototype, "waitReady").mockImplementationOnce(
      () => new Promise(() => {}),
    );
    await expect(createSandbox(provider)).rejects.toMatchObject({ code: "timeout" });
  });
  test("readiness failure and cancellation clean up allocated VMs", async () => {
    tenkiState.failReady = true;
    await expect(createSandbox(factory())).rejects.toMatchObject({ code: "provider" });
    expect(tenkiState.boxes.size).toBe(0);
    tenkiState.failReady = false;
    tenkiState.delayMs = 30;
    const controller = new AbortController();
    const pending = createSandbox(factory(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(tenkiState.boxes.size).toBe(0);
  });
  test("timeout and abort kill descendants, including TERM-ignoring children", async () => {
    const box = await createSandbox(factory());
    const command = "(trap '' TERM; sleep .2; echo leaked > leaked) & wait";
    expect(await box.run(command, { timeoutMs: 20 })).toMatchObject({
      timedOut: true,
      exitCode: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await box.files.exists("leaked")).toBe(false);
    const controller = new AbortController();
    const result = Promise.resolve(box.run(command, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await result).toMatchObject({ timedOut: true, exitCode: null });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await box.files.exists("leaked")).toBe(false);
    expect(await box.run("exit 124")).toMatchObject({ timedOut: false, exitCode: 124 });
  });
  test("policy or size mismatches destroy the VM instead of silently accepting them", async () => {
    vi.spyOn(MockTenki.prototype, "create").mockImplementationOnce(async (params) => {
      const value = await MockSession.create(params ?? {});
      value.outboundEnabled = true;
      return value;
    });
    await expect(createSandbox(factory(), { network: "none" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(tenkiState.boxes.size).toBe(0);
    vi.spyOn(MockTenki.prototype, "create").mockImplementationOnce(async (params) => {
      const value = await MockSession.create(params ?? {});
      value.cpuCores = 99;
      return value;
    });
    await expect(createSandbox(factory(), { size: "small" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(tenkiState.boxes.size).toBe(0);
  });
  test("huge output uses bounded native capture while streaming all bytes", async () => {
    const box = await createSandbox(factory());
    tenkiState.retainedPeakBytes = 0;
    const bytes = 2 * 1024 * 1024;
    const handle = box.run(
      `printf begin; sleep .05; head -c ${bytes} /dev/zero | tr '\\0' x; printf end; printf err >&2`,
      { maxOutputBytes: 1024 },
    );
    let streamed = 0;
    for await (const chunk of handle) streamed += Buffer.byteLength(chunk.text);
    const result = await handle;
    expect(result).toMatchObject({ exitCode: 0, truncated: true, stderr: "err" });
    expect(result.stdout).toMatch(/^begin.*end$/s);
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(1200);
    expect(streamed).toBe(bytes + 11);
    // The mock deliberately retains chunks just like native run(), even when drained.
    expect(tenkiState.retainedPeakBytes).toBeLessThan(128 * 1024);
  });
  test("stalled termination streams settle after the cancellation grace period", async () => {
    tenkiState.streaming = false;
    const provider = factory();
    const box = await createSandbox(provider);
    const run = MockSession.prototype.run;
    let transportSignal: AbortSignal | undefined;
    const events: string[] = [];
    vi.spyOn(MockSession.prototype, "run").mockImplementation(
      function (this: MockSession, argv, options) {
        const handle = run.call(this, argv, options);
        if (argv[2]?.includes("PID unavailable")) {
          return Object.assign(
            Promise.resolve(handle).then((result) => {
              if (result.exitCode === 0) events.push("kill confirmed");
              return result;
            }),
            { ...handle },
          );
        }
        if (!argv[2]?.includes("subprocess.Popen")) return handle;
        transportSignal = options?.signal;
        transportSignal?.addEventListener("abort", () => events.push("transport aborted"), {
          once: true,
        });
        void Promise.resolve(handle).catch(() => {});
        return Object.assign(new Promise<ProcessRunResult>(() => {}), {
          ...handle,
          stdout: new ReadableStream<Uint8Array>({
            cancel() {
              events.push("stdout cancelled");
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            cancel() {
              events.push("stderr cancelled");
            },
          }),
        });
      },
    );
    const started = Date.now();
    // Exercise the adapter deadline: box.run's timer also includes activity-file
    // setup and may expire before the supervisor is ever launched.
    const pending = provider.exec(box.id, {
      command: "sleep 20",
      cwd: "/workspace",
      env: {},
      timeoutMs: 50,
      onChunk() {},
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        pending,
        new Promise<"hung">((resolve) => {
          watchdog = setTimeout(() => resolve("hung"), 1800);
        }),
      ]);
      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      expect(Date.now() - started).toBeLessThan(1800);
      expect(transportSignal).toBeInstanceOf(AbortSignal);
      expect(transportSignal?.aborted).toBe(true);
      expect(events).toEqual([
        "kill confirmed",
        "transport aborted",
        "stdout cancelled",
        "stderr cancelled",
      ]);
    } finally {
      clearTimeout(watchdog);
    }
  });
  test("literal SDK paths in user commands are preserved", async () => {
    const box = await createSandbox(factory());
    expect((await box.run("printf '%s' '/tmp/.sandbox-sdk/value'")).stdout).toBe(
      "/tmp/.sandbox-sdk/value",
    );
  });
  test("command environment and stdin never enter the supervisor argv", async () => {
    const box = await createSandbox(factory(), { secrets: { TOKEN: "private-argv-check" } });
    const argv = await box.run("cat /proc/$PPID/cmdline");
    expect(argv.stdout).not.toContain("[REDACTED]");
    const input = "private-input-check";
    const result = await box.run("cat", { stdin: input });
    expect(result.stdout).toBe(input);
  });
  test("missing auth and native error names map without leaking native messages", async () => {
    vi.stubEnv("TENKI_API_KEY", "");
    vi.stubEnv("TENKI_AUTH_TOKEN", "");
    await expect(createSandbox(tenki())).rejects.toMatchObject({ code: "auth" });
    for (const [name, code] of [
      ["UnauthorizedError", "auth"],
      ["SessionNotFoundError", "not_found"],
      ["QuotaExceededError", "quota"],
      ["CapacityUnavailableError", "unavailable"],
      ["CommandTimeoutError", "timeout"],
    ]) {
      vi.spyOn(MockTenki.prototype, "get").mockRejectedValueOnce(
        Object.assign(new Error("secret-key must not leak"), { name }),
      );
      const error = await factory()
        .connect("missing")
        .catch((error) => error);
      expect(error).toMatchObject({ code, provider: "tenki" });
      expect(String(error)).not.toContain("secret-key");
    }
  });
});

test("resume RPC has its own bounded budget before readiness", async () => {
  const provider = tenki({
    authToken: "key",
    requestTimeoutMs: 100,
    waitTimeoutMs: 1000,
    resumeTimeoutMs: 400,
  });
  const box = await createSandbox(provider);
  const resume = vi.spyOn(box.native, "resume").mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await box.resume();
  expect(resume).toHaveBeenCalledTimes(1);
  expect((await box.run("echo usable")).stdout).toBe("usable\n");
  resume.mockImplementationOnce(() => new Promise(() => {}));
  await expect(box.resume()).rejects.toMatchObject({ code: "timeout" });
});

test("pause RPC uses the lifecycle budget rather than the ordinary request deadline", async () => {
  const provider = tenki({ authToken: "key", requestTimeoutMs: 100, waitTimeoutMs: 400 });
  const box = await createSandbox(provider);
  vi.spyOn(box.native, "pause").mockImplementationOnce(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
  await box.pause();
});
test("transition budgets reject unbounded values before allocation", async () => {
  for (const value of [0, Infinity, -1, 900001]) {
    await expect(
      createSandbox(tenki({ authToken: "key", resumeTimeoutMs: value })),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      createSandbox(tenki({ authToken: "key", waitTimeoutMs: value })),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }
});

test("Tenki listing skips SDK entries with missing creation metadata", async () => {
  const box = await createSandbox(factory());
  const native = tenkiState.boxes.get(box.id);
  if (!native) throw new Error("Missing mock session");
  for (const key of Object.keys(native.metadata))
    if (key !== "sandbox-sdk") delete native.metadata[key];
  expect(await factory().list({})).toEqual([]);
  vi.spyOn(MockTenki.prototype, "list").mockRejectedValue(
    Object.assign(new Error("denied"), { name: "UnauthorizedError" }),
  );
  await expect(factory().list({})).rejects.toMatchObject({ code: "auth" });
});

test("explicit resources map correctly and omitted disk defaults to five GiB", async () => {
  const provider = factory();
  const size = { cpu: 4, memoryMb: 8192, diskGb: 5 };
  await provider.create({ labels: {}, size });
  expect(tenkiState.creates.at(-1)).toMatchObject({ cpuCores: 4, memoryMb: 8192, diskSizeGb: 5 });
  Reflect.deleteProperty(size, "diskGb");
  await provider.create({ labels: {}, size });
  expect(tenkiState.creates.at(-1)).toMatchObject({ cpuCores: 4, memoryMb: 8192, diskSizeGb: 5 });
});

test("quiet commands use one non-buffering Run stream without polling or cleanup RPCs", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  const run = vi.spyOn(MockSession.prototype, "run");
  expect(
    await provider.exec(box.id, {
      command: "true",
      cwd: "/workspace",
      env: {},
      timeoutMs: 1000,
      onChunk() {},
    }),
  ).toEqual({ exitCode: 0, timedOut: false });
  expect(run).not.toHaveBeenCalled();
});

test("native file transfers follow a retargeted workspace alongside exec and stat", async () => {
  const box = await createSandbox(factory());
  await box.run(
    "mkdir -p /home/tenki/alternate; rm /workspace; ln -s /home/tenki/alternate /workspace",
    { cwd: "/home/tenki" },
  );
  await box.files.write("nested/value", "native");
  expect(await box.files.read("nested/value")).toBe("native");
  expect((await box.run("cat nested/value")).stdout).toBe("native");
  expect((await box.files.stat("nested/value")).size).toBe(6);
});

test("stalled native transfers retain the thirty-second deadline", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  vi.spyOn(box.native, "readFile").mockImplementationOnce(() => new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const read = expect(provider.files.read(box.id, "/home/tenki/value")).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.advanceTimersByTimeAsync(30_001);
    await read;
  } finally {
    vi.useRealTimers();
  }
});

test.each(["complete", "reject"])(
  "expired native writes drain late %s before reporting their outcome",
  async (outcome) => {
    const provider = factory();
    const box = await createSandbox(provider);
    const events: string[] = [];
    let settle = () => {};
    vi.spyOn(box.native, "writeFile").mockImplementationOnce(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = () => {
            events.push("native settled");
            if (outcome === "reject")
              reject(
                Object.assign(new Error("late authorization failure"), {
                  name: "UnauthorizedError",
                }),
              );
            else resolve();
          };
        }),
    );
    const fallback = vi.spyOn(MockSession.prototype, "run");
    vi.useFakeTimers();
    const pending = provider.files.write(box.id, "/home/tenki/late-write", new Uint8Array([1]));
    const checked = expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });
    void pending.then(
      () => events.push("caller succeeded"),
      () => events.push("caller failed"),
    );
    try {
      await vi.advanceTimersByTimeAsync(30_001);
      expect(events).toEqual([]);
      settle();
      await checked;
      expect(events).toEqual(["native settled", "caller failed"]);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      settle();
      await pending.catch(() => {});
      vi.useRealTimers();
    }
  },
);

test.each([16, 14, 12, 5])(
  "retries a rejected pre-launch stream once without terminating the sandbox (RPC %s)",
  async (code) => {
    const provider = factory();
    const box = await createSandbox(provider);
    const close = vi.spyOn(box.native, "close");
    const renew = vi.spyOn(box.native, "reauthOnUnauthenticated").mockResolvedValue(code === 16);
    const refresh = vi.spyOn(box.native, "refreshHintedDataPlane");
    tenkiState.streamAttempts = 0;
    tenkiState.streamFailures.push({
      phase: "before-start",
      error: Object.assign(new Error(code === 12 ? "404 route not ready" : "session not found"), {
        code,
      }),
    });
    expect(
      await provider.exec(box.id, {
        command: "printf once >> recovery-count",
        cwd: "/workspace",
        env: {},
        timeoutMs: 5000,
        onChunk() {},
      }),
    ).toEqual({ exitCode: 0, timedOut: false });
    expect(tenkiState.streamAttempts).toBe(2);
    expect(renew).toHaveBeenCalledTimes(code === 16 ? 1 : 0);
    if (code === 5) expect(refresh).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(await box.files.read("recovery-count")).toBe("once");
  },
);

test("repeated pre-launch auth rejection returns auth after one renewal without closing the VM", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  const close = vi.spyOn(box.native, "close");
  const renew = vi.spyOn(box.native, "reauthOnUnauthenticated").mockResolvedValue(true);
  tenkiState.streamAttempts = 0;
  for (let i = 0; i < 2; i++)
    tenkiState.streamFailures.push({
      phase: "before-start",
      error: Object.assign(new Error("expired credential"), { code: 16 }),
    });
  await expect(
    provider.exec(box.id, {
      command: "touch never-launched",
      cwd: "/workspace",
      env: {},
      timeoutMs: 5000,
      onChunk() {},
    }),
  ).rejects.toMatchObject({ code: "auth" });
  expect(renew).toHaveBeenCalledOnce();
  expect(tenkiState.streamAttempts).toBe(2);
  expect(close).not.toHaveBeenCalled();
  expect(await box.files.exists("never-launched")).toBe(false);
});

test.each([16, 14])(
  "never replays a command after its input was submitted (RPC %s)",
  async (code) => {
    const provider = factory();
    const box = await createSandbox(provider);
    const close = vi.spyOn(box.native, "close");
    const renew = vi.spyOn(box.native, "reauthOnUnauthenticated").mockResolvedValue(true);
    tenkiState.streamAttempts = 0;
    tenkiState.streamFailures.push({
      phase: "after-input",
      error: Object.assign(new Error("connection rejected after submission"), { code }),
    });
    await expect(
      provider.exec(box.id, {
        command: "sleep 2; touch leaked-after-rejection",
        cwd: "/workspace",
        env: {},
        timeoutMs: 5000,
        onChunk() {},
      }),
    ).rejects.toBeDefined();
    expect(tenkiState.streamAttempts).toBe(1);
    expect(renew).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(await box.files.exists("leaked-after-rejection")).toBe(false);
  },
);

test.each([
  [16, "credential rejected"],
  [12, "HTTP 404 route not ready"],
  [5, "session not found"],
  [14, "NGHTTP2_REFUSED_STREAM"],
])(
  "recovers an explicit RPC rejection after body submission but before any response (%s)",
  async (code, message) => {
    const provider = factory();
    tenkiState.streaming = false;
    const box = await createSandbox(provider);
    tenkiState.streaming = true;
    const close = vi.spyOn(box.native, "close");
    const renew = vi.spyOn(box.native, "reauthOnUnauthenticated").mockResolvedValue(true);
    tenkiState.streamAttempts = 0;
    tenkiState.streamFailures.push({
      phase: "before-response",
      error: Object.assign(new Error(message), { code }),
    });
    expect(
      await provider.exec(box.id, {
        command: "printf once >> no-handshake-count",
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
        onChunk() {},
      }),
    ).toEqual({ exitCode: 0, timedOut: false });
    expect(tenkiState.streamAttempts).toBe(2);
    expect(renew).toHaveBeenCalledTimes(code === 16 ? 1 : 0);
    expect(close).not.toHaveBeenCalled();
    expect(await box.files.read("no-handshake-count")).toBe("once");
  },
);

test.each(["connection reset", "GOAWAY", "service unavailable"])(
  "does not replay or destroy the VM when submission has an uncertain outcome (%s)",
  async (message) => {
    const provider = factory();
    tenkiState.streaming = false;
    const box = await createSandbox(provider);
    tenkiState.streaming = true;
    const close = vi.spyOn(box.native, "close");
    const renew = vi.spyOn(box.native, "reauthOnUnauthenticated");
    tenkiState.streamAttempts = 0;
    tenkiState.streamFailures.push({
      phase: "before-response",
      error: Object.assign(new Error(message), { code: 14 }),
    });
    await expect(
      provider.exec(box.id, {
        command: "touch uncertain-launch",
        cwd: "/workspace",
        env: {},
        timeoutMs: 1000,
        onChunk() {},
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(tenkiState.streamAttempts).toBe(1);
    expect(renew).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect((await box.run("true")).exitCode).toBe(0);
  },
);

test("workspace transfers use one native call each after create, without guest path probes", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  const run = vi.spyOn(MockSession.prototype, "run");
  const write = vi.spyOn(MockSession.prototype, "writeFile");
  const read = vi.spyOn(MockSession.prototype, "readFile");
  for (let i = 0; i < 2; i++) {
    const bytes = new Uint8Array([i, 2, 3]);
    await provider.files.write(box.id, "/workspace/nested/value", bytes);
    expect(await provider.files.read(box.id, "/workspace/nested/value")).toEqual(bytes);
  }
  expect(write).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledTimes(2);
  expect(run).not.toHaveBeenCalled();
});

test("connect resolves a custom workspace once and resume refreshes the cached alias", async () => {
  const original = factory();
  const box = await createSandbox(original);
  await box.run("mkdir -p /home/tenki/custom; rm /workspace; ln -s /home/tenki/custom /workspace", {
    cwd: "/home/tenki",
  });
  const provider = factory();
  await provider.connect(box.id);
  const run = vi.spyOn(MockSession.prototype, "run");
  await provider.files.write(box.id, "/workspace/value", new Uint8Array([1]));
  expect(await provider.files.read(box.id, "/workspace/value")).toEqual(new Uint8Array([1]));
  expect(run).not.toHaveBeenCalled();
  await provider.pause?.(box.id);
  await provider.resume?.(box.id);
  run.mockClear();
  expect(await provider.files.read(box.id, "/workspace/value")).toEqual(new Uint8Array([1]));
  expect(run).not.toHaveBeenCalled();
});

test("removing the workspace alias invalidates the native root", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  await box.files.write("original", "old root");
  await provider.files.remove(box.id, "/workspace", { recursive: false });
  await provider.files.mkdir(box.id, "/workspace");
  const write = vi.spyOn(MockSession.prototype, "writeFile");
  const read = vi.spyOn(MockSession.prototype, "readFile");
  await box.files.write("replacement", "new root");
  expect(await box.files.read("replacement")).toBe("new root");
  expect(write).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(await box.files.exists("original")).toBe(false);
});

test("native symlink-escape rejection falls back to the logical workspace path", async () => {
  const box = await createSandbox(factory());
  await box.run("mkdir -p /tmp/sdk-bare; ln -s /tmp/sdk-bare escape");
  const denied = () =>
    Object.assign(new Error("outside native root"), { name: "PermissionDeniedError" });
  const write = vi.spyOn(MockSession.prototype, "writeFile").mockRejectedValueOnce(denied());
  const read = vi.spyOn(MockSession.prototype, "readFile").mockRejectedValueOnce(denied());
  await box.files.write("escape/value", "escaped");
  expect(await box.files.read("escape/value")).toBe("escaped");
  expect(write).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  expect((await box.run("cat /tmp/sdk-bare/value")).stdout).toBe("escaped");
});

test("overlapping command responses cannot repopulate the root cache out of order", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  let ready = () => {};
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  tenkiState.streamExitWaits.push(async () => {
    ready();
    await gate;
  });
  const old = box.run("true").then((result) => result);
  try {
    await waiting;
    await box.run(
      "mkdir -p /home/tenki/new-root; rm /workspace; ln -s /home/tenki/new-root /workspace",
      { cwd: "/home/tenki" },
    );
  } finally {
    release();
  }
  await old;
  const native = vi.spyOn(MockSession.prototype, "writeFile");
  await box.files.write("after-overlap", "new root");
  expect(native).not.toHaveBeenCalled();
  expect((await box.run("cat after-overlap")).stdout).toBe("new root");
});

test("retained native handles keep the workspace cache disabled after ordinary commands", async () => {
  const box = await createSandbox(factory());
  const native = box.native;
  await box.run("true");
  await native.run(
    [
      "sh",
      "-c",
      "mkdir -p /home/tenki/native-root; rm /workspace; ln -s /home/tenki/native-root /workspace",
    ],
    { privileged: true },
  );
  const write = vi.spyOn(MockSession.prototype, "writeFile");
  await box.files.write("native-mutation", "new root");
  expect(write).not.toHaveBeenCalled();
  expect((await box.run("cat native-mutation")).stdout).toBe("new root");
});

test("removing an intermediate workspace symlink invalidates its resolved root", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  await box.run(
    "mkdir -p /home/tenki/actual; ln -s /home/tenki/actual /home/tenki/alias; rm /workspace; ln -s /home/tenki/alias /workspace",
    { cwd: "/home/tenki" },
  );
  await box.files.write("value", "old root");
  await provider.files.remove(box.id, "/home/tenki/alias", { recursive: false });
  const read = vi.spyOn(MockSession.prototype, "readFile");
  await expect(box.files.read("value")).rejects.toMatchObject({ code: "file_not_found" });
  expect(read).not.toHaveBeenCalled();
});

test("surviving detached workers cannot leave a stale workspace root", async () => {
  const box = await createSandbox(factory());
  await box.run(
    "mkdir -p /home/tenki/later; printf old > value; printf new > /home/tenki/later/value",
  );
  await box.run(
    "nohup setsid sh -c 'while [ ! -e /home/tenki/release-worker ]; do sleep .01; done; rm /workspace; ln -s /home/tenki/later /workspace; touch /home/tenki/worker-done' >/dev/null 2>&1 </dev/null &",
  );
  await box.files.write("/home/tenki/release-worker", "go");
  await vi.waitFor(
    async () => expect(await box.files.exists("/home/tenki/worker-done")).toBe(true),
    { timeout: 2000, interval: 10 },
  );
  const read = vi.spyOn(MockSession.prototype, "readFile");
  expect(await box.files.read("value")).toBe("new");
  expect(read).not.toHaveBeenCalled();
});

test("a delayed removal invalidates snapshots taken before it settles", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  await box.run(
    "mkdir -p /home/tenki/removal-root; ln -s /home/tenki/removal-root /home/tenki/removal-alias; rm /workspace; ln -s /home/tenki/removal-alias /workspace; printf old > /workspace/value",
    { cwd: "/home/tenki" },
  );
  const run = MockSession.prototype.run;
  vi.spyOn(MockSession.prototype, "run").mockImplementation(
    function (this: MockSession, argv, options) {
      if (argv[3] === "remove" && argv[4] === "/home/tenki/removal-alias") {
        argv = [...argv];
        argv[2] =
          "import os,time\nopen('/home/tenki/removal-started','w').close()\nwhile not os.path.exists('/home/tenki/release-removal'): time.sleep(.01)\n" +
          argv[2];
      }
      return run.call(this, argv, options);
    },
  );
  const removing = provider.files.remove(box.id, "/home/tenki/removal-alias", { recursive: false });
  try {
    await vi.waitFor(
      async () => expect(await box.files.exists("/home/tenki/removal-started")).toBe(true),
      { timeout: 2000, interval: 10 },
    );
    await box.run("true");
  } finally {
    await box.files.write("/home/tenki/release-removal", "go");
  }
  await removing;
  const read = vi.spyOn(MockSession.prototype, "readFile");
  await expect(box.files.read("value")).rejects.toMatchObject({ code: "file_not_found" });
  expect(read).not.toHaveBeenCalled();
});

test("a failed command with surviving workers cannot refill the cache on a later command", async () => {
  const box = await createSandbox(factory());
  await box.run(
    "mkdir -p /home/tenki/after-failure; mkfifo /home/tenki/release-failed-worker; printf old > value; printf new > /home/tenki/after-failure/value",
  );
  tenkiState.streamFailures.push({
    phase: "after-output",
    error: Object.assign(new Error("connection reset after output"), { code: 14 }),
  });
  await expect(
    box.run(
      "nohup setsid sh -c 'touch /home/tenki/failed-worker-ready; read go < /home/tenki/release-failed-worker; rm /workspace; ln -s /home/tenki/after-failure /workspace; touch /home/tenki/failed-worker-done' >/dev/null 2>&1 </dev/null & while [ ! -e /home/tenki/failed-worker-ready ]; do sleep .01; done; printf launched; sleep 5",
    ),
  ).rejects.toMatchObject({ code: "outcome_unknown" });
  await box.run("true");
  await box.files.write("/home/tenki/release-failed-worker", "go\n");
  await vi.waitFor(
    async () => expect(await box.files.exists("/home/tenki/failed-worker-done")).toBe(true),
    { timeout: 2000, interval: 10 },
  );
  const read = vi.spyOn(MockSession.prototype, "readFile");
  expect(await box.files.read("value")).toBe("new");
  expect(read).not.toHaveBeenCalled();
});

test("a failed destroy preserves cache disablement across reconnect", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  const native = box.native;
  vi.spyOn(native, "close").mockRejectedValueOnce(new Error("close unavailable"));
  await expect(provider.destroy(box.id)).rejects.toMatchObject({ code: "provider" });
  await provider.connect(box.id);
  await native.run(
    [
      "sh",
      "-c",
      "mkdir -p /home/tenki/survived; rm /workspace; ln -s /home/tenki/survived /workspace",
    ],
    { privileged: true },
  );
  const write = vi.spyOn(MockSession.prototype, "writeFile");
  await box.files.write("value", "survived");
  expect(write).not.toHaveBeenCalled();
  expect((await box.run("cat value")).stdout).toBe("survived");
});

test("native failures retain safe evidence through public redaction", async () => {
  const provider = tenki({ authToken: "secret-key" });
  const box = await createSandbox(provider);
  const native = box.native;
  const transport = Object.assign(new Error("Bearer secret-key response body private-command"), {
    code: 14,
    metadata: new Headers({ "x-request-id": "req-123", authorization: "Bearer secret-key" }),
  });
  vi.spyOn(native, "resume").mockRejectedValueOnce(
    Object.assign(new Error("private-body"), {
      name: "ResumeFailedError",
      status: 503,
      cause: transport,
    }),
  );
  const error = await box.resume().catch((error) => error);
  expect(error).toMatchObject({ code: "provider", provider: "tenki" });
  expect(JSON.parse(String(error.cause))).toEqual({
    operation: "resume",
    nativeName: "ResumeFailedError",
    status: 503,
    providerCode: 14,
    requestId: "req-123",
  });
  expect(String(error.cause)).not.toMatch(/secret-key|private|Bearer|authorization/);
});

test("native evidence rejects secret scalars and arbitrary native properties", async () => {
  const provider = tenki({ authToken: "SECRET" });
  vi.spyOn(MockTenki.prototype, "get").mockRejectedValueOnce(
    Object.assign(new Error("private"), {
      status: "503",
      code: "SECRET_CODE",
      requestId: "req-SECRET",
      operation: "private/path",
      body: "private",
      cause: Object.assign(new Error("private"), {
        statusCode: 504,
        code: "UNAVAILABLE",
        requestId: "https://secret",
      }),
    }),
  );
  const error = await provider.connect("missing").catch((error) => error);
  expect(error.cause).toMatchObject({
    operation: "connect",
    status: 504,
    providerCode: "UNAVAILABLE",
  });
  expect(error.cause.message).toBe(
    '{"operation":"connect","status":504,"providerCode":"UNAVAILABLE"}',
  );
});
