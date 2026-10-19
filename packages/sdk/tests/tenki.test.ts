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
    const provider = tenki({ authToken: "key", requestTimeoutMs: 100, waitTimeoutMs: 20, resumeTimeoutMs: 100 });
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
  const provider = tenki({ authToken: "key", requestTimeoutMs: 100, waitTimeoutMs: 1000, resumeTimeoutMs: 400 });
  const box = await createSandbox(provider);
  const resume = vi.spyOn(box.native, "resume").mockImplementationOnce(async () => {
    await new Promise(resolve => setTimeout(resolve, 150));
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
    await new Promise(resolve => setTimeout(resolve, 150));
  });
  await box.pause();
});
test("transition budgets reject unbounded values before allocation", async () => {
  for (const value of [0, Infinity, -1, 900001]) {
    await expect(createSandbox(tenki({ authToken: "key", resumeTimeoutMs: value }))).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(createSandbox(tenki({ authToken: "key", waitTimeoutMs: value }))).rejects.toMatchObject({ code: "invalid_argument" });
  }
});
