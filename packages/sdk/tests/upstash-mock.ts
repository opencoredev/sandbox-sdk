/** SDK-shaped transport backed by isolated Linux files and processes. */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import type {
  Box,
  BoxConfig,
  BoxData,
  BoxSize,
  EphemeralBoxConfig,
  ExecSessionHandle,
  ExecSessionOptions,
  FileStat,
} from "@upstash/box";
const missing = () => Object.assign(new Error("not found"), { statusCode: 404 });
export const state = {
  boxes: new Map<string, MockBox>(),
  creates: [] as BoxConfig[],
  ephemeralCreates: [] as EphemeralBoxConfig[],
  snapshots: new Map<string, string>(),
  snapshotMetadata: new Map<string, { id: string; name: string; box_id: string }>(),
  delayMs: 0,
  envWrites: [] as { path: string; mode: number; directoryMode: number }[],
  /** How the next durable create boots: status reads that report "creating", then its outcome. */
  boot: { polls: 0, outcome: "running" },
  statusReads: 0,
  deletes: [] as string[],
};
export class MockBox {
  readonly id = crypto.randomUUID();
  readonly data: BoxData;
  readonly size: BoxSize;
  readonly children = new Set<number>();
  /** Ephemeral boxes reject pause and resume, as Upstash does. */
  ephemeral = false;
  private constructor(
    readonly root: string,
    readonly params: BoxConfig,
    readonly port: number,
  ) {
    this.size = params.size ?? "small";
    this.data = {
      id: this.id,
      status: "running",
      labels: params.labels ?? [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
  }
  static async create(params: BoxConfig = {}) {
    state.creates.push(params);
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const box = new MockBox(await fs.mkdtemp(join(tmpdir(), "sdk-upstash-")), params, address.port);
    await fs.mkdir(box.map("/tmp"), { recursive: true });
    state.boxes.set(box.id, box);
    return box;
  }
  static async get(id: string) {
    const value = state.boxes.get(id);
    if (!value) throw missing();
    return value;
  }
  static async list(options: { label?: string } = {}) {
    return [...state.boxes.values()]
      .map((box) => box.data)
      .filter((data) => !options.label || data.labels?.includes(options.label));
  }
  static async fromSnapshot(id: string, params: BoxConfig) {
    const root = state.snapshots.get(id);
    if (!root) throw missing();
    const value = await this.create(params);
    await fs.cp(root, value.root, { recursive: true });
    if (params.initCommand) await value.exec.command(params.initCommand);
    return value;
  }
  map(path: string) {
    return join(this.root, path);
  }
  rewrite(text: string) {
    return text
      .replace("data.hex()", `data.replace(${JSON.stringify(this.root)}.encode(),bytes()).hex()`)
      .replace("base64.b64encode(data)", `base64.b64encode(data.replace(${JSON.stringify(this.root)}.encode(),b""))`)
      // Emulate the guest's passwordless install using the host-owned test root.
      .replace(/sudo -n install/g, "install")
      .replace(/\/workspace|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g, (path) => this.map(path))
      .replace(/\.listen\(3000/g, `.listen(${this.port}`);
  }
  labels = {
    add: async (label: string) => {
      this.data.labels ??= [];
      if (!this.data.labels.includes(label)) this.data.labels.push(label);
      return this.data.labels;
    },
  } satisfies Pick<Box["labels"], "add">;
  files: Pick<Box["files"], "read" | "write" | "mkdir" | "stat" | "list" | "remove"> = {
    read: async (
      path: string,
      settings?: { encoding?: "base64"; offset?: number; length?: number },
    ) => {
      try {
        let bytes = await fs.readFile(this.map(path));
        if (settings?.length !== undefined)
          bytes = bytes.subarray(settings.offset ?? 0, (settings.offset ?? 0) + settings.length);
        return bytes.toString(settings?.encoding ?? "utf8");
      } catch {
        throw missing();
      }
    },
    write: async (settings: { path: string; content: string; encoding?: "base64" }) => {
      try { await fs.writeFile(this.map(settings.path), settings.content, settings.encoding ?? "utf8"); } catch { throw missing(); }
      if (settings.path.endsWith("/env") && settings.path.includes("/upstash-runs/"))
        state.envWrites.push({
          path: settings.path,
          mode: (await fs.stat(this.map(settings.path))).mode & 0o777,
          directoryMode: (await fs.stat(this.map(posix.dirname(settings.path)))).mode & 0o777,
        });
    },
    mkdir: async (path: string, settings?: { parents?: boolean }) => {
      await fs.mkdir(this.map(path), { recursive: settings?.parents });
    },
    stat: async (path: string): Promise<FileStat> => {
      try {
        const s = await fs.lstat(this.map(path));
        return {
          type: s.isDirectory() ? "directory" : s.isSymbolicLink() ? "symlink" : "file",
          size: s.size,
          mod_time: s.mtime.toISOString(),
          inode: s.ino,
          version: String(s.mtimeMs),
        };
      } catch {
        throw missing();
      }
    },
    list: async (path = "/workspace") => {
      try {
        return await Promise.all(
          (await fs.readdir(this.map(path))).map(async (name) => {
            const full = posix.join(path, name);
            const file = await this.files.stat(full);
            return {
              name,
              path: full,
              size: file.size,
              is_dir: file.type === "directory",
              mod_time: file.mod_time,
            };
          }),
        );
      } catch {
        throw missing();
      }
    },
    remove: async (path: string, settings?: { recursive?: boolean }) => {
      try {
        await fs.rm(this.map(path), { recursive: settings?.recursive });
      } catch {
        throw missing();
      }
    },
  } satisfies Pick<Box["files"], "read" | "write" | "mkdir" | "stat" | "list" | "remove">;
  exec = {
    command: async (command: string) => {
      const child = spawn("sh", ["-c", this.rewrite(command)], {
        cwd: this.root,
        env: { ...process.env, ...this.params.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 137));
      });
      return { exitCode, stdout, stderr, result: stdout };
    },
    session: async (settings: ExecSessionOptions): Promise<ExecSessionHandle> => {
      if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
      const [command = "sh", ...args] = settings.argv ?? ["sh", "-c", settings.cmd ?? ""];
      const env = { ...process.env, ...this.params.env };
      for (const entry of settings.env ?? []) {
        const cut = entry.indexOf("=");
        env[entry.slice(0, cut)] = entry.slice(cut + 1);
      }
      if (env.GIT_INDEX_FILE) env.GIT_INDEX_FILE = this.rewrite(env.GIT_INDEX_FILE);
      const child = spawn(
        command,
        args.map((arg) => this.rewrite(arg)),
        {
          cwd: this.map(settings.cwd ?? "/workspace"),
          env,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const pid = child.pid;
      if (!pid) throw new Error("No process pid");
      this.children.add(pid);
      let done = false;
      child.stdout.on("data", (data: Buffer) =>
        settings.onStdout?.(Buffer.from(data.toString().split(this.root).join(""))),
      );
      child.stderr.on("data", (data: Buffer) =>
        settings.onStderr?.(Buffer.from(data.toString().split(this.root).join(""))),
      );
      child.stdin.on("error", () => {});
      const wait = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          done = true;
          this.children.delete(pid);
          resolve(code ?? 137);
        });
      });
      const kill = (signal = "TERM") => {
        try {
          process.kill(-pid, signal === "KILL" ? "SIGKILL" : "SIGTERM");
        } catch {}
      };
      return {
        pid,
        execId: crypto.randomUUID(),
        write: (data) => {
          child.stdin.write(data);
        },
        endStdin: () => child.stdin.end(),
        resize() {},
        kill,
        terminate: () => kill("KILL"),
        wait: () => wait,
        close: () => {
          if (!done) kill("KILL");
        },
      };
    },
  } satisfies {
    session: Box["exec"]["session"];
    command(
      command: string,
    ): Promise<{ exitCode: number; stdout: string; stderr: string; result: string }>;
  };
  /** Status reads left that still report "creating", then the outcome a boot reaches. */
  booting = { polls: 0, outcome: "running" };
  async getStatus() {
    state.statusReads++;
    if (this.booting.polls > 0) { this.booting.polls--; return { status: "creating" }; }
    return { status: this.booting.outcome };
  }
  async getPublicURL(port: number, settings?: { bearerToken?: boolean }) {
    return {
      url: `http://127.0.0.1:${this.port}/?port=${port}`,
      port,
      ...(settings?.bearerToken ? { token: "mock-preview" } : {}),
    };
  }
  async pause() {
    if (this.ephemeral) throw Object.assign(new Error("Ephemeral boxes cannot be paused"), { statusCode: 400 });
    await this.terminate();
    this.data.status = "paused";
  }
  async resume() {
    if (this.ephemeral) throw Object.assign(new Error("Ephemeral boxes cannot be resumed"), { statusCode: 400 });
    const paused = this.data.status === "paused";
    this.data.status = "running";
    if (paused && this.params.initCommand) await this.exec.command(this.params.initCommand);
  }
  async snapshot(options?: { name: string }) {
    const id = crypto.randomUUID();
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-upstash-snapshot-"));
    await fs.cp(this.root, root, {
      recursive: true,
      filter: async (path) => !(await fs.lstat(path)).isFIFO(),
    });
    state.snapshots.set(id, root);
    const snapshot = { id, name: options?.name ?? "native-snapshot", box_id: this.id };
    state.snapshotMetadata.set(id, snapshot);
    return snapshot;
  }
  async terminate() {
    const path = this.map("/tmp/.sandbox-sdk/procs");
    for (const name of await fs.readdir(path).catch(() => [])) {
      const pid = Number(await fs.readFile(join(path, name, "pid"), "utf8").catch(() => ""));
      if (pid > 0) this.children.add(pid);
    }
    for (const pid of this.children) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }
    this.children.clear();
  }
  async delete() {
    await this.terminate();
    state.boxes.delete(this.id);
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
/** Ephemeral create takes no initCommand and returns a box usable at once. */
export class MockEphemeralBox {
  static async create(params: EphemeralBoxConfig = {}) {
    state.ephemeralCreates.push(structuredClone(params));
    const { ttl: _ttl, ...rest } = params;
    const value = await MockBox.create(rest);
    value.ephemeral = true;
    Object.assign(value.data, { ephemeral: true });
    return value;
  }
  static async fromSnapshot(id: string, params: EphemeralBoxConfig = {}) {
    state.ephemeralCreates.push(structuredClone(params));
    const { ttl: _ttl, ...rest } = params;
    const value = await MockBox.fromSnapshot(id, rest);
    value.ephemeral = true;
    Object.assign(value.data, { ephemeral: true });
    return value;
  }
}
/** The adapter sends Box.create's and Box.fromSnapshot's request itself, then attaches with Box.get. Serve
 * those routes from MockBox, turning the wire body back into the BoxConfig the native SDK would receive,
 * so `state.creates` still records what reached Upstash. Other requests pass through. */
type Wire = { snapshot_id?: string; labels?: string[]; size?: BoxSize; keep_alive?: boolean; init_command?: string; runtime?: BoxConfig["runtime"]; browser?: boolean; env_vars?: Record<string, string>; attach_headers?: BoxConfig["attachHeaders"]; network_policy?: { mode: "allow-all" | "deny-all" | "custom"; allowed_domains?: string[]; allowed_cidrs?: string[]; denied_cidrs?: string[] } };
function configOf(wire: Wire, apiKey: string | null): BoxConfig {
  const policy = wire.network_policy;
  return {
    ...(apiKey === null ? {} : { apiKey }),
    ...(wire.labels ? { labels: wire.labels } : {}),
    ...(wire.size ? { size: wire.size } : {}),
    ...(wire.keep_alive ? { keepAlive: true } : {}),
    ...(wire.init_command === undefined ? {} : { initCommand: wire.init_command }),
    ...(wire.runtime ? { runtime: wire.runtime } : {}),
    ...(wire.browser ? { browser: true } : {}),
    ...(wire.env_vars ? { env: wire.env_vars } : {}),
    ...(wire.attach_headers ? { attachHeaders: wire.attach_headers } : {}),
    ...(policy === undefined ? {} : {
      networkPolicy: policy.mode === "custom"
        ? { mode: "custom", ...(policy.allowed_domains ? { allowedDomains: policy.allowed_domains } : {}), ...(policy.allowed_cidrs ? { allowedCidrs: policy.allowed_cidrs } : {}), ...(policy.denied_cidrs ? { deniedCidrs: policy.denied_cidrs } : {}) }
        : { mode: policy.mode },
    }),
  };
}
const upstream = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  const method = init?.method ?? "GET";
  const create = /^https:\/\/us-east-1\.box\.upstash\.com\/v2\/box(\/from-snapshot)?$/.exec(url);
  if (create && method === "POST") {
    const wire: Wire = JSON.parse(String(init?.body));
    const config = configOf(wire, new Headers(init?.headers).get("X-Box-Api-Key"));
    let box: MockBox;
    try { box = create[1] ? await MockBox.fromSnapshot(wire.snapshot_id ?? "", config) : await MockBox.create(config); }
    catch (error) {
      const status = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
      return Response.json({ error: error instanceof Error ? error.message : "failed" }, { status });
    }
    box.booting = { ...state.boot };
    return Response.json({ ...box.data, status: box.booting.polls > 0 ? "creating" : box.booting.outcome });
  }
  const id = /^https:\/\/us-east-1\.box\.upstash\.com\/v2\/box\/([^/]+)$/.exec(url)?.[1];
  if (id !== undefined && method === "DELETE") {
    state.deletes.push(decodeURIComponent(id));
    const box = state.boxes.get(decodeURIComponent(id));
    if (!box) return Response.json({ error: "not found" }, { status: 404 });
    await box.delete();
    return Response.json({});
  }
  return upstream(input, init);
}, upstream);
export async function cleanup() {
  for (const box of state.boxes.values()) await box.delete();
  for (const root of state.snapshots.values()) await fs.rm(root, { recursive: true, force: true });
  state.snapshots.clear();
  state.snapshotMetadata.clear();
  state.creates.length = 0;
  state.ephemeralCreates.length = 0;
  state.delayMs = 0;
  state.envWrites.length = 0;
  state.boot = { polls: 0, outcome: "running" };
  state.statusReads = 0;
  state.deletes.length = 0;
}
