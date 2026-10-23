import { afterAll, expect, test, vi } from "vitest";
const mock = await vi.hoisted(async () => import("./railway-mock.js"));
vi.mock("railway", async importOriginal => ({ ...await importOriginal<typeof import("railway")>(), Sandbox: mock.MockSandbox }));
import type { CreateOptions } from "../src/types.js";
import { railway } from "../src/providers/railway/index.js";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { railwayError } from "../src/providers/railway/errors.js";
import { runConformance } from "../src/testing.js";
const options = { token: "mock", environmentId: "mock-env" };
vi.stubGlobal("fetch", mock.mockFetch(globalThis.fetch));
afterAll(async () => { await mock.cleanup(); vi.unstubAllGlobals(); });
runConformance(() => railway(options), { live: true, ports: [3000] });

test("fresh clients discover versioned keys and labels across pages, excluding foreign VMs", async () => {
  const boxes = [];
  const foreign = await mock.MockSandbox.create();
  try {
    for (let n = 0; n < 4; n++) boxes.push(await createSandbox(railway(options), { key: `railway-key-${n}`, labels: { app: "test" } }));
    mock.state.cursors.length = 0;
    expect(await listSandboxes(railway(options), { labels: { app: "test" } })).toHaveLength(4);
    expect(mock.state.cursors.length).toBeGreaterThan(1);
    expect((await createSandbox(railway(options), { key: "railway-key-3" })).id).toBe(boxes[3]?.id);
    expect(boxes[0]?.native).toBeInstanceOf(mock.MockSandbox);
  } finally { await Promise.all(boxes.map(box => box.destroy())); await foreign.destroy(); }
});
test("snapshots restore file state and overwrite source keys", async () => {
  const box = await createSandbox(railway(options), { key: "source" });
  try {
    await box.files.write("state", "saved"); const snapshot = await box.snapshot();
    await box.files.write("state", "changed");
    const restored = await createSandbox(railway(options), { from: snapshot.id, key: "restored" });
    try { expect(await restored.files.read("state")).toBe("saved"); expect((await connectSandbox(railway(options), restored.id)).key).toBe("restored"); }
    finally { await restored.destroy(); }
  } finally { await box.destroy(); }
});
test("creation maps idle minutes, env and domains without claiming network isolation", async () => {
  const box = await createSandbox(railway({ ...options, region: "us-east4-eqdc4a" }), { ports: [3000], idleTimeoutMs: 60_001, env: { HELLO: "world" } });
  try {
    expect(mock.state.creates.at(-1)).toMatchObject({ idleTimeoutMinutes: 2, networkIsolation: "PRIVATE", domains: [{ port: 3000 }], region: "us-east4-eqdc4a", env: { HELLO: "world" } });
    expect((await box.run("printf '%s' \"$HELLO\"")).stdout).toBe("world");
    expect(mock.state.execs.some(options => options.captureOutput === false && options.ephemeral === true)).toBe(true);
    await expect(box.preview(9999)).rejects.toMatchObject({ code: "unsupported" });
  } finally { await box.destroy(); }
  for (const opts of [{ timeoutMs: 1000 }, { size: "small" }, { network: "none" }, { network: { allow: ["example.com"] } }] satisfies CreateOptions[]) await expect(createSandbox(railway(options), opts)).rejects.toMatchObject({ code: "unsupported" });
  await expect(createSandbox(railway({ ...options, networkIsolation: "ISOLATED" }), { ports: [3000] })).rejects.toMatchObject({ code: "unsupported" });
});
test("timeouts and aborts kill descendant groups", async () => {
  const box = await createSandbox(railway(options));
  try {
    expect(await box.run("(sleep .2; echo bad > child) & wait", { timeoutMs: 20 })).toMatchObject({ timedOut: true });
    const controller = new AbortController(); const pending = Promise.resolve(box.run("(sleep .2; echo bad > aborted) & wait", { signal: controller.signal })); setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ timedOut: true });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(await box.files.exists("child")).toBe(false); expect(await box.files.exists("aborted")).toBe(false);
  } finally { await box.destroy(); }
});
test("interrupted exec destroys the VM and returns a safe outcome_unknown error", async () => {
  const provider = railway(options); const info = await provider.create({ labels: {} });
  mock.state.interrupt = true;
  await expect(provider.exec(info.id, { command: "true", cwd: "/workspace", env: {}, timeoutMs: 1000, onChunk() {} })).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(mock.state.boxes.has(info.id)).toBe(false);
});
test("native missing sandbox, file and auth errors are structured and secret safe", async () => {
  await expect(createSandbox(railway({ ...options, token: "invalid" }))).rejects.toMatchObject({ code: "auth", provider: "railway" });
  await expect(connectSandbox(railway(options), "missing")).rejects.toMatchObject({ code: "not_found" });
  const box = await createSandbox(railway(options));
  try { await expect(box.files.read("missing")).rejects.toMatchObject({ code: "file_not_found" }); await expect(box.files.read("missing")).rejects.not.toThrow("secret-key-do-not-leak"); }
  finally { await box.destroy(); }
});
test("late creation after abort is destroyed", async () => {
  mock.state.delayMs = 60; const controller = new AbortController();
  const pending = createSandbox(railway(options), { labels: { late: "yes" }, signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await expect(pending).rejects.toMatchObject({ code: "aborted" });
  await new Promise(resolve => setTimeout(resolve, 120)); mock.state.delayMs = 0;
  expect(await listSandboxes(railway(options), { labels: { late: "yes" } })).toEqual([]);
});
test("stat preserves symlinks and range reads preserve binary bytes", async () => {
  const box = await createSandbox(railway(options));
  try {
    await box.files.write("file", new Uint8Array([0, 255, 1])); await box.run("ln -s file link");
    expect(await box.files.stat("link")).toMatchObject({ type: "symlink" });
    expect((await box.files.list(".")).find(file => file.path.endsWith("/link"))?.type).toBe("symlink");
    expect(await railway(options).files.readRange?.(box.id, "/workspace/file", { offset: 1, length: 1 })).toEqual(new Uint8Array([255]));
  } finally { await box.destroy(); }
});

test("early successful exit while stdin is flow-controlled preserves the VM and files", async () => {
  const box = await createSandbox(railway(options));
  try {
    await box.files.write("keep", "saved");
    expect(await box.run("head -c 1", { stdin: "x".repeat(4 * 1024 * 1024) })).toMatchObject({ exitCode: 0, stdout: "x", timedOut: false });
    expect(await box.files.read("keep")).toBe("saved");
    expect((await box.run("echo still-running")).stdout).toBe("still-running\n");
  } finally { await box.destroy(); }
});

test("HTTP storage exhaustion maps to quota rather than a server outage", () => {
  expect(railwayError({ status: 507 }).code).toBe("quota");
  expect(railwayError({ status: 503 }).code).toBe("unavailable");
});
test("checkpoint restore invalidates inherited live process IDs and active runs", async () => {
  const box = await createSandbox(railway(options));
  try {
    await box.files.write({
      "/tmp/.sandbox-sdk/procs/old/spec.json": JSON.stringify({ command: "sleep 99", startedAt: Date.now() }),
      "/tmp/.sandbox-sdk/procs/old/pid": "999999",
      "/tmp/.sandbox-sdk/runs/stale": "old",
    });
    const snapshot = await box.snapshot();
    const restored = await createSandbox(railway(options), { from: snapshot.id });
    try {
      expect((await restored.processes())[0]).toMatchObject({ name: "old", status: "failed", exitCode: 137 });
      expect(await restored.files.exists("/tmp/.sandbox-sdk/runs")).toBe(false);
    } finally { await restored.destroy(); }
  } finally { await box.destroy(); }
});

test("run preserves Railway's native Bash command dialect", async () => {
  const box = await createSandbox(railway(options));
  try {
    expect(await box.run('items=(one two); [[ ${items[1]} == two ]] && printf bash')).toMatchObject({ ok: true, stdout: "bash" });
  } finally { await box.destroy(); }
});


test("Railway listing skips malformed guest metadata and preserves auth failures", async () => {
  const box = await createSandbox(railway(options));
  const native = mock.state.boxes.get(box.id);
  if (!native) throw new Error("Missing mock sandbox");
  const read = vi.spyOn(native.files, "read");
  try {
    for (const body of ["{", JSON.stringify({ version: 1, labels: { bad: 2 } })]) {
      read.mockResolvedValue(body);
      expect(await listSandboxes(railway(options))).toEqual([]);
    }
    read.mockRejectedValue(Object.assign(new Error("gone"), { status: 404 }));
    expect(await listSandboxes(railway(options))).toEqual([]);
    read.mockRejectedValue(Object.assign(new Error("denied"), { status: 401 }));
    await expect(listSandboxes(railway(options))).rejects.toMatchObject({ code: "auth" });
  } finally { read.mockRestore(); await box.destroy(); }
});

test("writes reuse the attached native client and let native uploads create parents", async () => {
  const box = await createSandbox(railway(options));
  const native = mock.state.boxes.get(box.id);
  if (!native) throw new Error("Missing mock sandbox");
  const mkdir = vi.spyOn(native.files, "mkdir");
  const connect = vi.spyOn(mock.MockSandbox, "connect");
  try {
    await box.files.write("nested/deep/file", "first");
    expect(await box.files.read("nested/deep/file")).toBe("first");
    await box.run("rm -rf nested");
    await box.files.write("nested/deep/file", "second");
    expect(await box.files.read("nested/deep/file")).toBe("second");
    expect(mkdir).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
  } finally { mkdir.mockRestore(); connect.mockRestore(); await box.destroy(); }
});
