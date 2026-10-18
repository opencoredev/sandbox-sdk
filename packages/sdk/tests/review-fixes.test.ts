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
