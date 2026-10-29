import { afterAll, describe, expect, test } from "vitest";
import { createSandbox, connectSandbox } from "../src/index.js";
import { createVercelProvider } from "../src/providers/vercel/provider.js";
import { vercel, type VercelNonPersistentProvider, type VercelOptions, type VercelProvider } from "../src/providers/vercel/index.js";
import { vercelError } from "../src/providers/vercel/errors.js";
import { runConformance } from "../src/testing.js";
import { vercelMock } from "./vercel-mock.js";

const mock = await vercelMock();
afterAll(() => mock.dispose());
const provider = () => createVercelProvider(async () => mock.client, { token: "mock-token", teamId: "team", projectId: "project" });
runConformance(provider, { live: true, ports: [3000] });

describe("Vercel adapter", { timeout: 30_000 }, () => {
  test("maps resources, tags and firewall; uses native domains", async () => {
    const box = await createSandbox(provider(), { key: "user:123", labels: { app: "builder" }, ports: [3000], size: "medium", network: { allow: ["registry.npmjs.org"] } });
    try {
      expect(mock.creates.at(-1)).toMatchObject({ name: expect.stringMatching(/^sdk-[a-f0-9]{64}$/), resources: { vcpus: 2 }, persistent: true, ports: [3000], networkPolicy: { allow: ["registry.npmjs.org"] }, tags: { "sandbox-sdk": "1", "sandbox-sdk-key": "user:123", app: "builder" } });
      expect((await box.preview(3000)).url).toBe(box.native.domain(3000));
      await expect(box.preview(8080)).rejects.toMatchObject({ code: "invalid_argument" });
      const other = await createSandbox(provider(), { key: "user:123" }); expect(other.id).toBe(box.id); expect(other.created).toBe(false);
    } finally { await box.destroy(); }
  });
  test("fails closed on idle timeout, custom disk, mismatched memory and tag overflow", async () => {
    await expect(createSandbox(provider(), { idleTimeoutMs: 1000 })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider(), { size: { cpu: 2, memoryMb: 2048 } })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider(), { size: { cpu: 1, memoryMb: 2048, diskGb: 10 } })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider(), { labels: { a: "a", b: "b", c: "c", d: "d", e: "e" } })).rejects.toMatchObject({ code: "unsupported" });
  });
  test("timeout and abort kill descendants before delayed side effects", async () => {
    const box = await createSandbox(provider());
    try {
      expect(await box.run("(sleep 0.2; echo bad > late) & wait", { timeoutMs: 30 })).toMatchObject({ timedOut: true });
      const controller = new AbortController(); const result = Promise.resolve(box.run("(sleep 0.2; echo bad > aborted-child) & wait", { signal: controller.signal })); setTimeout(() => controller.abort(), 30);
      expect(await result).toMatchObject({ timedOut: true });
      await new Promise(resolve => setTimeout(resolve, 250)); expect(await box.files.exists("late")).toBe(false); expect(await box.files.exists("aborted-child")).toBe(false);
    } finally { await box.destroy(); }
  });
  test("fresh clients stop the whole detached process group", async () => {
    const box = await createSandbox(provider());
    try {
      await box.start("(sleep 0.4; echo bad > detached-child) & wait", { name: "tree" });
      const client = await connectSandbox(provider(), box.id); await client.process("tree").stop({ graceMs: 10 });
      await new Promise(resolve => setTimeout(resolve, 450)); expect(await box.files.exists("detached-child")).toBe(false);
    } finally { await box.destroy(); }
  });
  test("resume and snapshot restore preserve files and invalidate old process records", async () => {
    const box = await createSandbox(provider());
    try {
      await box.files.write("saved", "yes"); await box.start("sleep 10", { name: "old" }); await box.pause(); await new Promise(resolve => setTimeout(resolve, 250)); expect(box.native.status).toBe("stopped"); await box.resume();
      expect(await box.files.read("saved")).toBe("yes"); expect((await box.processes())[0]).toMatchObject({ status: "failed", exitCode: 137 });
      const snapshot = await box.snapshot(); const clone = await createSandbox(provider(), { from: snapshot.id });
      try { expect(await clone.files.read("saved")).toBe("yes"); expect((await clone.processes())[0]?.status).toBe("failed"); } finally { await clone.destroy(); }
      await box.resume(); const attached = await connectSandbox(provider(), box.id); expect(await attached.files.read("saved")).toBe("yes");
    } finally { await box.destroy(); }
  });
  test("keyed clients initialize the workspace on first use without create setup", async () => {
    const key = crypto.randomUUID();
    const before = mock.commands.length;
    const a = await createSandbox(provider(), { key });
    expect(mock.commands.length).toBe(before);
    const b = await createSandbox(provider(), { key });
    try {
      expect(b.created).toBe(false);
      expect(await b.files.list("/workspace")).toEqual([]);
      expect((await a.run("pwd")).stdout.trim()).toBe("/workspace");
      expect(await a.files.exists("/workspace")).toBe(true);
    } finally { await a.destroy(); }
  });
  test("launch setup failures kill the group before rejecting", async () => {
    const box = await createSandbox(provider());
    try {
      const remove = box.native.fs.rm.bind(box.native.fs); let fail = true;
      box.native.fs.rm = async (path, options) => { if (fail && /sandbox-sdk-.*\.pid$/.test(path)) { fail = false; throw new Error("Injected removal failure"); } await remove(path, options); };
      await expect(box.run("(sleep 0.2; echo bad > launch-orphan) & wait")).rejects.toMatchObject({ code: "provider" });
      await new Promise(resolve => setTimeout(resolve, 250)); expect(await box.files.exists("launch-orphan")).toBe(false);
    } finally { await box.destroy(); }
  });
  test("maps native failures without leaking request credentials", () => {
    for (const [status, code] of [[401, "auth"], [403, "auth"], [404, "not_found"], [429, "quota"], [503, "unavailable"], [400, "invalid_argument"]] as const) {
      const mapped = vercelError(Object.assign(new Error("Bearer secret"), { response: new Response(null, { status }) })); expect(mapped.code).toBe(code); expect(mapped.message).not.toContain("secret"); expect(mapped.cause).toBe(`Error HTTP ${status}`);
    }
    expect(vercelError({ code: "ENOENT" }, "box").code).toBe("file_not_found");
  });
});


test("Vercel listing skips a VM deleted after the native list but preserves auth failures", async () => {
  const { vi } = await import("vitest");
  const box = await createSandbox(provider());
  const get = vi.spyOn(mock.client, "get");
  try {
    get.mockRejectedValue(Object.assign(new Error("gone"), { response: new Response(null, { status: 404 }) }));
    expect(await provider().list({})).toEqual([]);
    get.mockRejectedValue(Object.assign(new Error("denied"), { response: new Response(null, { status: 401 }) }));
    await expect(provider().list({})).rejects.toMatchObject({ code: "auth" });
  } finally { get.mockRestore(); await box.destroy(); }
});

test("nested writes create parents once and recover after guest removal", async () => {
  const { vi } = await import("vitest");
  const load = vi.fn(async () => mock.client);
  const adapter = createVercelProvider(load, { token: "mock-token", teamId: "team", projectId: "project" });
  expect(load).not.toHaveBeenCalled();
  const box = await createSandbox(adapter);
  const mkdir = vi.spyOn(box.native.fs, "mkdir");
  try {
    await box.files.write("nested/deep/file", "first");
    expect(mkdir).not.toHaveBeenCalled();
    expect(await box.files.read("nested/deep/file")).toBe("first");
    await box.run("rm -rf nested"); mkdir.mockClear();
    await box.files.write("nested/deep/file", "second");
    expect(mkdir).toHaveBeenCalledTimes(1);
    expect(await box.files.read("nested/deep/file")).toBe("second");
    await adapter.list({});
    expect(load).toHaveBeenCalledTimes(1);
  } finally { mkdir.mockRestore(); await box.destroy(); }
});


test.each(["list", "stat", "read", "write", "mkdir", "remove", "exec"])("fresh Vercel first %s prepares the workspace in the operation", async operation => {
  const before = mock.commands.length;
  const adapter = provider();
  const box = await createSandbox(adapter);
  try {
    expect(mock.commands.length).toBe(before);
    if (operation === "list") expect(await box.files.list("/workspace")).toEqual([]);
    if (operation === "stat") expect(await box.files.stat("/workspace")).toMatchObject({ type: "directory" });
    if (operation === "read") await expect(box.files.read("missing")).rejects.toMatchObject({ code: "file_not_found" });
    if (operation === "write") { await box.files.write("nested/file", Uint8Array.from([0, 255, 1])); expect(await box.files.read("nested/file", { as: "bytes" })).toEqual(Uint8Array.from([0, 255, 1])); }
    if (operation === "mkdir") await adapter.files.mkdir(box.id, "/workspace/nested");
    if (operation === "remove") await box.files.remove("/workspace", { recursive: true });
    if (operation === "exec") expect(await box.run("pwd")).toMatchObject({ ok: true, stdout: "/workspace\n" });
    expect(mock.commands.length - before).toBe(1);
  } finally { await box.destroy(); }
});

test("first uploads do not depend on application Node startup configuration", async () => {
  const box = await createSandbox(provider(), { env: { NODE_OPTIONS: "--require=/workspace/preload.js" } });
  try {
    await box.files.write("preload.js", "module.exports = {};");
    expect(await box.files.read("preload.js")).toBe("module.exports = {};");
  } finally { await box.destroy(); }
});

test.each([false, true])("missing Vercel cwd remains a request failure (warm=%s)", async warm => {
  const box = await createSandbox(provider());
  try {
    if (warm) await box.run("true");
    await expect(box.run("true", { cwd: "missing-directory" })).rejects.toMatchObject({ code: "invalid_argument", provider: "vercel" });
    expect((await box.run("exit 125")).exitCode).toBe(125);
  } finally { await box.destroy(); }
});

test("first directory listing preserves symlinks, newline names and file timestamps", async () => {
  const box = await createSandbox(provider());
  const { promises: fs } = await import("node:fs");
  try {
    await box.native.fs.writeFile("/tmp/line\nname", "contents");
    await fs.symlink("line\nname", box.native.map("/tmp/link"));
    const stat = await box.native.fs.lstat("/tmp/line\nname");
    const entries = await box.files.list("/tmp");
    expect(entries.find(entry => entry.path === "/tmp/line\nname")).toMatchObject({ type: "file", size: 8 });
    expect(entries.find(entry => entry.path === "/tmp/line\nname")?.modifiedAt).toBeCloseTo(stat.mtimeMs, -1);
    expect(entries.find(entry => entry.path === "/tmp/link")?.type).toBe("symlink");
  } finally { await box.destroy(); }
});

test("Vercel first-use marker survives reconnect and workspace removal", async () => {
  const box = await createSandbox(provider());
  try {
    expect((await box.run("rm -rf /workspace", { cwd: "/" })).ok).toBe(true);
    const attached = provider(); await attached.connect(box.id);
    await expect(attached.files.stat(box.id, "/workspace")).rejects.toMatchObject({ code: "file_not_found" });
  } finally { await box.destroy(); }
});

test.each(["file", "directory-link"])("first Vercel list preserves native %s behavior", async kind => {
  const box = await createSandbox(provider());
  const { promises: fs } = await import("node:fs");
  try {
    if (kind === "file") {
      await box.native.fs.writeFile("/tmp/file", "bytes");
      await expect(box.files.list("/tmp/file")).rejects.toMatchObject({ code: "invalid_argument" });
    } else {
      await box.native.fs.mkdir("/tmp/target", { recursive: true });
      await box.native.fs.writeFile("/tmp/target/file", "bytes");
      await fs.symlink("target", box.native.map("/tmp/link"));
      expect((await box.files.list("/tmp/link")).map(file => file.path)).toEqual(["/tmp/link/file"]);
    }
  } finally { await box.destroy(); }
});

test("restoring a snapshot taken before first use persists the prepared marker", async () => {
  const box = await createSandbox(provider());
  try {
    const snapshot = await box.snapshot();
    const restored = await createSandbox(provider(), { from: snapshot.id });
    try {
      await restored.run("rm -rf /workspace", { cwd: "/" });
      const attached = provider(); await attached.connect(restored.id);
      await expect(attached.files.stat(restored.id, "/workspace")).rejects.toMatchObject({ code: "file_not_found" });
    } finally { await restored.destroy(); }
  } finally { await box.destroy(); }
});

test("first Vercel timeout kills workspace setup while the setup lock is held", async () => {
  const box = await createSandbox(provider());
  const { spawn } = await import("node:child_process");
  const { promises: fs } = await import("node:fs");
  const lock = spawn("flock", ["-x", box.native.map("/tmp/.sandbox-sdk-workspace-ready.lock"), "sh", "-c", "echo locked; cat >/dev/null"], { detached: true });
  let held = true; lock.once("exit", () => { held = false; });
  await new Promise<void>((resolve, reject) => { lock.stdout.once("data", () => resolve()); lock.once("error", reject); });
  try {
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve(box.run("touch /tmp/should-not-run", { timeoutMs: 30 })),
        new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("Run did not settle while the workspace lock remained held")), 4000); }),
      ]);
      expect(result).toMatchObject({ timedOut: true, exitCode: null });
      expect(held).toBe(true);
    } finally { clearTimeout(watchdog); }
    await expect(fs.stat(box.native.map("/workspace"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(box.native.map("/tmp/should-not-run"))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { if (lock.pid) { try { process.kill(-lock.pid, "SIGKILL"); } catch {} } await box.destroy(); }
});

describe("Vercel native options", { timeout: 30_000 }, () => {
  const day = 86_400_000;
  const configured = (options: VercelOptions) => createVercelProvider(async () => mock.client, { token: "mock-token", teamId: "team", projectId: "project", ...options });

  test("fresh sandboxes receive persistence, lifetime, image, source, placement and snapshot policy", async () => {
    const options = { persistent: false, image: "vercel/sandbox/node:24", source: { type: "git", url: "https://github.com/acme/app.git", depth: 1, revision: "main", username: "x-access-token", password: "pat" }, region: "fra1", failoverRegions: ["cdg1"], networkId: "net_1", mounts: { "/data": { drive: "drive_1", mode: "read-write" } }, snapshotExpiresInMs: 0, keepLastSnapshots: { count: 3, expiresInMs: 7 * day, deleteEvicted: false } } satisfies VercelOptions;
    const box = await createSandbox(configured(options), { timeoutMs: 90_000.5 });
    try {
      expect(mock.creates.at(-1)).toMatchObject({ persistent: false, timeout: 90_001, image: "vercel/sandbox/node:24", source: options.source, region: "fra1", failoverRegions: ["cdg1"], networkId: "net_1", mounts: options.mounts, snapshotExpiration: 0, keepLastSnapshots: { count: 3, expiration: 7 * day, deleteEvicted: false } });
      expect(mock.creates.at(-1)).not.toHaveProperty("runtime");
    } finally { await box.destroy(); }
  });

  test("defaults stay persistent with Vercel's own timeout, image and region", async () => {
    const box = await createSandbox(provider());
    try {
      const params = mock.creates.at(-1);
      expect(params).toMatchObject({ persistent: true, networkPolicy: "allow-all" });
      for (const field of ["timeout", "image", "runtime", "source", "region", "snapshotExpiration", "keepLastSnapshots"] as const) expect(params?.[field]).toBeUndefined();
    } finally { await box.destroy(); }
  });

  test("legacy runtimes pass through; snapshots drop the base image and source", async () => {
    const adapter = configured({ runtime: "node22", source: { type: "tarball", url: "https://example.com/app.tgz" }, region: "sfo1" });
    const box = await createSandbox(adapter);
    try {
      expect(mock.creates.at(-1)).toMatchObject({ runtime: "node22", source: { type: "tarball", url: "https://example.com/app.tgz" } });
      const { id } = await box.snapshot();
      const copy = await createSandbox(adapter, { from: id, timeoutMs: 60_000 });
      try {
        const params = mock.creates.at(-1);
        expect(params).toMatchObject({ source: { type: "snapshot", snapshotId: id }, region: "sfo1", timeout: 60_000 });
        expect(params).not.toHaveProperty("runtime");
      } finally { await copy.destroy(); }
    } finally { await box.destroy(); }
  });

  test("exact sizes map to vCPUs at 2048 MiB each", async () => {
    const box = await createSandbox(provider(), { size: { cpu: 8, memoryMb: 16_384 } });
    try { expect(mock.creates.at(-1)).toMatchObject({ resources: { vcpus: 8 } }); } finally { await box.destroy(); }
    await expect(createSandbox(provider(), { size: { cpu: 1.5, memoryMb: 3072 } })).rejects.toMatchObject({ code: "unsupported" });
  });

  test("native network policies pass through and conflict with network", async () => {
    const networkPolicy = { allow: { "api.openai.com": [{ transform: [{ headers: { authorization: "Bearer injected" } }] }] }, subnets: { deny: ["10.0.0.0/8"] } } satisfies VercelOptions["networkPolicy"];
    const box = await createSandbox(configured({ networkPolicy }));
    try { expect(mock.creates.at(-1)?.networkPolicy).toEqual(networkPolicy); } finally { await box.destroy(); }
    await expect(createSandbox(configured({ networkPolicy }), { network: "none" })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(createSandbox(configured({ networkPolicy }), { network: "all" })).rejects.toMatchObject({ code: "invalid_argument" });
  });

  test("snapshot expiresInMs maps to native expiration in milliseconds", async () => {
    for (const [settings, expected] of [[undefined, undefined], [{}, undefined], [{ expiresInMs: 0 }, { expiration: 0 }], [{ expiresInMs: day }, { expiration: day }]] as const) {
      const box = await createSandbox(provider());
      try { await box.snapshot(settings); expect(mock.snapshotCalls.at(-1)).toEqual(expected); } finally { await box.destroy(); }
    }
    const box = await createSandbox(provider());
    try {
      const calls = mock.snapshotCalls.length;
      for (const expiresInMs of [60_000, -1, day + 0.5, Number.NaN]) await expect(box.snapshot({ expiresInMs })).rejects.toMatchObject({ code: "invalid_argument", provider: "vercel" });
      expect(mock.snapshotCalls.length).toBe(calls);
    } finally { await box.destroy(); }
  });

  test("snapshot policy options are validated when the provider is built", () => {
    expect(() => configured({ snapshotExpiresInMs: 3_600_000 })).toThrow(expect.objectContaining({ code: "invalid_argument" }));
    expect(() => configured({ keepLastSnapshots: { count: 11 } })).toThrow(expect.objectContaining({ code: "invalid_argument" }));
    expect(() => configured({ keepLastSnapshots: { count: 2, expiresInMs: 1000 } })).toThrow(expect.objectContaining({ code: "invalid_argument" }));
  });

  test.each([false, true])("write applies mode natively (warm=%s)", async warm => {
    const box = await createSandbox(provider());
    try {
      if (warm) await box.run("true");
      const uploads = mock.uploads.length;
      await box.files.write("secrets/token", "s3cret", { mode: 0o600 });
      await box.files.write("bin/tool", "#!/bin/sh\n", { mode: 0o4755 });
      expect((await box.run("stat -c %a secrets/token bin/tool")).stdout).toBe("600\n4755\n");
      expect(await box.files.read("secrets/token")).toBe("s3cret");
      expect(mock.uploads.slice(uploads).map(file => file.mode)).toEqual(warm ? [0o600, 0o755] : [0o755]);
      await box.files.write("secrets/token", "rotated", { mode: 0o640 });
      expect((await box.run("stat -c %a secrets/token; cat secrets/token")).stdout).toBe("640\nrotated");
    } finally { await box.destroy(); }
  });

  test("non-persistent sandboxes drop pause and report stopped once they end", async () => {
    const adapter = configured({ persistent: false });
    expect(adapter.capabilities.has("pause")).toBe(false);
    const box = await createSandbox(adapter);
    try {
      await box.files.write("kept", "no");
      await box.snapshot();
      expect((await adapter.connect(box.id)).state).toBe("stopped");
      await expect(box.files.read("kept")).rejects.toMatchObject({ code: "not_found", provider: "vercel", message: expect.stringContaining("not persistent") });
    } finally { await box.destroy(); }
    expect(mock.deletes.at(-1)).toBeUndefined();
  });

  test("a stopped persistent sandbox reports paused", async () => {
    const box = await createSandbox(provider());
    try { await box.pause(); expect((await provider().connect(box.id)).state).toBe("paused"); } finally { await box.destroy(); }
  });

  test("a keyed non-persistent sandbox that ended is replaced on the next lookup", async () => {
    const adapter = configured({ persistent: false }); const key = crypto.randomUUID();
    const first = await createSandbox(adapter, { key });
    await first.files.write("old", "1"); await first.snapshot();
    const second = await createSandbox(configured({ persistent: false }), { key });
    try {
      expect(second.created).toBe(true); expect(second.id).toBe(first.id);
      expect(await second.files.exists("old")).toBe(false);
    } finally { await second.destroy(); }
  });

  test("a stopped non-persistent sandbox can still be connected and destroyed by ID", async () => {
    const adapter = configured({ persistent: false });
    const box = await createSandbox(adapter); await box.snapshot();
    const fresh = configured({ persistent: false });
    expect(await fresh.connect(box.id)).toMatchObject({ id: box.id, state: "stopped" });
    await fresh.destroy(box.id);
    await expect(provider().connect(box.id)).rejects.toMatchObject({ code: "not_found" });
  });

  test("deleteOrphanSnapshots and fetch reach the native SDK", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 599 });
    const { vi } = await import("vitest");
    const get = vi.spyOn(mock.client, "get"); const list = vi.spyOn(mock.client, "list");
    const adapter = configured({ deleteOrphanSnapshots: true, fetch });
    try {
      const box = await createSandbox(adapter);
      expect(mock.creates.at(-1)?.fetch).toBe(fetch);
      await adapter.list({}); expect(list.mock.calls.at(-1)?.[0].fetch).toBe(fetch);
      await configured({ fetch }).connect(box.id); expect(get.mock.calls.at(-1)?.[0]).toMatchObject({ fetch });
      await box.destroy(); expect(mock.deletes.at(-1)).toEqual({ deleteOrphanSnapshots: true });
    } finally { get.mockRestore(); list.mockRestore(); }
  });
});

test("vercel() overloads drop pause only for non-persistent options", () => {
  const persistent: VercelProvider = vercel({ persistent: true, image: "vercel/sandbox/node:24" });
  const ephemeral: VercelNonPersistentProvider = vercel({ persistent: false, runtime: "node22" });
  const unknown = vercel({ persistent: Math.random() > 2 });
  // Type-only: these handles are never created.
  async function types() {
    const durable = await createSandbox(persistent); await durable.pause();
    // @ts-expect-error a non-persistent Vercel sandbox has no pause
    await (await createSandbox(ephemeral)).pause();
    // @ts-expect-error persistence unknown at compile time does not promise pause
    await (await createSandbox(unknown)).pause();
    // @ts-expect-error image and runtime are mutually exclusive
    vercel({ image: "vercel/sandbox/node:24", runtime: "node22" });
  }
  void types;
  expect([[...persistent.capabilities], [...ephemeral.capabilities], [...unknown.capabilities]].map(caps => caps.includes("pause"))).toEqual([true, false, false]);
});
