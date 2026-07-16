import {
  DirectoryNotEmptyError,
  DirectoryNotFoundError,
  FileExistsError,
  FileNotFoundError,
  IsDirectoryError,
  MastraFilesystem,
  MastraSandbox,
  NotDirectoryError,
  PermissionError,
  ProcessHandle,
  SandboxNotReadyError,
  SandboxProcessManager,
  StaleFileError,
  Workspace,
  WorkspaceReadOnlyError,
} from "@mastra/core/workspace";
import type {
  CommandResult,
  CopyOptions,
  FileContent,
  FileEntry,
  FilesystemInfo,
  InstructionsOption,
  ListOptions,
  MastraFilesystemOptions,
  MastraSandboxOptions,
  ProcessInfo,
  ProviderStatus,
  ReadOptions,
  RemoveOptions,
  SandboxInfo,
  SpawnProcessOptions,
  WorkspaceConfig,
  WriteOptions,
} from "@mastra/core/workspace";
import type { RequestContext } from "@mastra/core/di";
import { isSandboxError, SandboxError } from "../core/errors";
import type {
  ManagedSandboxProvider,
  ManagedSandboxSession,
  SandboxProvider,
} from "../core/provider";
import type { Sandbox, SandboxDirectoryEntry, SandboxProcess } from "../core/types";

type WorkspaceOptions = Omit<
  WorkspaceConfig<SandboxSDKMastraFilesystem, SandboxSDKMastraSandbox>,
  "filesystem" | "sandbox" | "mounts"
>;

export interface CreateMastraSandboxOptions extends Omit<MastraSandboxOptions, "processes"> {
  provider: SandboxProvider<unknown>;
  id?: string;
  identity?: string;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  ports?: ReadonlyArray<number>;
  instructions?: InstructionsOption;
  onFirstCreate?: (sandbox: Sandbox) => void | Promise<void>;
}

export interface CreateMastraWorkspaceOptions extends CreateMastraSandboxOptions {
  filesystem?: Omit<CreateMastraFilesystemOptions, "sandbox">;
  workspace?: WorkspaceOptions;
}

export interface CreateMastraFilesystemOptions extends MastraFilesystemOptions {
  sandbox: SandboxSDKMastraSandbox;
  readOnly?: boolean;
  instructions?: InstructionsOption;
}

/** Create a Mastra sandbox backed by any managed Sandbox SDK provider. */
export function createMastraSandbox(options: CreateMastraSandboxOptions): SandboxSDKMastraSandbox {
  return new SandboxSDKMastraSandbox(options);
}

/**
 * Create a Mastra workspace whose filesystem and commands share one Sandbox SDK
 * session. The workspace owns and destroys the session.
 */
export function createMastraWorkspace(
  options: CreateMastraWorkspaceOptions,
): Workspace<SandboxSDKMastraFilesystem, SandboxSDKMastraSandbox> {
  const sandbox = createMastraSandbox(options);
  const filesystem = new SandboxSDKMastraFilesystem({ ...options.filesystem, sandbox });
  return new Workspace({ ...options.workspace, filesystem, sandbox });
}

/** Mastra WorkspaceSandbox implementation for Sandbox SDK providers. */
export class SandboxSDKMastraSandbox extends MastraSandbox {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly cwd: string;
  readonly processes: SandboxSDKProcessManager;
  status: ProviderStatus = "pending";

  private readonly managed: ManagedSandboxProvider;
  private readonly identity?: string;
  private readonly env: Readonly<Record<string, string>>;
  private readonly ports: ReadonlyArray<number>;
  private readonly instructions?: InstructionsOption;
  private readonly onFirstCreate?: (sandbox: Sandbox) => void | Promise<void>;
  private readonly createdAt = new Date();
  private session?: ManagedSandboxSession;

  constructor(options: CreateMastraSandboxOptions) {
    const processes = new SandboxSDKProcessManager({ env: options.env });
    super({ ...options, name: "Sandbox SDK", processes });
    this.managed = requireManaged(options.provider);
    this.id = options.id ?? `mastra-${options.provider.id}-${crypto.randomUUID()}`;
    this.name = `Sandbox SDK (${options.provider.id})`;
    this.provider = options.provider.id;
    this.cwd = normalizeCwd(options.cwd ?? "/workspace");
    this.env = options.env ?? {};
    this.ports = options.ports ?? [];
    this.identity = options.identity;
    this.instructions = options.instructions;
    this.onFirstCreate = options.onFirstCreate;
    this.processes = processes;
  }

  /** The live normalized Sandbox SDK session. */
  get sandboxSdk(): Sandbox {
    if (!this.session) throw new SandboxNotReadyError(this.id);
    return this.session.sandbox;
  }

  async start(): Promise<void> {
    if (this.session) {
      await this.session.resume();
      return;
    }
    this.session = await this.managed.create({
      sessionId: this.id,
      identity: this.identity,
      cwd: this.cwd,
      env: this.env,
      ports: this.ports,
      onFirstCreate: this.onFirstCreate,
    });
  }

  async stop(): Promise<void> {
    if (!this.session) return;
    await this.killTrackedProcesses();
    await this.session.stop();
  }

  async destroy(): Promise<void> {
    if (!this.session) return;
    await this.killTrackedProcesses();
    const session = this.session;
    this.session = undefined;
    await session.destroy();
  }

  async getPortUrl(port: number, protocol?: "http" | "https" | "ws"): Promise<string> {
    await this.ensureRunning();
    return this.session!.getPortUrl({ port, protocol });
  }

  getInfo(): SandboxInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      createdAt: this.createdAt,
      metadata: {
        sandboxId: this.session?.sandbox.id,
        sandboxProvider: this.provider,
        cwd: this.cwd,
        capabilities: this.session?.sandbox.capabilities,
      },
    };
  }

  getInstructions(options?: { requestContext?: RequestContext }): string {
    const defaultInstructions =
      `Commands run in an isolated ${this.provider} sandbox. ` +
      `The default working directory is ${this.cwd}.`;
    if (this.instructions === undefined) return defaultInstructions;
    if (typeof this.instructions === "string") return this.instructions;
    return this.instructions({
      defaultInstructions,
      requestContext: options?.requestContext,
    });
  }

  /** @deprecated Use `status === "running"` instead. */
  isReady(): boolean {
    return this.status === "running" && this.session !== undefined;
  }

  private async killTrackedProcesses(): Promise<void> {
    const processes = await this.processes.list().catch(() => []);
    await Promise.all(
      processes
        .filter((process) => process.running)
        .map((process) => this.processes.kill(process.pid).catch(() => false)),
    );
  }
}

/** Mastra background-process bridge for normalized Sandbox SDK processes. */
export class SandboxSDKProcessManager extends SandboxProcessManager<SandboxSDKMastraSandbox> {
  async spawn(command: string, options: SpawnProcessOptions = {}): Promise<ProcessHandle> {
    const env = Object.fromEntries(
      Object.entries({ ...this.env, ...options.env }).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const process = await this.sandbox.sandboxSdk.processes.start(
      parseSimpleCommand(command) ?? command,
      {
        cwd: options.cwd,
        env,
        timeout: options.timeout,
        signal: options.abortSignal,
      },
    );
    const handle = new SandboxSDKProcessHandle(process, options);
    this._tracked.set(handle.pid, handle);
    return handle;
  }

  async list(): Promise<ProcessInfo[]> {
    return Promise.all(
      [...this._tracked.values()].map(async (handle) => {
        const adapter = handle as SandboxSDKProcessHandle;
        return {
          pid: handle.pid,
          command: handle.command,
          running: await adapter.isRunning(),
          ...(handle.exitCode === undefined ? {} : { exitCode: handle.exitCode }),
        };
      }),
    );
  }
}

class SandboxSDKProcessHandle extends ProcessHandle {
  readonly pid: string;
  private readonly process: SandboxProcess;
  private readonly startedAt = performance.now();
  private readonly completed: Promise<CommandResult>;
  private currentExitCode?: number;
  private killed = false;
  private timedOut = false;
  private timeoutId?: ReturnType<typeof setTimeout>;

  constructor(process: SandboxProcess, options: SpawnProcessOptions) {
    super(options);
    this.process = process;
    this.pid = process.id;
    if (options.timeout !== undefined && options.timeout > 0) {
      this.timeoutId = setTimeout(() => {
        this.timedOut = true;
        void this.kill();
      }, options.timeout);
    }
    this.completed = this.collect();
  }

  get exitCode(): number | undefined {
    return this.currentExitCode;
  }

  async wait(): Promise<CommandResult> {
    return this.completed;
  }

  async kill(): Promise<boolean> {
    if (this.currentExitCode !== undefined) return false;
    this.killed = true;
    await this.process.kill();
    return true;
  }

  async sendStdin(data: string): Promise<void> {
    if (this.currentExitCode !== undefined) {
      throw new Error(`Process ${this.pid} has already exited with code ${this.currentExitCode}`);
    }
    await this.process.write(data);
  }

  async isRunning(): Promise<boolean> {
    if (this.currentExitCode !== undefined) return false;
    const status = await this.process.status();
    return status === "starting" || status === "running";
  }

  private async collect(): Promise<CommandResult> {
    const output = this.pumpOutput();
    try {
      const result = await this.process.wait();
      this.currentExitCode = this.timedOut ? 124 : result.exitCode;
      await output;
    } catch (error) {
      await output.catch(() => undefined);
      if (isSandboxError(error) && error.code === "timeout") {
        this.timedOut = true;
      }
      this.currentExitCode = this.timedOut ? 124 : 1;
      this.emitStderr(error instanceof Error ? error.message : String(error));
    } finally {
      if (this.timeoutId) clearTimeout(this.timeoutId);
    }
    return {
      success: this.currentExitCode === 0,
      exitCode: this.currentExitCode,
      stdout: this.stdout,
      stderr: this.stderr,
      executionTimeMs: Math.round(performance.now() - this.startedAt),
      ...(this.killed ? { killed: true } : {}),
      ...(this.timedOut ? { timedOut: true } : {}),
    };
  }

  private async pumpOutput(): Promise<void> {
    const decoders = {
      stdout: new TextDecoder(),
      stderr: new TextDecoder(),
    };
    try {
      for await (const event of this.process.output()) {
        const data =
          typeof event.data === "string"
            ? event.data
            : decoders[event.stream].decode(event.data, { stream: true });
        if (data) {
          if (event.stream === "stdout") this.emitStdout(data);
          else this.emitStderr(data);
        }
      }
    } finally {
      const stdout = decoders.stdout.decode();
      const stderr = decoders.stderr.decode();
      if (stdout) this.emitStdout(stdout);
      if (stderr) this.emitStderr(stderr);
    }
  }
}

/** Mastra WorkspaceFilesystem implementation sharing a Mastra sandbox session. */
export class SandboxSDKMastraFilesystem extends MastraFilesystem {
  readonly id: string;
  readonly name = "Sandbox SDK Filesystem";
  readonly provider = "sandbox-sdk";
  readonly readOnly: boolean;
  readonly basePath: string;
  status: ProviderStatus = "pending";

  private readonly sandbox: SandboxSDKMastraSandbox;
  private readonly instructions?: InstructionsOption;

  constructor(options: CreateMastraFilesystemOptions) {
    super({ ...options, name: "Sandbox SDK Filesystem" });
    this.sandbox = options.sandbox;
    this.id = `${options.sandbox.id}-filesystem`;
    this.basePath = options.sandbox.cwd;
    this.readOnly = options.readOnly ?? false;
    this.instructions = options.instructions;
  }

  async init(): Promise<void> {}

  async destroy(): Promise<void> {}

  getInfo(): FilesystemInfo {
    return {
      id: this.id,
      name: this.name,
      provider: this.provider,
      status: this.status,
      readOnly: this.readOnly,
      metadata: {
        sandboxId: this.sandbox.id,
        sandboxProvider: this.sandbox.provider,
        basePath: this.basePath,
      },
    };
  }

  getInstructions(options?: { requestContext?: RequestContext }): string {
    const defaultInstructions =
      `Files are stored in the same ${this.sandbox.provider} sandbox used for commands. ` +
      `Filesystem path / maps to ${this.basePath} inside the sandbox.`;
    if (this.instructions === undefined) return defaultInstructions;
    if (typeof this.instructions === "string") return this.instructions;
    return this.instructions({
      defaultInstructions,
      requestContext: options?.requestContext,
    });
  }

  async realpath(path: string): Promise<string> {
    await this.ready();
    const virtual = toVirtualPath(this.basePath, path);
    const result = await this.sandbox.sandboxSdk.run({
      command: "realpath",
      args: ["-m", toSandboxPath(this.basePath, virtual)],
    });
    if (!result.success) return virtual;
    const resolved = result.stdout.trim();
    if (!isWithin(this.basePath, resolved)) {
      throw new PermissionError(path, "realpath");
    }
    return fromSandboxPath(this.basePath, resolved);
  }

  async readFile(path: string, options?: ReadOptions): Promise<string | Buffer> {
    await this.ready();
    const stat = await this.stat(path);
    if (stat.type === "directory") throw new IsDirectoryError(path);
    try {
      const content = Buffer.from(
        await this.sandbox.sandboxSdk.files.read(toSandboxPath(this.basePath, path)),
      );
      return options?.encoding ? content.toString(options.encoding) : content;
    } catch (error) {
      throw mapFileError(path, "read", error);
    }
  }

  async writeFile(path: string, content: FileContent, options?: WriteOptions): Promise<void> {
    await this.ready();
    this.assertWritable("writeFile");
    const target = toSandboxPath(this.basePath, path);
    const exists = await this.exists(path);
    if (exists && options?.overwrite === false) throw new FileExistsError(path);
    if (exists) {
      const current = await this.stat(path);
      if (current.type === "directory") throw new IsDirectoryError(path);
      if (
        options?.expectedMtime &&
        current.modifiedAt.getTime() !== options.expectedMtime.getTime()
      ) {
        throw new StaleFileError(path, options.expectedMtime, current.modifiedAt);
      }
    }
    await this.ensureParent(path, options?.recursive !== false);
    try {
      await this.sandbox.sandboxSdk.files.write(target, toBytes(content));
    } catch (error) {
      throw mapFileError(path, "write", error);
    }
  }

  async appendFile(path: string, content: FileContent): Promise<void> {
    await this.ready();
    this.assertWritable("appendFile");
    const current = (await this.exists(path))
      ? Buffer.from(await this.readFile(path))
      : Buffer.alloc(0);
    const added = Buffer.from(toBytes(content));
    const combined = new Uint8Array(current.byteLength + added.byteLength);
    combined.set(current);
    combined.set(added, current.byteLength);
    await this.writeFile(path, combined);
  }

  async deleteFile(path: string, options?: RemoveOptions): Promise<void> {
    await this.ready();
    this.assertWritable("deleteFile");
    if (!(await this.exists(path))) {
      if (options?.force) return;
      throw new FileNotFoundError(path);
    }
    if ((await this.stat(path)).type === "directory") {
      throw new IsDirectoryError(path);
    }
    try {
      await this.sandbox.sandboxSdk.files.remove(toSandboxPath(this.basePath, path));
    } catch (error) {
      throw mapFileError(path, "delete", error);
    }
  }

  async copyFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    await this.ready();
    this.assertWritable("copyFile");
    if (!(await this.exists(src))) throw new FileNotFoundError(src);
    if ((await this.exists(dest)) && options?.overwrite === false) {
      throw new FileExistsError(dest);
    }
    const source = await this.stat(src);
    if (source.type === "directory") {
      if (!options?.recursive) throw new IsDirectoryError(src);
      await this.mkdir(dest, { recursive: true });
      for (const entry of await this.readdir(src)) {
        await this.copyFile(joinVirtual(src, entry.name), joinVirtual(dest, entry.name), options);
      }
      return;
    }
    await this.writeFile(dest, await this.readFile(src), {
      recursive: true,
      overwrite: options?.overwrite,
    });
  }

  async moveFile(src: string, dest: string, options?: CopyOptions): Promise<void> {
    this.assertWritable("moveFile");
    const source = await this.stat(src);
    await this.copyFile(src, dest, {
      ...options,
      recursive: source.type === "directory" ? true : options?.recursive,
    });
    if (source.type === "directory") {
      await this.rmdir(src, { recursive: true });
    } else {
      await this.deleteFile(src);
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.ready();
    this.assertWritable("mkdir");
    if (await this.exists(path)) {
      if ((await this.stat(path)).type !== "directory") {
        throw new FileExistsError(path);
      }
      return;
    }
    if (options?.recursive === false) await this.requireParent(path);
    try {
      await this.sandbox.sandboxSdk.files.mkdir(toSandboxPath(this.basePath, path));
    } catch (error) {
      throw mapFileError(path, "mkdir", error);
    }
  }

  async rmdir(path: string, options?: RemoveOptions): Promise<void> {
    await this.ready();
    this.assertWritable("rmdir");
    if (!(await this.exists(path))) {
      if (options?.force) return;
      throw new DirectoryNotFoundError(path);
    }
    if ((await this.stat(path)).type !== "directory") {
      throw new NotDirectoryError(path);
    }
    if (!options?.recursive && (await this.readdir(path)).length > 0) {
      throw new DirectoryNotEmptyError(path);
    }
    try {
      await this.sandbox.sandboxSdk.files.remove(toSandboxPath(this.basePath, path));
    } catch (error) {
      throw mapFileError(path, "rmdir", error);
    }
  }

  async readdir(path: string, options?: ListOptions): Promise<FileEntry[]> {
    await this.ready();
    if (!(await this.exists(path))) throw new DirectoryNotFoundError(path);
    if ((await this.stat(path)).type !== "directory") {
      throw new NotDirectoryError(path);
    }
    const extensions = options?.extension
      ? new Set(
          (Array.isArray(options.extension) ? options.extension : [options.extension]).map(
            (extension) => (extension.startsWith(".") ? extension : `.${extension}`),
          ),
        )
      : undefined;
    return this.listDirectory(path, options?.recursive ? (options.maxDepth ?? 100) : 0, extensions);
  }

  async exists(path: string): Promise<boolean> {
    await this.ready();
    return this.sandbox.sandboxSdk.files.exists(toSandboxPath(this.basePath, path));
  }

  async stat(path: string) {
    await this.ready();
    const virtual = toVirtualPath(this.basePath, path);
    const target = toSandboxPath(this.basePath, virtual);
    if (virtual === "/") {
      return directoryStat("", "/");
    }
    if (!(await this.sandbox.sandboxSdk.files.exists(target))) {
      throw new FileNotFoundError(path);
    }
    const native = await this.nativeStat(target);
    if (native) {
      return {
        name: basename(virtual),
        path: virtual,
        type: native.type,
        size: native.size,
        createdAt: native.createdAt,
        modifiedAt: native.modifiedAt,
      };
    }
    const entry = await this.findEntry(target);
    if (!entry) throw new FileNotFoundError(path);
    const timestamp = new Date(0);
    return {
      name: entry.name,
      path: virtual,
      type: entry.type === "directory" ? ("directory" as const) : ("file" as const),
      size: entry.size ?? 0,
      createdAt: timestamp,
      modifiedAt: timestamp,
    };
  }

  private async ready(): Promise<void> {
    await this.ensureReady();
    await this.sandbox.ensureRunning();
  }

  private assertWritable(operation: string): void {
    if (this.readOnly) throw new WorkspaceReadOnlyError(operation);
  }

  private async ensureParent(path: string, recursive: boolean): Promise<void> {
    const parent = dirname(toVirtualPath(this.basePath, path));
    if (parent === "/") return;
    if (recursive) await this.mkdir(parent, { recursive: true });
    else await this.requireParent(path);
  }

  private async requireParent(path: string): Promise<void> {
    const parent = dirname(toVirtualPath(this.basePath, path));
    if (!(await this.exists(parent))) throw new DirectoryNotFoundError(parent);
    if ((await this.stat(parent)).type !== "directory") {
      throw new NotDirectoryError(parent);
    }
  }

  private async listDirectory(
    path: string,
    depth: number,
    extensions?: ReadonlySet<string>,
  ): Promise<FileEntry[]> {
    const entries = await this.sandbox.sandboxSdk.files.list(toSandboxPath(this.basePath, path));
    const result: FileEntry[] = [];
    for (const entry of entries) {
      const type = entry.type === "directory" ? "directory" : "file";
      if (type === "file" && extensions && !extensions.has(extension(entry.name))) {
        continue;
      }
      result.push({
        name: entry.name,
        type,
        ...(entry.size === undefined ? {} : { size: entry.size }),
        ...(entry.type === "symlink" ? { isSymlink: true } : {}),
      });
      if (depth > 0 && type === "directory") {
        const childPath = joinVirtual(path, entry.name);
        const children = await this.listDirectory(childPath, depth - 1, extensions);
        result.push(
          ...children.map((child) => ({
            ...child,
            name: `${entry.name}/${child.name}`,
          })),
        );
      }
    }
    return result;
  }

  private async findEntry(target: string): Promise<SandboxDirectoryEntry | undefined> {
    const parent = dirname(target);
    const entries = await this.sandbox.sandboxSdk.files.list(parent);
    return entries.find((entry) => entry.path === target);
  }

  private async nativeStat(target: string): Promise<
    | {
        type: "file" | "directory";
        size: number;
        createdAt: Date;
        modifiedAt: Date;
      }
    | undefined
  > {
    try {
      const result = await this.sandbox.sandboxSdk.run({
        command: "stat",
        args: ["-c", "%F|%s|%W|%Y", target],
      });
      if (!result.success) return undefined;
      const [kind, sizeValue, createdValue, modifiedValue] = result.stdout.trim().split("|");
      if (!kind || !sizeValue || !createdValue || !modifiedValue) {
        return undefined;
      }
      const modified = Number(modifiedValue) * 1_000;
      const createdSeconds = Number(createdValue);
      return {
        type: kind.includes("directory") ? "directory" : "file",
        size: Number(sizeValue),
        createdAt: new Date((createdSeconds > 0 ? createdSeconds : Number(modifiedValue)) * 1_000),
        modifiedAt: new Date(modified),
      };
    } catch {
      return undefined;
    }
  }
}

function requireManaged(provider: SandboxProvider<unknown>): ManagedSandboxProvider {
  if (!provider.managed) {
    throw new SandboxError({
      code: "unsupported",
      provider: provider.id,
      operation: "mastra.createSandbox",
      message: `Provider ${provider.id} does not implement managed sandbox sessions`,
    });
  }
  return provider.managed;
}

function normalizeCwd(value: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "mastra",
      operation: "cwd",
      message: "cwd must be an absolute path",
    });
  }
  return value.replace(/\/$/, "") || "/";
}

function toVirtualPath(cwd: string, value: string): string {
  assertPath(value);
  if (value === cwd) return "/";
  if (value.startsWith(`${cwd}/`)) return `/${value.slice(cwd.length + 1)}`;
  const absolute = value.startsWith("/") ? value : `/${value}`;
  return absolute.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
}

function toSandboxPath(cwd: string, value: string): string {
  const virtual = toVirtualPath(cwd, value);
  return virtual === "/" ? cwd : `${cwd}${virtual}`;
}

function fromSandboxPath(cwd: string, value: string): string {
  if (value === cwd) return "/";
  if (!value.startsWith(`${cwd}/`)) throw new PermissionError(value, "access");
  return `/${value.slice(cwd.length + 1)}`;
}

function assertPath(value: string): void {
  if (!value || value.includes("\0") || value.split("/").includes("..")) {
    throw new PermissionError(value, "access");
  }
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function toBytes(content: FileContent): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content);
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "";
}

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return `/${parts.join("/")}`.replace(/\/$/, "") || "/";
}

function joinVirtual(parent: string, child: string): string {
  return `${parent.replace(/\/$/, "")}/${child}`.replace(/\/{2,}/g, "/");
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index <= 0 ? "" : name.slice(index);
}

/**
 * Preserve argument boundaries for ordinary commands. Commands that use shell
 * syntax deliberately fall back to the provider's shell-string execution path.
 */
function parseSimpleCommand(value: string): { command: string; args: string[] } | undefined {
  const parts: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const finish = () => {
    if (!tokenStarted) return;
    parts.push(current);
    current = "";
    tokenStarted = false;
  };

  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else current += character;
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        const next = value[++index];
        if (next === undefined) return undefined;
        current += next;
      } else if (character === "$" || character === "`") {
        return undefined;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(character)) {
      finish();
      continue;
    }
    if (character === "'") {
      quote = "single";
      tokenStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (character === "\\") {
      const next = value[++index];
      if (next === undefined) return undefined;
      current += next;
      tokenStarted = true;
      continue;
    }
    if ("|&;<>()$`*?[]{}~#\n\r".includes(character)) return undefined;
    current += character;
    tokenStarted = true;
  }
  if (quote) return undefined;
  finish();
  const [command, ...args] = parts;
  return command ? { command, args } : undefined;
}

function directoryStat(name: string, path: string) {
  const timestamp = new Date(0);
  return {
    name,
    path,
    type: "directory" as const,
    size: 0,
    createdAt: timestamp,
    modifiedAt: timestamp,
  };
}

function mapFileError(path: string, operation: string, error: unknown): Error {
  if (!isSandboxError(error)) return error instanceof Error ? error : new Error(String(error));
  if (error.code === "not_found") return new FileNotFoundError(path);
  if (error.code === "permission") return new PermissionError(path, operation);
  if (error.code === "conflict") return new FileExistsError(path);
  return error;
}
