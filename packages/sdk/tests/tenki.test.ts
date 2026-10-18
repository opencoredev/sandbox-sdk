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
      timeoutMs: 5000,
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
  test("stalled termination streams settle after the cancellation grace period", async () => {
    const box = await createSandbox(factory());
    const run = MockSession.prototype.run;
    let transportSignal: AbortSignal | undefined;
    vi.spyOn(MockSession.prototype, "run").mockImplementation(function (argv, options) {
      const handle = run.call(this, argv, options);
      if (!argv[2]?.includes("subprocess.Popen")) return handle;
      transportSignal = options?.signal;
      void Promise.resolve(handle).catch(() => {});
      return Object.assign(new Promise<ProcessRunResult>(() => {}), {
        ...handle,
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
      });
    });
    const started = Date.now();
    const pending = Promise.resolve(box.run("sleep 20", { timeoutMs: 50 }));
    const result = await Promise.race([
      pending,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 1800)),
    ]);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(Date.now() - started).toBeLessThan(1800);
    expect(transportSignal?.aborted).toBe(true);
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
