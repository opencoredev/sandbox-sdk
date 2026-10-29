/** Only Railway's transport is mocked. Files, shell, git, groups and HTTP are real. */
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createServer, type AddressInfo } from "node:net";
import * as railwaySdk from "railway";
import {
  SandboxNotFoundError,
  SandboxFileNotFoundError,
  RailwayAuthError,
  RailwayConnectionError,
} from "railway";
import type {
  CreateOptions,
  ExecOptions,
  ExecHandle,
  ExecResult,
  SandboxDomain,
  SandboxFileEntry,
  SandboxStatus,
  SandboxTemplate,
} from "railway";
import { createRailwayProvider, type RailwayOptions } from "../src/providers/railway/provider.js";

interface MockState {
  boxes: Map<string, MockSandbox>;
  creates: CreateOptions[];
  execs: ExecOptions[];
  snapshots: Map<string, string>;
  writes: { path: string; options?: { mode?: number } }[];
  delayMs: number;
  interrupt: boolean;
  unconfirmed: boolean;
  pageSize: number;
  cursors: (string | null)[];
}

export const state: MockState = {
  boxes: new Map(),
  creates: [],
  execs: [],
  snapshots: new Map(),
  writes: [],
  delayMs: 0,
  interrupt: false,
  unconfirmed: false,
  pageSize: 2,
  cursors: [],
};

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

function isCheckpointName(source: string | SandboxTemplate | CreateOptions): source is string {
  return typeof source === "string";
}

/** The `after` cursor of a RailwaySandboxes request. */
function hasCursor(request: unknown): request is { variables: { after: string } } {
  return (
    typeof request === "object" &&
    request !== null &&
    "variables" in request &&
    typeof request.variables === "object" &&
    request.variables !== null &&
    "after" in request.variables &&
    typeof request.variables.after === "string"
  );
}

const missing = (id: string) => new SandboxNotFoundError({ id, environmentId: "mock-env" });

export class MockSandbox {
  readonly id = crypto.randomUUID();
  readonly createdAt = new Date().toISOString();
  status: SandboxStatus = "RUNNING";
  readonly domains: SandboxDomain[] = [];
  readonly groups = new Set<number>();
  private children = new Set<ReturnType<typeof spawn>>();
  private constructor(
    readonly root: string,
    readonly params: CreateOptions,
  ) {}
  static create(options?: CreateOptions): Promise<MockSandbox>;
  static create(checkpointName: string, options?: CreateOptions): Promise<MockSandbox>;
  static create(template: SandboxTemplate, options?: CreateOptions): Promise<MockSandbox>;
  static async create(
    source: string | SandboxTemplate | CreateOptions = {},
    options: CreateOptions = {},
  ) {
    if (!isCheckpointName(source) && "withPackages" in source)
      throw new Error("The Railway mock builds no templates");
    const params = isCheckpointName(source) ? options : source;
    state.creates.push(params);

    if (params.token === "invalid") throw new RailwayAuthError("RAILWAY_API_TOKEN");

    if (state.delayMs) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
    const box = new MockSandbox(await fs.mkdtemp(join(tmpdir(), "sdk-railway-")), params);

    if (isCheckpointName(source)) {
      const root = state.snapshots.get(source);

      if (!root) throw missing(source);
      await fs.cp(root, box.root, { recursive: true });
    }

    await fs.mkdir(box.map("/tmp"), { recursive: true });

    for (const { port } of params.domains ?? []) {
      const socket = createServer();
      await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
      const address = socket.address();

      if (!isAddressInfo(address)) throw new Error("No mock port");
      await new Promise<void>((resolve) => socket.close(() => resolve()));
      box.domains.push({ prefix: "mock", port, domain: `mock-${address.port}.railway.test` });
    }

    state.boxes.set(box.id, box);

    return box;
  }
  static async connect(id: string) {
    const box = state.boxes.get(id);

    if (!box) throw missing(id);

    return box;
  }
  map(path: string) {
    return join(this.root, path);
  }
  rewrite(text: string) {
    let value = text.replace(/\/workspace|\/tmp\//g, (path) => this.map(path));

    for (const domain of this.domains)
      value = value.replaceAll(
        `.listen(${domain.port},`,
        `.listen(${domain.domain.split(".")[0]?.slice(5)},`,
      );

    return value;
  }
  readonly files = new MockFiles(this);
  exec(command: string, options: ExecOptions = {}): Pick<ExecHandle, "then" | "stdin"> {
    state.execs.push(options);

    const env = { ...process.env, ...this.params.env, ...options.env };

    if (options.env?.GIT_INDEX_FILE) env.GIT_INDEX_FILE = this.rewrite(options.env.GIT_INDEX_FILE);

    const child = spawn("sh", ["-c", this.rewrite(command)], {
      cwd: this.map(options.cwd ?? "/"),
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.children.add(child);

    let stdout = "",
      stderr = "";

    const out = new StringDecoder("utf8"),
      err = new StringDecoder("utf8");

    child.stdout.on("data", (data) => {
      const text = out.write(data).split(this.root).join("");
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (data) => {
      const text = err.write(data).split(this.root).join("");
      stderr += text;
      options.onStderr?.(text);
    });
    let lost = (_error: Error) => {};

    // `unconfirmed` models a connection lost while stopping: the command keeps running.
    const kill = () => {
      if (state.unconfirmed) {
        state.unconfirmed = false;
        lost(new RailwayConnectionError({ message: "secret-key-do-not-leak" }));

        return;
      }

      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };

    const done = new Promise<ExecResult>((resolve, reject) => {
      lost = reject;
      child.on("error", reject);
      child.on("close", (code) => {
        this.children.delete(child);
        options.signal?.removeEventListener("abort", kill);

        if (state.interrupt) {
          state.interrupt = false;
          reject(new RailwayConnectionError({ message: "secret-key-do-not-leak" }));
        } else if (options.signal?.aborted) reject(options.signal.reason);
        else resolve({ exitCode: code, timedOut: false, stdout, stderr, truncated: false });
      });
    });

    void done.catch(() => {});
    options.signal?.addEventListener("abort", kill, { once: true });

    if (options.signal?.aborted) kill();
    child.stdin.on("error", () => {});

    if (!options.stdin) child.stdin.end();

    return Object.assign(done, {
      stdin: {
        write: (data: string | Uint8Array) =>
          new Promise<void>((resolve, reject) => {
            child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
          }),
        end: async () => {
          child.stdin.end();
        },
      },
    });
  }
  async checkpoint(name: string) {
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-railway-checkpoint-"));
    await fs.cp(this.root, root, { recursive: true });
    state.snapshots.set(name, root);

    return {
      id: crypto.randomUUID(),
      key: name,
      createdAt: new Date().toISOString(),
      environmentId: "mock-env",
    };
  }
  async destroy() {
    // Native VM destruction ends detached process groups as well as execs.
    const procs = this.map("/tmp/.sandbox-sdk/procs");

    for (const name of await fs.readdir(procs).catch(() => [])) {
      const pid = Number(await fs.readFile(join(procs, name, "pid"), "utf8").catch(() => ""));

      if (pid > 1) this.groups.add(pid);
    }

    for (const pid of this.groups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }

    for (const child of this.children)
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }

    // Real Railway keeps a destroyed VM: connect still returns it, with status DESTROYED.
    this.status = "DESTROYED";
    await fs.rm(this.root, { recursive: true, force: true });
  }
}

/** Guest files under the sandbox root, read as text or bytes as Railway's SandboxFiles does. */
class MockFiles {
  constructor(private readonly box: MockSandbox) {}
  private async entry(path: string): Promise<SandboxFileEntry> {
    try {
      const s = await fs.stat(this.box.map(path));

      return {
        name: posix.basename(path),
        isDir: s.isDirectory(),
        size: s.size,
        mode: s.mode,
        modTime: s.mtime.toISOString(),
      };
    } catch {
      throw new SandboxFileNotFoundError({
        operation: "stat",
        path,
        message: "secret-key-do-not-leak",
      });
    }
  }
  read(
    path: string,
    options: { format: "bytes"; offset?: number; length?: number },
  ): Promise<Uint8Array>;
  read(path: string): Promise<string>;
  async read(
    path: string,
    options: { format?: "bytes"; offset?: number; length?: number } = {},
  ): Promise<string | Uint8Array> {
    // A VM that is not RUNNING serves no guest files.
    if (this.box.status !== "RUNNING")
      throw new RailwayConnectionError({ message: "secret-key-do-not-leak" });
    let data: Buffer;

    try {
      data = await fs.readFile(this.box.map(path));
    } catch {
      throw new SandboxFileNotFoundError({
        operation: "read",
        path,
        message: "secret-key-do-not-leak",
      });
    }

    const offset = options.offset ?? 0;
    data = data.subarray(
      offset,
      options.length === undefined ? undefined : offset + options.length,
    );

    if (path.endsWith("/pid")) {
      const pid = Number(data.toString());

      if (pid > 1) this.box.groups.add(pid);
    }

    return options.format === "bytes" ? new Uint8Array(data) : data.toString();
  }
  async write(path: string, data: string | Uint8Array, options?: { mode?: number }) {
    state.writes.push({ path, options });
    await fs.mkdir(posix.dirname(this.box.map(path)), { recursive: true });
    await fs.writeFile(this.box.map(path), data);

    if (options?.mode !== undefined) await fs.chmod(this.box.map(path), options.mode);
  }
  async mkdir(path: string) {
    await fs.mkdir(this.box.map(path), { recursive: true });
  }
  async list(path: string) {
    return Promise.all(
      (await fs.readdir(this.box.map(path))).map((name) => this.entry(posix.join(path, name))),
    );
  }
  stat(path: string) {
    return this.entry(path);
  }
  async remove(path: string) {
    const stat = await fs.lstat(this.box.map(path));

    if (stat.isDirectory()) await fs.rmdir(this.box.map(path));
    else await fs.unlink(this.box.map(path));
  }
}

export function mockFetch(original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = String(input);

    if (url === "https://backboard.railway.com/graphql/v2") {
      const request: unknown = JSON.parse(String(init?.body));

      const cursor = hasCursor(request) ? request.variables.after : null;

      state.cursors.push(cursor);

      const offset = Number(cursor ?? 0),
        all = [...state.boxes.keys()],
        page = all.slice(offset, offset + state.pageSize);

      return Response.json({
        data: {
          sandboxes: {
            edges: page.map((id) => ({ node: { id } })),
            pageInfo: {
              hasNextPage: offset + page.length < all.length,
              endCursor: String(offset + page.length),
            },
          },
        },
      });
    }

    const match = /^https:\/\/mock-(\d+)\.railway\.test(.*)$/.exec(url);

    return original(match ? `http://127.0.0.1:${match[1]}${match[2]}` : input, init);
  };
}

export async function cleanup() {
  await Promise.all([...state.boxes.values()].map((box) => box.destroy()));
  await Promise.all(
    [...state.snapshots.values()].map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  state.snapshots.clear();
}

/** The Railway adapter with this fixture in place of the SDK's Sandbox. */
export function railway(options: RailwayOptions = {}) {
  return createRailwayProvider(options, async () => ({ ...railwaySdk, Sandbox: MockSandbox }));
}
