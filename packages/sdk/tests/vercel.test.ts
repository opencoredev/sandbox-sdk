import { afterAll, describe, expect, test } from "vitest";
import { createSandbox, connectSandbox } from "../src/index.js";
import { createVercelProvider } from "../src/providers/vercel/provider.js";
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
      expect(mock.creates.at(-1)).toMatchObject({ name: expect.stringMatching(/^sdk-[a-f0-9]{64}$/), resources: { vcpus: 2 }, persistent: true, ports: [3000], networkPolicy: { allow: ["registry.npmjs.org"] }, tags: { "sandbox-sdk": "pending", "sandbox-sdk-key": "user:123", app: "builder" } });
      expect((await box.preview(3000)).url).toBe(box.native.domain(3000));
      await expect(box.preview(8080)).rejects.toMatchObject({ code: "invalid_argument" });
      const other = await createSandbox(provider(), { key: "user:123" }); expect(other.id).toBe(box.id); expect(other.created).toBe(false);
    } finally { await box.destroy(); }
  });
  test("fails closed on hard lifetime, idle timeout, custom disk and tag overflow", async () => {
    await expect(createSandbox(provider(), { timeoutMs: 60000 })).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider(), { idleTimeoutMs: 1000 })).rejects.toMatchObject({ code: "unsupported" });
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
  test("racing keyed callers wait for workspace initialization", async () => {
    let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    let arrived = () => {}; const initializing = new Promise<void>(resolve => { arrived = resolve; });
    const slow = { ...mock.client, create: async (params: Parameters<typeof mock.client.create>[0]) => {
      const box = await mock.client.create(params); const run = box.runCommand.bind(box);
      box.runCommand = async input => { if (input.sudo) { arrived(); await gate; } return run(input); }; return box;
    } };
    const key = crypto.randomUUID(); const first = createSandbox(createVercelProvider(async () => slow), { key });
    await initializing; let attached = false;
    const second = createSandbox(provider(), { key }).then(box => { attached = true; return box; });
    try {
      await new Promise(resolve => setTimeout(resolve, 50)); expect(attached).toBe(false);
    } finally { release(); }
    const [a, b] = await Promise.all([first, second]);
    try { expect(b.created).toBe(false); expect(await b.files.exists("/workspace")).toBe(true); } finally { await a.destroy(); }
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
      const mapped = vercelError(Object.assign(new Error("Bearer secret"), { response: new Response(null, { status }) })); expect(mapped.code).toBe(code); expect(mapped.message).not.toContain("secret"); expect(mapped.cause).toBeUndefined();
    }
    expect(vercelError({ code: "ENOENT" }, "box").code).toBe("file_not_found");
  });
});
