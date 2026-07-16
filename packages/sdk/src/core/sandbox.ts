import { normalizeError, SandboxError } from "./errors";
import type { SandboxProvider } from "./provider";
import type { FileValue, RunOptions, Sandbox } from "./types";

export interface CreateSandboxOptions<TProvider extends SandboxProvider<unknown>> {
  provider: TProvider;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
}

type RawOf<TProvider> = TProvider extends SandboxProvider<infer TRaw> ? TRaw : never;

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

export async function createSandbox<TProvider extends SandboxProvider<unknown>>(
  options: CreateSandboxOptions<TProvider>,
): Promise<Sandbox<RawOf<TProvider>>> {
  const cwd = validateCwd(options.cwd ?? "/workspace");
  const env = options.env ?? {};
  let runtime;
  try {
    runtime = await options.provider.create({
      cwd,
      env,
      timeout: options.timeout,
      signal: options.signal,
    });
  } catch (error) {
    throw normalizeError(options.provider.id, "sandbox.create", error);
  }
  let stopPromise: Promise<void> | undefined;
  const stop = async () => {
    stopPromise ??= call("sandbox.stop", () => runtime.stop());
    return stopPromise;
  };
  const call = async <T>(operation: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      throw normalizeError(options.provider.id, operation, error);
    }
  };
  return {
    id: runtime.id,
    provider: options.provider.id,
    cwd,
    capabilities: runtime.capabilities,
    raw: runtime.raw as RawOf<TProvider>,
    files: {
      write: async (path: string, value: FileValue) =>
        call("files.write", () => runtime.files.write(validatePath(cwd, path), value)),
      read: async (path: string) =>
        call("files.read", () => runtime.files.read(validatePath(cwd, path))),
      text: async (path: string) =>
        new TextDecoder().decode(
          await call("files.read", () => runtime.files.read(validatePath(cwd, path))),
        ),
      list: async (path = ".") =>
        call("files.list", () => runtime.files.list(path === "." ? cwd : validatePath(cwd, path))),
      mkdir: async (path: string) =>
        call("files.mkdir", () => runtime.files.mkdir(validatePath(cwd, path))),
      remove: async (path: string) =>
        call("files.remove", () => runtime.files.remove(validatePath(cwd, path))),
      exists: async (path: string) =>
        call("files.exists", () => runtime.files.exists(validatePath(cwd, path))),
    },
    processes: {
      start: (command, runOptions = {}) =>
        call("process.start", () => runtime.start(command, normalizeRunOptions(cwd, runOptions))),
    },
    ports: { expose: (port) => call("ports.expose", () => runtime.expose(port)) },
    snapshots: {
      create: (snapshotOptions) =>
        call("snapshot.create", () => runtime.snapshots.create(snapshotOptions)),
      delete: (snapshot) => call("snapshot.delete", () => runtime.snapshots.delete(snapshot)),
      restore: (snapshot) => call("snapshot.restore", () => runtime.snapshots.restore(snapshot)),
    },
    run: (command, runOptions = {}) =>
      call("process.run", () => runtime.run(command, normalizeRunOptions(cwd, runOptions))),
    stop,
  };
}

function normalizeRunOptions(cwd: string, options: RunOptions): RunOptions {
  return { ...options, cwd: options.cwd ? validatePath(cwd, options.cwd) : cwd };
}

export async function withSandbox<TProvider extends SandboxProvider<unknown>, TResult>(
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
