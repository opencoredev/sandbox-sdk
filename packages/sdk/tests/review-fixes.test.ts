import { expect, test, vi } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import { shellProvider } from "./shell-provider.js";
import type { Provider } from "../src/provider.js";

test.each(["outcome_unknown", "provider"] satisfies ("outcome_unknown" | "provider")[])("cancellation propagates %s cleanup failures", async code => {
  const base = memory();
  const provider: Provider = { ...base, async exec(_, input) {
    if (input.command !== "cancel") return base.exec(_, input);
    await new Promise<void>(resolve => input.signal?.addEventListener("abort", () => resolve(), { once: true }));
    throw new SandboxError("Remote group termination failed", { code });
  } };
  const box = await createSandbox(provider);
  try { await expect(box.run("cancel", { timeoutMs: 20 })).rejects.toMatchObject({ code }); }
  finally { await box.destroy(); }
});

test("redacts secrets spanning stdout and stderr in output and subscriptions", async () => {
  const provider = memory({ handlers: { split({ stdout, stderr }) { stdout("ab"); stderr("cd"); return 0; } } });
  const box = await createSandbox(provider, { secrets: { TOKEN: "abcd" } });
  try {
    expect((await box.run("split")).output).toBe("[REDACTED]");
    const chunks = []; for await (const chunk of box.run("split")) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("[REDACTED]");
  } finally { await box.destroy(); }
});

test("line cursors preserve other-stream fragments across serialized resume", async () => {
  const provider = memory({ handlers: { fragments({ stdout, stderr }) { stdout("hel"); stderr("error\n"); stdout("lo\n"); return 0; } } });
  const box = await createSandbox(provider);
  try {
    const proc = await box.start("fragments", { name: "fragments" }); await proc.wait();
    const iterator = proc.lines()[Symbol.asyncIterator](); const first = await iterator.next(); await iterator.return?.();
    expect(first.value?.text).toBe("error");
    const resumed = []; for await (const line of proc.lines({ after: JSON.parse(JSON.stringify(first.value?.cursor)) })) resumed.push(line.text);
    expect(resumed).toEqual(["hello"]);
    for (const after of ['{"v":1,"offset":"0","pending":{"stdout":1,"stderr":""}}', '{"v":2}', 'NaN']) {
      await expect(proc.lines({ after })[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "invalid_argument" });
    }
  } finally { await box.destroy(); }
});

test("line cursors remain resumable for large escaped pending fragments", async () => {
  const provider = memory({ handlers: { large({ stdout, stderr }) { stdout("\u0001".repeat(190_000)); stderr("checkpoint\n"); stdout("tail\n"); return 0; } } });
  const box = await createSandbox(provider);
  try {
    const proc = await box.start("large", { name: "large" }); await proc.wait();
    const iterator = proc.lines()[Symbol.asyncIterator](); const first = await iterator.next(); await iterator.return?.();
    expect(Buffer.byteLength(first.value?.cursor ?? "")).toBeLessThanOrEqual(1_048_576);
    const resumed = []; for await (const line of proc.lines({ after: first.value?.cursor })) resumed.push(line.text);
    expect(resumed[0]).toContain("tail");
  } finally { await box.destroy(); }
});

test.each(["exit", "timeout"])("readiness %s errors retain the last 50 lines across empty pages", async mode => {
  const provider = memory({ handlers: { async early({ stdout }) {
    stdout(Array.from({ length: 70 }, (_, n) => `diagnostic-${n + 1}\n`).join(""));
    await new Promise(resolve => setTimeout(resolve, mode === "exit" ? 120 : 400)); return 7;
  } } });
  const box = await createSandbox(provider);
  try {
    let failure: unknown;
    try { await box.start("early", { name: "early", ready: { log: /NEVER/ }, readyTimeoutMs: 220 }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SandboxError);
    if (!(failure instanceof SandboxError)) throw new Error("Expected readiness failure");
    expect(failure.code).toBe(mode === "exit" ? "process_exited" : "timeout");
    expect(failure.message).toContain("diagnostic-21\n"); expect(failure.message).toContain("diagnostic-70");
    expect(failure.message).not.toContain("diagnostic-20\n");
  } finally { await box.destroy(); }
});

test("exit-before-ready diagnostics drain remaining bounded pages", async () => {
  const box = await createSandbox(memory({ handlers: { pages({ stdout }) { stdout("x".repeat(100_000) + "\nlast-diagnostic\n"); return 7; } } }));
  try {
    await expect(box.start("pages", { name: "pages", ready: { log: /NEVER/ }, readyTimeoutMs: 1000 })).rejects.toMatchObject({ code: "process_exited", message: expect.stringContaining("last-diagnostic") });
  } finally { await box.destroy(); }
});


test("HTTP readiness allows a cloud handshake longer than 100ms", async () => {
  const box = await createSandbox(await shellProvider());
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 150);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
    return new Response("ok");
  });
  try {
    const process = await box.start("sleep 5", { name: "http", ready: { http: { port: 3000 } }, readyTimeoutMs: 600 });
    expect(process.ready).toBe(true);
    await process.stop();
  } finally { fetcher.mockRestore(); await box.destroy(); }
});
