/** Faithful slice of the Modal SDK backed by real local Linux commands, not a shell parser.
 * Unique running names, tag filters, filesystem errors by class name, filesystem snapshots and
 * tunnels are modeled here. No Modal requests or credentials are used.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createServer, type AddressInfo } from "node:net";
import type {
  ImageDockerfileCommandsParams,
  SandboxCreateParams,
  SandboxListParams,
  SandboxSnapshotFilesystemParams,
} from "modal";
import type {
  ModalClientSlice,
  NativeApp,
  NativeFilesystem,
  NativeImage,
  NativeProcess,
  NativeSandbox,
} from "../src/providers/modal/transport.js";

/** A Modal error, identified by its class name the way the SDK sets it. */
export function modalFailure(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}

/** nice-grpc's ClientError: a numeric status code. */
export function grpcFailure(code: number, message = `gRPC ${code}`) {
  return Object.assign(new Error(message), { name: "ClientError", code });
}

function isAddressInfo(address: AddressInfo | string | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!isAddressInfo(address)) throw new Error("No port");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  return address.port;
}

const fsErrors = new Map([
  ["ENOENT", "SandboxFilesystemNotFoundError"],
  ["ENOTDIR", "SandboxFilesystemNotADirectoryError"],
  ["EISDIR", "SandboxFilesystemIsADirectoryError"],
  ["ENOTEMPTY", "SandboxFilesystemDirectoryNotEmptyError"],
  ["EEXIST", "SandboxFilesystemPathAlreadyExistsError"],
  ["EACCES", "SandboxFilesystemPermissionError"],
]);

async function translated<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    throw modalFailure(fsErrors.get(code) ?? "SandboxFilesystemError", `${code} (mock)`);
  }
}

export async function modalMock() {
  const root = await fs.mkdtemp(join(process.cwd(), ".modal-mock-"));
  const sandboxes = new Map<string, MockSandbox>();
  const images = new Map<string, MockImage>();
  const creates: SandboxCreateParams[] = [];
  const execs: string[][] = [];
  const snapshotCalls: (SandboxSnapshotFilesystemParams | undefined)[] = [];
  const deletedImages: string[] = [];
  const lists: SandboxListParams[] = [];
  const apps: string[] = [];
  const existingApps = new Set<string>();
  let loads = 0;

  class MockImage implements NativeImage {
    imageId: string;
    constructor(
      readonly tag: string,
      readonly commands: string[] = [],
      readonly env: Record<string, string> = {},
      readonly source?: string,
      imageId = "",
    ) {
      this.imageId = imageId;
    }
    dockerfileCommands(commands: string[], params?: ImageDockerfileCommandsParams): MockImage {
      return new MockImage(this.tag, [...this.commands, ...commands], {
        ...this.env,
        ...params?.env,
      });
    }
    async build(_app: NativeApp): Promise<MockImage> {
      if (!this.imageId) this.imageId = `im-${crypto.randomUUID()}`;
      images.set(this.imageId, this);

      return this;
    }
  }

  class MockSandbox implements NativeSandbox {
    readonly sandboxId = `sb-${crypto.randomUUID().replaceAll("-", "")}`;
    exit: number | null = null;
    appId = "";
    tags: Record<string, string>;
    detached = false;
    readonly children = new Set<ChildProcess>();
    readonly ports = new Map<number, number>();
    /** Fault injection: setTags, terminate or stdin calls reject with this error. */
    tagFailure?: Error;
    /** With `tagFailure`, how many setTags calls fail before writes go through again. */
    tagFailureCount?: number;
    terminateFailure?: Error;
    /** Fault injection: these calls never settle, as a stalled gRPC request would not. */
    stall: Partial<Record<"setTags" | "poll" | "terminate", boolean>> = {};
    stdinFailure?: { on: "write" | "close"; error: Error; afterExit?: boolean };
    terminateCalls = 0;
    constructor(
      readonly directory: string,
      readonly params: SandboxCreateParams,
    ) {
      this.tags = { ...params.tags };
    }
    map(path: string) {
      return join(this.directory, path);
    }
    rewrite(value: string) {
      let result = value.replace(/\/workspace|\/tmp(?=\/|$|\s|')/g, (path) => this.map(path));

      for (const [port, local] of this.ports)
        result = result.replaceAll(`.listen(${port},`, `.listen(${local},`);

      return result;
    }
    alive() {
      if (this.exit !== null)
        throw grpcFailure(
          5,
          "Modal Sandbox with container ID ta-mock not found. This means this Sandbox has already shut down.",
        );
    }
    readonly filesystem: NativeFilesystem = {
      readBytes: async (path) => {
        this.alive();

        return translated(async () => new Uint8Array(await fs.readFile(this.map(path))));
      },
      writeBytes: async (data, path) => {
        this.alive();
        await translated(async () => {
          await fs.mkdir(join(this.map(path), ".."), { recursive: true });
          await fs.writeFile(this.map(path), new Uint8Array(data));
        });
      },
      listFiles: async (path) => {
        this.alive();

        return translated(async () => {
          const names = (await fs.readdir(this.map(path))).sort();

          return Promise.all(names.map((name) => this.filesystem.stat(join(path, name))));
        });
      },
      stat: async (path) => {
        this.alive();

        return translated(async () => {
          const stat = await fs.lstat(this.map(path));

          return {
            name: path.split("/").at(-1) ?? "",
            path,
            type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
            size: stat.size,
            mode: stat.mode,
            permissions: (stat.mode & 0o777).toString(8),
            owner: "root",
            group: "root",
            modifiedTime: Math.floor(stat.mtimeMs / 1000),
            symlinkTarget: null,
          };
        });
      },
      remove: async (path, options) => {
        this.alive();
        await translated(async () => {
          const target = this.map(path);

          if ((await fs.lstat(target)).isDirectory() && !options?.recursive) await fs.rmdir(target);
          else await fs.rm(target, { recursive: options?.recursive ?? false });
        });
      },
      makeDirectory: async (path, options) => {
        this.alive();
        await translated(async () => {
          await fs.mkdir(this.map(path), { recursive: options?.createParents ?? true });
        });
      },
    };
    async exec(
      command: string[],
      params?: { env?: Record<string, string> },
    ): Promise<NativeProcess> {
      this.alive();
      execs.push(command);
      const environment = { ...process.env, ...this.params.env, ...params?.env };

      if (environment.GIT_INDEX_FILE)
        environment.GIT_INDEX_FILE = this.rewrite(environment.GIT_INDEX_FILE);

      const [program = "true", ...args] = command;

      const child = spawn(
        program,
        args.map((arg) => this.rewrite(arg)),
        { cwd: this.map(this.params.workdir ?? "/"), env: environment, stdio: "pipe" },
      );

      this.children.add(child);
      const strip = (text: string) => text.split(this.directory).join("");

      const stream = (source: NodeJS.ReadableStream) =>
        new ReadableStream<string>({
          start(controller) {
            const decoder = new StringDecoder("utf8");
            source.on("data", (data: Buffer) => controller.enqueue(strip(decoder.write(data))));
            source.on("end", () => {
              const rest = decoder.end();

              if (rest) controller.enqueue(strip(rest));
              controller.close();
            });
          },
        });

      const stdout = stream(child.stdout);
      const stderr = stream(child.stderr);
      child.stdin.on("error", () => {});

      const exit = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code, signal) => {
          this.children.delete(child);
          resolve(code ?? (signal === "SIGKILL" ? 137 : 143));
        });
      });

      // A failure models Modal's command router: either a transport error or a refused write to a finished command.
      const fail = async (on: "write" | "close") => {
        const failure = this.stdinFailure;

        if (failure?.on !== on) return;

        if (failure.afterExit) await exit;
        throw failure.error;
      };

      return {
        stdin: {
          writeText: async (text) => {
            await fail("write");
            child.stdin.write(this.rewrite(text));
          },
          close: async () => {
            await fail("close");
            child.stdin.end();
          },
        },
        stdout,
        stderr,
        wait: () => exit,
      };
    }
    async getTags() {
      return { ...this.tags };
    }
    async setTags(tags: Record<string, string>) {
      if (this.stall.setTags) return new Promise<void>(() => {});

      if (this.tagFailure) {
        const failure = this.tagFailure;

        if (this.tagFailureCount !== undefined && --this.tagFailureCount <= 0) {
          this.tagFailure = undefined;
          this.tagFailureCount = undefined;
        }

        throw failure;
      }

      this.alive();
      this.tags = { ...tags };
    }
    async poll() {
      if (this.stall.poll) return new Promise<number | null>(() => {});

      return this.exit;
    }
    /** Modal sometimes reports a terminated sandbox running for ~30 s; tests set this to model it. */
    stopDelayMs = 0;
    stopping?: Promise<void>;
    async terminate() {
      this.terminateCalls++;

      if (this.stall.terminate) return new Promise<void>(() => {});

      if (this.terminateFailure) throw this.terminateFailure;
      this.stopping ??= (async () => {
        await new Promise((resolve) => setTimeout(resolve, this.stopDelayMs));
        await this.killAll();
        this.exit = 137;
        await fs.rm(this.directory, { recursive: true, force: true });
      })();

      if (!this.stopDelayMs) await this.stopping;
    }
    async killAll() {
      const procs = this.map("/tmp/.sandbox-sdk/procs");

      for (const name of await fs.readdir(procs).catch(() => [])) {
        const pid = Number(await fs.readFile(join(procs, name, "pid"), "utf8").catch(() => ""));

        if (Number.isInteger(pid) && pid > 0)
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
      }

      for (const child of this.children)
        if (child.pid)
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              process.kill(child.pid, "SIGKILL");
            } catch {}
          }
    }
    detach() {
      this.detached = true;
    }
    async tunnels() {
      this.alive();

      return Object.fromEntries(
        [...this.ports].map(([port, local]) => [
          port,
          { url: `http://127.0.0.1:${local}/?port=${port}` },
        ]),
      );
    }
    async snapshotFilesystem(params?: SandboxSnapshotFilesystemParams) {
      this.alive();
      snapshotCalls.push(params);

      const image = new MockImage(
        "snapshot",
        [],
        {},
        join(root, `snapshot-${crypto.randomUUID()}`),
      );

      await fs.cp(this.directory, image.source ?? "", {
        recursive: true,
        filter: async (path) => !(await fs.lstat(path)).isFIFO(),
      });
      await image.build({ appId: "ap-mock" });
      images.set(image.imageId, image);

      return image;
    }
  }

  const client: ModalClientSlice<MockSandbox> = {
    apps: {
      async fromName(name, params) {
        apps.push(name);

        // Like Modal, a lookup without createIfMissing fails for an App that was never created.
        if (!params?.createIfMissing && !existingApps.has(name))
          throw modalFailure("NotFoundError", `App '${name}' not found in environment 'main'`);
        existingApps.add(name);

        return { appId: `ap-${name}` };
      },
    },
    images: {
      fromRegistry: (tag) => new MockImage(tag),
      async fromId(imageId) {
        const image = images.get(imageId);

        if (!image) throw modalFailure("NotFoundError", `Could not find image with ID ${imageId}`);

        return image;
      },
      async delete(imageId) {
        deletedImages.push(imageId);
        images.delete(imageId);
      },
    },
    sandboxes: {
      async create(app, image, params = {}) {
        for (const box of sandboxes.values())
          if (
            params.name &&
            box.exit === null &&
            box.appId === app.appId &&
            box.params.name === params.name
          )
            throw modalFailure(
              "AlreadyExistsError",
              `sandbox name "${params.name}" is already in use`,
            );

        if (Object.keys(params.tags ?? {}).length > 10)
          throw modalFailure("InvalidError", "sandboxes have a limit of 10 tags");
        creates.push(params);
        const directory = join(root, crypto.randomUUID());
        const box = new MockSandbox(directory, params);
        box.appId = app.appId;
        sandboxes.set(box.sandboxId, box);
        const built = await image.build({ appId: "ap-mock" });
        const known = images.get(built.imageId);

        if (known?.source) await fs.cp(known.source, directory, { recursive: true });
        else {
          await fs.mkdir(join(directory, "tmp"), { recursive: true });

          if (built instanceof MockImage) {
            images.set(built.imageId, built);

            // Template layers run in the new file system, with the build-only env.
            for (const step of built.commands) {
              const run = /^RUN (.*)$/.exec(step);

              if (!run?.[1]) continue;
              const [, , script = ""] = JSON.parse(run[1]);

              await new Promise<void>((resolve, reject) =>
                spawn("sh", ["-c", box.rewrite(script)], {
                  cwd: directory,
                  env: { ...process.env, ...built.env },
                  stdio: "ignore",
                }).on("close", (code) => (code === 0 ? resolve() : reject(new Error("build")))),
              );
            }
          }
        }

        // Modal creates the working directory.
        if (params.workdir) await fs.mkdir(box.map(params.workdir), { recursive: true });

        for (const port of params.encryptedPorts ?? []) box.ports.set(port, await freePort());

        return box;
      },
      async fromId(sandboxId) {
        const box = sandboxes.get(sandboxId);

        if (box) return box;

        // Like Modal, fromId makes no request; the first call on it fails.
        const ghost = new MockSandbox(join(root, "missing"), {});
        Object.defineProperty(ghost, "sandboxId", { value: sandboxId });

        const missing = () => {
          throw modalFailure("InvalidError", `"${sandboxId}" is not a valid sandbox ID`);
        };

        ghost.poll = async () => missing();
        ghost.getTags = async () => missing();
        ghost.terminate = async () => missing();

        return ghost;
      },
      async fromName(appName, name) {
        for (const box of sandboxes.values())
          if (box.exit === null && box.appId === `ap-${appName}` && box.params.name === name)
            return box;

        throw modalFailure("NotFoundError", `Sandbox with name '${name}' not found`);
      },
      list: (params = {}) =>
        (async function* () {
          lists.push(params);

          for (const box of sandboxes.values())
            if (
              box.exit === null &&
              (params.appId === undefined || box.appId === params.appId) &&
              Object.entries(params.tags ?? {}).every(([k, v]) => box.tags[k] === v)
            )
              yield box;
        })(),
    },
    close() {},
  };

  return {
    client,
    load: async () => {
      loads++;

      return client;
    },
    get loads() {
      return loads;
    },
    sandboxes,
    images,
    creates,
    execs,
    snapshotCalls,
    deletedImages,
    lists,
    apps,
    async dispose() {
      for (const box of sandboxes.values()) {
        box.stopDelayMs = 0;
        box.terminateFailure = undefined;
        box.stall = {};
        await box.terminate();
        await box.stopping;
      }

      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
