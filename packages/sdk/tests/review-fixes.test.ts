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
