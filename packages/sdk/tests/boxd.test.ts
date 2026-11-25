import { afterAll, describe, expect, test, vi } from "vitest";
import { ExecStream } from "@boxd-sh/sdk";
import { boxd as mockBoxd, boxdState, MockBoxd } from "./cloud-guest-mock.js";
import { isString } from "../src/shared/narrow.js";
import type { BoxdClient, BoxdOptions, BoxdTransfers } from "../src/providers/boxd/provider.js";
import { boxdError, type BoxdEvidence } from "../src/providers/boxd/errors.js";
import { SandboxError } from "../src/errors.js";
import { createSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";

type Snapshots = BoxdClient["snapshots"];

const mocks = {
  web: new Array<MockBoxd>(),
  snapshotCreate: vi.fn<Snapshots["create"]>(),
  snapshotGet: vi.fn<Snapshots["get"]>(),
  snapshotDelete: vi.fn<Snapshots["delete"]>(),
  setEgressAllow: vi.fn(async (_id: string, entries: string[]) => entries),
  /** releaseIdle calls on the transfer workers. */
  releases: 0,
};

/** The boxd client fixture: Linux-backed machines plus spied snapshot and egress calls. */
class TestBoxd extends MockBoxd {
  override snapshots = {
    create: mocks.snapshotCreate,
    get: mocks.snapshotGet,
    delete: mocks.snapshotDelete,
  };
  constructor() {
    super();
    this.machines.setEgressAllow = mocks.setEgressAllow;
  }
}

/** Whole-file transfers through an in-process mock client instead of worker threads. */
class TestTransfers implements BoxdTransfers {
  private client = new MockBoxd();
  constructor() {
    mocks.web.push(this.client);
  }
  upload(id: string, path: string, bytes: Uint8Array) {
    return this.client.machines.files.upload(id, path, bytes);
  }
  download(id: string, path: string) {
    return this.client.machines.files.download(id, path);
  }
  async closeMachine() {}
  async releaseIdle() {
    mocks.releases++;
  }
}

function boxd(options: BoxdOptions) {
  return mockBoxd(options, TestBoxd, () => new TestTransfers());
}

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

/** The evidence fields a boxd SandboxError carries in its cause. */
function evidence(error: SandboxError): BoxdEvidence {
  if (!(error.cause instanceof Error)) throw new Error("expected an evidence cause");
  const fields: BoxdEvidence = JSON.parse(error.cause.message);

  return fields;
}

const statusName = (code: number) =>
  ({
    1: "CANCELLED",
    3: "INVALID_ARGUMENT",
    4: "DEADLINE_EXCEEDED",
    5: "NOT_FOUND",
    7: "PERMISSION_DENIED",
    8: "RESOURCE_EXHAUSTED",
    14: "UNAVAILABLE",
    16: "UNAUTHENTICATED",
  })[code];

const factory = () => boxd({ apiKey: "mock-key" });

// The conformance guard admits local transports only when live:false. This is
// a local Linux transport, not permission to contact the cloud.
runConformance(factory, {
  live: true,
  unsupported: { httpProbe: "Mock boxd preview URLs point at an unreachable host" },
});

afterAll(async () => {
  await Promise.all([...boxdState.boxes.values()].map((v) => v.guest.destroy()));
  boxdState.boxes.clear();
});

test("pending allocations use only native readiness before returning", async () => {
  const provider = factory();
  const first = await createSandbox(provider);
  const client = first.native.client;
  const create = client.machines.create.bind(client.machines);

  const allocation = vi
    .spyOn(client.machines, "create")
    .mockImplementationOnce(async (input) => ({ ...(await create(input)), status: "pending" }));

  const wait = vi.spyOn(client.machines, "waitUntilReady");
  const exec = vi.spyOn(client.machines, "exec");
  const second = await createSandbox(provider);

  try {
    expect(wait).toHaveBeenCalledTimes(1);
    expect(exec).not.toHaveBeenCalled();
    expect(await factory().connect(second.id)).toMatchObject({ labels: second.labels });
    expect(await second.files.exists("injected")).toBe(false);
  } finally {
    allocation.mockRestore();
    wait.mockRestore();
    exec.mockRestore();
    await second.destroy();
    await first.destroy();
  }
});

describe("boxd contract", () => {
  test("rejects every unenforceable option before allocating", async () => {
    const provider = factory();
    const before = boxdState.creates.length;

    for (const opts of [
      { network: "none" },
      { network: { allow: [] } },
      { network: { allow: ["https://example.com"] } },
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
      expect(evidence(error)).toEqual({
        providerCode: grpcCode,
        providerStatus: statusName(grpcCode),
      });
      expect(String(error)).not.toContain("secret-native-error");
      expect(String(error.cause)).not.toContain("secret-native-error");
    }
  });
  test("maps SDK failures without a gRPC status", () => {
    for (const [name, code] of [
      ["AuthenticationError", "auth"],
      ["PermissionDeniedError", "auth"],
      ["APIConnectionError", "unavailable"],
      ["RateLimitError", "quota"],
    ] as const) {
      // A recognized error keeps only its name as evidence.
      const result = boxdError(Object.assign(new Error("private-key"), { name }));
      expect(result.code).toBe(code);
      expect(evidence(result)).toEqual({ nativeName: name });
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

cloudRegressions(
  () => {
    const provider = factory();
    const create = provider.create;
    provider.create = async (input) => {
      const info = await create(input);
      await provider.files.list(info.id, "/workspace");

      return info;
    };

    return provider;
  },
  (id) => boxdState.boxes.get(id)?.guest,
);

test("plain BoxdError local exec deadline maps to timeout without native details", () => {
  const result = boxdError(
    Object.assign(new Error("exec timed out after 10ms"), { name: "BoxdError" }),
  );

  expect(result.code).toBe("timeout");
  expect(evidence(result)).toEqual({ nativeName: "BoxdError" });
  expect(String(result)).not.toContain("10ms");
  expect(boxdError(Object.assign(new Error("unrelated failure"), { name: "BoxdError" })).code).toBe(
    "provider",
  );
});

test("cancellation before launch is confirmed by preventing a late command", async () => {
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
      timedOut: true,
      exitCode: null,
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
  const result = boxdError(
    Object.assign(new Error("upload failed: Permission denied private-key /secret/path"), {
      grpcCode: 13,
    }),
  );

  expect(result.code).toBe("provider");
  expect(result.message).toContain("permission denied");
  expect(result.message).not.toContain("private-key");
  expect(result.message).not.toContain("/secret/path");
  expect(evidence(result)).toEqual({ providerCode: 13, providerStatus: "INTERNAL" });
});

test("a delayed native launch cannot run after cancellation was confirmed", async () => {
  const box = await createSandbox(factory());
  const native = box.native.client.machines;
  const original = native.streamExec.bind(native);

  const spy = vi.spyOn(native, "streamExec").mockImplementationOnce((id, params) => {
    const stream = original(id, params);
    const end = stream.end.bind(stream);
    stream.end = () => {
      setTimeout(end, 1300);
    };

    return stream;
  });

  try {
    expect(await box.run("echo leaked > late-launch", { timeoutMs: 20 })).toMatchObject({
      timedOut: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await box.files.exists("late-launch")).toBe(false);
  } finally {
    spy.mockRestore();
    await box.destroy();
  }
});

test("transport cancellation kills descendants after their shell has exited", async () => {
  const box = await createSandbox(factory());
  const entry = boxdState.boxes.get(box.id);

  if (!entry) throw new Error("Missing mock VM");
  entry.guest.cancelWithoutTermination = true;

  try {
    expect(await box.run("(sleep 2; echo leaked > orphan) &", { timeoutMs: 80 })).toMatchObject({
      timedOut: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(await box.files.exists("orphan")).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("activity protects background output after the command shell exits", async () => {
  const provider = factory();
  const box = await createSandbox(provider);

  try {
    let ready = () => {};

    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const run = box.run("(sleep .5; echo child) & echo ready");

    const output = (async () => {
      for await (const chunk of run) if (chunk.text.includes("ready")) ready();
    })();

    await started;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await box.files.list("/tmp/.sandbox-sdk/runs")).length).toBe(1);
    await output;
    expect((await run).stdout).toContain("child");
    expect(await box.files.list("/tmp/.sandbox-sdk/runs")).toEqual([]);
  } finally {
    await box.destroy();
  }
});

test("preview uses the native default hostname covered by the wildcard certificate", async () => {
  const box = await createSandbox(factory());

  try {
    const proxies = box.native.client.machines.proxies;
    vi.spyOn(proxies, "list").mockResolvedValueOnce([
      {
        name: null,
        domain: "machine.boxd.sh",
        port: 3000,
        isDefault: true,
        machineId: box.id,
        machineName: "machine",
        portMode: "locked",
      },
      {
        name: "sdk-3000",
        domain: "sdk-3000.machine.boxd.sh",
        port: 3000,
        isDefault: false,
        machineId: box.id,
        machineName: "machine",
        portMode: "locked",
      },
    ]);
    const setPort = vi.spyOn(proxies, "setPort");
    expect(await box.preview(3000)).toMatchObject({ url: "https://machine.boxd.sh" });
    expect(setPort).toHaveBeenLastCalledWith(box.id, 3000);
  } finally {
    await box.destroy();
    vi.restoreAllMocks();
  }
});

test("large binary reads avoid the truncated native download stream", async () => {
  const box = await createSandbox(factory());

  try {
    const data = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 251);
    await box.files.write("large.bin", data);
    vi.spyOn(box.native.client.machines.files, "download").mockRejectedValue(
      new Error("download truncated: expected 10485760 bytes, got 10424320"),
    );
    expect(
      Buffer.from(await box.files.read("large.bin", { as: "bytes" })).equals(Buffer.from(data)),
    ).toBe(true);
  } finally {
    await box.destroy();
    vi.restoreAllMocks();
  }
});

test("whole-file transfers use the web client and preserve authentication errors", async () => {
  const box = await createSandbox(factory());

  try {
    const data = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => i % 251);
    await box.files.list(".");
    // Lazy file transport is initialized on the first transfer.
    await box.files.write("retry.bin", data);
    const fileClient = mocks.web.at(-1);

    if (!fileClient) throw new Error("Missing web transport");
    const read = vi.spyOn(fileClient.machines.files, "download");
    const native = vi.spyOn(box.native.client.machines, "exec");
    expect(
      Buffer.from(await box.files.read("retry.bin", { as: "bytes" })).equals(Buffer.from(data)),
    ).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(native).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(Object.assign(new Error("denied"), { grpcCode: 7 }));
    await expect(box.files.read("retry.bin")).rejects.toMatchObject({ code: "auth" });
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    await box.destroy();
  }
});

test("boxd listing skips corrupt or vanished per-machine metadata and preserves auth failures", async () => {
  // A keyed machine's metadata is only in its guest; a v2 name carries its own.
  const box = await createSandbox(factory(), { key: `corrupt-${crypto.randomUUID()}` });

  try {
    const entry = boxdState.boxes.get(box.id);

    if (!entry) throw new Error("Missing mock machine");
    const read = vi.spyOn(entry.guest, "read");

    for (const body of ["{", JSON.stringify({ key: null, labels: { bad: 2 }, createdAt: 1 })]) {
      read.mockResolvedValue(Buffer.from(body));
      expect(await factory().list({})).toEqual([]);
    }

    // Without its marker a keyed machine can't be identified, so it is left out.
    read.mockRejectedValue(Object.assign(new Error("gone"), { grpcCode: 5 }));
    expect((await factory().list({})).map((value) => value.id)).not.toContain(box.id);
    read.mockRejectedValue(Object.assign(new Error("denied"), { grpcCode: 16 }));
    await expect(factory().list({})).rejects.toMatchObject({ code: "auth" });
    read.mockRestore();
  } finally {
    await box.destroy();
  }
});

test("listing never reads a paused machine's guest, which would wake it; find still reaches one by key", async () => {
  const provider = factory();
  const key = `asleep-${crypto.randomUUID()}`;
  const plain = await createSandbox(provider);
  const keyed = await provider.create({ key, labels: { team: "a" } });

  const entryOf = (id: string) => {
    const entry = boxdState.boxes.get(id);

    if (!entry) throw new Error("Missing mock machine");

    return entry;
  };

  const entries = [entryOf(plain.id), entryOf(keyed.id)];

  try {
    // The plain machine's name carries its metadata; the keyed one's lives only in the guest.
    expect(entries.map((e) => e.machine.name.startsWith("sbxsdk-v2-"))).toEqual([true, false]);

    for (const e of entries) e.machine.status = "hibernated";
    const reads = entries.map((e) => vi.spyOn(e.guest, "read"));
    const listed = await factory().list({});

    expect(listed.find((v) => v.id === plain.id)).toMatchObject({
      state: "paused",
      labels: { "sandbox-sdk": "1" },
    });
    expect(listed.some((v) => v.id === keyed.id)).toBe(false);
    expect(reads.map((r) => r.mock.calls.length)).toEqual([0, 0]);

    // The machines left out are reported, still without reading a guest.
    expect((await factory().listSleeping()).filter((m) => m.id === keyed.id)).toEqual([
      expect.objectContaining({ id: keyed.id, state: "paused" }),
    ]);
    expect(reads.map((r) => r.mock.calls.length)).toEqual([0, 0]);

    // It reads no guest even of a running keyed machine, which could fall asleep before the read.
    const keyedMachine = entries[1]?.machine;

    if (!keyedMachine) throw new Error("Missing mock machine");
    keyedMachine.status = "running";
    expect((await factory().listSleeping()).some((m) => m.id === keyed.id)).toBe(false);
    expect(reads.map((r) => r.mock.calls.length)).toEqual([0, 0]);
    keyedMachine.status = "hibernated";

    // A v2 machine boxd lists as running is not read either, so one that falls asleep between
    // boxd's listing and the read can't be woken.
    const machine = entries[0]?.machine;

    if (!machine) throw new Error("Missing mock machine");
    machine.status = "running";
    expect((await factory().list({})).some((v) => v.id === plain.id)).toBe(true);
    expect(reads.map((r) => r.mock.calls.length)).toEqual([0, 0]);
    machine.status = "hibernated";

    // Finding by key has to read the guest, and does so only for the paused machines.
    expect(await factory().find(key)).toMatchObject({ id: keyed.id, key, state: "paused" });
    expect(reads.map((r) => r.mock.calls.length > 0)).toEqual([false, true]);
  } finally {
    vi.restoreAllMocks();

    for (const e of entries) e.machine.status = "running";
    await plain.destroy();
    await provider.destroy(keyed.id);
  }
});

test("sizes select boxd's coupled CPU and memory classes before allocation", async () => {
  const provider = factory();
  expect(provider.capabilities.has("size")).toBe(true);

  for (const [size, vcpu] of [
    ["small", 1],
    ["medium", 2],
    ["large", 4],
    [{ cpu: 8, memoryMb: 32768, diskGb: 100 }, 8],
  ] satisfies [NonNullable<Parameters<typeof provider.create>[0]["size"]>, number][]) {
    const info = await provider.create({ labels: {}, size });

    try {
      expect(boxdState.creates.at(-1)?.config?.vcpu).toBe(vcpu);
    } finally {
      await provider.destroy(info.id);
    }
  }

  const before = boxdState.creates.length;
  await expect(
    provider.create({ labels: {}, size: { cpu: 4, memoryMb: 8192, diskGb: 100 } }),
  ).rejects.toMatchObject({
    code: "unsupported",
    message: expect.stringContaining("4 vCPU / 16 GiB"),
  });
  expect(boxdState.creates.length).toBe(before);
});

test("custom ownership metadata is persisted before returning", async () => {
  const provider = factory();
  const info = await provider.create({ labels: { example: "quote'雪" }, key: "new" });

  try {
    const entry = boxdState.boxes.get(info.id);
    expect(entry?.guest.commands).toHaveLength(1);
    expect(entry?.guest.uploads).toHaveLength(0);
    expect(entry?.guest.reads).toHaveLength(0);
    expect(await factory().connect(info.id)).toEqual(info);
  } finally {
    await provider.destroy(info.id);
  }
});

test("snapshots wait until ready and restore without fresh-machine options", async () => {
  const provider = factory();
  const info = await provider.create({ labels: {} });
  mocks.snapshotCreate.mockResolvedValue({ status: "pending" });
  mocks.snapshotGet
    .mockResolvedValueOnce({ status: "pending" })
    .mockResolvedValue({ status: "ready" });

  try {
    const saved = await provider.snapshot?.(info.id);
    expect(saved?.id).toMatch(/^sbxsdk-/);
    expect(mocks.snapshotGet).toHaveBeenCalledTimes(2);

    const restored = await createSandbox(provider, {
      labels: { restored: "yes" },
      from: saved?.id,
    });

    try {
      expect(boxdState.creates.at(-1)).toMatchObject({
        fromSnapshot: saved?.id,
        config: { autoSuspendTimeout: 0 },
      });
      expect(boxdState.creates.at(-1)).not.toHaveProperty("image");
      expect(boxdState.creates.at(-1)).not.toHaveProperty("env");
      expect(await factory().connect(restored.id)).toMatchObject({ labels: { restored: "yes" } });
    } finally {
      await provider.destroy(restored.id);
    }

    for (const overrides of [{ size: "small" }, { env: { X: "1" } }] satisfies Partial<
      Parameters<typeof provider.create>[0]
    >[]) {
      await expect(
        provider.create({ labels: {}, from: saved?.id, ...overrides }),
      ).rejects.toMatchObject({ code: "unsupported" });
    }
  } finally {
    await provider.destroy(info.id);
    mocks.snapshotGet.mockReset();
  }
});

test("failed snapshot capture removes its artifact", async () => {
  const provider = factory();
  const info = await provider.create({ labels: {} });
  mocks.snapshotCreate.mockResolvedValue({ status: "pending" });
  mocks.snapshotGet.mockResolvedValue({ status: "failed" });
  mocks.snapshotDelete.mockResolvedValue(undefined);

  try {
    await expect(provider.snapshot?.(info.id)).rejects.toMatchObject({ code: "provider" });
    expect(mocks.snapshotDelete).toHaveBeenCalledWith(mocks.snapshotCreate.mock.calls.at(-1)?.[1]);
  } finally {
    await provider.destroy(info.id);
  }
});

test("snapshot creation failures survive cleanup of a nonexistent capture", async () => {
  const provider = factory();
  const info = await provider.create({ labels: {} });
  mocks.snapshotCreate.mockRejectedValueOnce(Object.assign(new Error("quota"), { grpcCode: 8 }));
  mocks.snapshotDelete.mockRejectedValueOnce(Object.assign(new Error("missing"), { grpcCode: 5 }));

  try {
    await expect(provider.snapshot?.(info.id)).rejects.toMatchObject({ code: "quota" });
  } finally {
    await provider.destroy(info.id);
  }
});

test("unconfirmed snapshot cleanup reports the recoverable capture name", async () => {
  const provider = factory();
  const info = await provider.create({ labels: {} });
  mocks.snapshotCreate.mockRejectedValueOnce(
    Object.assign(new Error("private timeout details"), { grpcCode: 4 }),
  );
  mocks.snapshotDelete.mockRejectedValueOnce(
    Object.assign(new Error("private transport details"), { grpcCode: 14 }),
  );

  try {
    await expect(provider.snapshot?.(info.id)).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringMatching(/Snapshot sbxsdk-.*cleanup is unconfirmed after timeout/),
    });
  } finally {
    await provider.destroy(info.id);
  }
});

test("empty snapshot names cannot silently allocate a fresh machine", async () => {
  const provider = factory();
  const before = boxdState.creates.length;

  for (const from of ["", " "])
    await expect(provider.create({ labels: {}, from })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  expect(boxdState.creates.length).toBe(before);
});

test("command shells restore SIGPIPE and use the supplied PATH", async () => {
  const box = await createSandbox(factory());

  try {
    expect(await box.run("kill -PIPE $$; echo survived")).toMatchObject({
      exitCode: 141,
      stdout: "",
    });
    const pipe = await box.run("yes | head -n 1");
    expect(pipe.stderr).toBe("");
    await box.files.write("shell-path/sh", '#!/bin/sh\nprintf selected >&2\nexec /bin/sh "$@"\n');
    await box.files.write("blocked-path/sh", "not executable");
    await box.run("chmod +x shell-path/sh");
    expect(
      await box.run("printf command", {
        env: { PATH: "/workspace/blocked-path:/workspace/shell-path" },
      }),
    ).toMatchObject({ stdout: "command", stderr: "selected", exitCode: 0 });
  } finally {
    await box.destroy();
  }
});

test.each(["missing", "unsupported", "restricted"])(
  "guest launch retains the portable fallback (%s)",
  async (mode) => {
    const box = await createSandbox(factory());
    const machines = box.native.client.machines;
    const stream = machines.streamExec.bind(machines);

    const injection =
      mode === "missing"
        ? 'import subprocess\nfor name in ["memfd_create","posix_spawn","waitstatus_to_exitcode"]:\n if hasattr(os,name): delattr(os,name)'
        : mode === "unsupported"
          ? "def unavailable(*args,**kwargs): raise NotImplementedError()\nos.posix_spawn=unavailable"
          : 'def unavailable(*args,**kwargs): raise OSError(38,"unavailable")\nos.memfd_create=unavailable\nos.posix_spawn=unavailable';

    const spy = vi.spyOn(machines, "streamExec").mockImplementation((id, params) => {
      if (!isString(params.command)) throw new Error("Expected shell command");

      return stream(id, {
        ...params,
        command: params.command.replace("class Process:", injection + "\nclass Process:"),
      });
    });

    try {
      expect(await box.run("cat; kill -PIPE $$; echo survived", { stdin: "input" })).toMatchObject({
        stdout: "input",
        exitCode: 141,
      });
      expect(
        await box.run("(sleep .5; echo leaked > fallback-leak) & wait", { timeoutMs: 30 }),
      ).toMatchObject({ timedOut: true });
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await box.files.exists("fallback-leak")).toBe(false);
    } finally {
      spy.mockRestore();
      await box.destroy();
    }
  },
);

test("listing keeps no per-machine state; connecting queues the guest preparation", async () => {
  const box = await createSandbox(factory());
  const guest = boxdState.boxes.get(box.id)?.guest;

  if (!guest) throw new Error("Missing guest");
  const lister = factory();
  const run = { command: "true", cwd: "/", env: {}, timeoutMs: 30_000, onChunk: () => {} };

  try {
    expect((await lister.list({})).some((v) => v.id === box.id)).toBe(true);
    const before = guest.commands.length;

    await lister.exec(box.id, run);
    expect(guest.commands.slice(before).join("\n")).not.toContain("metadata.json");
    await lister.connect(box.id);
    await lister.exec(box.id, run);
    expect(guest.commands.slice(before).join("\n")).toContain("metadata.json");
  } finally {
    await box.destroy();
  }
});

test("plain create has no guest call and first list prepares in one request", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  const guest = boxdState.boxes.get(box.id)?.guest;

  if (!guest) throw new Error("Missing guest");

  try {
    expect(guest.commands).toHaveLength(0);
    expect(await box.files.list(".")).toEqual([]);
    expect(guest.commands).toHaveLength(1);
    await box.run("rm -rf /workspace", { cwd: "/" });
    expect(await box.files.exists("/workspace")).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("fresh client prepares a sandbox closed before first use", async () => {
  const box = await createSandbox(factory());
  const id = box.id;
  await box.close();
  const { connectSandbox } = await import("../src/index.js");
  const connected = await connectSandbox(factory(), id);

  try {
    expect(await connected.run("pwd")).toMatchObject({ stdout: "/workspace\n", exitCode: 0 });
  } finally {
    await connected.destroy();
  }
});

describe("boxd native options (SBX-71)", () => {
  test("lifetime, idle suspend and volumes reach machines.create in seconds", async () => {
    const provider = boxd({
      apiKey: "mock-key",
      volumes: [{ diskId: "disk-1", mountPath: "/data", readOnly: true }],
    });

    const created = await provider.create({
      labels: {},
      timeoutMs: 90_500,
      idleTimeoutMs: 300_000,
    });

    try {
      expect(boxdState.creates.at(-1)).toMatchObject({
        deleteAfter: 91,
        config: {
          autoSuspendTimeout: 300,
          autoDestroyTimeout: 0,
          volumes: [{ diskId: "disk-1", mountPath: "/data", readOnly: true }],
        },
      });
    } finally {
      await provider.destroy(created.id);
    }

    const plain = await factory().create({ labels: {} });

    try {
      expect(boxdState.creates.at(-1)).not.toHaveProperty("deleteAfter");
      expect(boxdState.creates.at(-1)).toMatchObject({ config: { autoSuspendTimeout: 0 } });
    } finally {
      await factory().destroy(plain.id);
    }

    await expect(provider.create({ labels: {}, from: "snap" })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(factory().create({ labels: {}, timeoutMs: 0 })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });
  test("snapshot restores carry the lifetime and idle settings", async () => {
    const provider = factory();

    const created = await provider.create({
      labels: {},
      from: "snap",
      timeoutMs: 60_000,
      idleTimeoutMs: 1_000,
    });

    try {
      expect(boxdState.creates.at(-1)).toMatchObject({
        fromSnapshot: "snap",
        deleteAfter: 60,
        config: { autoSuspendTimeout: 1 },
      });
    } finally {
      await provider.destroy(created.id);
    }
  });
  test("an allow-list is applied with setEgressAllow and confirmed before return", async () => {
    const provider = factory();
    expect(provider.capabilities.has("network-policy")).toBe(true);
    mocks.setEgressAllow.mockClear();

    const created = await provider.create({
      labels: {},
      network: { allow: ["registry.npmjs.org", "*.github.com", "140.82.112.0/20"] },
    });

    try {
      expect(mocks.setEgressAllow).toHaveBeenCalledWith(created.id, [
        "registry.npmjs.org",
        "*.github.com",
        "140.82.112.0/20",
      ]);
    } finally {
      await provider.destroy(created.id);
    }

    mocks.setEgressAllow.mockResolvedValueOnce([]);
    const before = boxdState.boxes.size;
    await expect(
      provider.create({ labels: {}, network: { allow: ["example.com"] } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(boxdState.boxes.size).toBe(before);
  });
  test("snapshot rejects expiresInMs before capturing", async () => {
    const provider = factory();
    const created = await provider.create({ labels: {} });

    try {
      mocks.snapshotCreate.mockClear();
      await expect(provider.snapshot?.(created.id, { expiresInMs: 1000 })).rejects.toMatchObject({
        code: "unsupported",
      });
      expect(mocks.snapshotCreate).not.toHaveBeenCalled();
    } finally {
      await provider.destroy(created.id);
    }
  });
});

test("a missing file is file_not_found for read, edit and remove, like the other providers", async () => {
  const box = await createSandbox(factory());

  try {
    await box.run("true");

    for (const action of [
      () => box.files.read("missing.txt"),
      () => box.files.edit("missing.txt", { find: "a", replace: "b" }),
      () => box.files.remove("missing.txt"),
      () => box.files.remove("missing-dir/x.txt", { recursive: true }),
    ])
      await expect(action()).rejects.toMatchObject({ code: "file_not_found", provider: "boxd" });
    await box.files.write("present.txt", "x");
    await box.files.remove("present.txt");
    expect(await box.files.exists("present.txt")).toBe(false);
  } finally {
    await box.destroy();
  }
});

test("a keyed machine with an allow-list is not findable until the list is confirmed", async () => {
  const provider = factory();
  const other = factory();
  const key = `egress-${crypto.randomUUID()}`;
  let confirm = () => {};

  const gate = new Promise<void>((resolve) => {
    confirm = resolve;
  });

  mocks.setEgressAllow.mockClear();

  mocks.setEgressAllow.mockImplementationOnce(async (_id, entries) => {
    await gate;

    return entries;
  });

  const creating = provider.create({ key, labels: {}, network: { allow: ["example.com"] } });

  try {
    await vi.waitFor(() => expect(mocks.setEgressAllow).toHaveBeenCalledTimes(1));
    // Long enough for a metadata write racing the confirmation to land.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await other.find(key)).toBeUndefined();
  } finally {
    confirm();
  }

  const created = await creating;

  try {
    expect((await other.find(key))?.id).toBe(created.id);
  } finally {
    await provider.destroy(created.id);
  }
});

test("a create whose allow-list fails drops the machine locally even when its delete fails", async () => {
  const provider = factory();
  const kept = await createSandbox(provider);
  let failed: string | undefined;

  try {
    // A whole-file read opens the transfer workers that close() releases.
    await kept.files.write("f.txt", "x");
    expect(await kept.files.read("f.txt")).toBe("x");
    const machines = kept.native.client.machines;
    const remove = vi.spyOn(machines, "delete").mockRejectedValueOnce(new Error("delete failed"));
    mocks.setEgressAllow.mockResolvedValueOnce([]);

    await expect(
      provider.create({ labels: {}, network: { allow: ["example.com"] } }),
    ).rejects.toBeDefined();
    failed = remove.mock.calls[0]?.[0];
    expect(failed).toBeDefined();
    remove.mockRestore();

    // The only machine left on this client is `kept`, so closing it releases the idle workers.
    mocks.releases = 0;
    await kept.close();
    expect(mocks.releases).toBe(1);
  } finally {
    await provider.destroy(kept.id);

    if (failed) await provider.destroy(failed);
  }
});

describe("boxd failure evidence", () => {
  test("a control-plane call keeps boxd's status, message, reason and request ID, with the API key redacted", () => {
    vi.stubEnv("BOXD_API_KEY", "bxd-secret-key-123");

    try {
      const native = Object.assign(
        new Error("machine 0a1b is not suspended (key bxd-secret-key-123)"),
        {
          name: "ConflictError",
          grpcCode: 9,
          reason: "machine_not_suspended",
          metadata: new Headers({ "x-request-id": "req-42" }),
        },
      );

      const error = boxdError(native, { call: "machines.resume", sandboxId: "0a1b" });

      expect(error.code).toBe("invalid_argument");
      expect(error.sandboxId).toBe("0a1b");
      expect(error.message).not.toContain("not suspended");
      expect(evidence(error)).toEqual({
        operation: "machines.resume",
        machineId: "0a1b",
        providerCode: 9,
        providerStatus: "FAILED_PRECONDITION",
        nativeName: "ConflictError",
        providerReason: "machine_not_suspended",
        requestId: "req-42",
        providerMessage: "machine 0a1b is not suspended (key [REDACTED])",
      });
      expect(String(error.cause)).not.toContain("bxd-secret-key-123");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("an API key passed to the provider is redacted like BOXD_API_KEY", () => {
    const error = boxdError(
      Object.assign(new Error("key sk-explicit-42 is not allowed here"), { grpcCode: 7 }),
      { call: "machines.create" },
      ["sk-explicit-42"],
    );

    expect(evidence(error)).toMatchObject({
      providerMessage: "key [REDACTED] is not allowed here",
    });
    expect(String(error.cause)).not.toContain("sk-explicit-42");
  });

  test("boxd's message is not cut before the core redacts the sandbox's secrets", async () => {
    // 64 characters: 15 redacted copies shrink, so a copy cut at character 1,000 would land
    // inside the core's 300-character field bound and leave a fragment.
    const secret = `SANDBOX-SECRET-${"0123456789".repeat(4)}-abcdefgh`;
    const box = await createSandbox(factory(), { secrets: { TOKEN: secret } });
    const machines = box.native.client.machines;

    const resume = vi.spyOn(machines, "resume").mockRejectedValueOnce(
      Object.assign(new Error(`${`${secret} `.repeat(15)}pad${secret}`), {
        name: "ConflictError",
        grpcCode: 9,
      }),
    );

    try {
      await box.pause();

      const error = await box.resume().then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(String(error instanceof SandboxError ? error.cause : "")).not.toContain("SANDBOX-SEC");
    } finally {
      resume.mockRestore();
      await box.destroy();
    }
  });

  test("the adapter's own error keeps boxd's message scrubbed", () => {
    const error = boxdError(
      Object.assign(
        new Error("rejected https://api.example/?token=abc\nAuthorization: Bearer zz9"),
        {
          grpcCode: 3,
        },
      ),
      { call: "machines.list" },
    );

    const { providerMessage } = evidence(error);

    expect(providerMessage).not.toContain("api.example");
    expect(providerMessage).not.toContain("zz9");
    expect(providerMessage).not.toContain("\n");
  });

  test("a multiline sandbox secret in boxd's message is redacted whole", async () => {
    const secret =
      "-----BEGIN KEY-----\nline-one-0123456789\nline-two-abcdefghij\n-----END KEY-----";

    const box = await createSandbox(factory(), { secrets: { PRIVATE_KEY: secret } });
    const machines = box.native.client.machines;

    const resume = vi.spyOn(machines, "resume").mockRejectedValueOnce(
      Object.assign(new Error(`bad value ${secret} in request`), {
        name: "ConflictError",
        grpcCode: 9,
      }),
    );

    try {
      await box.pause();

      const error = await box.resume().then(
        () => undefined,
        (cause: unknown) => cause,
      );

      const cause = String(error instanceof SandboxError ? error.cause : "");

      expect(cause).toContain("bad value [REDACTED] in request");
      expect(cause).not.toContain("line-one");
      expect(cause).not.toContain("line-two");
    } finally {
      resume.mockRestore();
      await box.destroy();
    }
  });

  test("a URL that begins with a sandbox secret is still scrubbed whole", async () => {
    const box = await createSandbox(factory(), { secrets: { STORE: "https://storage.example" } });
    const machines = box.native.client.machines;

    const resume = vi
      .spyOn(machines, "resume")
      .mockRejectedValueOnce(
        Object.assign(
          new Error("upload to https://storage.example/object?X-Amz-Signature=sig123 failed"),
          { name: "ConflictError", grpcCode: 9 },
        ),
      );

    try {
      await box.pause();

      const error = await box.resume().then(
        () => undefined,
        (cause: unknown) => cause,
      );

      const cause = String(error instanceof SandboxError ? error.cause : "");

      expect(cause).not.toContain("sig123");
      expect(cause).not.toContain("storage.example");
    } finally {
      resume.mockRestore();
      await box.destroy();
    }
  });

  test("a credential label that overlaps a sandbox secret still hides its value", async () => {
    const box = await createSandbox(factory(), { secrets: { APP: "myapp-api" } });
    const machines = box.native.client.machines;

    const resume = vi.spyOn(machines, "resume").mockRejectedValueOnce(
      Object.assign(new Error("rejected myapp-api_key=hunter2 for this machine"), {
        name: "ConflictError",
        grpcCode: 9,
      }),
    );

    try {
      await box.pause();

      const error = await box.resume().then(
        () => undefined,
        (cause: unknown) => cause,
      );

      const cause = String(error instanceof SandboxError ? error.cause : "");

      expect(cause).not.toContain("hunter2");
      expect(cause).not.toContain("myapp-api");
    } finally {
      resume.mockRestore();
      await box.destroy();
    }
  });

  test("a guest call never keeps boxd's text, which can echo user paths", () => {
    const error = boxdError(
      Object.assign(new Error("read /workspace/private.txt: input/output error"), {
        name: "APIStatusError",
        grpcCode: 13,
      }),
      { sandboxId: "box" },
    );

    expect(evidence(error)).toEqual({
      providerCode: 13,
      providerStatus: "INTERNAL",
      nativeName: "APIStatusError",
    });
  });

  test("request IDs and reasons that are not opaque tokens are dropped", () => {
    const error = boxdError(
      Object.assign(new Error("rejected"), {
        grpcCode: 3,
        reason: "has spaces /and/paths",
        requestId: "x".repeat(200),
      }),
      { call: "machines.pause", sandboxId: "box" },
    );

    expect(evidence(error)).toEqual({
      operation: "machines.pause",
      machineId: "box",
      providerCode: 3,
      providerStatus: "INVALID_ARGUMENT",
      providerMessage: "rejected",
    });
  });

  test("a rejected resume names the call and machine, and keeps the same code", async () => {
    const box = await createSandbox(factory());
    const machines = box.native.client.machines;

    const resume = vi.spyOn(machines, "resume").mockRejectedValueOnce(
      Object.assign(new Error("machine is still suspending"), {
        name: "ConflictError",
        grpcCode: 9,
      }),
    );

    try {
      await box.pause();

      const error = await box.resume().then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(error).toMatchObject({ code: "invalid_argument", sandboxId: box.id });
      // The core keeps the evidence as text in the cause.
      expect(error instanceof SandboxError ? JSON.parse(String(error.cause)) : null).toMatchObject({
        operation: "machines.resume",
        machineId: box.id,
        providerCode: 9,
        providerStatus: "FAILED_PRECONDITION",
        nativeName: "ConflictError",
        providerMessage: "machine is still suspending",
      });
    } finally {
      resume.mockRestore();
      await box.destroy();
    }
  });

  test("a machine that fails while starting is named in evidence, never as the create's sandbox", async () => {
    const provider = factory();
    const first = await createSandbox(provider);
    const machines = first.native.client.machines;
    const create = machines.create.bind(machines);
    let failed = "";

    const allocation = vi.spyOn(machines, "create").mockImplementationOnce(async (input) => {
      const m = await create(input);
      failed = m.id;

      return { ...m, status: "pending" };
    });

    const wait = vi.spyOn(machines, "waitUntilReady").mockImplementationOnce(async (id) =>
      Promise.reject(
        Object.assign(new Error(`machine ${id} entered terminal state 'failed' while waiting`), {
          name: "BoxdError",
        }),
      ),
    );

    try {
      const error = await createSandbox(provider).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(error).toBeInstanceOf(SandboxError);
      expect(error instanceof SandboxError ? error.sandboxId : "set").toBeUndefined();
      expect(error instanceof SandboxError ? JSON.parse(String(error.cause)) : null).toMatchObject({
        operation: "machines.waitUntilReady",
        machineId: failed,
        nativeName: "BoxdError",
        providerMessage: `machine ${failed} entered terminal state 'failed' while waiting`,
      });
    } finally {
      allocation.mockRestore();
      wait.mockRestore();
      await first.destroy();
    }
  });
});
