import { randomUUID } from "node:crypto";
import type {
  AgentOs as AgentOsVm,
  AgentOsOptions,
  Permissions,
  RootSnapshotExport,
} from "@rivet-dev/agentos-core";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider, SandboxRuntime } from "../../core/provider";
import type {
  CommandInput,
  CommandResult,
  ProcessOutputEvent,
  ProcessStatus,
  RunOptions,
  SandboxDirectoryEntry,
  SandboxProcess,
  SandboxSnapshot,
} from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import { portResult, toUint8Array } from "../../internal/provider-utils";
import { localCapabilities } from "../capabilities";

const DEFAULT_PERMISSIONS: Permissions = {
  fs: "allow",
  childProcess: "allow",
  process: "allow",
  env: "allow",
  network: {
    default: "deny",
    rules: [
      { mode: "allow", operations: ["listen"], patterns: ["**"] },
      {
        mode: "allow",
        operations: ["http"],
        patterns: ["tcp://127.0.0.1:*", "tcp://[::1]:*", "tcp://localhost:*"],
      },
    ],
  },
  binding: "deny",
};

const DEFAULT_LIMITS: NonNullable<AgentOsOptions["limits"]> = {
  resources: {
    cpuCount: 1,
    maxProcesses: 64,
    maxOpenFds: 256,
    maxPipes: 128,
    maxPtys: 16,
    maxSockets: 128,
    maxConnections: 64,
    maxFilesystemBytes: 512 * 1024 * 1024,
    maxInodeCount: 100_000,
    maxWasmMemoryBytes: 256 * 1024 * 1024,
  },
  http: { maxFetchResponseBytes: 16 * 1024 * 1024 },
  jsRuntime: {
    v8HeapLimitMb: 256,
    wallClockLimitMs: 120_000,
    capturedOutputLimitBytes: 8 * 1024 * 1024,
    stdinBufferLimitBytes: 1024 * 1024,
  },
};

export interface AgentOsProviderOptions {
  /**
   * Native agentOS VM options. The provider supplies production-oriented permissions and limits
   * unless these fields are explicitly provided.
   */
  agentOs?: AgentOsOptions;
}

export interface AgentOsSandbox {
  /** The currently running native VM. Access throws while the sandbox is suspended or stopped. */
  readonly vm: AgentOsVm;
  suspend(): Promise<void>;
  resume(): Promise<void>;
}

type StoredSnapshot = {
  metadata: SandboxSnapshot;
  root: RootSnapshotExport;
};

export { agentosCapabilities } from "../capabilities";

/**
 * Internal constructor for the AgentOS VM that powers the Local provider.
 *
 * Outbound networking is denied by default. Pass an explicit agentOS permission policy when the
 * guest needs network or host bindings.
 */
function createAgentOsProvider(
  options: AgentOsProviderOptions = {},
): SandboxProvider<AgentOsSandbox> {
  const provider: SandboxProvider<AgentOsSandbox> = {
    id: "local",
    capabilities: localCapabilities,
    async create(createOptions) {
      const id = randomUUID();
      const snapshots = new Map<string, StoredSnapshot>();
      const baseOptions = options.agentOs ?? {};
      let vm: AgentOsVm | null = null;
      let suspendedRoot: RootSnapshotExport | undefined;
      let stopped = false;

      const createVm = async (root?: RootSnapshotExport): Promise<AgentOsVm> => {
        let AgentOs: (typeof import("@rivet-dev/agentos-core"))["AgentOs"];
        try {
          ({ AgentOs } = await import("@rivet-dev/agentos-core"));
        } catch (error) {
          throw new SandboxError({
            code: "unavailable",
            provider: "local",
            operation: "sandbox.create",
            message:
              "The Local provider could not load its @rivet-dev/agentos-core runtime dependency.",
            cause: error,
          });
        }
        const next = await AgentOs.create({
          ...baseOptions,
          permissions: baseOptions.permissions ?? DEFAULT_PERMISSIONS,
          limits: baseOptions.limits ?? DEFAULT_LIMITS,
          ...(root
            ? {
                rootFilesystem: {
                  disableDefaultBaseLayer: true,
                  lowers: [root],
                },
              }
            : {}),
        });
        await next.mkdir(createOptions.cwd, { recursive: true });
        return next;
      };

      const currentVm = (): AgentOsVm => {
        if (stopped)
          throw new SandboxError({
            code: "terminated",
            provider: "local",
            operation: "sandbox",
            message: "Sandbox has stopped",
          });
        if (!vm)
          throw new SandboxError({
            code: "terminated",
            provider: "local",
            operation: "sandbox",
            message: "Sandbox is suspended; call sandbox.raw.resume() before using it",
          });
        return vm;
      };

      const suspend = async () => {
        if (stopped || !vm) return;
        suspendedRoot = await vm.snapshotRootFilesystem();
        await vm.dispose();
        vm = null;
      };

      const resume = async () => {
        if (stopped)
          throw new SandboxError({
            code: "terminated",
            provider: "local",
            operation: "sandbox.resume",
            message: "A stopped sandbox cannot be resumed",
          });
        if (vm) return;
        vm = await createVm(suspendedRoot);
        suspendedRoot = undefined;
      };

      vm = await createVm();
      const raw: AgentOsSandbox = {
        get vm() {
          return currentVm();
        },
        suspend,
        resume,
      };

      const runtime: SandboxRuntime<AgentOsSandbox> = {
        id,
        raw,
        capabilities: localCapabilities,
        files: {
          write: async (path, value) => currentVm().writeFile(path, await toUint8Array(value)),
          read: (path) => currentVm().readFile(path),
          async list(path) {
            const entries = await currentVm().readdirRecursive(path, { maxDepth: 0 });
            return entries.map(
              (entry): SandboxDirectoryEntry => ({
                name: entry.path.slice(entry.path.lastIndexOf("/") + 1),
                path: entry.path,
                type: entry.type,
                size: entry.type === "file" ? entry.size : undefined,
              }),
            );
          },
          mkdir: (path) => currentVm().mkdir(path, { recursive: true }),
          async remove(path) {
            if (path === "/")
              throw new SandboxError({
                code: "invalid_input",
                provider: "local",
                operation: "files.remove",
                message: "Cannot remove the sandbox root",
              });
            await currentVm().delete(path, { recursive: true });
          },
          exists: (path) => currentVm().exists(path),
        },
        run: (command, runOptions) =>
          runCommand(currentVm(), command, withEnv(createOptions, runOptions)),
        async start(command, runOptions) {
          return startProcess(currentVm(), command, withEnv(createOptions, runOptions));
        },
        async expose(port) {
          validatePort(port);
          const url = `http://agentos-${id}.internal:${port}`;
          return portResult(port, url, false, false, (path = "/", init) => {
            const request = new Request(new URL(path, url), init);
            return currentVm().fetch(port, request);
          });
        },
        snapshots: {
          async create(snapshotOptions) {
            const snapshot: SandboxSnapshot = {
              id: randomUUID(),
              name: snapshotOptions?.name,
              mode: "filesystem",
              createdAt: new Date(),
            };
            snapshots.set(snapshot.id, {
              metadata: snapshot,
              root: await currentVm().snapshotRootFilesystem(),
            });
            return snapshot;
          },
          async delete(snapshot) {
            const id = typeof snapshot === "string" ? snapshot : snapshot.id;
            if (!snapshots.delete(id)) throw snapshotNotFound(id, "snapshot.delete");
          },
          async restore(snapshot) {
            const id = typeof snapshot === "string" ? snapshot : snapshot.id;
            const stored = snapshots.get(id);
            if (!stored) throw snapshotNotFound(id, "snapshot.restore");
            const previous = currentVm();
            vm = null;
            await previous.dispose();
            try {
              vm = await createVm(stored.root);
            } catch (error) {
              stopped = true;
              throw error;
            }
          },
        },
        async stop() {
          if (stopped) return;
          stopped = true;
          suspendedRoot = undefined;
          snapshots.clear();
          const active = vm;
          vm = null;
          await active?.dispose();
        },
      };
      return runtime;
    },
  };

  return withManagedSessions(provider, [], {
    stop: (sandbox) => sandbox.raw.suspend(),
    resume: (sandbox) => sandbox.raw.resume(),
  });
}

/**
 * @deprecated AgentOS now powers `local()` under the hood. Import `local` from
 * `@opencoredev/sandbox-sdk/local` instead.
 */
export function agentos(options: AgentOsProviderOptions = {}): SandboxProvider<AgentOsSandbox> {
  return createAgentOsProvider(options);
}

function withEnv(
  createOptions: { env: Readonly<Record<string, string>> },
  runOptions: RunOptions,
): RunOptions {
  return { ...runOptions, env: { ...createOptions.env, ...runOptions.env } };
}

function commandParts(command: CommandInput): [string, string[]] {
  return typeof command === "string"
    ? ["sh", ["-lc", command]]
    : [command.command, [...(command.args ?? [])]];
}

function startProcess(vm: AgentOsVm, command: CommandInput, options: RunOptions): SandboxProcess {
  if (options.signal?.aborted) throw interrupted("process.start");
  const [executable, args] = commandParts(command);
  const history: ProcessOutputEvent[] = [];
  const waiting = new Set<() => void>();
  let state: ProcessStatus = "running";
  let exitCode: number | undefined;
  const push = (stream: "stdout" | "stderr", data: Uint8Array) => {
    const output = stream === "stderr" ? withoutInternalAgentOsWarnings(data) : data;
    if (output.byteLength === 0) return;
    history.push({ stream, data: new Uint8Array(output), timestamp: new Date() });
    for (const wake of waiting) wake();
    waiting.clear();
  };
  const process = vm.spawn(executable, args, {
    cwd: options.cwd,
    env: options.env ? { ...options.env } : undefined,
    streamStdin: true,
    onStdout: (data) => push("stdout", data),
    onStderr: (data) => push("stderr", data),
  });
  const completed = vm.waitProcess(process.pid).then((code) => {
    exitCode = code;
    state = code === 137 || code === 143 ? "killed" : "exited";
    for (const wake of waiting) wake();
    waiting.clear();
    return { exitCode: code };
  });
  const abort = () => vm.stopProcess(process.pid);
  options.signal?.addEventListener("abort", abort, { once: true });
  void completed.finally(() => options.signal?.removeEventListener("abort", abort));

  return {
    id: String(process.pid),
    async status() {
      return state;
    },
    async *output() {
      let index = 0;
      while (state === "running" || index < history.length) {
        while (index < history.length) yield history[index++]!;
        if (state !== "running") break;
        await new Promise<void>((resolve) => waiting.add(resolve));
      }
    },
    write: (value) => vm.writeProcessStdin(process.pid, value),
    wait: () => (exitCode === undefined ? completed : Promise.resolve({ exitCode })),
    async kill(signal = "SIGTERM") {
      if (state !== "running") return;
      if (signal === "SIGKILL" || signal === "KILL" || signal === "9") vm.killProcess(process.pid);
      else vm.stopProcess(process.pid);
    },
  };
}

function withoutInternalAgentOsWarnings(data: Uint8Array): Uint8Array {
  const value = new TextDecoder()
    .decode(data)
    .replaceAll("\u001b[33m WARN\u001b[0m could not retrieve pid for child process\n", "");
  return new TextEncoder().encode(value);
}

async function runCommand(
  vm: AgentOsVm,
  command: CommandInput,
  options: RunOptions,
): Promise<CommandResult> {
  const started = performance.now();
  const process = startProcess(vm, command, options);
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const collect = (async () => {
    for await (const event of process.output()) {
      const bytes =
        typeof event.data === "string" ? new TextEncoder().encode(event.data) : event.data;
      (event.stream === "stdout" ? stdout : stderr).push(bytes);
    }
  })();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const interruptions: Promise<never>[] = [];

  if (options.timeout && options.timeout > 0) {
    interruptions.push(
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          void process.kill("SIGKILL");
          reject(
            new SandboxError({
              code: "timeout",
              provider: "local",
              operation: "process.run",
              message: `Command timed out after ${options.timeout}ms`,
            }),
          );
        }, options.timeout);
      }),
    );
  }
  if (options.signal) {
    interruptions.push(
      new Promise<never>((_, reject) => {
        const abort = () => {
          void process.kill("SIGKILL");
          reject(interrupted("process.run"));
        };
        options.signal!.addEventListener("abort", abort, { once: true });
        removeAbort = () => options.signal!.removeEventListener("abort", abort);
      }),
    );
  }

  try {
    const result = await Promise.race([process.wait(), ...interruptions]);
    await collect;
    return {
      stdout: decodeChunks(stdout),
      stderr: decodeChunks(stderr),
      exitCode: result.exitCode,
      success: result.exitCode === 0,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    await process.wait().catch(() => {});
    await collect.catch(() => {});
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
    removeAbort();
  }
}

function decodeChunks(chunks: Uint8Array[]): string {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new SandboxError({
      code: "invalid_input",
      provider: "local",
      operation: "ports.expose",
      message: `Invalid port: ${port}`,
    });
}

function snapshotNotFound(id: string, operation: string): SandboxError {
  return new SandboxError({
    code: "not_found",
    provider: "local",
    operation,
    message: `Snapshot not found: ${id}`,
  });
}

function interrupted(operation: string): SandboxError {
  return new SandboxError({
    code: "terminated",
    provider: "local",
    operation,
    message: "Operation was aborted",
  });
}
