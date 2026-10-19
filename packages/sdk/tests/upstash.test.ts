import { afterEach, describe, expect, test, vi } from "vitest";
import { upstash } from "../src/providers/upstash/index.js";
import { upstashError } from "../src/providers/upstash/errors.js";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { runConformance } from "../src/testing.js";
import { cleanup, MockBox, state } from "./upstash-mock.js";
vi.mock("@upstash/box", async () => ({ Box: (await import("./upstash-mock.js")).MockBox }));
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const factory = () => upstash({ apiKey: "mock-key" });
// live:true authorizes this explicitly mocked cloud SDK; no Upstash calls run.
runConformance(factory, { live: true });
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup();
});
describe("Upstash Box mappings", () => {
  test("keeps secrets out of command text and argv for runs and processes", async () => {
    const secret = "private-token-9ec5e94f";
    const value = "override 'quotes' $literal\n雪";
    const box = await createSandbox(factory(), {
      secrets: { TOKEN: secret },
      env: { CHECK_OVERRIDE: "base" },
    });
    try {
      const commands = vi.spyOn(box.native.exec, "command");
      const sessions = vi.spyOn(box.native.exec, "session");
      const command = `node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.TOKEN + process.env.CHECK_OVERRIDE).digest("hex"))'`;
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secret + value),
      );
      const expected = Buffer.from(digest).toString("hex");
      expect((await box.run(command, { env: { CHECK_OVERRIDE: value } })).stdout).toBe(expected);
      const process = await box.start(command, {
        name: "secret-check",
        env: { CHECK_OVERRIDE: value },
      });
      expect(await process.wait()).toMatchObject({ exitCode: 0 });
      expect((await process.logs()).text).toContain(expected);
      expect(state.envWrites.length).toBeGreaterThan(0);
      for (const file of state.envWrites) {
        expect(file).toMatchObject({ mode: 0o600, directoryMode: 0o700 });
        expect(await box.files.exists(file.path)).toBe(false);
      }
      expect(commands).toHaveBeenCalled();
      expect(sessions).toHaveBeenCalled();
      for (const [command] of commands.mock.calls) expect(command).not.toContain(secret);
      for (const [options] of sessions.mock.calls) {
        expect(options.cmd ?? "").not.toContain(secret);
        for (const arg of options.argv ?? []) expect(arg).not.toContain(secret);
      }
    } finally {
      await box.destroy();
    }
  });
  test("lazy credentials, native sizes, network and protected preview", async () => {
    const provider = factory();
    expect(state.creates).toEqual([]);
    const box = await createSandbox(provider, {
      size: "medium",
      network: { allow: ["registry.npmjs.org"] },
      env: { HELLO: "world" },
    });
    expect(state.creates[0]).toMatchObject({
      apiKey: "mock-key",
      size: "medium",
      networkPolicy: { mode: "custom", allowedDomains: ["registry.npmjs.org"] },
    });
    expect((await box.run('printf "$HELLO"')).stdout).toBe("world");
    expect((await box.preview(3000)).headers).toEqual({ Authorization: "Bearer mock-preview" });
    vi.stubEnv("UPSTASH_BOX_API_KEY", "");
    await expect(createSandbox(upstash())).rejects.toMatchObject({ code: "auth" });
    vi.stubEnv("UPSTASH_BOX_API_KEY", "env-key");
    await createSandbox(upstash());
    expect(state.creates.at(-1)?.apiKey).toBe("env-key");
  });
  test("preserves arbitrary labels and keys across fresh clients and excludes foreign boxes", async () => {
    await MockBox.create();
    const box = await createSandbox(factory(), {
      key: "user:" + "long".repeat(30),
      labels: { app: "long value with spaces", "sandbox-sdk": "forged" },
    });
    expect((await createSandbox(factory(), { key: box.key })).id).toBe(box.id);
    expect(
      await listSandboxes(factory(), { labels: { app: "long value with spaces" } }),
    ).toHaveLength(1);
    expect(await listSandboxes(factory())).toHaveLength(1);
    expect((await connectSandbox(factory(), box.id)).labels).toMatchObject({
      app: "long value with spaces",
      "sandbox-sdk": "1",
    });
    expect((await factory().connect(box.id)).createdAt).toBeGreaterThan(Date.now() - 60_000);
  });
  test("unsupported settings fail before creation", async () => {
    for (const input of [
      { idleTimeoutMs: 1000 },
      { timeoutMs: 1000 },
      { size: { cpu: 1, memoryMb: 1024, diskGb: 10 } },
      { network: { allow: ["https://example.com"] } },
    ])
      await expect(createSandbox(factory(), input)).rejects.toMatchObject({ code: "unsupported" });
    expect(state.boxes.size).toBe(0);
  });
  test("pause, resume, binary files, symlinks and snapshot restore", async () => {
    const box = await createSandbox(factory(), { network: "none" });
    expect(state.creates[0]?.networkPolicy).toEqual({ mode: "deny-all" });
    await box.files.write("saved", new Uint8Array([0, 255, 1]));
    await box.run("ln -s saved link");
    expect((await box.files.stat("link")).type).toBe("symlink");
    await box.pause();
    expect((await factory().connect(box.id)).state).toBe("paused");
    await box.resume();
    const snapshot = await box.snapshot();
    const copy = await createSandbox(factory(), { from: snapshot.id, labels: { clone: "yes" } });
    expect(await copy.files.read("saved", { as: "bytes" })).toEqual(new Uint8Array([0, 255, 1]));
    expect(copy.labels.clone).toBe("yes");
  });
  test("timeout and abort kill descendants including delayed launch", async () => {
    const box = await createSandbox(factory());
    state.delayMs = 50;
    expect(await box.run("(sleep .2; echo leak > late) & wait", { timeoutMs: 10 })).toMatchObject({
      timedOut: true,
      exitCode: null,
    });
    state.delayMs = 0;
    const controller = new AbortController();
    const pending = Promise.resolve(
      box.run("(sleep .2; echo leak > aborted) & wait", { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ timedOut: true, exitCode: null });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await box.files.exists("late")).toBe(false);
    expect(await box.files.exists("aborted")).toBe(false);
    expect(await box.run("echo bad > preabort", { signal: controller.signal })).toMatchObject({
      timedOut: true,
    });
    expect(await box.files.exists("preabort")).toBe(false);
  });
  test("durable launches survive close and fresh clients stop descendants", async () => {
    const box = await createSandbox(factory());
    const command = vi.spyOn(box.native.exec, "command");
    await box.start("sleep .15; echo alive > detached; sleep 5", { name: "durable" });
    expect(command).toHaveBeenCalledWith(expect.stringContaining("nohup setsid"));
    await box.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const fresh = await connectSandbox(factory(), box.id);
    expect(await fresh.files.read("detached")).toBe("alive\n");
    await fresh.process("durable").stop({ graceMs: 10 });
    expect((await fresh.process("durable").wait()).exitCode).not.toBeNull();
    await fresh.destroy();
  });
  test("resume invalidates old process records and repeated resume preserves live work", async () => {
    const box = await createSandbox(factory());
    await box.start("sleep 5", { name: "old" });
    await box.pause();
    await box.resume();
    expect((await box.processes())[0]).toMatchObject({ status: "failed", exitCode: 137 });
    await box.start("sleep 5", { name: "new" });
    await box.resume();
    expect((await box.processes()).find((value) => value.name === "new")?.status).toBe("running");
    await box.process("new").stop({ graceMs: 10 });
  });
  test("repeated and concurrent previews do not rotate native credentials", async () => {
    const box = await createSandbox(factory());
    const native = vi.spyOn(box.native, "getPublicURL");
    const links = await Promise.all([box.preview(3000), box.preview(3000), box.preview(3000)]);
    expect(native).toHaveBeenCalledTimes(1);
    expect(links[0]).toEqual(links[2]);
    await box.preview(3000);
    expect(native).toHaveBeenCalledTimes(1);
    native.mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }));
    await expect(box.preview(8080)).rejects.toMatchObject({ code: "unavailable" });
    await expect(box.preview(8080)).resolves.toHaveProperty("url");
  });
  test("public previews are opt-in and unexpected session loss is a provider failure", async () => {
    const box = await createSandbox(upstash({ apiKey: "key", public: true }));
    expect((await box.preview(3000)).headers).toBeUndefined();
    vi.spyOn(box.native.exec, "session").mockResolvedValueOnce({
      pid: 12,
      execId: "lost",
      write() {},
      endStdin() {},
      resize() {},
      kill() {},
      terminate() {},
      wait: async () => -1,
      close() {},
    });
    await expect(box.run("echo lost")).rejects.toMatchObject({ code: "unavailable" });
  });
  test("maps errors without credential leakage", async () => {
    for (const [statusCode, code] of [
      [401, "auth"],
      [404, "not_found"],
      [429, "quota"],
      [503, "unavailable"],
      [408, "timeout"],
      [400, "invalid_argument"],
    ]) {
      const mapped = upstashError(Object.assign(new Error("Bearer secret"), { statusCode }));
      expect(mapped.code).toBe(code);
      expect(mapped.message).not.toContain("secret");
      expect(mapped.cause).toBeUndefined();
    }
    expect(upstashError({ statusCode: 404 }, "box", true).code).toBe("file_not_found");
    const box = await createSandbox(factory());
    await expect(box.files.read("missing")).rejects.toMatchObject({ code: "file_not_found" });
    await expect(factory().connect("missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

test("creation makes an initially unwritable workspace usable for files and git", async () => {
  const { promises: fs } = await import("node:fs");
  const create = MockBox.create.bind(MockBox);
  let guest: MockBox | undefined;
  vi.spyOn(MockBox, "create").mockImplementationOnce(async params => {
    guest = await create(params);
    await fs.mkdir(`${guest.root}/workspace`, { mode: 0o111 });
    return guest;
  });
  try {
    const box = await createSandbox(factory());
    await box.files.write("app/file", "writable");
    expect(await box.files.read("app/file")).toBe("writable");
    expect((await box.run("git init repo")).ok).toBe(true);
  } finally { if (guest) await fs.chmod(`${guest.root}/workspace`, 0o755).catch(() => {}); }
});
