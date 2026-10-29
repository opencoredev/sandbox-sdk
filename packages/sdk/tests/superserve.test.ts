import { afterAll, expect, test, vi } from "vitest";
import { mkdtemp, writeFile, readFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockGuest } from "./cloud-guest-mock.js";
import { quote } from "../src/providers/boxd/guest.js";
const state = vi.hoisted(() => ({
  boxes: new Map<
    string,
    { guest: MockGuest; metadata: Record<string, string>; createdAt: Date; status: string; network?: unknown }
  >(),
  creates: 0,
  nativeTimeoutSeconds: 0,
  bootstrapPath: "",
  updates: new Array<unknown>(),
  createOptions: undefined as unknown,
  transportFailure: false,
  stdinFailure: false,
  closes: 0,
  bootstrap: undefined as undefined | (() => Promise<void>),
  snapshotFailure: false,
  snapshotOptions: undefined as unknown,
  dropNetwork: false,
  previewAccess: [] as unknown[],
}));
vi.mock("@superserve/sdk", () => ({
  Sandbox: class {
    constructor(readonly id: string) {}
    static async create(options: { metadata: Record<string, string>; network?: unknown }) {
      const guest = await MockGuest.create();
      state.creates++;
      state.createOptions = options;
      state.boxes.set(guest.id, {
        guest,
        metadata: options.metadata,
        createdAt: new Date(),
        status: "active",
        ...(options.network && !state.dropNetwork ? { network: options.network } : {}),
      });
      return new this(guest.id);
    }
    static async connect(id: string) {
      if (!state.boxes.has(id)) throw Object.assign(new Error("private"), { statusCode: 404 });
      return new this(id);
    }
    static async list() {
      return [...state.boxes.entries()].map(([id, v]) => ({ ...v, id }));
    }
    static async killById(id: string) {
      await state.boxes.get(id)?.guest.destroy();
      state.boxes.delete(id);
    }
    get value() {
      const v = state.boxes.get(this.id);
      if (!v) throw Object.assign(new Error("private"), { statusCode: 404 });
      return v;
    }
    async getInfo() {
      return {
        ...this.value,
        id: this.id,
        ...(state.nativeTimeoutSeconds > 0 ? { timeoutSeconds: state.nativeTimeoutSeconds } : {}),
      };
    }
    async update(options: unknown) {
      state.updates.push(options);
    }
    async snapshot(options: unknown) {
      state.snapshotOptions = options;
      if (state.snapshotFailure) throw new Error("private-native-token");
      return { id: "snapshot-1" };
    }
    async pause() {
      this.value.status = "paused";
    }
    async resume() {
      this.value.status = "active";
    }
    get commands() {
      const g = this.value.guest;
      const launch = (command: string) => {
        const mapping = `
def sdk_paths(value):
 if isinstance(value,str): return value.replace("/"+"workspace",bytes.fromhex("${Buffer.from(g.root + "/workspace").toString("hex")}").decode()).replace("/tmp/"+".sandbox-sdk",bytes.fromhex("${Buffer.from(g.root + "/tmp/.sandbox-sdk").toString("hex")}").decode())
 if isinstance(value,list): return [sdk_paths(x) for x in value]
 if isinstance(value,dict): return {k:sdk_paths(x) for k,x in value.items()}
 return value
v=sdk_paths(v)`;
        return command.replace("else marshal.loads(bytes.fromhex(sys.stdin.read()))", "else marshal.loads(bytes.fromhex(sys.stdin.read()))" + mapping).replace("data.hex()", `data.replace(${JSON.stringify(g.root)}.encode(),bytes()).hex()`);

      };
      return {
        run: async (command: string, options: { env?: Record<string, string> } = {}) => {
          if (options.env?.SANDBOX_SDK_BOOTSTRAP) await state.bootstrap?.();
          if (state.transportFailure) {
            state.transportFailure = false;
            void g.raw(command).catch(() => {});
            throw new Error("private-native-token");
          }
          const env = { ...options.env };
          if ((options.env?.SANDBOX_SDK_BOOTSTRAP) && state.bootstrapPath)
            env.PATH = state.bootstrapPath;
          const prefix = Object.entries(env)
            .map(([key, value]) => {
              // Match MockGuest.upload's host-path normalization for encoded output.
              const payload =
                key === "SANDBOX_SDK_BOOTSTRAP"
                  ? value.replace(
                      "base64.b64encode(data)",
                      `base64.b64encode(data.replace(${JSON.stringify(g.root)}.encode(),bytes()))`,
                    )
                  : value;
              return `export ${key}=${quote(payload)};`;
            })
            .join(" ");
          try {
            return { stdout: await g.raw(`${prefix} ${launch(command)}`), stderr: "", exitCode: 0 };
          } catch (error) {
            if (
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              typeof error.code === "number"
            )
              return {
                stdout: "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
                stderr: "stderr" in error && typeof error.stderr === "string" ? error.stderr : "",
                exitCode: error.code,
              };
            throw error;
          }
        },
        spawn: async (
          command: string,
          options: {
            onStdout?: (s: string) => void;
            onStderr?: (s: string) => void;
            startupSignal?: AbortSignal;
            env?: Record<string, string>;
          },
        ) => {
          if (options.startupSignal?.aborted) throw new DOMException("aborted", "AbortError");
          const prefix = Object.entries(options.env ?? {}).map(([key, value]) => `export ${key}=${quote(value.replace("base64.b64encode(data)", `base64.b64encode(data.replace(${JSON.stringify(g.root)}.encode(),bytes()))`))};`).join(" ");
          const stream = g.stream(`${prefix} ${launch(command)}`);
          let stdout = "",
            stderr = "";
          stream.stdout.push = (bytes) => {
            const text = Buffer.from(bytes).toString();
            stdout += text;
            options.onStdout?.(text);
          };
          stream.stderr.push = (bytes) => {
            const text = Buffer.from(bytes).toString();
            stderr += text;
            options.onStderr?.(text);
          };
          return {
            stdin: {
              write: (s: string) => {
                if (state.stdinFailure) {
                  state.stdinFailure = false;
                  throw new Error("private-input-error");
                }
                stream.write(s);
              },
              close: () => stream.end(),
            },
            kill: () => stream.close(),
            wait: async () => {
              const pending = stream.wait();
              if (state.transportFailure) {
                state.transportFailure = false;
                pending.catch(() => {});
                throw new Error("private-native-token");
              }
              return { exitCode: await pending, stdout, stderr };
            },
            close: async () => {
              state.closes++;
              stream.close();
            },
          };
        },
      };
    }
    get files() {
      const g = this.value.guest;
      return {
        write: (p: string, b: Uint8Array) => g.upload(p, b),
        read: async (p: string) => {
          try {
            return await g.read(p);
          } catch {
            throw Object.assign(new Error("private"), { statusCode: 404 });
          }
        },
      };
    }
    async publishPreviewPort(_port: number, options: unknown) { state.previewAccess.push(options); }
    async getPreviewToken() {
      return { header: "x-preview", token: "mock" };
    }
    getPreviewUrl(port: number) {
      return `https://mock.invalid/${port}`;
    }
  },
}));
import { superserve } from "../src/providers/superserve/index.js";
import { superserveError } from "../src/providers/superserve/errors.js";
import { createSandbox, connectSandbox } from "../src/index.js";
import { runConformance } from "../src/testing.js";
const factory = () => superserve({ apiKey: "mock" });
runConformance(() => ({ ...factory(), name: "memory" }), { live: false });
afterAll(async () => {
  for (const v of state.boxes.values()) await v.guest.destroy();
  state.boxes.clear();
});
test("fails closed before allocation for unsupported creation settings", async () => {
  const p = factory(),
    before = state.creates;
  for (const options of [
    { size: "small" },
    { size: { cpu: 1, memoryMb: 1024, diskGb: 4 } },
    { network: { allow: ["https://example.com"] } },
    { network: { allow: ["example.com:443"] } },
    { timeoutMs: 1000 },
    { idleTimeoutMs: 1000 },
  ] satisfies Partial<Parameters<typeof p.create>[0]>[])
    await expect(p.create({ labels: {}, ...options })).rejects.toMatchObject({
      code: "unsupported",
    });
  expect(state.creates).toBe(before);
});
test("maps statuses without retaining native secrets", () => {
  for (const [statusCode, code] of [
    [401, "auth"],
    [403, "auth"],
    [404, "not_found"],
    [429, "quota"],
    [503, "unavailable"],
    [504, "timeout"],
    [422, "invalid_argument"],
  ] as const) {
    const error = superserveError(Object.assign(new Error("secret-api-key"), { statusCode }));
    expect(error.code).toBe(code);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain("secret-api-key");
  }
});

test("transport failure confirms termination before a delayed side effect", async () => {
  const box = await createSandbox(factory());
  try {
    state.transportFailure = true;
    await expect(box.run("sleep .4; echo leaked > late-transport")).rejects.toMatchObject({
      code: "provider",
    });
    expect(await box.files.exists("late-transport")).toBe(false);
    expect((await box.run("echo usable")).stdout).toBe("usable\n");
  } finally {
    await box.destroy();
  }
});
test("creation defers bootstrap to the first execution", async () => {
  let calls = 0;
  state.bootstrap = async () => { calls++; };
  const box = await createSandbox(factory());
  try {
    expect(calls).toBe(0);
    expect((await box.run("true")).ok).toBe(true);
    expect(calls).toBe(1);
    expect((await box.run("true")).ok).toBe(true);
    expect(calls).toBe(1);
  } finally { state.bootstrap = undefined; await box.destroy(); }
});
test("snapshot failures retain a safe idempotent recovery name", async () => {
  const box = await createSandbox(factory());
  try {
    expect(await box.snapshot()).toEqual({ id: "snapshot-1" });
    expect(state.snapshotOptions).toMatchObject({
      name: expect.stringMatching(/^sbxsdk-/),
      idempotencyKey: expect.any(String),
    });
    state.snapshotFailure = true;
    await expect(box.snapshot()).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringContaining("recover snapshot named sbxsdk-"),
    });
  } finally {
    state.snapshotFailure = false;
    await box.destroy();
  }
});

test("stdin setup failure closes the native session", async () => {
  const box = await createSandbox(factory());
  try {
    const before = state.closes;
    state.stdinFailure = true;
    await expect(box.run("cat", { stdin: "private-input" })).rejects.toMatchObject({ code: "provider" });
    expect(state.closes).toBeGreaterThan(before);
  } finally {
    state.stdinFailure = false;
    await box.destroy();
  }
});
test("a range read does not download the full native file", async () => {
  const provider = factory(),
    box = await createSandbox(provider);
  try {
    await box.files.write("range.bin", new Uint8Array([0, 1, 2, 3, 4, 5]));
    const guest = state.boxes.get(box.id)?.guest;
    if (!guest) throw new Error("missing guest");
    const before = guest.reads.length;
    expect(
      await provider.files.readRange?.(box.id, "/workspace/range.bin", { offset: 2, length: 3 }),
    ).toEqual(new Uint8Array([2, 3, 4]));
    expect(guest.reads.length).toBe(before);
  } finally {
    await box.destroy();
  }
});

test.each([
  [undefined, "superserve/node-22"],
  ["sandbox-bench-node22-py311-1x1", "sandbox-bench-node22-py311-1x1"],
  ["93d75667-9e61-4d93-b8f8-2b5beac98fca", "93d75667-9e61-4d93-b8f8-2b5beac98fca"],
])("selects template %s without changing the provider default", async (template, expected) => {
  const provider = superserve({ apiKey: "mock", template });
  const box = await provider.create({ labels: {} });
  try {
    expect(state.createOptions).toMatchObject({ fromTemplate: expected });
    expect(state.createOptions).not.toHaveProperty("fromSnapshot");
  } finally {
    await provider.destroy(box.id);
  }
});

test("snapshot restore takes precedence over a custom template", async () => {
  const provider = superserve({ apiKey: "mock", template: "sandbox-bench-node22-py311-1x1" });
  const box = await provider.create({ labels: {}, from: "snapshot-custom" });
  try {
    expect(state.createOptions).toMatchObject({ fromSnapshot: "snapshot-custom" });
    expect(state.createOptions).not.toHaveProperty("fromTemplate");
  } finally {
    await provider.destroy(box.id);
  }
});

test("first execution prepares the environment and launcher in its single guest call", async () => {
  const provider = factory();
  const before = state.updates.length;
  const value = "literal'$(echo injected)";
  const box = await provider.create({ labels: {}, env: { LITERAL: value } });
  try {
    const guest = state.boxes.get(box.id)?.guest;
    if (!guest) throw new Error("missing guest");
    expect(guest.commands).toHaveLength(0);
    expect(guest.uploads).toHaveLength(0);
    expect(state.updates).toHaveLength(before);
    const chunks: string[] = [];
    expect(
      await provider.exec(box.id, {
        command: `printf '%s' "$LITERAL"`,
        cwd: "/workspace",
        env: {},
        timeoutMs: 10000,
        onChunk: (chunk) => chunks.push(chunk.text),
      }),
    ).toMatchObject({ exitCode: 0, timedOut: false });
    expect(chunks.join("")).toBe(value);
    expect(guest.commands).toHaveLength(1);
  } finally {
    await provider.destroy(box.id);
  }
});

test("restores clear an inherited auto-pause timeout", async () => {
  const provider = factory();
  const before = state.updates.length;
  state.nativeTimeoutSeconds = 60;
  try {
    const box = await provider.create({ labels: {}, from: "external-snapshot" });
    try {
      expect(state.updates.slice(before)).toEqual([{ timeoutSeconds: null }]);
    } finally {
      await provider.destroy(box.id);
    }
  } finally {
    state.nativeTimeoutSeconds = 0;
  }
});

test("missing Python fails on first use without running apt", async () => {
  const path = await mkdtemp(join(tmpdir(), "superserve-no-python-"));
  state.bootstrapPath = path;
  const provider = factory();
  const box = await provider.create({ labels: {} });
  try {
    await expect(provider.files.list(box.id, "/workspace")).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("explicitly set installPython: true") });
  } finally { state.bootstrapPath = ""; await provider.destroy(box.id); await rm(path, { recursive: true, force: true }); }
});

test("missing Python on a first run reports unsupported, not an unconfirmed cancellation", async () => {
  const path = await mkdtemp(join(tmpdir(), "superserve-no-python-run-"));
  state.bootstrapPath = path;
  const box = await createSandbox(factory());
  try {
    await expect(box.run("echo ok")).rejects.toMatchObject({ code: "unsupported", message: expect.stringContaining("explicitly set installPython: true") });
  } finally { state.bootstrapPath = ""; await box.destroy(); await rm(path, { recursive: true, force: true }); }
});

test("only an explicit installPython opt-in runs apt when Python is absent", async () => {
  const path = await mkdtemp(join(tmpdir(), "superserve-opt-in-"));
  const log = join(path, "apt.log");
  for (const tool of ["git", "tar", "nohup"]) await symlink(`/usr/bin/${tool}`, join(path, tool));
  await writeFile(
    join(path, "apt-get"),
    `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(log)}
if [ "$1" = install ]; then /usr/bin/ln -s /usr/bin/python3 ${quote(join(path, "python3"))}; fi
`,
    { mode: 0o700 },
  );
  state.bootstrapPath = path;
  const provider = superserve({ apiKey: "mock", installPython: true });
  try {
    const box = await provider.create({ labels: {} });
    try {
      await provider.files.list(box.id, "/workspace");
      expect(await readFile(log, "utf8")).toBe(
        "update -qq\ninstall -y -qq python3 python3-venv python3-pip\n",
      );
    } finally {
      await provider.destroy(box.id);
    }
  } finally {
    state.bootstrapPath = "";
    await rm(path, { recursive: true, force: true });
  }
});

test("one-shot execution keeps env values out of argv and preserves stdin sessions", async () => {
  const box = await createSandbox(factory());
  try {
    const secret = "private-command-secret";
    const probe = await box.run("python3 -c 'import os; print(open(\"/proc/%s/cmdline\" % os.getppid(), \"rb\").read().decode()); print(os.environ[\"TOKEN\"])'", { env: { TOKEN: secret } });
    expect(probe.stdout.trim().split("\n").at(-1)).toBe(secret);
    expect(probe.stdout.slice(0, probe.stdout.lastIndexOf(secret))).not.toContain(secret);
    expect((await box.run("cat", { stdin: secret })).stdout).toBe(secret);
  } finally { await box.destroy(); }
});

test("quote-heavy commands use stdin transport before shell argument expansion exceeds its limit", async () => {
  const box = await createSandbox(factory());
  try { expect(await box.run(": #" + "'".repeat(40_000))).toMatchObject({ exitCode: 0 }); }
  finally { await box.destroy(); }
});

test("fresh files prepare the workspace before execution", async () => {
  const provider = factory();
  const box = await createSandbox(provider);
  try {
    const guest = state.boxes.get(box.id)?.guest;
    if (!guest) throw new Error("Missing guest");
    expect(guest.commands).toHaveLength(0);
    expect(await box.files.list(".")).toEqual([]);
    expect((await box.files.stat(".")).type).toBe("directory");
    await box.files.write("nested/first.bin", new Uint8Array([0, 255, 10]));
    expect(await box.files.read("nested/first.bin", { as: "bytes" })).toEqual(new Uint8Array([0, 255, 10]));
    expect((await Promise.all([box.run("echo one"), box.run("echo two")])).map(x => x.stdout)).toEqual(["one\n", "two\n"]);
  } finally { await box.destroy(); }
});

test("an empty create environment clears an inherited snapshot env file", async () => {
  const box = await createSandbox(factory());
  try {
    const guest = state.boxes.get(box.id)?.guest;
    if (!guest) throw new Error("Missing guest");
    await guest.upload("/var/lib/sandbox-sdk-env.json", Buffer.from('{"STALE_SNAPSHOT_ENV":"stale"}'));
    expect((await box.run('printf %s "$STALE_SNAPSHOT_ENV"')).stdout).toBe("");
  } finally { await box.destroy(); }
});

test("first file operation persists create environment for a fresh client", async () => {
  const box = await createSandbox(factory(), { env: { FIRST_FILE_ENV: "persisted" } });
  try {
    await box.files.list(".");
    const reconnected = await connectSandbox(factory(), box.id);
    try { expect((await reconnected.run('printf %s "$FIRST_FILE_ENV"')).stdout).toBe("persisted"); }
    finally { await reconnected.close(); }
  } finally { await box.destroy(); }
});

test("native lifetime, secret and preview options reach Sandbox.create in seconds", async () => {
  const provider = superserve({ apiKey: "mock", autoPauseMs: 90_500, autoDeleteMs: 0, secretBindings: { OPENAI_API_KEY: "openai-prod" }, previewAccess: "public" });
  const box = await provider.create({ labels: {} });
  try {
    expect(state.createOptions).toMatchObject({ timeoutSeconds: 91, autoDeleteSeconds: 0, secrets: { OPENAI_API_KEY: "openai-prod" }, previewAccess: "public" });
    expect(state.createOptions).not.toHaveProperty("network");
    expect(await provider.previewUrl(box.id, 3000)).toEqual({ url: "https://mock.invalid/3000" });
    expect(state.previewAccess.at(-1)).toEqual({ access: "public" });
  } finally { await provider.destroy(box.id); }
  expect(() => superserve({ autoPauseMs: 0 })).toThrowError(expect.objectContaining({ code: "invalid_argument" }));
  expect(() => superserve({ autoDeleteMs: -1 })).toThrowError(expect.objectContaining({ code: "invalid_argument" }));
});
test("network policy maps to Superserve egress rules and is confirmed after create", async () => {
  const provider = factory();
  expect(provider.capabilities.has("network-policy")).toBe(true);
  for (const [network, expected] of [
    ["none", { allowOut: [], denyOut: ["0.0.0.0/0"] }],
    [{ allow: ["10.0.0.0/8", "1.2.3.4"] }, { allowOut: ["10.0.0.0/8", "1.2.3.4/32"], denyOut: ["0.0.0.0/0"] }],
    [{ allow: ["registry.npmjs.org", "*.github.com"] }, { allowOut: ["registry.npmjs.org", "*.github.com", "1.1.1.1/32", "8.8.8.8/32"], denyOut: ["0.0.0.0/0"] }],
  ] as const) {
    const box = await provider.create({ labels: {}, network });
    try { expect(state.createOptions).toMatchObject({ network: expected }); }
    finally { await provider.destroy(box.id); }
  }
  state.dropNetwork = true;
  const before = state.boxes.size;
  try { await expect(provider.create({ labels: {}, network: "none" })).rejects.toMatchObject({ code: "unsupported" }); }
  finally { state.dropNetwork = false; }
  expect(state.boxes.size).toBe(before);
});
test("restores apply the configured auto-pause instead of the inherited one", async () => {
  const provider = superserve({ apiKey: "mock", autoPauseMs: 30_000 });
  const before = state.updates.length;
  state.nativeTimeoutSeconds = 60;
  try {
    const box = await provider.create({ labels: {}, from: "external-snapshot" });
    try {
      expect(state.createOptions).toMatchObject({ fromSnapshot: "external-snapshot", timeoutSeconds: 30 });
      expect(state.updates.slice(before)).toEqual([{ timeoutSeconds: 30 }]);
    } finally { await provider.destroy(box.id); }
  } finally { state.nativeTimeoutSeconds = 0; }
});
test("snapshot rejects expiresInMs because Superserve keeps snapshots until deleted", async () => {
  const provider = factory();
  const box = await provider.create({ labels: {} });
  try {
    state.snapshotOptions = undefined;
    await expect(provider.snapshot?.(box.id, { expiresInMs: 3_600_000 })).rejects.toMatchObject({ code: "unsupported" });
    expect(state.snapshotOptions).toBeUndefined();
    expect(await provider.snapshot?.(box.id, { expiresInMs: 0 })).toEqual({ id: "snapshot-1" });
  } finally { await provider.destroy(box.id); }
});
