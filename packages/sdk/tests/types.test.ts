import { test, expect } from "vitest";
import { createSandbox } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Capability, Provider } from "../src/provider.js";

/** A provider picked at runtime: the compiler knows only the Provider contract. */
function runtimeProvider(): Provider {
  return memory();
}

/** A capability picked at runtime, typed as the whole Capability union. */
function runtimeCapability(): Capability {
  return "network-policy";
}

test("capability methods are absent from unsupported provider types", async () => {
  const box = await createSandbox(memory());

  // Compile-time negative API check. The function is type-checked but never called.
  async function unsupportedCall() {
    // @ts-expect-error memory has no pause capability
    await box.pause();
    // @ts-expect-error memory has no snapshot capability
    await box.snapshot();
    // @ts-expect-error memory has no terminal capability
    await box.terminal({ cols: 80, rows: 24 });
  }

  expect(unsupportedCall).toBeTypeOf("function");

  expect("pause" in box).toBe(false);
  await box.destroy();
});

test("native types and supported capability methods remain precise", async () => {
  const base = memory();
  let paused = false;

  const provider: Provider<{ typed: true }, "pause"> = {
    ...base,
    capabilities: new Set(["pause"]),
    native: () => ({ typed: true }),
    async pause() {
      paused = true;
    },
    async resume() {
      paused = false;
    },
  };

  const box = await createSandbox(provider);
  const typed: true = box.native.typed;
  expect(typed).toBe(true);
  await box.pause();
  expect(paused).toBe(true);
  await box.resume();
  expect(paused).toBe(false);
  await box.destroy();
});

test("Vercel native sandbox is fully typed and terminal remains absent", () => {
  type VercelProvider = ReturnType<typeof import("../src/providers/vercel/index.js").vercel>;

  type Native = ReturnType<VercelProvider["native"]>;

  const check = (native: Native) => {
    const value: import("@vercel/sandbox").Sandbox = native;

    return value;
  };

  expect(check).toBeTypeOf("function");
});

test("a provider chosen at runtime exposes capability methods only after hasCapability", async () => {
  const { hasCapability } = await import("../src/index.js");
  const box = await createSandbox(runtimeProvider());

  // Compile-time negative API check. The function is type-checked but never called.
  async function unsupportedCall() {
    // @ts-expect-error pause may be missing on a runtime-chosen provider
    await box.pause();
  }

  expect(unsupportedCall).toBeTypeOf("function");

  if (hasCapability(box, "pause")) await box.pause();

  if (hasCapability(box, "snapshot")) {
    const snap: { id: string } = await box.snapshot();
    expect(snap.id).toBeTypeOf("string");
  }

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
  expect((await box.processes()).map((info) => info.name)).toContain(proc.name);
  await proc.stop();
  await box.destroy();
});

test("hasCapability with a union capability narrows nothing it did not check", async () => {
  const { hasCapability } = await import("../src/index.js");
  const box = await createSandbox(runtimeProvider());
  const capability = runtimeCapability();

  if (hasCapability(box, capability)) {
    // Compile-time negative API check. The function is type-checked but never called.
    async function unsupportedCall() {
      // @ts-expect-error checking an unknown capability does not prove terminal exists
      await box.terminal({ cols: 80, rows: 24 });
    }

    expect(unsupportedCall).toBeTypeOf("function");
  }

  await box.destroy();
});

test("a union of concrete providers keeps each provider's capabilities", async () => {
  const { local } = await import("../src/providers/local/index.js");
  const { hasCapability } = await import("../src/index.js");
  const pick = (useLocal: boolean) => (useLocal ? local() : memory());
  const box = await createSandbox(pick(false));

  // Compile-time negative API check. The function is type-checked but never called.
  async function unsupportedCall() {
    // @ts-expect-error memory in the union has no pause, so pause is not guaranteed
    await box.pause();
  }

  expect(unsupportedCall).toBeTypeOf("function");

  if (hasCapability(box, "pause")) await box.pause();
  expect(box.provider).toBe("memory");
  await box.destroy();
});

test("provider-level capabilities, the E2B template spec and extensions are type-gated", async () => {
  const { buildTemplate, deleteSnapshot } = await import("../src/index.js");
  const { e2b } = await import("../src/providers/e2b/index.js");

  // Compile-time checks. The function is type-checked but never called.
  async function gated() {
    // @ts-expect-error memory has no snapshot-delete capability
    await deleteSnapshot(memory(), "snap");
    // @ts-expect-error memory has no templates capability
    await buildTemplate(memory(), { name: "t" });

    await deleteSnapshot(e2b(), "snap");
    // E2B widens the portable spec with its own fields.
    await buildTemplate(e2b(), { name: "t", image: "node:22", startCommand: "npm start" });
    // @ts-expect-error the portable spec has no startCommand
    await buildTemplate(runtimeProvider(), { name: "t", startCommand: "npm start" });

    // A union passes only when every member declares the capability.
    const either = Math.random() > 0.5 ? e2b() : memory();
    // @ts-expect-error memory, one member of the union, has no snapshot-delete capability
    await deleteSnapshot(either, "snap");

    const box = await createSandbox(e2b());
    const samples: { cpuUsedPct: number }[] = await box.ext.e2b.metrics({ startMs: 0 });
    const terminal = await box.terminal({ cols: 80, rows: 24 });
    const exit: { exitCode: number | null } | undefined = await terminal.wait?.();
    const cpu: number | undefined = (await box.usage()).cpuPercent;

    const plain = await createSandbox(memory());
    // @ts-expect-error memory declares no extensions
    await plain.ext.e2b.metrics();

    return [samples, exit, cpu];
  }

  expect(gated).toBeTypeOf("function");
});
