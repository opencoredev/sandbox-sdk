import { describe, test, expect } from "vitest";
import { local } from "../src/providers/local/index.js";
import { Demux } from "../src/providers/local/docker.js";

describe("local transport", () => {
  test("rejects remote Docker hosts that cannot supply localhost previews", () => {
    expect(() => local({ dockerHost: "tcp://example.com:2375" })).toThrowError(expect.objectContaining({ code: "unsupported" }));
  });
  test("declares only implemented capabilities", () => {
    const provider = local();
    expect(provider.keyMode).toBe("exact");
    expect([...provider.capabilities].sort()).toEqual(["network-policy", "pause", "size", "snapshot"]);
    expect(provider.terminal).toBeUndefined();
  });
  test("demultiplexes split headers and split UTF-8 without corrupting bytes", () => {
    const output: string[] = []; const demux = new Demux(chunk => output.push(`${chunk.stream}:${chunk.text}`));
    const frame = (stream: number, bytes: Buffer) => { const header = Buffer.alloc(8); header[0] = stream; header.writeUInt32BE(bytes.length, 4); return Buffer.concat([header, bytes]); };
    const bytes = Buffer.from("€");
    const wire = Buffer.concat([frame(1, bytes.subarray(0, 1)), frame(2, Buffer.from("error")), frame(1, bytes.subarray(1))]);
    for (const byte of wire) demux.push(Buffer.from([byte]));
    demux.end(); expect(output).toEqual(["stderr:error", "stdout:€"]);
  });
  test("rejects truncated output rather than silently losing bytes", () => {
    const demux = new Demux(() => {}); demux.push(Buffer.from([1])); expect(() => demux.end()).toThrow();
  });
  test("fails closed before creating resources", async () => {
    const provider = local({ dockerHost: "unix:///nonexistent-sbx25.sock" });
    for (const options of [{ labels: {}, network: { allow: ["example.com"] } }, { labels: {}, size: { cpu: 1, memoryMb: 1024, diskGb: 1 } }] satisfies import("../src/provider.js").CreateInput[]) {
      await expect(provider.create({ ...options, labels: {} })).rejects.toMatchObject({ code: "unsupported" });
    }
  });
});

test.each(["timeoutMs", "idleTimeoutMs"])("local accepts %s before contacting Docker", async option => {
  const provider = local({ dockerHost: "unix:///nonexistent-review-fixes.sock" });
  await expect(provider.create({ labels: {}, [option]: 1000 })).rejects.toMatchObject({ code: "unavailable" });
});

test.each(["lifetime", "idle"])("fresh local clients destroy %s-expired containers", async mode => {
  const { vi } = await import("vitest");
  const { Docker } = await import("../src/providers/local/docker.js");
  const calls: string[] = [];
  const call = vi.spyOn(Docker.prototype, "call").mockImplementation(async (method, path) => {
    calls.push(`${method} ${path}`);
    return { Id: "expired", Created: new Date(Date.now() - 10_000).toISOString(), Config: { Labels: { "sandbox-sdk": "1", ...(mode === "lifetime" ? { "sandbox-sdk.local.deadline": String(Date.now() - 1000) } : { "sandbox-sdk.local.idle-ms": "100" }) } }, State: { Running: true } };
  });
  const exec = vi.spyOn(Docker.prototype, "exec").mockImplementation(async (_, __, options) => { options.onChunk({ stream: "stdout", text: String(Date.now() - 1000) }); return 0; });
  try {
    await expect(local().connect("expired")).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toContain("DELETE /containers/expired?force=1&v=1");
  } finally { call.mockRestore(); exec.mockRestore(); }
});

test("local usage exposes creation phase and first-command timings", async () => {
  const { vi } = await import("vitest");
  const { Docker } = await import("../src/providers/local/docker.js");
  const call = vi.spyOn(Docker.prototype, "call").mockImplementation(async (_, path) => {
    if (path.startsWith("/containers/create")) return { Id: "timed" };
    return { Id: "timed", Created: new Date().toISOString(), Config: { Labels: { "sandbox-sdk": "1" } }, State: { Running: true, StartedAt: new Date().toISOString() } };
  });
  const exec = vi.spyOn(Docker.prototype, "exec").mockResolvedValue(0);
  try {
    const provider = local(); const created = await provider.create({ labels: {} });
    await provider.exec(created.id, { command: "true", cwd: "/workspace", env: {}, timeoutMs: 1000, onChunk() {} });
    const usage = await provider.usage?.(created.id);
    for (const key of ["createInspectMs", "createContainerMs", "createStartMs", "createPrerequisiteMs", "firstCommandMs"]) {
      expect(usage?.[key]).toEqual(expect.any(Number)); expect(usage?.[key]).toBeGreaterThanOrEqual(0);
    }
  } finally { call.mockRestore(); exec.mockRestore(); }
});

test("file writes use one native exec with parent creation", async () => {
  const { vi } = await import("vitest");
  const { Docker } = await import("../src/providers/local/docker.js");
  const { createSandbox } = await import("../src/index.js");
  const call = vi.spyOn(Docker.prototype, "call").mockImplementation(async (_, path) => {
    if (path.startsWith("/containers/create")) return { Id: "write-once" };
    return { Id: "write-once", Created: new Date().toISOString(), Config: { Labels: { "sandbox-sdk": "1" } }, State: { Running: true } };
  });
  const exec = vi.spyOn(Docker.prototype, "exec").mockResolvedValue(0);
  const box = await createSandbox(local());
  try {
    exec.mockClear();
    await box.files.write("nested/deep/file", "bytes");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1].join(" ")).toContain("mkdirSync");
  } finally { await box.destroy(); call.mockRestore(); exec.mockRestore(); }
});

test("Docker reuses one keepalive connection across control requests", async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Docker } = await import("../src/providers/local/docker.js");
  const directory = await mkdtemp(join(tmpdir(), "sbx57-docker-"));
  const path = join(directory, "docker.sock");
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end('{"ok":true}'); });
  server.on("connection", socket => sockets.add(socket));
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const client = new Docker(`unix://${path}`);
    expect(await client.call("GET", "/info")).toEqual({ ok: true });
    expect(await client.call("GET", "/info")).toEqual({ ok: true });
    expect(sockets.size).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});


test("plain local create returns after Docker start without guest setup or metadata GET", async () => {
  const { vi } = await import("vitest");
  const { Docker } = await import("../src/providers/local/docker.js");
  const call = vi.spyOn(Docker.prototype, "call").mockImplementation(async (_, path) => path.startsWith("/containers/create") ? { Id: "fast-create" } : undefined);
  const exec = vi.spyOn(Docker.prototype, "exec").mockResolvedValue(0);
  try {
    const before = Date.now();
    const created = await local().create({ labels: { verification: "sbx57" }, key: "fast-key" });
    expect(created).toMatchObject({ id: "fast-create", state: "running", key: "fast-key", labels: { verification: "sbx57", "sandbox-sdk": "1" } });
    expect(created.createdAt).toBeGreaterThanOrEqual(before);
    expect(created.createdAt).toBeLessThanOrEqual(Date.now());
    expect(call.mock.calls.map(([method, path]) => `${method} ${path}`)).toEqual(["GET /images/node%3A22-bookworm/json", expect.stringMatching(/^POST \/containers\/create/), "POST /containers/fast-create/start"]);
    expect(exec).not.toHaveBeenCalled();
  } finally { call.mockRestore(); exec.mockRestore(); }
});
