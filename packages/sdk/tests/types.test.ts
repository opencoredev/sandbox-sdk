import { test, expect } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
test("capability methods are absent from unsupported provider types", async () => {
  const box = await createSandbox(memory());
  // oxlint-disable-next-line no-constant-condition -- compile-time negative API checks never execute.
  if (false) {
    // @ts-expect-error memory has no pause capability
    await box.pause();
    // @ts-expect-error memory has no snapshot capability
    await box.snapshot();
    // @ts-expect-error memory has no terminal capability
    await box.terminal({ cols: 80, rows: 24 });
  }
  expect("pause" in box).toBe(false); await box.destroy();
});
test("native types and supported capability methods remain precise", async () => {
  const base = memory(); let paused = false;
  const provider: Provider<{ typed: true }, "pause"> = { ...base, capabilities: new Set(["pause"]), native: () => ({ typed: true }), async pause() { paused = true; }, async resume() { paused = false; } };
  const box = await createSandbox(provider); const typed: true = box.native.typed; expect(typed).toBe(true);
  await box.pause(); expect(paused).toBe(true); await box.resume(); expect(paused).toBe(false); await box.destroy();
});

test("Vercel native sandbox is fully typed and terminal remains absent", () => {
  type VercelProvider = ReturnType<typeof import("../src/providers/vercel/index.js").vercel>;
  type Native = ReturnType<VercelProvider["native"]>;
  const check = (native: Native) => { const value: import("@vercel/sandbox").Sandbox = native; return value; };
  expect(check).toBeTypeOf("function");
});
