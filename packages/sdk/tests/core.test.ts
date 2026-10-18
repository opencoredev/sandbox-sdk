import { describe, test, expect } from "vitest";
import { createSandbox, connectSandbox, reapSandboxes, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe("core safety guarantees", () => {
  test("secrets stay redacted across chunks, streams, causes and reconnects", async () => {
    const token = "secret-value";
    const provider = memory({ handlers: {
      chunks({ stdout, stderr }) { stdout("sec"); stderr("ERROR "); stdout("ret-value sec"); stdout("ret-value"); return 0; },
      fail() { throw new Error(`failure ${token}`, { cause: { nested: token } }); },
    } });
    const box = await createSandbox(provider, { secrets: { TOKEN: token } });
    try {
      const result = await box.run("chunks"); expect(result.stdout).toBe("[REDACTED] [REDACTED]"); expect(result.output).not.toContain(token);
      const chunks: string[] = []; for await (const chunk of box.run("chunks")) chunks.push(chunk.text);
      expect(chunks.join("")).not.toContain(token);
      const connected = await connectSandbox(provider, box.id); expect((await connected.run("printenv TOKEN")).stdout).toBe("[REDACTED]\n");
      await expect(box.run("fail")).rejects.toMatchObject({ message: "failure [REDACTED]", code: "provider" });
    } finally { await box.destroy(); }
  });
  test("background logs redact secrets split across native chunks", async () => {
    const provider = memory({ handlers: { split({ stdout }) { stdout("abc"); stdout("def\n"); return 0; } } });
    const box = await createSandbox(provider, { secrets: { TOKEN: "abcdef" } });
    try { const process = await box.start("split", { name: "split" }); await process.wait(); expect((await process.logs()).text).toBe("[REDACTED]\n"); }
    finally { await box.destroy(); }
  });
  test("locator stale IDs recreate and concurrent keyed callers share a sandbox", async () => {
    const provider = memory(); const entries = new Map([["key", "stale-id"]]);
    const locator = { get: async (key: string) => entries.get(key), set: async (key: string, id: string) => { entries.set(key, id); }, delete: async (key: string) => { entries.delete(key); } };
    const boxes = await Promise.all(Array.from({ length: 10 }, () => createSandbox(provider, { key: "key", locator })));
    expect(new Set(boxes.map(box => box.id)).size).toBe(1); expect(boxes.filter(box => box.created).length).toBe(1);
    await boxes[0]?.destroy(); expect(entries.size).toBe(0);
  });
  test("best-effort exact keys require an explicit locator", async () => {
    const provider: Provider = { ...memory(), keyMode: "best-effort" };
    await expect(createSandbox(provider, { key: "x", keyMode: "exact" })).rejects.toMatchObject({ code: "unsupported" });
  });
  test("late-arriving creations are destroyed after cancellation", async () => {
    const base = memory(); const controller = new AbortController(); let lateId = "";
    const provider: Provider = { ...base, async create(input) { await pause(40); const info = await base.create(input); lateId = info.id; return info; } };
    const pending = createSandbox(provider, { signal: controller.signal }); setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    await pause(60); await expect(base.connect(lateId)).rejects.toMatchObject({ code: "not_found" });
  });
  test("invalid options throw SandboxError and failed streams reject", async () => {
    const provider = memory({ handlers: { broken() { throw new Error("broken provider"); } } });
    const box = await createSandbox(provider);
    try {
      await expect(box.run("true", { timeoutMs: 0 })).rejects.toBeInstanceOf(SandboxError);
      await expect((async () => { for await (const chunk of box.run("broken")) void chunk; })()).rejects.toBeInstanceOf(SandboxError);
      const abort = new AbortController(); abort.abort(); expect(await box.run("echo never", { signal: abort.signal })).toMatchObject({ timedOut: true, output: "" });
    } finally { await box.destroy(); }
  });
  test("interpolated shell operators remain data", async () => {
    const box = await createSandbox(memory());
    try { for (const value of ["x > /tmp/injected", "a && false", "$(false)", "a'b", "a\nb", "", "\"quotes\"", "a\\b"]) expect((await box.$`printf '%s' ${value}`).stdout).toBe(value); }
    finally { await box.destroy(); }
  });
  test("idleOnly preserves a running process and reaps it after stop", async () => {
    const provider = memory(); const box = await createSandbox(provider);
    await box.start("sleep 5", { name: "busy" }); expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0);
    await box.process("busy").stop(); expect(await reapSandboxes(provider, { idleOnly: true })).toBe(1);
  });
  test("logs rotate at 10 MB with a resumable stale cursor", async () => {
    const provider = memory({ handlers: { noisy({ stdout }) { stdout("a".repeat(6_000_000)); stdout("b".repeat(6_000_000)); return 0; } } });
    const box = await createSandbox(provider);
    try {
      const process = await box.start("noisy", { name: "noisy" }); await process.wait();
      expect((await box.files.stat("/tmp/.sandbox-sdk/procs/noisy/out.log")).size).toBeLessThanOrEqual(10_485_760);
      expect(await process.logs({ after: "0", maxBytes: 16 })).toMatchObject({ truncated: true, text: "b".repeat(16) });
    } finally { await box.destroy(); }
  });
  test("process lines preserve stderr and cursors resume each line", async () => {
    const provider = memory({ handlers: { streams({ stdout, stderr }) { stdout("first\nsecond\n"); stderr("error\n"); return 0; } } });
    const box = await createSandbox(provider);
    try {
      const process = await box.start("streams", { name: "streams" }); await process.wait();
      const lines = []; for await (const line of process.lines()) lines.push(line);
      expect(lines.map(({ text, stream }) => ({ text, stream }))).toEqual([{ text: "first", stream: "stdout" }, { text: "second", stream: "stdout" }, { text: "error", stream: "stderr" }]);
      const resumed = []; for await (const line of process.lines({ after: lines[0]?.cursor })) resumed.push(line.text);
      expect(resumed).toEqual(["second", "error"]);
    } finally { await box.destroy(); }
  });
  test("fresh-client restart preserves cwd, env and readiness", async () => {
    const provider = memory({ handlers: { inspect({ cwd, env, stdout }) { stdout(`${cwd}:${env.CUSTOM}\n`); return 0; } } });
    const box = await createSandbox(provider);
    try {
      await box.files.write("app/file", ""); const first = await box.start("inspect", { name: "restart", cwd: "app", env: { CUSTOM: "value" } }); await first.wait();
      const second = (await connectSandbox(provider, box.id)).process("restart"); await second.restart(); await second.wait();
      expect((await second.logs()).text).toBe("/workspace/app:value\n");
    } finally { await box.destroy(); }
  });
  test("idle reaping leaves an in-flight command alone", async () => {
    const provider = memory(); const box = await createSandbox(provider);
    const running = Promise.resolve(box.run("sleep 0.1")); await pause(20);
    expect(await reapSandboxes(provider, { idleOnly: true })).toBe(0); await running; expect(await reapSandboxes(provider, { idleOnly: true })).toBe(1);
  });

});
