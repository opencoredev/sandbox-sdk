/** Faithful SDK slice backed by real local Linux commands, not a shell parser.
 * Persistent named machines, detached logs, native EOF, and session restores are
 * modeled here. No Vercel requests or credentials are used.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { createServer } from "node:net";
import type { Sandbox } from "@vercel/sandbox";
import type {
  NativeSandbox,
  NativeCommand,
  VercelClient,
} from "../src/providers/vercel/transport.js";

type Params = NonNullable<Parameters<typeof Sandbox.create>[0]>;

type RunParams = Parameters<NativeSandbox["runCommand"]>[0];

const missing = () =>
  Object.assign(new Error("Sandbox not found"), { response: new Response(null, { status: 404 }) });

const gone = () =>
  Object.assign(
    new Error("Status code 400 is not ok: Cannot resume sandbox: no snapshot available."),
    {
      response: new Response(null, { status: 400 }),
      json: {
        error: {
          code: "snapshot_not_found",
          message: "Cannot resume sandbox: no snapshot available.",
        },
      },
    },
  );

export async function vercelMock() {
  const root = await fs.mkdtemp(join(process.cwd(), ".vercel-mock-"));
  const machines = new Map<string, MockSandbox>();
  const snapshots = new Map<string, string>();
  const creates: Params[] = [];
  const commands: RunParams[] = [];
  const snapshotCalls: ({ expiration?: number } | undefined)[] = [];
  const deletes: Parameters<Sandbox["delete"]>[0][] = [];
  const uploads: Parameters<Sandbox["writeFiles"]>[0] = [];

  class MockSandbox implements NativeSandbox {
    readonly cwd = "/vercel/sandbox";
    status: Sandbox["status"] = "running";
    readonly createdAt = new Date();
    readonly persistent: boolean;
    tags: Sandbox["tags"];
    readonly routes: Sandbox["routes"] = [];
    readonly children = new Set<ReturnType<typeof spawn>>();
    readonly groups = new Set<number>();
    resumeHook?: (box: MockSandbox) => Promise<void>;
    private readonly serverPorts = new Map<number, number>();
    constructor(
      readonly name: string,
      readonly directory: string,
      readonly params: Params,
    ) {
      this.tags = params.tags;
      this.persistent = params.persistent ?? true;
    }
    async initialize() {
      await fs.mkdir(this.map("/vercel/sandbox"), { recursive: true });
      await fs.mkdir(this.map("/tmp"), { recursive: true });

      for (const port of this.params.ports ?? []) {
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();

        if (!address || typeof address === "string") throw new Error("No port");
        this.serverPorts.set(port, address.port);
        await new Promise<void>((resolve) => server.close(() => resolve()));
        this.routes.push({ port, subdomain: `mock-${port}`, url: this.domain(port) });
      }
    }
    map(path: string) {
      return join(this.directory, path);
    }
    rewrite(value: string) {
      let result = value
        .replace(/\/workspace|\/vercel\/sandbox|\/tmp(?=\/|$)/g, (path) => this.map(path))
        .replace(/sudo (mkdir|chmod) /g, "$1 ");

      for (const [port, local] of this.serverPorts)
        result = result.replaceAll(`.listen(${port},`, `.listen(${local},`);

      return result;
    }
    // Just like the SDK, auto-resume awaits the adapter's actual callback.
    async restore() {
      if (this.status === "running") return;

      // Vercel cannot resume a non-persistent sandbox: it kept no file system.
      if (!this.persistent) throw gone();
      this.status = "running";
      await this.resumeHook?.(this);
    }
    fs: NativeSandbox["fs"] = {
      readFile: async (path) => {
        await this.restore();
        const data = await fs.readFile(this.map(path));

        if (/sandbox-sdk-.*\.pid$/.test(path)) this.groups.add(Number(data.toString()));

        return data;
      },
      writeFile: async (path, data, options) => {
        await this.restore();
        await fs.writeFile(this.map(path), data, options);
      },
      lstat: async (path) => {
        await this.restore();

        return fs.lstat(this.map(path));
      },
      readdir: async (path) => {
        await this.restore();

        return fs.readdir(this.map(path));
      },
      mkdir: async (path, options) => {
        await this.restore();

        return fs.mkdir(this.map(path), options);
      },
      rm: async (path, options) => {
        await this.restore();

        return fs.rm(this.map(path), options);
      },
      chmod: async (path, mode) => {
        await this.restore();
        await fs.chmod(this.map(path), mode);
      },
    };
    domain(port: number) {
      const local = this.serverPorts.get(port);

      if (!local) throw new Error("Undeclared port");

      return `http://127.0.0.1:${local}/?port=${port}`;
    }
    // Like Vercel's tar upload: parents are created and only permission bits survive.
    async writeFiles(files: Parameters<Sandbox["writeFiles"]>[0]) {
      await this.restore();

      for (const file of files) {
        uploads.push(file);
        const target = this.map(file.path);
        await fs.mkdir(join(target, ".."), { recursive: true });
        await fs.writeFile(target, file.content);

        if (file.mode !== undefined) await fs.chmod(target, file.mode & 0o777);
      }
    }
    async update(params: Parameters<Sandbox["update"]>[0]) {
      if (params.tags) this.tags = params.tags;
    }
    async stop() {
      await this.terminate();
      this.status = "stopped";

      return {
        id: this.name,
        status: "stopped",
        createdAt: Date.now(),
        timeout: 300000,
        memory: 2048,
        vcpus: 1,
        region: "iad1",
        cwd: this.cwd,
        runtime: "node22",
      };
    }
    async terminate() {
      const procs = this.map("/tmp/.sandbox-sdk/procs");

      for (const name of await fs.readdir(procs).catch(() => [])) {
        const pid = Number(await fs.readFile(join(procs, name, "pid"), "utf8").catch(() => ""));

        if (Number.isInteger(pid) && pid > 0) this.groups.add(pid);
      }

      for (const group of this.groups) {
        try {
          process.kill(-group, "SIGKILL");
        } catch {}
      }

      this.groups.clear();

      for (const child of this.children)
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
    }
    async delete(options?: Parameters<Sandbox["delete"]>[0]) {
      deletes.push(options);
      await this.terminate();
      machines.delete(this.name);
      await fs.rm(this.directory, { recursive: true, force: true });
    }
    async snapshot(options?: { expiration?: number }) {
      snapshotCalls.push(options);
      await this.terminate();
      this.status = "stopped";
      const snapshotId = crypto.randomUUID();
      const directory = join(root, snapshotId);
      await fs.cp(this.directory, directory, {
        recursive: true,
        filter: async (path) => !(await fs.lstat(path)).isFIFO(),
      });
      snapshots.set(snapshotId, directory);

      return { snapshotId };
    }
    async runCommand(params: RunParams): Promise<NativeCommand> {
      await this.restore();
      commands.push(params);
      const environment = { ...process.env, ...this.params.env, ...params.env };

      if (environment.GIT_INDEX_FILE)
        environment.GIT_INDEX_FILE = this.rewrite(environment.GIT_INDEX_FILE);

      const child = spawn(
        params.cmd,
        (params.args ?? []).map((arg) => this.rewrite(arg)),
        {
          cwd: this.map(params.cwd ?? this.cwd),
          env: environment,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      this.children.add(child);
      const events: { stream: "stdout" | "stderr"; data: string }[] = [];
      let wake: (() => void) | undefined;
      let done = false;

      for (const stream of ["stdout", "stderr"] as const) {
        const decoder = new StringDecoder("utf8");
        child[stream].on("data", (data: Buffer) => {
          events.push({ stream, data: decoder.write(data).split(this.directory).join("") });
          wake?.();
        });
        child[stream].on("end", () => {
          const data = decoder.end();

          if (data) events.push({ stream, data });
          wake?.();
        });
      }

      child.stdin.on("error", () => {});

      if (params.stdin instanceof Readable) params.stdin.pipe(child.stdin);
      else if (!params.stdin) child.stdin.end();

      const result = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
          done = true;
          this.children.delete(child);
          wake?.();
          resolve(code ?? (signal === "SIGTERM" ? 143 : 137));
        });
      });

      // wait() returns only the SDK fields consumed by this provider. The slice
      // below narrows it instead of fabricating a full CommandFinished instance.
      const logs = async function* () {
        let index = 0;

        while (!done || index < events.length) {
          const event = events[index++];

          if (event) yield event;
          else {
            index--;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        }
      };

      return {
        cmdId: crypto.randomUUID(),
        logs: () => Object.assign(logs(), { close() {}, [Symbol.dispose]() {} }),
        wait: async () => {
          const exitCode = await result;

          return { exitCode };
        },
        kill: async (signal) => {
          if (child.pid && !done) {
            try {
              process.kill(child.pid, signal ?? "SIGTERM");
            } catch {}
          }
        },
      };
    }
  }

  const client: VercelClient<MockSandbox> = {
    async create(params) {
      const name = params.name ?? crypto.randomUUID();

      if (machines.has(name))
        throw Object.assign(new Error("Conflict"), {
          response: new Response(null, { status: 409 }),
        });
      creates.push(params);
      const directory = join(root, name);
      const box = new MockSandbox(name, directory, params);
      machines.set(name, box);
      box.resumeHook = params.onResume;

      if (params.source?.type === "snapshot") {
        const source = snapshots.get(params.source.snapshotId);

        if (!source) throw missing();
        await fs.cp(source, directory, { recursive: true });
      }

      await box.initialize();

      return box;
    },
    async get(params) {
      const box = machines.get(params.name);

      if (!box) throw missing();
      box.resumeHook = params.onResume;

      if (params.resume) await box.restore();

      return box;
    },
    async list() {
      return (async function* () {
        for (const box of machines.values())
          if (box.tags?.["sandbox-sdk"] === "1") yield { name: box.name };
      })();
    },
  };

  return {
    client,
    creates,
    commands,
    snapshotCalls,
    deletes,
    uploads,
    async dispose() {
      for (const box of machines.values()) await box.delete();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
