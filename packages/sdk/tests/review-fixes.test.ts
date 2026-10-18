import { expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
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
