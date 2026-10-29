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

describe("local native options (SBX-71)", () => {
  async function fake(inspect: Record<string, unknown> = {}) {
    const { vi } = await import("vitest");
    const { Docker } = await import("../src/providers/local/docker.js");
    const calls: [string, string, unknown][] = [];
    const call = vi.spyOn(Docker.prototype, "call").mockImplementation(async (method, path, body) => {
      calls.push([method, path, body]);
      if (path.startsWith("/containers/create")) return { Id: "opts" };
      if (path.startsWith("/images/") && path.endsWith("/json")) return { Os: "linux", Architecture: "amd64", ...inspect };
      if (path.startsWith("/commit")) return { Id: "sha256:snap" };
      return { Id: "opts", Created: new Date().toISOString(), Config: { Labels: { "sandbox-sdk": "1" } }, State: { Running: true } };
    });
    const exec = vi.spyOn(Docker.prototype, "exec").mockResolvedValue(0);
    return { calls, exec, restore() { call.mockRestore(); exec.mockRestore(); } };
  }
  test("create passes every Docker option with Docker's field names and units", async () => {
    const docker = await fake();
    try {
      await local({
        platform: "linux/arm64", user: "1000:1000", runtime: "runsc", networkMode: "sbx-net", pidsLimit: 256, shmSizeMb: 128,
        capAdd: ["SYS_ADMIN"], capDrop: ["NET_RAW"], securityOpt: ["no-new-privileges"],
        mounts: [{ type: "volume", source: "cache", target: "/cache" }, { type: "tmpfs", target: "/scratch", readOnly: false }, { type: "bind", source: "/srv/data", target: "/data", readOnly: true }],
      }).create({ labels: {}, size: { cpu: 1.5, memoryMb: 2048 } });
      // The cached amd64 image does not match, so it is pulled for arm64.
      expect(docker.calls.map(([m, p]) => `${m} ${p}`)).toContain("POST /images/create?fromImage=node%3A22-bookworm&platform=linux%2Farm64");
      const [, path, body] = docker.calls.find(([, p]) => p.startsWith("/containers/create")) ?? [];
      expect(path).toMatch(/&platform=linux%2Farm64$/);
      expect(body).toMatchObject({
        User: "1000:1000",
        HostConfig: {
          Runtime: "runsc", NetworkMode: "sbx-net", PidsLimit: 256, ShmSize: 128 * 1024 * 1024,
          CapAdd: ["SYS_ADMIN"], CapDrop: ["NET_RAW"], SecurityOpt: ["no-new-privileges"],
          NanoCpus: 1.5e9, Memory: 2048 * 1024 * 1024, MemorySwap: 2048 * 1024 * 1024,
          Mounts: [{ Type: "volume", Source: "cache", Target: "/cache", ReadOnly: false }, { Type: "tmpfs", Target: "/scratch", ReadOnly: false }, { Type: "bind", Source: "/srv/data", Target: "/data", ReadOnly: true }],
        },
      });
      expect(docker.exec.mock.calls[0]?.[1]).toEqual(["chown", "--", "1000:1000", "/workspace"]);
      expect(docker.exec.mock.calls[0]?.[2]).toMatchObject({ user: "0" });
    } finally { docker.restore(); }
  });
  test("a cached image for the requested platform is not pulled again, and network none still wins", async () => {
    const docker = await fake({ Architecture: "arm64" });
    try {
      await local({ platform: "linux/arm64/v8", networkMode: "sbx-net" }).create({ labels: {}, network: "none" });
      expect(docker.calls.some(([, p]) => p.startsWith("/images/create"))).toBe(false);
      expect(docker.calls.find(([, p]) => p.startsWith("/containers/create"))?.[2]).toMatchObject({ HostConfig: { NetworkMode: "none", PortBindings: {} } });
    } finally { docker.restore(); }
  });
  test("rejects options Docker cannot honor before any request", () => {
    for (const options of [{ networkMode: "host" }, { networkMode: "container:abc" }, { pidsLimit: 0 }, { shmSizeMb: 1.5 }, { mounts: [{ type: "bind" as const, target: "/x" }] }, { mounts: [{ type: "volume" as const, target: "relative" }] }])
      expect(() => local({ dockerHost: "unix:///nonexistent.sock", ...options })).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^(unsupported|invalid_argument)$/) }));
  });
  test("files.write applies mode in the same exec and declares writeSupportsMode", async () => {
    const docker = await fake();
    try {
      const provider = local();
      expect(provider.files.writeSupportsMode).toBe(true);
      await provider.files.write("opts", "/workspace/secret", new TextEncoder().encode("x"), { mode: 0o600 });
      await provider.files.write("opts", "/workspace/plain", new TextEncoder().encode("x"));
      const [secret, plain] = docker.exec.mock.calls.map(([, command]) => command);
      expect(secret?.slice(0, 2)).toEqual(["node", "-e"]);
      expect(secret?.[2]).toContain("chmodSync");
      expect(secret?.slice(3)).toEqual(["/workspace/secret", "600"]);
      expect(plain?.slice(3)).toEqual(["/workspace/plain", ""]);
      expect(docker.exec).toHaveBeenCalledTimes(2);
    } finally { docker.restore(); }
  });
  test("snapshot rejects expiresInMs because Docker images never expire", async () => {
    const docker = await fake();
    try {
      const snapshot = local().snapshot;
      if (!snapshot) throw new Error("local() declares snapshot");
      await expect(snapshot("opts", { expiresInMs: 60_000 })).rejects.toMatchObject({ code: "unsupported" });
      expect(docker.calls.some(([, p]) => p.startsWith("/commit"))).toBe(false);
      expect(await snapshot("opts", { expiresInMs: 0 })).toEqual({ id: "sha256:snap" });
    } finally { docker.restore(); }
  });
});

test.each([undefined, 5_000])("a restore from a snapshot does not inherit the source's deadline or idle timer (idleTimeoutMs %s)", async idleTimeoutMs => {
  const { vi } = await import("vitest");
  const { Docker } = await import("../src/providers/local/docker.js");
  // Docker merges the image's labels into the container's, and the snapshot carries the source's activity file.
  const image = { "sandbox-sdk": "1", "sandbox-sdk.local.deadline": String(Date.now() - 1000), "sandbox-sdk.local.idle-ms": "100", "sandbox-sdk.local.snapshot": "1" };
  let labels: Record<string, string> = {}; const calls: string[] = [];
  const call = vi.spyOn(Docker.prototype, "call").mockImplementation(async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (path.startsWith("/images/")) return { Os: "linux", Architecture: "amd64", Config: { Labels: image } };
    if (path.startsWith("/containers/create")) { labels = { ...image, ...(body as { Labels: Record<string, string> }).Labels }; return { Id: "restored" }; }
    return { Id: "restored", Created: new Date().toISOString(), Config: { Labels: labels }, State: { Running: true } };
  });
  // Run the real idle-check script against a guest with no runs and an activity file from a minute ago.
  const fs = { existsSync: (path: string) => path === "/tmp/.sandbox-sdk-activity", statSync: () => ({ mtimeMs: Date.now() - 60_000 }), readdirSync: () => [] };
  const exec = vi.spyOn(Docker.prototype, "exec").mockImplementation(async (_, command, options) => {
    let text = "";
    new Function("require", "process", command[2] ?? "")(() => fs, { stdout: { write: (value: string) => { text += value; } } });
    options.onChunk({ stream: "stdout", text });
    return 0;
  });
  try {
    const provider = local();
    const restored = await provider.create({ labels: {}, from: "sha256:snap", idleTimeoutMs });
    expect(restored.labels).toEqual({ "sandbox-sdk": "1" });
    await expect(provider.connect("restored")).resolves.toMatchObject({ id: "restored" });
    await expect(local().connect("restored")).resolves.toMatchObject({ id: "restored" });
    expect(calls.some(path => path.startsWith("DELETE"))).toBe(false);
  } finally { call.mockRestore(); exec.mockRestore(); }
});
