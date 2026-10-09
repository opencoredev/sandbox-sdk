import { dirname } from "node:path";
import { Machine, type ConnectOptions, type ExecOptions, type MachineConfig } from "smolmachines";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type {
  CapabilityMap,
  CommandInput,
  ProcessOutputEvent,
  SandboxProcess,
} from "../../core/types";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { smolCapabilities } from "../capabilities";

/** Smol's local engine and hosted cloud share the same machine API. */
export interface SmolOptions {
  /** The target is explicit so ambient SMOL_CLOUD_TOKEN does not change where code runs. */
  target?: "local" | "cloud";
  /** Base OCI image, which must contain sh and standard Linux file utilities. */
  image?: string;
  /** CPU, memory, and network settings passed directly to Smol. */
  resources?: MachineConfig["resources"];
  /** Cloud token; otherwise smolmachines reads SMOL_CLOUD_TOKEN. */
  apiKey?: string;
  /** Custom cloud API endpoint. */
  baseUrl?: string;
  /** Maximum cloud lifetime, in seconds. */
  ttlSeconds?: number;
  /** Additional native machine settings for advanced workloads. */
  machine?: Omit<MachineConfig, "image" | "resources" | "env" | "workdir" | "ttlSeconds">;
  /** Additional native connection settings. */
  connection?: Omit<ConnectOptions, "target" | "apiKey" | "baseUrl">;
}

export { smolCapabilities } from "../capabilities";

const CLOUD_CAPABILITIES: CapabilityMap = {
  ...smolCapabilities,
  "process.background": false,
  "process.stream": false,
  "process.cancel": false,
};

/** Create an isolated Linux microVM, locally or in Smol's cloud. */
export function smol(options: SmolOptions = {}): SandboxProvider<Machine> {
  const target = options.target ?? "local";
  const publishedPorts = options.machine?.ports ?? [];
  const capabilities: CapabilityMap =
    target === "cloud"
      ? CLOUD_CAPABILITIES
      : publishedPorts.length
        ? { ...smolCapabilities, "ports.expose": "localhost" }
        : smolCapabilities;
  const connection: ConnectOptions = {
    ...options.connection,
    target,
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    // The host embedding sandbox-sdk owns cleanup and signal handling.
    ...(target === "local" && options.connection?.handleSignals === undefined
      ? { handleSignals: false }
      : {}),
  };
  return {
    id: "smol",
    capabilities,
    async create(createOptions) {
      createOptions.signal?.throwIfAborted();
      const config: MachineConfig = {
        ...options.machine,
        ...(target === "local" &&
        publishedPorts.length &&
        options.machine?.waitForPorts === undefined
          ? { waitForPorts: false }
          : {}),
        image: options.image ?? "node:22",
        resources: options.resources,
        ttlSeconds: options.ttlSeconds,
        workdir: createOptions.cwd,
        env: { ...createOptions.env },
      };
      const raw = await awaitMachine(Machine.create(config, connection), createOptions);
      try {
        await assertSuccess(raw, ["mkdir", "-p", "--", createOptions.cwd], "sandbox.create.cwd");
      } catch (error) {
        await raw.delete().catch(() => undefined);
        throw error;
      }
      const processes = new Set<SandboxProcess>();
      const runtimeEnv = { ...createOptions.env };
      return {
        id: raw.id,
        raw,
        capabilities,
        files: {
          async write(path, value) {
            await assertSuccess(raw, ["mkdir", "-p", "--", dirname(path)], "files.write.mkdir");
            await raw.writeFile(path, await toUint8Array(value));
          },
          async read(path) {
            return new Uint8Array(await raw.readFile(path));
          },
          async list(path) {
            const result = await raw.exec(
              ["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0%y\\0%s\\0"],
              { output: "b64" },
            );
            if (result.exitCode !== 0) throw new Error(`files.list: ${result.stderr}`);
            if (result.stdoutTruncated) throw new Error("files.list output was truncated");
            const parts = new TextDecoder().decode(result.stdoutBytes).split("\0");
            parts.pop();
            const entries = [];
            for (let index = 0; index < parts.length; index += 3) {
              const name = parts[index]!;
              const kind = parts[index + 1];
              entries.push({
                name,
                path: `${path.replace(/\/$/, "")}/${name}`,
                type:
                  kind === "d"
                    ? ("directory" as const)
                    : kind === "f"
                      ? ("file" as const)
                      : kind === "l"
                        ? ("symlink" as const)
                        : ("unknown" as const),
                size: kind === "f" ? Number(parts[index + 2]) : undefined,
              });
            }
            return entries;
          },
          async mkdir(path) {
            await assertSuccess(raw, ["mkdir", "-p", "--", path], "files.mkdir");
          },
          async remove(path) {
            await assertSuccess(raw, ["rm", "-rf", "--", path], "files.remove");
          },
          async exists(path) {
            const result = await raw.exec(["test", "-e", path]);
            if (result.exitCode === 0) return true;
            if (result.exitCode === 1) return false;
            throw new Error(`files.exists failed: ${result.stderr || result.stdout}`);
          },
        },
        async run(command, runOptions) {
          runOptions.signal?.throwIfAborted();
          const started = performance.now();
          const result = await runCommand(raw, command, {
            ...runOptions,
            env: { ...runtimeEnv, ...runOptions.env },
          });
          return {
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            success: result.success,
            durationMs: Math.round(performance.now() - started),
          };
        },
        async start(command, runOptions) {
          if (target === "cloud") unsupported("smol", "process.background");
          runOptions.signal?.throwIfAborted();
          const proc = startLocalProcess(raw, command, {
            ...runOptions,
            env: { ...runtimeEnv, ...runOptions.env },
          });
          processes.add(proc);
          void proc.wait().finally(() => processes.delete(proc));
          return proc;
        },
        async expose(port) {
          if (target === "cloud" || !publishedPorts.some((published) => published.guest === port))
            return unsupported("smol", "ports.expose");
          const endpoint = raw.endpoint(port);
          return portResult(port, endpoint.httpUrl, false, false, (path = "", init) => {
            const next = raw.endpoint(port, path);
            const headers = new Headers(init?.headers);
            for (const [name, value] of Object.entries(next.headers)) headers.set(name, value);
            return fetch(next.httpUrl, { ...init, headers });
          });
        },
        snapshots: unsupportedSnapshots("smol"),
        async stop() {
          try {
            await Promise.all([...processes].map((proc) => proc.kill()));
          } finally {
            await raw.delete();
          }
        },
      };
    },
  };
}

function argv(input: CommandInput): string[] {
  return ["sh", "-lc", commandString(input)];
}

function execOptions(options: {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
}): ExecOptions {
  return {
    workdir: options.cwd,
    env: options.env ? { ...options.env } : undefined,
    timeout:
      options.timeout === undefined ? undefined : Math.max(1, Math.ceil(options.timeout / 1000)),
    signal: options.signal,
  };
}

async function runCommand(
  machine: Machine,
  command: CommandInput,
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeout?: number;
    signal?: AbortSignal;
  },
) {
  if (options.timeout === undefined) return machine.exec(argv(command), execOptions(options));
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Command aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = setTimeout(
    () =>
      controller.abort(
        new SandboxError({
          code: "timeout",
          provider: "smol",
          operation: "process.run",
          message: `Command timed out after ${options.timeout}ms`,
        }),
      ),
    options.timeout,
  );
  try {
    return await machine.exec(argv(command), {
      ...execOptions(options),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function assertSuccess(machine: Machine, args: string[], operation: string): Promise<void> {
  const result = await machine.exec(args);
  if (!result.success)
    throw new Error(`${operation}: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
}

async function awaitMachine(
  pending: Promise<Machine>,
  options: { signal?: AbortSignal; timeout?: number },
): Promise<Machine> {
  const { signal, timeout } = options;
  if (timeout === undefined && !signal) return pending;
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal?.reason ?? new Error("Sandbox creation aborted"));
    signal?.addEventListener("abort", abort, { once: true });
    if (timeout !== undefined)
      timer = setTimeout(
        () =>
          reject(
            new SandboxError({
              code: "timeout",
              provider: "smol",
              operation: "sandbox.create",
              message: `Creation timed out after ${timeout}ms`,
            }),
          ),
        timeout,
      );
    if (signal?.aborted) abort();
  });
  const creation = pending.then(async (machine) => {
    if (done) await machine.delete();
    return machine;
  });
  try {
    return await Promise.race([creation, stopped]);
  } finally {
    done = true;
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
    void creation.catch(() => undefined);
  }
}

function startLocalProcess(
  machine: Machine,
  command: CommandInput,
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    timeout?: number;
    signal?: AbortSignal;
  },
): SandboxProcess {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason ?? new Error("Process aborted"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const queue: ProcessOutputEvent[] = [];
  const listeners = new Set<() => void>();
  let state: "running" | "exited" | "killed" = "running";
  let exitCode = -1;
  const notify = () => {
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const finished = (async () => {
    try {
      for await (const event of machine.execStream(argv(command), {
        ...execOptions(options),
        signal: controller.signal,
      })) {
        if (event.kind === "stdout" || event.kind === "stderr") {
          queue.push({ stream: event.kind, data: event.data, timestamp: new Date() });
          // Bound memory when callers never consume output from long-running agents.
          if (queue.length > 1024) queue.shift();
          notify();
        } else if (event.kind === "exit") {
          exitCode = event.exitCode;
        } else {
          queue.push({ stream: "stderr", data: event.message, timestamp: new Date() });
          notify();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        queue.push({ stream: "stderr", data: String(error), timestamp: new Date() });
        notify();
      }
    } finally {
      state = controller.signal.aborted ? "killed" : "exited";
      options.signal?.removeEventListener("abort", onAbort);
      notify();
    }
    return { exitCode };
  })();
  return {
    id: crypto.randomUUID(),
    async status() {
      return state;
    },
    async *output() {
      while (queue.length || state === "running") {
        if (queue.length) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((resolve) => listeners.add(resolve));
        }
      }
    },
    async write() {
      unsupported("smol", "process.stdin");
    },
    wait() {
      return finished;
    },
    async kill() {
      if (state === "running") {
        state = "killed";
        controller.abort(new Error("Process killed"));
      }
      await finished;
    },
  };
}
