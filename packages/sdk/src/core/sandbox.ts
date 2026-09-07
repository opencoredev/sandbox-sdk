import type { SandboxAdapter } from "./adapter";
import { requireCapability } from "./capabilities";
import { CommandFailedError, isSandboxError, normalizeError, SandboxError } from "./errors";
import { emitHook, runHookSnapshot, type SandboxHooks } from "./hooks";
import {
  buildShellCommand,
  genericGitClone,
  genericGitCommand,
  genericGitStatus,
  genericRunCode,
  genericStat,
  genericTransfer,
  genericWatch,
  type ExtensionContext,
} from "./extensions";
import type { SandboxNetworkPolicy, SandboxProvider, SandboxRuntime } from "./provider";
import type {
  CommandInput,
  CommandResult,
  FileValue,
  GitSource,
  ProviderName,
  RunCommandOptions,
  RunOptions,
  Sandbox,
  SandboxSummary,
} from "./types";

export type AnySandboxProvider<TRaw = unknown> = SandboxProvider<TRaw> | SandboxAdapter<TRaw>;

export interface CreateSandboxOptions<TProvider extends AnySandboxProvider> {
  provider: TProvider;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
  source?: { git: GitSource };
  hooks?: SandboxHooks;
}

type RawOf<TProvider> = TProvider extends AnySandboxProvider<infer TRaw> ? TRaw : never;

function runtimeCreate<TRaw>(
  provider: AnySandboxProvider<TRaw>,
): (options: {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
}) => Promise<SandboxRuntime<TRaw>> {
  if (provider.createRuntime) return provider.createRuntime.bind(provider);
  return (provider as SandboxProvider<TRaw>).create.bind(provider);
}

function validateCwd(cwd: string): string {
  if (!cwd.startsWith("/") || cwd.includes("\0")) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "core",
      operation: "create",
      message: "cwd must be an absolute path",
    });
  }
  return cwd.replace(/\/$/, "") || "/";
}

function validatePath(cwd: string, value: string): string {
  if (!value || value.includes("\0") || value.split("/").includes("..")) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "core",
      operation: "path",
      message: `Invalid sandbox path: ${value}`,
    });
  }
  if (value.startsWith("/")) return value.replace(/\/{2,}/g, "/");
  return `${cwd}/${value}`.replace(/\/{2,}/g, "/");
}

/**
 * Creates a normalized sandbox. Prefer `await using` so cleanup runs when the scope exits.
 */
function throwIfAborted(signal: AbortSignal | undefined, provider: string, operation: string): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new SandboxError({
    code: "terminated",
    provider,
    operation,
    message: `${operation} was aborted`,
  });
}

export async function createSandbox<TProvider extends AnySandboxProvider>(
  options: CreateSandboxOptions<TProvider>,
): Promise<Sandbox<RawOf<TProvider>>> {
  throwIfAborted(options.signal, options.provider.id, "sandbox.create");
  const cwd = validateCwd(options.cwd ?? "/workspace");
  const env = options.env ?? {};
  let runtime;
  try {
    runtime = await runtimeCreate(options.provider)({
      cwd,
      env,
      timeout: options.timeout,
      signal: options.signal,
    });
  } catch (error) {
    throw normalizeError(options.provider.id, "sandbox.create", error);
  }
  const sandbox = wrapRuntime(options.provider.id, cwd, runtime, options.hooks) as Sandbox<
    RawOf<TProvider>
  >;
  await emitHook(options.hooks?.onCreate, {
    provider: options.provider.id,
    id: sandbox.id,
    cwd,
    operation: "sandbox.create",
  });
  if (options.source?.git) {
    try {
      await sandbox.git.clone(options.source.git.url, options.source.git);
    } catch (error) {
      try {
        await sandbox.destroy();
      } catch {
        await sandbox.stop();
      }
      throw error;
    }
  }
  return sandbox;
}

export interface ConnectSandboxOptions<TProvider extends AnySandboxProvider> {
  provider: TProvider;
  /** Provider-native identifier of the sandbox to reattach to. */
  id: string;
  cwd?: string;
  signal?: AbortSignal;
  hooks?: SandboxHooks;
}

/**
 * Reattaches to an existing sandbox by id. Requires provider support
 * (`sandbox.connect` capability).
 */
export async function connectSandbox<TProvider extends AnySandboxProvider>(
  options: ConnectSandboxOptions<TProvider>,
): Promise<Sandbox<RawOf<TProvider>>> {
  throwIfAborted(options.signal, options.provider.id, "sandbox.connect");
  if (!options.provider.connect) {
    throw new SandboxError({
      code: "unsupported",
      provider: options.provider.id,
      operation: "sandbox.connect",
      message: `${options.provider.id} does not support reconnecting to existing sandboxes`,
    });
  }
  const cwd = validateCwd(options.cwd ?? "/workspace");
  let runtime;
  try {
    runtime = await options.provider.connect({ id: options.id, cwd, signal: options.signal });
  } catch (error) {
    throw normalizeError(options.provider.id, "sandbox.connect", error);
  }
  return wrapRuntime(options.provider.id, cwd, runtime, options.hooks) as Sandbox<RawOf<TProvider>>;
}

/**
 * Lists the account's sandboxes. Requires provider support (`sandbox.list` capability).
 */
export async function listSandboxes(
  provider: AnySandboxProvider,
  options?: { signal?: AbortSignal },
): Promise<SandboxSummary[]> {
  if (!provider.list) {
    throw new SandboxError({
      code: "unsupported",
      provider: provider.id,
      operation: "sandbox.list",
      message: `${provider.id} does not support listing sandboxes`,
    });
  }
  try {
    return await provider.list(options);
  } catch (error) {
    throw normalizeError(provider.id, "sandbox.list", error);
  }
}

function wrapRuntime<TRaw>(
  providerId: ProviderName,
  cwd: string,
  runtime: SandboxRuntime<TRaw>,
  hooks: SandboxHooks = {},
): Sandbox<TRaw> {
  let stopPromise: Promise<void> | undefined;
  let destroyPromise: Promise<void> | undefined;
  const stop = async () => {
    stopPromise ??= (async () => {
      await call("sandbox.stop", () => runtime.stop());
      await emitHook(hooks.onStop, { provider: providerId, id: runtime.id, operation: "sandbox.stop" });
    })();
    return stopPromise;
  };
  const destroy = async () => {
    if (!runtime.destroy) {
      throw new SandboxError({
        code: "unsupported",
        provider: providerId,
        operation: "sandbox.destroy",
        message: `${providerId} does not support permanently deleting sandboxes`,
      });
    }
    destroyPromise ??= (async () => {
      await call("sandbox.destroy", () => runtime.destroy!());
      await emitHook(hooks.onDestroy, {
        provider: providerId,
        id: runtime.id,
        operation: "sandbox.destroy",
      });
    })();
    return destroyPromise;
  };
  const call = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      const normalized = normalizeError(providerId, operation, error);
      await emitHook(hooks.onError, {
        provider: providerId,
        id: runtime.id,
        operation,
        code: isSandboxError(normalized) ? normalized.code : undefined,
        message: normalized.message,
      });
      throw normalized;
    }
  };
  const gated = { capabilities: runtime.capabilities, provider: providerId };
  const run = async (command: CommandInput, runOptions: RunCommandOptions = {}) => {
    requireCapability(gated, "process.run");
    const { onStdout, onStderr, ...rest } = runOptions;
    const normalized = normalizeRunOptions(cwd, rest);
    if ((onStdout || onStderr) && Boolean(runtime.capabilities["process.stream"])) {
      return call("process.run", async () => {
        const result = await streamRun(runtime, command, normalized, onStdout, onStderr);
        await emitHook(hooks.onRun, {
          provider: providerId,
          id: runtime.id,
          operation: "process.run",
          command: typeof command === "string" ? command : command.command,
          ...runHookSnapshot(result),
        });
        return result;
      });
    }
    return call("process.run", async () => {
      const result = await runtime.run(command, normalized);
      if (onStdout && result.stdout) onStdout(result.stdout);
      if (onStderr && result.stderr) onStderr(result.stderr);
      await emitHook(hooks.onRun, {
        provider: providerId,
        id: runtime.id,
        operation: "process.run",
        command: typeof command === "string" ? command : command.command,
        ...runHookSnapshot(result),
      });
      return result;
    });
  };
  const extensionContext: ExtensionContext = { provider: providerId, run };
  const write = async (path: string, value: FileValue) =>
    call("files.write", () => runtime.files.write(validatePath(cwd, path), value));
  const read = async (path: string) =>
    call("files.read", () => runtime.files.read(validatePath(cwd, path)));
  const remove = async (path: string) =>
    call("files.remove", () => runtime.files.remove(validatePath(cwd, path)));
  return {
    id: runtime.id,
    provider: providerId,
    cwd,
    capabilities: runtime.capabilities,
    raw: runtime.raw,
    files: {
      write,
      writeMany: async (files) => {
        await Promise.all(files.map((file) => write(file.path, file.value)));
      },
      read,
      text: async (path: string) => new TextDecoder().decode(await read(path)),
      list: async (path = ".") =>
        call("files.list", () => runtime.files.list(path === "." ? cwd : validatePath(cwd, path))),
      mkdir: async (path: string) =>
        call("files.mkdir", () => runtime.files.mkdir(validatePath(cwd, path))),
      remove,
      exists: async (path: string) =>
        call("files.exists", () => runtime.files.exists(validatePath(cwd, path))),
      stat: async (path: string) => {
        const resolved = validatePath(cwd, path);
        if (runtime.files.stat) return call("files.stat", () => runtime.files.stat!(resolved));
        return genericStat(extensionContext, resolved);
      },
      move: async (source: string, destination: string) => {
        const from = validatePath(cwd, source);
        const to = validatePath(cwd, destination);
        if (runtime.files.move) return call("files.move", () => runtime.files.move!(from, to));
        return genericTransfer(extensionContext, "move", from, to);
      },
      copy: async (source: string, destination: string) => {
        const from = validatePath(cwd, source);
        const to = validatePath(cwd, destination);
        if (runtime.files.copy) return call("files.copy", () => runtime.files.copy!(from, to));
        return genericTransfer(extensionContext, "copy", from, to);
      },
      upload: async (localPath: string, path: string) => {
        const { readFile } = await import("node:fs/promises");
        const data = await call("files.upload", () => readFile(localPath));
        await write(path, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      },
      download: async (path: string, localPath: string) => {
        const { writeFile } = await import("node:fs/promises");
        const data = await read(path);
        await call("files.download", () => writeFile(localPath, data));
      },
      watch: async (path, onEvent, watchOptions = {}) => {
        const resolved = validatePath(cwd, path);
        const recursive = watchOptions.recursive ?? true;
        const handle = runtime.files.watch
          ? await call("files.watch", () =>
              runtime.files.watch!(resolved, onEvent, {
                recursive,
                signal: watchOptions.signal,
              }),
            )
          : await genericWatch(extensionContext, resolved, onEvent, {
              recursive,
              pollInterval: watchOptions.pollInterval ?? 1_000,
              signal: watchOptions.signal,
            });
        const stopWatcher = () => handle.stop();
        return { stop: stopWatcher, [Symbol.asyncDispose]: stopWatcher };
      },
    },
    processes: {
      start: async (command, runOptions = {}) => {
        requireCapability(gated, "process.background");
        return call("process.start", () =>
          runtime.start(command, normalizeRunOptions(cwd, runOptions)),
        );
      },
    },
    ports: {
      expose: async (port) => {
        requireCapability(gated, "ports.expose");
        return call("ports.expose", () => runtime.expose(port));
      },
    },
    snapshots: {
      create: async (snapshotOptions) => {
        requireCapability(gated, "snapshot.create");
        return call("snapshot.create", () => runtime.snapshots.create(snapshotOptions));
      },
      delete: async (snapshot) => {
        requireCapability(gated, "snapshot.delete");
        return call("snapshot.delete", () => runtime.snapshots.delete(snapshot));
      },
      restore: async (snapshot) => {
        requireCapability(gated, "snapshot.restore");
        return call("snapshot.restore", () => runtime.snapshots.restore(snapshot));
      },
    },
    git: {
      clone: (url, cloneOptions) => genericGitClone(extensionContext, cwd, url, cloneOptions),
      pull: (gitOptions = {}) =>
        genericGitCommand(
          extensionContext,
          "pull",
          gitOptions.path ? validatePath(cwd, gitOptions.path) : cwd,
          [],
          gitOptions,
        ),
      checkout: (ref, gitOptions = {}) =>
        genericGitCommand(
          extensionContext,
          "checkout",
          gitOptions.path ? validatePath(cwd, gitOptions.path) : cwd,
          [ref],
          gitOptions,
        ),
      status: (gitOptions = {}) =>
        genericGitStatus(
          extensionContext,
          gitOptions.path ? validatePath(cwd, gitOptions.path) : cwd,
          gitOptions,
        ),
    },
    run,
    $: async (strings, ...values) => {
      const command = buildShellCommand(strings, values);
      const result = await run(command);
      if (!result.success) {
        throw new CommandFailedError({ provider: providerId, command, result });
      }
      return result;
    },
    runCode: (code, codeOptions) =>
      genericRunCode(
        extensionContext,
        (path, value) => write(path, value),
        (path) => remove(path),
        code,
        codeOptions,
      ),
    extendTimeout: async (ms: number) => {
      if (!runtime.extendTimeout) {
        throw new SandboxError({
          code: "unsupported",
          provider: providerId,
          operation: "sandbox.timeout",
          message: `${providerId} does not support extending the sandbox timeout`,
        });
      }
      return call("sandbox.timeout", () => runtime.extendTimeout!(ms));
    },
    info: async () => {
      const extra = runtime.info ? await call("sandbox.info", () => runtime.info!()) : {};
      return { id: runtime.id, provider: providerId, cwd, ...extra };
    },
    metrics: async () => {
      if (!runtime.metrics) {
        throw new SandboxError({
          code: "unsupported",
          provider: providerId,
          operation: "sandbox.metrics",
          message: `${providerId} does not support sandbox metrics`,
        });
      }
      return call("sandbox.metrics", () => runtime.metrics!());
    },
    pty: {
      create: async (ptyOptions = {}) => {
        if (!runtime.pty) {
          throw new SandboxError({
            code: "unsupported",
            provider: providerId,
            operation: "process.pty",
            message: `${providerId} does not support interactive PTYs`,
          });
        }
        return call("process.pty", () =>
          runtime.pty!.create({
            ...ptyOptions,
            cwd: ptyOptions.cwd ? validatePath(cwd, ptyOptions.cwd) : cwd,
          }),
        );
      },
    },
    setNetworkPolicy: async (policy: SandboxNetworkPolicy) => {
      if (!runtime.setNetworkPolicy) {
        throw new SandboxError({
          code: "unsupported",
          provider: providerId,
          operation: "network.policy",
          message: `${providerId} does not support network policy updates`,
        });
      }
      return call("network.policy", () => runtime.setNetworkPolicy!(policy));
    },
    stop,
    destroy,
    [Symbol.asyncDispose]: stop,
  };
}

function normalizeRunOptions(cwd: string, options: RunOptions): RunOptions {
  return { ...options, cwd: options.cwd ? validatePath(cwd, options.cwd) : cwd };
}

async function streamRun(
  runtime: SandboxRuntime<unknown>,
  command: CommandInput,
  options: RunOptions,
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
): Promise<CommandResult> {
  const started = performance.now();
  const process = await runtime.start(command, options);
  let stdout = "";
  let stderr = "";
  const consumed = (async () => {
    for await (const event of process.output()) {
      const text =
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      if (event.stream === "stdout") {
        stdout += text;
        onStdout?.(text);
      } else {
        stderr += text;
        onStderr?.(text);
      }
    }
  })();
  const { exitCode } = await process.wait();
  await consumed;
  return {
    stdout,
    stderr,
    exitCode,
    success: exitCode === 0,
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * Runs a callback with a sandbox and stops it afterward.
 *
 * Prefer `await using` with `createSandbox()` in new code. This helper remains useful for
 * callback-style code and runtimes that do not parse explicit resource management syntax.
 */
export async function withSandbox<TProvider extends AnySandboxProvider, TResult>(
  options: CreateSandboxOptions<TProvider>,
  callback: (sandbox: Sandbox<RawOf<TProvider>>) => TResult | Promise<TResult>,
): Promise<TResult> {
  const sandbox = await createSandbox(options);
  try {
    const result = await callback(sandbox);
    await sandbox.stop();
    return result;
  } catch (error) {
    try {
      await sandbox.stop();
    } catch (cleanupError) {
      if (error instanceof Error) {
        Object.defineProperty(error, "cleanupError", { value: cleanupError, enumerable: false });
      }
    }
    throw error;
  }
}
