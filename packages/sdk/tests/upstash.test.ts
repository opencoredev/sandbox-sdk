import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { upstash as publicUpstash, type UpstashOptions } from "../src/providers/upstash/index.js";
import { upstashError } from "../src/providers/upstash/errors.js";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { runConformance } from "../src/testing.js";
import { cleanup, MockBox, state, upstash } from "./upstash-mock.js";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const factory = () => upstash({ apiKey: "mock-key" });

// live:true authorizes this explicitly mocked cloud SDK; no Upstash calls run.
runConformance(factory, { live: true });

const ephemeral = () => upstash({ apiKey: "mock-key", ephemeral: true });

describe("Upstash Ephemeral Box conformance", () => {
  runConformance(ephemeral, { live: true });
});

beforeEach(() => {
  const fetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    if (String(input) === "https://us-east-1.box.upstash.com/v2/box/snapshots")
      return Promise.resolve(
        new Response(JSON.stringify({ snapshots: [...state.snapshotMetadata.values()] })),
      );

    const id = /^https:\/\/us-east-1\.box\.upstash\.com\/v2\/box\/([^/]+)$/.exec(
      String(input),
    )?.[1];

    if (id !== undefined && (init?.method ?? "GET") === "GET") {
      const box = state.boxes.get(decodeURIComponent(id));

      return Promise.resolve(
        box ? new Response(JSON.stringify(box.data)) : new Response("{}", { status: 404 }),
      );
    }

    return fetch(input, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanup();
});

describe("Upstash Box mappings", () => {
  test("keeps secrets out of command text and argv for runs and processes", async () => {
    const secret = "private-token-9ec5e94f";
    const value = "override 'quotes' $literal\n雪";

    const box = await createSandbox(factory(), {
      secrets: { TOKEN: secret },
      env: { CHECK_OVERRIDE: "base" },
    });

    try {
      const commands = vi.spyOn(box.native.exec, "command");
      const sessions = vi.spyOn(box.native.exec, "session");
      const command = `node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.env.TOKEN + process.env.CHECK_OVERRIDE).digest("hex"))'`;

      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(secret + value),
      );

      const expected = Buffer.from(digest).toString("hex");
      expect((await box.run(command, { env: { CHECK_OVERRIDE: value } })).stdout).toBe(expected);

      const process = await box.start(command, {
        name: "secret-check",
        env: { CHECK_OVERRIDE: value },
      });

      expect(await process.wait()).toMatchObject({ exitCode: 0 });
      expect((await process.logs()).text).toContain(expected);
      expect(state.envWrites.length).toBeGreaterThan(0);

      for (const file of state.envWrites) {
        expect(file).toMatchObject({ mode: 0o600, directoryMode: 0o700 });
        expect(await box.files.exists(file.path)).toBe(false);
      }

      expect(commands).toHaveBeenCalled();
      expect(sessions).toHaveBeenCalled();

      for (const [command] of commands.mock.calls) expect(command).not.toContain(secret);

      for (const [options] of sessions.mock.calls) {
        expect(options.cmd ?? "").not.toContain(secret);

        for (const arg of options.argv ?? []) expect(arg).not.toContain(secret);
      }
    } finally {
      await box.destroy();
    }
  });
  test("lazy credentials, native sizes, network and protected preview", async () => {
    const provider = factory();
    expect(state.creates).toEqual([]);

    const box = await createSandbox(provider, {
      size: "medium",
      network: { allow: ["registry.npmjs.org"] },
      env: { HELLO: "world" },
    });

    expect(state.creates[0]).toMatchObject({
      apiKey: "mock-key",
      size: "medium",
      networkPolicy: { mode: "custom", allowedDomains: ["registry.npmjs.org"] },
    });
    expect((await box.run('printf "$HELLO"')).stdout).toBe("world");
    expect((await box.preview(3000)).headers).toEqual({ Authorization: "Bearer mock-preview" });
    vi.stubEnv("UPSTASH_BOX_API_KEY", "");
    await expect(createSandbox(upstash())).rejects.toMatchObject({ code: "auth" });
    vi.stubEnv("UPSTASH_BOX_API_KEY", "env-key");
    await createSandbox(upstash());
    expect(state.creates.at(-1)?.apiKey).toBe("env-key");
  });
  test("preserves arbitrary labels and keys across fresh clients and excludes foreign boxes", async () => {
    await MockBox.create();

    const box = await createSandbox(factory(), {
      key: "user:" + "long".repeat(30),
      labels: { app: "long value with spaces", "sandbox-sdk": "forged" },
    });

    expect((await createSandbox(factory(), { key: box.key })).id).toBe(box.id);
    expect(
      await listSandboxes(factory(), { labels: { app: "long value with spaces" } }),
    ).toHaveLength(1);
    expect(await listSandboxes(factory())).toHaveLength(1);
    expect((await connectSandbox(factory(), box.id)).labels).toMatchObject({
      app: "long value with spaces",
      "sandbox-sdk": "1",
    });
    expect((await factory().connect(box.id)).createdAt).toBeGreaterThan(Date.now() - 60_000);
  });
  test("unsupported settings fail before creation", async () => {
    for (const input of [
      { idleTimeoutMs: 1000 },
      { timeoutMs: 1000 },
      { size: { cpu: 1, memoryMb: 1024, diskGb: 10 } },
      { network: { allow: ["https://example.com"] } },
    ])
      await expect(createSandbox(factory(), input)).rejects.toMatchObject({ code: "unsupported" });
    expect(state.boxes.size).toBe(0);
  });
  test("pause, resume, binary files, symlinks and snapshot restore", async () => {
    const box = await createSandbox(factory(), { network: "none" });
    expect(state.creates[0]?.networkPolicy).toEqual({ mode: "deny-all" });
    await box.files.write("saved", new Uint8Array([0, 255, 1]));
    await box.run("ln -s saved link");
    expect((await box.files.stat("link")).type).toBe("symlink");
    await box.pause();
    expect((await factory().connect(box.id)).state).toBe("paused");
    await box.resume();
    const snapshot = await box.snapshot();
    const copy = await createSandbox(factory(), { from: snapshot.id, labels: { clone: "yes" } });
    expect(await copy.files.read("saved", { as: "bytes" })).toEqual(new Uint8Array([0, 255, 1]));
    expect(copy.labels.clone).toBe("yes");
  });
  test("timeout and abort kill descendants including delayed launch", async () => {
    const box = await createSandbox(factory());
    state.delayMs = 50;
    expect(await box.run("(sleep .2; echo leak > late) & wait", { timeoutMs: 10 })).toMatchObject({
      timedOut: true,
      exitCode: null,
    });
    state.delayMs = 0;
    const controller = new AbortController();

    const pending = Promise.resolve(
      box.run("(sleep .2; echo leak > aborted) & wait", { signal: controller.signal }),
    );

    setTimeout(() => controller.abort(), 20);
    expect(await pending).toMatchObject({ timedOut: true, exitCode: null });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await box.files.exists("late")).toBe(false);
    expect(await box.files.exists("aborted")).toBe(false);
    expect(await box.run("echo bad > preabort", { signal: controller.signal })).toMatchObject({
      timedOut: true,
    });
    expect(await box.files.exists("preabort")).toBe(false);
  });
  test("durable launches survive close and fresh clients stop descendants", async () => {
    const box = await createSandbox(factory());
    const command = vi.spyOn(box.native.exec, "command");
    await box.start("sleep .15; echo alive > detached; sleep 5", { name: "durable" });
    expect(command).toHaveBeenCalledWith(expect.stringContaining("nohup setsid"));
    await box.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const fresh = await connectSandbox(factory(), box.id);
    expect(await fresh.files.read("detached")).toBe("alive\n");
    await fresh.process("durable").stop({ graceMs: 10 });
    expect((await fresh.process("durable").wait()).exitCode).not.toBeNull();
    await fresh.destroy();
  });
  test("resume invalidates old process records and repeated resume preserves live work", async () => {
    const box = await createSandbox(factory());
    await box.start("sleep 5", { name: "old" });
    await box.pause();
    await box.resume();
    expect((await box.processes())[0]).toMatchObject({ status: "failed", exitCode: 137 });
    await box.start("sleep 5", { name: "new" });
    await box.resume();
    expect((await box.processes()).find((value) => value.name === "new")?.status).toBe("running");
    await box.process("new").stop({ graceMs: 10 });
  });
  test("repeated and concurrent previews do not rotate native credentials", async () => {
    const box = await createSandbox(factory());
    const native = vi.spyOn(box.native, "getPublicURL");
    const links = await Promise.all([box.preview(3000), box.preview(3000), box.preview(3000)]);
    expect(native).toHaveBeenCalledTimes(1);
    expect(links[0]).toEqual(links[2]);
    await box.preview(3000);
    expect(native).toHaveBeenCalledTimes(1);
    native.mockRejectedValueOnce(Object.assign(new Error("busy"), { statusCode: 503 }));
    await expect(box.preview(8080)).rejects.toMatchObject({ code: "unavailable" });
    await expect(box.preview(8080)).resolves.toHaveProperty("url");
  });
  test("public previews are opt-in and unexpected session loss is a provider failure", async () => {
    const box = await createSandbox(upstash({ apiKey: "key", public: true }));
    expect((await box.preview(3000)).headers).toBeUndefined();
    vi.spyOn(box.native.exec, "session").mockResolvedValueOnce({
      pid: 12,
      execId: "lost",
      write() {},
      endStdin() {},
      resize() {},
      kill() {},
      terminate() {},
      wait: async () => -1,
      close() {},
    });
    await expect(box.run("echo lost", { stdin: "" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
  test("maps errors without credential leakage", async () => {
    for (const [statusCode, code] of [
      [401, "auth"],
      [404, "not_found"],
      [429, "quota"],
      [503, "unavailable"],
      [408, "timeout"],
      [400, "invalid_argument"],
    ]) {
      const mapped = upstashError(Object.assign(new Error("Bearer secret"), { statusCode }));
      expect(mapped.code).toBe(code);
      expect(mapped.message).not.toContain("secret");
      expect(mapped.message).toContain(`HTTP ${statusCode}`);
      expect(mapped.cause).toContain(`HTTP ${statusCode}`);
      expect(mapped.cause).not.toContain("secret");
    }

    expect(upstashError({ statusCode: 404 }, "box", true).code).toBe("file_not_found");
    const box = await createSandbox(factory());
    await expect(box.files.read("missing")).rejects.toMatchObject({ code: "file_not_found" });
    await expect(factory().connect("missing")).rejects.toMatchObject({ code: "not_found" });
  });
});

test("creation makes an initially unwritable workspace usable for files and git", async () => {
  const { promises: fs } = await import("node:fs");
  const create = MockBox.create.bind(MockBox);
  let guest: MockBox | undefined;
  vi.spyOn(MockBox, "create").mockImplementationOnce(async (params) => {
    guest = await create(params);
    await fs.mkdir(`${guest.root}/workspace`, { mode: 0o111 });

    return guest;
  });

  try {
    const box = await createSandbox(factory());
    await box.files.write("app/file", "writable");
    expect(await box.files.read("app/file")).toBe("writable");
    expect((await box.run("git init repo")).ok).toBe(true);
  } finally {
    if (guest) await fs.chmod(`${guest.root}/workspace`, 0o755).catch(() => {});
  }
});

test("binary files cross the native request limit without enlarging small transfers", async () => {
  const box = await createSandbox(factory());
  const nativeRead = box.native.files.read;
  const nativeWrite = box.native.files.write;

  const reads = vi.spyOn(box.native.files, "read").mockImplementation(async (path, options) => {
    if (options?.length !== undefined && options.length > 8 * 1024 * 1024)
      throw Object.assign(new Error("read limit"), { statusCode: 400 });
    const content = await nativeRead(path, options);

    // Model a response cap on unbounded reads so the chunked fallback runs.
    if (options?.length === undefined && Buffer.from(content, "base64").length > 8 * 1024 * 1024)
      throw Object.assign(new Error("read limit"), { statusCode: 400 });

    return content;
  });

  const writes = vi.spyOn(box.native.files, "write").mockImplementation(async (options) => {
    if (options.content.length > 8 * 1024 * 1024)
      throw Object.assign(new Error("request body limit"), { statusCode: 400 });

    if (options.path.includes("/upload-")) {
      const current = state.boxes.get(box.id);

      if (!current) throw new Error("Missing mock box");
      const { stat } = await import("node:fs/promises");
      const parent = options.path.slice(0, options.path.lastIndexOf("/"));
      expect((await stat(current.map(parent))).mode & 0o777).toBe(0o700);
    }

    return nativeWrite(options);
  });

  const data = Uint8Array.from({ length: 10 * 1024 * 1024 }, (_, i) => i % 251);
  await box.files.write("large.bin", data);
  expect(
    Buffer.from(await box.files.read("large.bin", { as: "bytes" })).equals(Buffer.from(data)),
  ).toBe(true);
  reads.mockClear();
  writes.mockClear();
  const mkdir = vi.spyOn(box.native.files, "mkdir");
  await box.files.write("small.bin", "small");
  expect(await box.files.read("small.bin")).toBe("small");
  expect(writes).toHaveBeenCalledTimes(1);
  expect(reads).toHaveBeenCalledTimes(1);
  expect(mkdir).not.toHaveBeenCalled();
});

test("an upload timeout cannot delete inputs of a still-running atomic assembly", async () => {
  const box = await createSandbox(factory());
  await box.files.write("atomic.bin", "original");
  const original = box.native.exec.command;
  let guest: Promise<Awaited<ReturnType<typeof original>>> | undefined;
  vi.spyOn(box.native.exec, "command").mockImplementation(async (command) => {
    if (!command.startsWith("python3 -c")) return original(command);
    guest = original(
      command
        .replace("import os,sys,shutil,tempfile,stat", "import os,sys,shutil,tempfile,stat,time")
        .replace("shutil.copyfileobj(part,out)", "shutil.copyfileobj(part,out); time.sleep(.1)"),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    throw Object.assign(new Error("HTTP request timed out"), { statusCode: 504 });
  });
  const data = new Uint8Array(10 * 1024 * 1024).fill(237);
  await expect(box.files.write("atomic.bin", data)).rejects.toMatchObject({
    code: "outcome_unknown",
    retryable: false,
  });
  expect(await box.files.read("atomic.bin")).toBe("original");
  expect((await guest)?.exitCode).toBe(0);
  expect(
    Buffer.from(await box.files.read("atomic.bin", { as: "bytes" })).equals(Buffer.from(data)),
  ).toBe(true);
});

test("Upstash listing skips corrupt or vanished metadata and preserves auth failures", async () => {
  const box = await createSandbox(factory());
  const native = state.boxes.get(box.id);

  if (!native) throw new Error("Missing mock box");
  const read = vi.spyOn(native.exec, "command");

  for (const body of ["{", JSON.stringify({ version: 1, labels: { bad: 2 } })]) {
    read.mockResolvedValue({ exitCode: 0, stdout: body, stderr: "", result: body });
    expect(await factory().list({})).toEqual([]);
  }

  read.mockRejectedValue(Object.assign(new Error("gone"), { statusCode: 404 }));
  expect(await factory().list({})).toEqual([]);
  read.mockRejectedValue(Object.assign(new Error("denied"), { statusCode: 401 }));
  await expect(factory().list({})).rejects.toMatchObject({ code: "auth" });
});

test("create carries shell-safe discovery metadata without a post-create call", async () => {
  const create = MockBox.create.bind(MockBox);
  const commands: string[] = [];
  vi.spyOn(MockBox, "create").mockImplementationOnce(async (params) => {
    const value = await create(params);
    const command = value.exec.command;
    vi.spyOn(value.exec, "command").mockImplementation(async (text) => {
      commands.push(text);

      return command(text);
    });
    vi.spyOn(value.files, "mkdir").mockRejectedValue(new Error("Unnecessary setup RPC"));
    vi.spyOn(value.files, "write").mockRejectedValue(new Error("Unnecessary setup RPC"));

    return value;
  });
  const provider = factory();
  const key = "owner:'; touch workspace/injected; #\n$(false)";
  const labels = { app: "quotes ' \" $literal \n雪" };
  const info = await provider.create({ key, labels });
  expect(commands).toHaveLength(0);
  expect(await factory().connect(info.id)).toMatchObject({ key, labels });
  expect(await factory().find(key)).toMatchObject({ id: info.id });
  await expect(provider.files.stat(info.id, "/workspace/injected")).rejects.toMatchObject({
    code: "file_not_found",
  });
  expect(state.creates.at(-1)?.env?.SANDBOX_SDK_UPSTASH_METADATA).toBe(
    JSON.stringify({ version: 1, key, labels: { ...labels, "sandbox-sdk": "1" } }),
  );
});

test("errors preserve operation, HTTP status and sanitized nested cause through core", async () => {
  const box = await createSandbox(factory(), { secrets: { TOKEN: "private-env-value" } });

  const native = Object.assign(
    new Error(
      'Request https://host/path?token=url-secret failed; Authorization: Bearer header-secret; apiKey="mock-key" private-env-value',
      {
        cause: new Error("socket reset; password=nested-secret"),
      },
    ),
    { statusCode: 503, request: { headers: { authorization: "unretained-secret" } } },
  );

  vi.spyOn(box.native.files, "read").mockRejectedValue(native);

  try {
    await box.files.read("missing");
    throw new Error("Expected read failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "unavailable", provider: "upstash", retryable: true });
    expect(error).toHaveProperty("cause", expect.stringContaining("files.read HTTP 503"));
    expect(error).toHaveProperty("cause", expect.stringContaining("socket reset"));
    const evidence = String(error) + String(error instanceof Error ? error.cause : "");

    for (const secret of [
      "url-secret",
      "header-secret",
      "mock-key",
      "private-env-value",
      "nested-secret",
      "unretained-secret",
    ])
      expect(evidence).not.toContain(secret);
  }
});

test("native Authorization headers redact credentials for every scheme", () => {
  for (const header of [
    "Authorization: Basic dXNlcjpwYXNz",
    "authorization=Digest username=hidden, nonce=hidden",
    '"Authorization": "Basic dXNlcjpwYXNz"',
    "Authorization: Bearer hidden",
  ]) {
    const mapped = upstashError(new Error(header));
    expect(mapped.cause).not.toContain("dXNlcjpwYXNz");
    expect(mapped.cause).not.toContain("hidden");
  }
});

test("snapshots preserve native IDs and source size after source deletion and fresh clients", async () => {
  const source = await createSandbox(factory(), { size: "medium" });
  const snapshot = await source.snapshot();
  expect(state.snapshots.has(snapshot.id)).toBe(true);
  await source.destroy();
  const restored = await createSandbox(factory(), { from: snapshot.id });
  expect(restored.native.size).toBe("medium");
  expect(state.creates.at(-1)?.size).toBe("medium");
  const override = await createSandbox(factory(), { from: snapshot.id, size: "large" });
  expect(override.native.size).toBe("large");
});

test("legacy snapshots inherit a surviving source size or require an explicit override", async () => {
  const source = await createSandbox(factory(), { size: "medium" });
  const snapshot = await source.native.snapshot({ name: "legacy-sdk-snapshot" });
  expect((await createSandbox(factory(), { from: snapshot.id })).native.size).toBe("medium");
  await source.destroy();
  await expect(createSandbox(factory(), { from: snapshot.id })).rejects.toMatchObject({
    code: "unsupported",
  });
  expect((await createSandbox(factory(), { from: snapshot.id, size: "medium" })).native.size).toBe(
    "medium",
  );
  await expect(createSandbox(factory(), { from: "missing-snapshot" })).rejects.toMatchObject({
    code: "not_found",
  });
});

test("an empty native snapshot list returns not_found", async () => {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify({ snapshots: null })),
  );
  await expect(createSandbox(factory(), { from: "missing-snapshot" })).rejects.toMatchObject({
    code: "not_found",
  });
});

describe("Upstash Ephemeral Box mode", () => {
  test("creates through EphemeralBox with a one-hour TTL, labels, env and no pause", async () => {
    const provider = ephemeral();
    expect([...provider.capabilities].sort()).toEqual(["network-policy", "size", "snapshot"]);
    expect(provider.pause).toBeUndefined();
    expect(provider.resume).toBeUndefined();

    const box = await createSandbox(provider, {
      size: "medium",
      secrets: { TOKEN: "secret-value" },
      labels: { run: "r1" },
    });

    expect(state.ephemeralCreates).toHaveLength(1);
    expect(state.ephemeralCreates[0]).toMatchObject({
      ttl: 3600,
      size: "medium",
      labels: ["sandbox-sdk"],
      env: { TOKEN: "secret-value" },
    });
    expect(state.ephemeralCreates[0]).not.toHaveProperty("initCommand");
    expect((await box.run('printf %s "$TOKEN"')).stdout).toBe("[REDACTED]");
    expect(await ephemeral().list({ run: "r1" })).toMatchObject([{ id: box.id }]);
    expect(box.native.id).toBe(box.id);
    upstash({ apiKey: "mock-key", ephemeral: true, ttlSeconds: 259_200 });
  });
  test("each mode discovers and connects only its own product", async () => {
    const durable = await factory().create({ key: "shared", labels: { run: "x" } });
    const short = await ephemeral().create({ key: "shared", labels: { run: "x" } });
    expect(await factory().find("shared")).toMatchObject({ id: durable.id });
    expect(await ephemeral().find("shared")).toMatchObject({ id: short.id });
    expect((await factory().list({ run: "x" })).map((info) => info.id)).toEqual([durable.id]);
    expect((await ephemeral().list({ run: "x" })).map((info) => info.id)).toEqual([short.id]);
    await expect(factory().connect(short.id)).rejects.toMatchObject({ code: "unsupported" });
    await expect(ephemeral().connect(durable.id)).rejects.toMatchObject({ code: "unsupported" });
    const options: UpstashOptions = { apiKey: "mock-key", ephemeral: true };
    const unknown = publicUpstash(options);
    // @ts-expect-error A provider of unknown mode does not promise pause.
    void unknown.capabilities.has("pause");
  });
  test("rejects TTLs Upstash cannot honor", () => {
    for (const ttlSeconds of [0, 1.5, 259_201, Number.NaN])
      expect(() => upstash({ apiKey: "mock-key", ephemeral: true, ttlSeconds })).toThrow(
        expect.objectContaining({ code: "invalid_argument" }),
      );
  });
  test("snapshot clones fail restored process records and stay discoverable", async () => {
    const source = await createSandbox(ephemeral(), { labels: {} });
    await source.start("sleep 5", { name: "old" });
    await source.files.write("saved", "kept");
    const snapshot = await source.snapshot();
    await source.destroy();

    const copy = await createSandbox(ephemeral(), {
      from: snapshot.id,
      key: "clone",
      labels: { clone: "yes" },
    });

    expect(state.ephemeralCreates.at(-1)).toMatchObject({ labels: ["sandbox-sdk"], ttl: 3600 });
    expect(await copy.files.read("saved")).toBe("kept");
    expect((await copy.processes())[0]).toMatchObject({ status: "failed", exitCode: 137 });
    expect(await ephemeral().find("clone")).toMatchObject({
      id: copy.id,
      labels: { clone: "yes" },
    });
  });
  test("a launch without a PID kills its own group instead of pausing", async () => {
    const provider = ephemeral();
    const info = await provider.create({ labels: {} });
    const value = state.boxes.get(info.id);

    if (!value) throw new Error("Missing mock box");
    const command = value.exec.command.bind(value.exec);
    const commands: string[] = [];
    vi.spyOn(value.exec, "command").mockImplementation(async (text) => {
      commands.push(text);

      return text.includes("nohup setsid")
        ? { exitCode: 1, stdout: "", stderr: "", result: "" }
        : command(text);
    });
    const pause = vi.spyOn(value, "pause");
    await expect(
      provider.startProcess?.(info.id, {
        command: "sleep 5",
        cwd: "/workspace",
        env: {},
        onChunk() {},
      }),
    ).rejects.toMatchObject({ code: "provider" });
    expect(pause).not.toHaveBeenCalled();
    expect(commands.at(-1)).toMatch(
      /^for p in \$\(pgrep -f '\[t\]mp\/\.sandbox-sdk\/upstash-runs\/[0-9a-f-]+\/'\)/,
    );
  });
});

test("buffered commands preserve large ordered output and isolate environment overrides", async () => {
  const box = await createSandbox(factory(), { env: { TOKEN: "native-secret" } });

  try {
    const result = await box.run(
      'python3 -c \'import sys; sys.stdout.write("雪"*50000); sys.stdout.flush(); sys.stderr.write("END")\'',
    );

    expect(result.stdout).toBe("雪".repeat(50000));
    expect(result.stderr).toBe("END");
    expect((await box.run('printf %s "$TOKEN"')).stdout).toBe("native-secret");
    expect(
      (await box.run('printf %s "$TOKEN"', { env: { TOKEN: "override-secret" } })).stdout,
    ).toBe("override-secret");
    expect((await box.run('printf %s "$TOKEN"')).stdout).toBe("native-secret");
    expect((await box.run("cat")).stdout).toBe("");
  } finally {
    await box.destroy();
  }
});

test("buffered cancellation retries when completion removes the locked directory", async () => {
  const { bufferedExecute } = await import("../src/providers/upstash/buffered.js");
  const box = await createSandbox(factory());
  const command = box.native.exec.command;
  let release = () => {};

  const cancelled = new Promise<void>((resolve) => {
    release = resolve;
  });

  vi.spyOn(box.native.exec, "command").mockImplementation(async (text) => {
    if (text.includes("for attempt in range(3)")) {
      try {
        return await command(
          text.replace(
            /^( *)open\(p\+"\/cancel","w"\)\.close\(\)/m,
            (_match: string, indent: string) =>
              `${indent}if attempt==0:\n${indent} import shutil\n${indent} shutil.rmtree(p)\n${indent}open(p+"/cancel","w").close()`,
          ),
        );
      } finally {
        release();
      }
    }

    const result = await command(text);

    if (text.includes("python3 -S -u")) await cancelled;

    return result;
  });

  try {
    expect(
      await bufferedExecute(box.native, {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 200,
        onChunk() {},
      }),
    ).toEqual({ exitCode: null, timedOut: true });
  } finally {
    release();
    await box.destroy();
  }
});

test("quote-heavy commands fall back to a session without destroying sandbox files", async () => {
  const box = await createSandbox(factory());

  try {
    await box.files.write("kept", "yes");
    expect(await box.run(": #" + "'".repeat(10_000))).toMatchObject({ exitCode: 0 });
    expect(await box.files.read("kept")).toBe("yes");
  } finally {
    await box.destroy();
  }
});

test("a lost buffered response prevents delayed launch without deleting unrelated files", async () => {
  const box = await createSandbox(factory());
  const command = box.native.exec.command;
  let late: Promise<unknown> | undefined;
  vi.spyOn(box.native.exec, "command").mockImplementation(async (text) => {
    if (text.includes("python3 -S -u")) {
      late = new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      }).then(() => command(text));
      void late.catch(() => {});
      throw new Error("private-native-token");
    }

    return command(text);
  });

  try {
    await box.files.write("kept", "yes");
    await expect(box.run("echo leaked > delayed")).rejects.toMatchObject({ code: "provider" });
    await late;
    expect(await box.files.read("kept")).toBe("yes");
    expect(await box.files.exists("delayed")).toBe(false);
  } finally {
    await late;
    await box.destroy();
  }
});

test("buffered primitives inherit sandbox defaults unless core explicitly overrides them", async () => {
  const provider = factory();
  const info = await provider.create({ labels: {}, env: { CI: "native-ci" } });
  const chunks: string[] = [];

  try {
    expect(
      await provider.exec(info.id, {
        command: 'printf %s "$CI"',
        cwd: "/workspace",
        env: {},
        timeoutMs: 3000,
        onChunk(chunk) {
          chunks.push(chunk.text);
        },
      }),
    ).toMatchObject({ exitCode: 0 });
    expect(chunks.join("")).toBe("native-ci");
  } finally {
    await provider.destroy(info.id);
  }
});

test.each([factory, ephemeral])(
  "fresh workspace supports first file operations before the first command",
  async (make) => {
    const provider = make();
    const box = await createSandbox(provider, { labels: { suite: "sbx57-first-files" } });

    try {
      expect((await box.files.stat(".")).type).toBe("directory");
      expect(await box.files.exists(".")).toBe(true);
      expect(await box.files.list(".")).toEqual([]);
      await box.files.write("nested/first.bin", new Uint8Array([0, 255, 10]));
      expect(await box.files.read("nested/first.bin", { as: "bytes" })).toEqual(
        new Uint8Array([0, 255, 10]),
      );
      expect((await box.run("pwd")).stdout).toBe("/workspace\n");
    } finally {
      await box.destroy();
    }
  },
);

test("first mkdir prepares nested paths and removing a fresh workspace stays removed", async () => {
  const provider = factory();
  const first = await createSandbox(provider);
  const second = await createSandbox(provider);

  try {
    await provider.files.mkdir(first.id, "/workspace/nested/dir");
    expect((await first.files.stat("nested/dir")).type).toBe("directory");
    await second.files.remove(".", { recursive: true });
    expect(await second.files.exists(".")).toBe(false);
  } finally {
    await first.destroy();
    await second.destroy();
  }
});

test("reserved discovery environment cannot silently replace caller values", async () => {
  await expect(
    factory().create({ labels: {}, env: { SANDBOX_SDK_UPSTASH_METADATA: "caller value" } }),
  ).rejects.toMatchObject({ code: "invalid_argument" });
  expect(state.creates).toHaveLength(0);
});

test.each([factory, ephemeral])(
  "failed first session setup is retried before the next command",
  async (make) => {
    const box = await createSandbox(make());
    const session = box.native.exec.session.bind(box.native.exec);
    vi.spyOn(box.native.exec, "session").mockImplementationOnce((input) =>
      session({
        ...input,
        argv: input.argv?.map((arg, i) =>
          i === 2 ? arg.replace(/^[\s\S]*? && cd "\$1"/, 'false && cd "$1"') : arg,
        ),
      }),
    );
    expect((await box.run("true", { stdin: "" })).exitCode).toBe(1);
    expect(await box.run("pwd")).toMatchObject({ ok: true, stdout: "/workspace\n" });
  },
);

test.each([factory, ephemeral])(
  "successful session setup survives a nonzero user command",
  async (make) => {
    const box = await createSandbox(make());
    expect((await box.run("exit 7", { stdin: "" })).exitCode).toBe(7);
    await box.native.files.remove("/workspace", { recursive: true });
    expect((await box.run("true", { stdin: "", cwd: "/" })).ok).toBe(true);
    expect(await box.files.exists("/workspace")).toBe(false);
  },
);

test("session setup confirmation tolerates split transport chunks without leaking into output", async () => {
  const box = await createSandbox(factory());
  const session = box.native.exec.session.bind(box.native.exec);
  vi.spyOn(box.native.exec, "session").mockImplementation((input) =>
    session({
      ...input,
      onStdout: (data) => {
        for (const byte of data) input.onStdout?.(new Uint8Array([byte]));
      },
    }),
  );
  expect(await box.run("printf 'é\\n'; exit 7", { stdin: "" })).toMatchObject({
    exitCode: 7,
    stdout: "é\n",
    stderr: "",
  });
});
