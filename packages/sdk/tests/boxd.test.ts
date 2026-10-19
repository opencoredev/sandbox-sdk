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
cloudRegressions(factory, (id) => boxdState.boxes.get(id)?.guest, true);

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

test("cancellation before launch is confirmed by preventing a late command", async () => {
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
    expect(await box.run("true", { timeoutMs: 20 })).toMatchObject({
      timedOut: true, exitCode: null,
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


test("permission failures give a fixed safe category without native details", () => {
  const result = boxdError(Object.assign(new Error("upload failed: Permission denied private-key /secret/path"), { grpcCode: 13 }));
  expect(result.code).toBe("provider");
  expect(result.message).toContain("permission denied");
  expect(result.message).not.toContain("private-key");
  expect(result.message).not.toContain("/secret/path");
  expect(result.cause).toBeUndefined();
});


test("a delayed native launch cannot run after cancellation was confirmed", async () => {
  const box = await createSandbox(factory());
  const native = box.native.client.machines;
  const original = native.streamExec.bind(native);
  const spy = vi.spyOn(native, "streamExec").mockImplementationOnce((id, params) => {
    const stream = original(id, params);
    const end = stream.end.bind(stream);
    stream.end = () => { setTimeout(end, 1300); };
    return stream;
  });
  try {
    expect(await box.run("echo leaked > late-launch", { timeoutMs: 20 })).toMatchObject({ timedOut: true });
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await box.files.exists("late-launch")).toBe(false);
  } finally { spy.mockRestore(); await box.destroy(); }
});

test("transport cancellation kills descendants after their shell has exited", async () => {
  const box = await createSandbox(factory());
  const entry = boxdState.boxes.get(box.id);
  if (!entry) throw new Error("Missing mock VM");
  entry.guest.cancelWithoutTermination = true;
  try {
    expect(await box.run("(sleep 2; echo leaked > orphan) &", { timeoutMs: 80 })).toMatchObject({ timedOut: true });
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await box.files.exists("orphan")).toBe(false);
  } finally { await box.destroy(); }
});

test("activity protects background output after the command shell exits", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  try {
    let ready = () => {};
    const started = new Promise<void>(resolve => { ready = resolve; });
    const run = box.run("(sleep .5; echo child) & echo ready");
    const output = (async () => { for await (const chunk of run) if (chunk.text.includes("ready")) ready(); })();
    await started;
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await box.files.list("/tmp/.sandbox-sdk/runs")).length).toBe(1);
    await output;
    expect((await run).stdout).toContain("child");
    expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
  } finally { await box.destroy(); }
});


test("preview uses the native default hostname covered by the wildcard certificate", async () => {
  const box = await createSandbox(factory());
  try {
    const proxies = box.native.client.machines.proxies;
    vi.spyOn(proxies, "list").mockResolvedValueOnce([
      { name: null, domain: "machine.boxd.sh", port: 3000, isDefault: true, machineId: box.id, machineName: "machine", portMode: "locked" },
      { name: "sdk-3000", domain: "sdk-3000.machine.boxd.sh", port: 3000, isDefault: false, machineId: box.id, machineName: "machine", portMode: "locked" },
    ]);
    const setPort = vi.spyOn(proxies, "setPort");
    expect(await box.preview(3000)).toMatchObject({ url: "https://machine.boxd.sh" });
    expect(setPort).toHaveBeenLastCalledWith(box.id, 3000);
  } finally { await box.destroy(); vi.restoreAllMocks(); }
});
test("large binary reads avoid the truncated native download stream", async () => {
  const box = await createSandbox(factory());
  try {
    const data = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 251);
    await box.files.write("large.bin", data);
    vi.spyOn(box.native.client.machines.files, "download").mockRejectedValue(new Error("download truncated: expected 10485760 bytes, got 10424320"));
    expect(Buffer.from(await box.files.read("large.bin", { as: "bytes" })).equals(Buffer.from(data))).toBe(true);
  } finally { await box.destroy(); vi.restoreAllMocks(); }
});

 test("binary chunk reads retry one native timeout without replaying writes or auth errors", async () => {
  const box = await createSandbox(factory());
  try {
    const data = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251);
    await box.files.write("retry.bin", data);
    const exec = vi.spyOn(box.native.client.machines, "exec").mockRejectedValueOnce(Object.assign(new Error("exec timed out after 30000ms"), { name: "BoxdError" }));
    expect(Buffer.from(await box.files.read("retry.bin", { as: "bytes" })).equals(Buffer.from(data))).toBe(true);
    expect(exec).toHaveBeenCalledTimes(3);
    exec.mockReset().mockRejectedValue(Object.assign(new Error("denied"), { grpcCode: 7 }));
    await expect(box.files.read("retry.bin")).rejects.toMatchObject({ code: "auth" });
    expect(exec).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); await box.destroy(); }
});


test("boxd listing skips corrupt or vanished per-machine metadata and preserves auth failures", async () => {
  const box = await createSandbox(factory());
  try {
    const entry = boxdState.boxes.get(box.id);
    if (!entry) throw new Error("Missing mock machine");
    const read = vi.spyOn(entry.guest, "read");
    for (const body of ["{", JSON.stringify({ key: null, labels: { bad: 2 }, createdAt: 1 })]) {
      read.mockResolvedValue(Buffer.from(body));
      expect(await factory().list({})).toEqual([]);
    }
    read.mockRejectedValue(Object.assign(new Error("gone"), { grpcCode: 5 }));
    expect(await factory().list({})).toEqual([]);
    read.mockRejectedValue(Object.assign(new Error("denied"), { grpcCode: 16 }));
    await expect(factory().list({})).rejects.toMatchObject({ code: "auth" });
    read.mockRestore();
  } finally { await box.destroy(); }
});
