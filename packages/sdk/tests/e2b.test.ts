import { vi, test, expect, afterAll } from "vitest";
const mock = await vi.hoisted(async () => import("./e2b-sdk-mock.js"));
vi.mock("e2b", async importOriginal => {
  const real = await importOriginal<typeof import("e2b")>();
  return { ...real, Sandbox: mock.MockSandbox };
});
import { e2b } from "../src/providers/e2b/index.js";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { runConformance } from "../src/testing.js";
const { calls, cleanupMock, mockFetch, listQueries, delayCreation, MockSandbox, reconnects, delayCommandStart } = mock;
const originalFetch = globalThis.fetch;
vi.stubGlobal("fetch", mockFetch(originalFetch));
afterAll(async () => { await cleanupMock(); vi.unstubAllGlobals(); });
// live:true enables the Linux/git/HTTP tests. vi.mock confines all E2B I/O to
// the local fixture; this suite never contacts E2B, even if keys are present.
runConformance(() => e2b({ apiKey: "mock" }), { live: true });

test("metadata lookup paginates, labels survive and native is the sandbox", async () => {
  const provider = e2b({ apiKey: "mock", template: "custom", domain: "example.test" });
  const box = await createSandbox(provider, { key: "key", labels: { app: "test" }, env: { HELLO: "world" } });
  try {
    expect(box.native).toBeInstanceOf(MockSandbox);
    expect(calls.at(-1)).toMatchObject({ template: "custom", options: { apiKey: "mock", domain: "example.test", envs: { HELLO: "world" }, metadata: { "sandbox-sdk": "1", "sandbox-sdk-key": "key", app: "test" } } });
    const fresh = e2b({ apiKey: "mock" });
    expect((await createSandbox(fresh, { key: "key" })).id).toBe(box.id);
    expect(listQueries.at(-1)).toMatchObject({ query: { metadata: { "sandbox-sdk": "1", "sandbox-sdk-key": "key" } } });
    expect((await listSandboxes(fresh, { labels: { app: "test" } }))[0]?.labels).toEqual({ "sandbox-sdk": "1", app: "test" });
  } finally { await box.destroy(); }
});
test("network rules are enforced at creation and sizes/idle fail closed", async () => {
  for (const network of ["none", { allow: ["registry.npmjs.org"] }] as const) {
    const box = await createSandbox(e2b(), { network: typeof network === "string" ? network : { allow: [...network.allow] } });
    expect(calls.at(-1)?.options).toMatchObject(network === "none" ? { allowInternetAccess: false } : { network: { denyOut: ["0.0.0.0/0"], allowOut: ["registry.npmjs.org"] } }); await box.destroy();
  }
  for (const size of ["small", "medium", "large", { cpu: 2, memoryMb: 512, diskGb: 1 }] as const) await expect(createSandbox(e2b(), { size })).rejects.toMatchObject({ code: "unsupported" });
  await expect(createSandbox(e2b(), { idleTimeoutMs: 1000 })).rejects.toMatchObject({ code: "unsupported" });
});
test("pause/resume and snapshot restore files through a new adapter", async () => {
  const provider = e2b(); const box = await createSandbox(provider);
  try {
    await box.files.write("state", "saved"); const snapshot = await box.snapshot();
    await box.pause(); expect((await provider.list({})).find(item => item.id === box.id)?.state).toBe("paused");
    await box.resume(); expect(await box.files.read("state")).toBe("saved");
    const restored = await createSandbox(e2b(), { from: snapshot.id });
    try { expect(await restored.files.read("state")).toBe("saved"); } finally { await restored.destroy(); }
  } finally { await box.destroy(); }
});
test("timeout and abort kill descendants before delayed writes", async () => {
  const box = await createSandbox(e2b());
  try {
    expect(await box.run("(sleep .25; echo survived > child) & wait", { timeoutMs: 30 })).toMatchObject({ timedOut: true });
    const controller = new AbortController();
    const run = Promise.resolve(box.run("(sleep .25; echo survived > aborted-child) & wait", { signal: controller.signal })); setTimeout(() => controller.abort(), 30);
    expect(await run).toMatchObject({ timedOut: true });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await box.files.exists("child")).toBe(false); expect(await box.files.exists("aborted-child")).toBe(false);
  } finally { await box.destroy(); }
});
test("native failures become safe structured errors", async () => {
  await expect(createSandbox(e2b({ apiKey: "invalid" }))).rejects.toMatchObject({ code: "auth", provider: "e2b" });
  await expect(createSandbox(e2b({ apiKey: "invalid" }))).rejects.not.toThrow("secret-key-do-not-leak");
  await expect(connectSandbox(e2b(), "missing")).rejects.toMatchObject({ code: "not_found" });
});
test("late creation after abort is destroyed", async () => {
  delayCreation(60); const controller = new AbortController();
  const promise = createSandbox(e2b(), { labels: { late: "yes" }, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await expect(promise).rejects.toMatchObject({ code: "aborted" });
  await new Promise(resolve => setTimeout(resolve, 150)); delayCreation(0);
  expect(await e2b().list({ late: "yes" })).toEqual([]);
});

test("native process wait reconnects after the local stream closes", async () => {
  const provider = e2b(); const info = await provider.create({ labels: {} });
  try {
    const process = await provider.startProcess?.(info.id, { command: "sleep .2; exit 7", cwd: "/workspace", env: {}, onChunk() {} });
    expect(process).toBeDefined(); await provider.close?.(info.id);
    await provider.connect(info.id);
    expect(await process?.wait()).toMatchObject({ exitCode: 7 }); expect(reconnects.length).toBeGreaterThan(0);
  } finally { await provider.destroy(info.id); }
});
test("hard lifetime is retained across pause and fresh-client resume", async () => {
  const provider = e2b(); const info = await provider.create({ labels: {}, timeoutMs: 200 });
  await provider.pause?.(info.id); await new Promise(resolve => setTimeout(resolve, 250));
  await expect(e2b().connect(info.id)).rejects.toMatchObject({ code: "not_found" });
  await provider.destroy(info.id);
});

test("unconfirmed network policy destroys the sandbox and fails closed", async () => {
  const original = MockSandbox.prototype.getInfo;
  const spy = vi.spyOn(MockSandbox.prototype, "getInfo").mockImplementationOnce(async function (this: Awaited<ReturnType<typeof MockSandbox.lookup>>) {
    const info = await original.call(this); return { ...info, allowInternetAccess: undefined, network: undefined };
  });
  try { await expect(e2b().create({ labels: { unconfirmed: "yes" }, network: "none" })).rejects.toMatchObject({ code: "unsupported" }); }
  finally { spy.mockRestore(); }
  expect(await e2b().list({ unconfirmed: "yes" })).toEqual([]);
});

test("cancellation wins when a completed command handle arrives late", async () => {
  const provider = e2b(); const info = await provider.create({ labels: {} });
  delayCommandStart(60);
  try { expect(await provider.exec(info.id, { command: "true", cwd: "/workspace", env: {}, timeoutMs: 10, onChunk() {} })).toEqual({ exitCode: null, timedOut: true }); }
  finally { delayCommandStart(0); await provider.destroy(info.id); }
});

test("launch strips a fragmented control frame and uses no marker file requests", async () => {
  const box = await createSandbox(e2b());
  const run = box.native.commands.run.bind(box.native.commands);
  const command = vi.spyOn(box.native.commands, "run").mockImplementation((text, options) => {
    const stdout = options?.onStdout;
    return run(text, { ...options, onStdout: async chunk => {
      // Force a boundary inside the private frame, then forward the remainder
      // (which may include user stdout) in one piece.
      await stdout?.(chunk.slice(0, 3));
      await stdout?.(chunk.slice(3));
    } });
  });
  const read = vi.spyOn(box.native.files, "read");
  const remove = vi.spyOn(box.native.files, "remove");
  try {
    const result = await box.run("printf 'hello\\n'; printf error >&2; exit 7");
    expect(result).toMatchObject({ stdout: "hello\n", stderr: "error", exitCode: 7 });
    expect(command).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  } finally { command.mockRestore(); read.mockRestore(); remove.mockRestore(); await box.destroy(); }
});

test("file writes create missing parents without mkdir requests", async () => {
  const box = await createSandbox(e2b());
  const mkdir = vi.spyOn(box.native.files, "makeDir");
  const write = vi.spyOn(box.native.files, "write");
  try {
    await box.files.write("new/nested/file", "saved");
    expect(await box.files.read("new/nested/file")).toBe("saved");
    expect(mkdir).not.toHaveBeenCalled(); expect(write).toHaveBeenCalledTimes(1);
  } finally { mkdir.mockRestore(); write.mockRestore(); await box.destroy(); }
});

test("custom hardware templates accept both names and IDs", async () => {
  for (const template of ["sandbox-bench-same-spec", "r1h7gud12rf1f6iu29r0", "sandbox-bench-advertised-default", "jwj8b58bmst9azjl2iim"]) {
    const box = await createSandbox(e2b({ template }));
    try { expect(calls.at(-1)?.template).toBe(template); }
    finally { await box.destroy(); }
  }
});


test("shell startup stdout before the control frame is preserved", async () => {
  const box = await createSandbox(e2b());
  try {
    for (const script of ["echo banner", "printf banner"]) {
      await box.files.write("banner.sh", script);
      const result = await box.run("printf hello", { env: { BASH_ENV: "/workspace/banner.sh" } });
      expect(result).toMatchObject({ stdout: script === "echo banner" ? "banner\nhello" : "bannerhello", exitCode: 0 });
    }
  } finally { await box.destroy(); }
});
