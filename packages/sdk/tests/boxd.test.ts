import { afterAll, describe, expect, test, vi } from "vitest";
import { boxdState, MockBoxd } from "./cloud-guest-mock.js";
vi.mock("@boxd-sh/sdk", () => ({ Boxd: MockBoxd }));
import { boxd } from "../src/providers/boxd/index.js";
import { boxdError } from "../src/providers/boxd/errors.js";
import { createSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });
const factory = () => boxd({ apiKey: "mock-key" });
// The conformance guard admits local transports only when live:false. This is
// a local Linux transport, not permission to contact the cloud.
runConformance(() => ({ ...factory(), name: "memory" }), { live: false });
afterAll(async () => {
  await Promise.all([...boxdState.boxes.values()].map((v) => v.guest.destroy()));
  boxdState.boxes.clear();
});
describe("boxd contract", () => {
  test("rejects every unenforceable option before allocating", async () => {
    const provider = factory();
    const before = boxdState.creates.length;
    for (const opts of [
      { size: "small" },
      { network: "none" },
      { network: { allow: [] } },
      { network: { allow: ["example.com"] } },
      { idleTimeoutMs: 1000 },
      { timeoutMs: 1000 },
      { from: "snap" },
    ] satisfies Partial<Parameters<typeof provider.create>[0]>[])
      await expect(provider.create({ labels: {}, ...opts })).rejects.toMatchObject({
        code: "unsupported",
      });
    expect(boxdState.creates.length).toBe(before);
  });
  test("maps gRPC errors without exposing native credentials", () => {
    for (const [grpcCode, code] of [
      [16, "auth"],
      [7, "auth"],
      [5, "not_found"],
      [8, "quota"],
      [14, "unavailable"],
      [4, "timeout"],
      [3, "invalid_argument"],
      [1, "aborted"],
    ] as const) {
      const error = boxdError(Object.assign(new Error("secret-native-error"), { grpcCode }));
      expect(error.code).toBe(code);
      expect(error.cause).toBeUndefined();
      expect(String(error)).not.toContain("secret-native-error");
    }
  });
  test("maps SDK failures without a gRPC status", () => {
    for (const [name, code] of [
      ["AuthenticationError", "auth"],
      ["PermissionDeniedError", "auth"],
      ["APIConnectionError", "unavailable"],
      ["RateLimitError", "quota"],
    ] as const) {
      const result = boxdError(Object.assign(new Error("private-key"), { name }));
      expect(result.code).toBe(code);
      expect(result.cause).toBeUndefined();
    }
  });
  test("secrets use native stdin and never command text", async () => {
    const box = await createSandbox(factory(), { secrets: { TOKEN: "secret-$-雪" } });
    try {
      expect((await box.run('test -n "$TOKEN" && echo ok')).stdout).toBe("ok\n");
      const native = boxdState.boxes.get(box.id);
      expect(native).toBeDefined();
      // Inspect a second command whose text has no intentional secret literal.
      const before = native?.guest.commands.length ?? 0;
      await box.run('printf %s "$TOKEN"');
      expect(native?.guest.commands.slice(before).join("\n")).not.toContain("secret-$-雪");
      expect(native?.guest.inputs.at(-1)).toContain("secret-$-雪");
    } finally {
      await box.destroy();
    }
  });
  test("timeout and abort kill descendants before later writes", async () => {
    const box = await createSandbox(factory());
    try {
      expect(await box.run("(sleep .3; echo leak > late) & wait", { timeoutMs: 40 })).toMatchObject(
        { timedOut: true },
      );
      const abort = new AbortController();
      const pending = Promise.resolve(
        box.run("(sleep .3; echo leak > abort) & wait", { signal: abort.signal }),
      );
      setTimeout(() => abort.abort(), 40);
      expect(await pending).toMatchObject({ timedOut: true });
      await new Promise((r) => setTimeout(r, 350));
      expect(await box.files.exists("late")).toBe(false);
      expect(await box.files.exists("abort")).toBe(false);
    } finally {
      await box.destroy();
    }
  });
});

import { cloudRegressions } from "./cloud-regressions.js";
cloudRegressions(factory, (id) => boxdState.boxes.get(id)?.guest);

test("plain BoxdError local exec deadline maps to timeout without native details", () => {
  const result = boxdError(
    Object.assign(new Error("exec timed out after 10ms"), { name: "BoxdError" }),
  );
  expect(result.code).toBe("timeout");
  expect(result.cause).toBeUndefined();
  expect(String(result)).not.toContain("10ms");
  expect(boxdError(Object.assign(new Error("unrelated failure"), { name: "BoxdError" })).code).toBe(
    "provider",
  );
});

test("unconfirmed native cancellation is bounded and reports uncertainty", async () => {
  const { ExecStream } = await vi.importActual<typeof import("@boxd-sh/sdk")>("@boxd-sh/sdk");
  const box = await createSandbox(factory());
  const native = box.native.client;
  let cancelled = false;
  const stream = new ExecStream({
    write() {},
    end() {},
    resize() {},
    cancel() {
      cancelled = true;
    },
  });
  const spy = vi.spyOn(native.machines, "streamExec").mockReturnValueOnce(stream);
  try {
    const start = Date.now();
    await expect(box.run("true", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(cancelled).toBe(true);
    expect(boxdState.boxes.has(box.id)).toBe(true);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("cancellation waits for the native terminal event", async () => {
  const { ExecStream } = await vi.importActual<typeof import("@boxd-sh/sdk")>("@boxd-sh/sdk");
  const box = await createSandbox(factory());
  let terminated = false;
  const stream = new ExecStream({
    write() {},
    end() {},
    resize() {},
    cancel() {
      setTimeout(() => {
        terminated = true;
        stream._setExit(137);
      }, 100);
    },
  });
  const spy = vi.spyOn(box.native.client.machines, "streamExec").mockReturnValueOnce(stream);
  try {
    expect(await box.run("true", { timeoutMs: 20 })).toMatchObject({ timedOut: true });
    expect(terminated).toBe(true);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("stdout and stderr preserve native wire arrival order", async () => {
  const { ExecStream } = await vi.importActual<typeof import("@boxd-sh/sdk")>("@boxd-sh/sdk");
  const box = await createSandbox(factory());
  const stream = new ExecStream({
    write() {},
    resize() {},
    cancel() {},
    end() {
      queueMicrotask(() => {
        stream.stdout.push(Buffer.from("A"));
        stream.stdout.push(Buffer.from("B"));
        stream.stderr.push(Buffer.from("C"));
        stream.stdout.close();
        stream.stderr.close();
        stream._setExit(0);
      });
    },
  });
  const spy = vi.spyOn(box.native.client.machines, "streamExec").mockReturnValueOnce(stream);
  try {
    const chunks: string[] = [];
    for await (const chunk of box.run("true")) chunks.push(chunk.text);
    expect(chunks).toEqual(["A", "B", "C"]);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("cancellation waits through native TERM grace and escalates transport-only cancellation", async () => {
  for (const unconfirmed of [false, true]) {
    const box = await createSandbox(factory());
    const native = boxdState.boxes.get(box.id);
    if (!native) throw new Error("Missing mock VM");
    native.guest.cancelGraceMs = 200;
    native.guest.cancelWithoutTermination = unconfirmed;
    try {
      const start = Date.now();
      expect(
        await box.run("trap '' TERM; (sleep 2; echo leaked > later) & wait", { timeoutMs: 100 }),
      ).toMatchObject({ timedOut: true });
      expect(Date.now() - start).toBeGreaterThan(unconfirmed ? 1000 : 250);
      expect((await box.run("test ! -e later && echo clean")).stdout).toBe("clean\n");
    } finally {
      await box.destroy();
    }
  }
});

test("cleanup failure preserves unconfirmed cancellation", async () => {
  const { ExecStream } = await vi.importActual<typeof import("@boxd-sh/sdk")>("@boxd-sh/sdk");
  const box = await createSandbox(factory());
  const stream = new ExecStream({ write() {}, end() {}, resize() {}, cancel() {} });
  const native = box.native.client;
  const streaming = vi.spyOn(native.machines, "streamExec").mockReturnValueOnce(stream);
  const exec = vi
    .spyOn(native.machines, "exec")
    .mockRejectedValue(new Error("cleanup transport failure"));
  try {
    await expect(box.run("true", { timeoutMs: 20 })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  } finally {
    streaming.mockRestore();
    exec.mockRestore();
    await box.destroy();
  }
});
