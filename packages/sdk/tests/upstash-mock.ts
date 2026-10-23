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
export async function cleanup() {
  for (const box of state.boxes.values()) await box.delete();
  for (const root of state.snapshots.values()) await fs.rm(root, { recursive: true, force: true });
  state.snapshots.clear();
  state.snapshotMetadata.clear();
  state.creates.length = 0;
  state.ephemeralCreates.length = 0;
  state.delayMs = 0;
  state.envWrites.length = 0;
}
