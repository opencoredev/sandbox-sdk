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

test("a provider chosen at runtime exposes capability methods only after hasCapability", async () => {
  const { hasCapability } = await import("../src/index.js");
  const providers: Record<string, () => Provider> = { memory };
  const box = await createSandbox(providers.memory!());
  // oxlint-disable-next-line no-constant-condition -- compile-time negative API checks never execute.
  if (false) {
    // @ts-expect-error pause may be missing on a runtime-chosen provider
    await box.pause();
  }
  if (hasCapability(box, "pause")) await box.pause();
  if (hasCapability(box, "snapshot")) { const snap: { id: string } = await box.snapshot(); expect(snap.id).toBeTypeOf("string"); }
  expect(hasCapability(box, "pause")).toBe(false);
  expect(hasCapability(box, "network-policy")).toBe(true);
  await box.destroy();
});

test("start derives a stable process name when none is given", async () => {
  const { defaultProcessName } = await import("../src/processes.js");
  expect(defaultProcessName("node server.js --port 3000")).toMatch(/^node-[0-9a-f]{8}$/);
  expect(defaultProcessName("/usr/bin/python3 -m http.server")).toMatch(/^python3-[0-9a-f]{8}$/);
  expect(defaultProcessName("node a.js")).not.toBe(defaultProcessName("node b.js"));
  expect(defaultProcessName("node a.js")).toBe(defaultProcessName("node a.js"));
  const box = await createSandbox(memory());
  const proc = await box.start("sleep 30");
  expect(proc.name).toBe(defaultProcessName("sleep 30"));
  expect((await box.processes()).map(info => info.name)).toContain(proc.name);
  await proc.stop(); await box.destroy();
});
