import { initialize, SandboxInstance, type SandboxCreateConfiguration } from "@blaxel/core";
import { randomUUID } from "node:crypto";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { ProcessOutputEvent, SandboxProcess } from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import {
  authenticatedPortRequest,
  commandString,
  portResult,
  shellQuote,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { blaxelCapabilities } from "../capabilities";

export type BlaxelOptions = Omit<SandboxCreateConfiguration, "envs"> & {
  /** Blaxel API key. Defaults to BL_API_KEY. */
  apiKey?: string;
  /** Blaxel workspace. Defaults to BL_WORKSPACE. */
  workspace?: string;
  /** Expose public previews instead of token-authenticated previews. */
  public?: boolean;
  /** Lifetime of private preview tokens in milliseconds. */
  previewTokenTtl?: number;
};

export { blaxelCapabilities } from "../capabilities";

export function blaxel(options: BlaxelOptions = {}): SandboxProvider<SandboxInstance> {
  const {
    apiKey,
    workspace,
    public: publicPorts = false,
    previewTokenTtl = 60 * 60 * 1_000,
    ...sandboxOptions
  } = options;
  const configuredPorts = (sandboxOptions.ports ?? [])
    .map((port) => Number("target" in port ? port.target : NaN))
    .filter(Number.isFinite);
  const createPreviewAccess = async (raw: SandboxInstance, port: number) => {
    const preview = await raw.previews.createIfNotExists({
      metadata: {
        name: `sandbox-sdk-${port}-${publicPorts ? "public" : "private"}`,
      },
      spec: { port, public: publicPorts },
    });
    const url = preview.spec.url;
    if (!url) throw new Error(`Blaxel did not return a preview URL for port ${port}`);
    if (publicPorts) return { url };
    const token = await preview.tokens.create(new Date(Date.now() + previewTokenTtl));
    return { url, token: token.value };
  };

  return withManagedSessions(
    {
      id: "blaxel",
      capabilities: blaxelCapabilities,
      async create(createOptions) {
        assertNotAborted(createOptions.signal);
        configureBlaxel(apiKey, workspace);
        const generatedName = sandboxOptions.name === undefined;
        const name =
          sandboxOptions.name ?? `sandbox-sdk-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
        let raw: SandboxInstance;
        try {
          raw = await SandboxInstance.create({
            ...sandboxOptions,
            name,
            envs: Object.entries(createOptions.env).map(([name, value]) => ({ name, value })),
          });
        } catch (error) {
          if (generatedName) await SandboxInstance.delete(name).catch(() => undefined);
          throw error;
        }
        try {
          assertNotAborted(createOptions.signal);
          await raw.fs.mkdir(createOptions.cwd);
        } catch (error) {
          await raw.delete().catch(() => undefined);
          throw error;
        }

        const activeProcessCleanups = new Set<() => void>();

        return {
          id: raw.metadata.name,
          raw,
          capabilities: blaxelCapabilities,
          files: {
            async write(path, value) {
              await raw.fs.writeBinary(path, await toUint8Array(value));
            },
            async read(path) {
              const value = await raw.fs.readBinary(path);
              return new Uint8Array(await value.arrayBuffer());
            },
            async list(path) {
              const directory = await raw.fs.ls(path);
              return [
                ...directory.files.map((file) => ({
                  name: file.name,
                  path: file.path,
                  type: "file" as const,
                  size: file.size,
                })),
                ...directory.subdirectories.map((entry) => ({
                  name: entry.name,
                  path: entry.path,
                  type: "directory" as const,
                })),
              ];
            },
            async mkdir(path) {
              await raw.fs.mkdir(path);
            },
            async remove(path) {
              await raw.fs.rm(path, true);
            },
            async exists(path) {
              const result = await raw.process.exec({
                command: `test -e ${shellQuote(path)}`,
                workingDir: "/",
                waitForCompletion: true,
              });
              return result.exitCode === 0;
            },
          },
          async run(command, runOptions) {
            assertNotAborted(runOptions.signal);
            const started = performance.now();
            const result = await raw.process.exec({
              command: commandString(command),
              name: `sandbox-sdk-${randomUUID()}`,
              workingDir: runOptions.cwd,
              env: { ...runOptions.env },
              timeout: seconds(runOptions.timeout),
              waitForCompletion: true,
            });
            assertNotAborted(runOptions.signal);
            return {
              stdout: result.stdout ?? "",
              stderr: result.stderr ?? "",
              exitCode: result.exitCode ?? 1,
              success: result.exitCode === 0,
              durationMs: Math.round(performance.now() - started),
            };
          },
          async start(command, runOptions) {
            assertNotAborted(runOptions.signal);
            const result = await raw.process.exec({
              command: commandString(command),
              name: `sandbox-sdk-${randomUUID()}`,
              workingDir: runOptions.cwd,
              env: { ...runOptions.env },
              timeout: seconds(runOptions.timeout),
              waitForCompletion: false,
            });
            const pid = result.pid;
            const output = createProcessEventQueue();
            let state: "running" | "exited" | "killed" = "running";
            const isKilled = () => state === "killed";
            let exitCode = 1;
            let streamError: Error | undefined;
            const stream = raw.process.streamLogs(pid, {
              onStdout: (data) => output.push("stdout", data),
              onStderr: (data) => output.push("stderr", data),
              onError: (error) => {
                streamError = error;
                output.finish(error);
              },
            });
            const closeForSandboxStop = () => {
              state = "killed";
              exitCode = 137;
              stream.close();
              output.finish();
            };
            activeProcessCleanups.add(closeForSandboxStop);
            const killProcess = async () => {
              if (isKilled()) return;
              await raw.process.kill(pid);
              closeForSandboxStop();
            };
            const abort = () => void killProcess().catch(() => undefined);
            runOptions.signal?.addEventListener("abort", abort, { once: true });
            if (runOptions.signal?.aborted) abort();

            const completed = (async () => {
              const maxWait = runOptions.timeout ?? 24 * 60 * 60 * 1_000;
              const waitStarted = Date.now();
              try {
                await waitWithTimeout(stream.wait(), maxWait);
                if (streamError) throw streamError;
                if (isKilled()) return { exitCode };
                let final = await raw.process.get(pid);
                if ((final.status ?? "running") === "running") {
                  const remaining = maxWait - (Date.now() - waitStarted);
                  if (remaining <= 0) throw new Error("Process did not finish in time");
                  final = await raw.process.wait(pid, { maxWait: remaining, interval: 250 });
                }
                if (!isKilled()) {
                  exitCode = final.exitCode ?? 1;
                  state =
                    final.status === "killed" || final.status === "stopped" ? "killed" : "exited";
                }
                output.finish();
                return { exitCode };
              } catch (error) {
                if (state === "running") {
                  await raw.process.kill(pid).catch(() => undefined);
                  state = "killed";
                }
                stream.close();
                await stream.wait().catch(() => undefined);
                output.finish(asError(error));
                throw error;
              } finally {
                runOptions.signal?.removeEventListener("abort", abort);
                activeProcessCleanups.delete(closeForSandboxStop);
                output.finish();
              }
            })();
            void completed.catch(() => undefined);

            return {
              id: pid,
              async status() {
                if (state !== "running") return state;
                const current = await raw.process.get(pid);
                if (current.status === "running") return "running";
                if (current.status === "killed" || current.status === "stopped") return "killed";
                return "exited";
              },
              output: () => output.iterate(),
              async write() {
                unsupported("blaxel", "process.stdin");
              },
              wait: () => completed,
              kill: killProcess,
            } satisfies SandboxProcess;
          },
          async expose(port) {
            const { url, token } = await createPreviewAccess(raw, port);
            if (!token) return portResult(port, url, true, false);
            return portResult(port, url, false, true, (path = "/", init = {}) =>
              authenticatedPortRequest("blaxel", url, path, init, {
                "x-blaxel-preview-token": token,
              }),
            );
          },
          snapshots: unsupportedSnapshots("blaxel"),
          async stop() {
            for (const cleanup of activeProcessCleanups) cleanup();
            activeProcessCleanups.clear();
            await raw.delete();
          },
        };
      },
    },
    configuredPorts,
    {
      // Blaxel automatically enters standby; resuming only needs to wait until it is ready.
      resume: async (sandbox) => {
        await sandbox.raw.wait();
      },
      getPortUrl: async (sandbox, port, protocol) => {
        const { url, token } = await createPreviewAccess(sandbox.raw, port);
        const target = new URL(url);
        if (token) target.searchParams.set("bl_preview_token", token);
        if (protocol) target.protocol = `${protocol}:`;
        return target.toString().replace(/\/$/, "");
      },
      destroy: async (sandbox) => {
        await sandbox.raw.delete();
      },
    },
  );
}

const maxBufferedProcessOutputBytes = 1024 * 1024;
const textEncoder = new TextEncoder();

function createProcessEventQueue() {
  const events: Array<{ event: ProcessOutputEvent; bytes: number }> = [];
  const waiters = new Set<() => void>();
  let firstEvent = 0;
  let bufferedBytes = 0;
  let finished = false;
  let terminalError: Error | undefined;
  const wake = () => {
    for (const waiter of waiters) waiter();
    waiters.clear();
  };
  const hasEvents = () => firstEvent < events.length;
  const takeEvent = () => {
    const event = events[firstEvent++]!;
    if (firstEvent === events.length) {
      events.length = 0;
      firstEvent = 0;
    } else if (firstEvent * 2 >= events.length) {
      events.splice(0, firstEvent);
      firstEvent = 0;
    }
    return event;
  };

  return {
    push(stream: "stdout" | "stderr", data: string) {
      if (finished) return;
      const bytes = textEncoder.encode(data).byteLength;
      events.push({ event: { stream, data, timestamp: new Date() }, bytes });
      bufferedBytes += bytes;
      while (bufferedBytes > maxBufferedProcessOutputBytes && hasEvents()) {
        bufferedBytes -= takeEvent().bytes;
      }
      wake();
    },
    finish(error?: Error) {
      terminalError ??= error;
      if (finished) return;
      finished = true;
      wake();
    },
    async *iterate(): AsyncIterable<ProcessOutputEvent> {
      while (!finished || hasEvents()) {
        while (hasEvents()) {
          const next = takeEvent();
          bufferedBytes -= next.bytes;
          yield next.event;
        }
        if (finished) break;
        await new Promise<void>((resolve) => waiters.add(resolve));
      }
      if (terminalError) throw terminalError;
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitWithTimeout(promise: Promise<void>, milliseconds: number): Promise<void> {
  if (!Number.isFinite(milliseconds)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Process did not finish in time")), milliseconds);
    timer.unref?.();
  });
  try {
    await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let configuredAuthentication: "implicit" | { apiKey: string; workspace: string } | undefined;

function configureBlaxel(apiKey?: string, workspace?: string): void {
  const resolvedApiKey = apiKey ?? process.env.BL_API_KEY;
  const resolvedWorkspace = workspace ?? process.env.BL_WORKSPACE;
  if (!resolvedApiKey && !resolvedWorkspace) {
    configuredAuthentication ??= "implicit";
    return;
  }
  if (!resolvedApiKey || !resolvedWorkspace) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "blaxel",
      operation: "sandbox.create",
      message: "Blaxel authentication requires both apiKey and workspace",
    });
  }

  if (
    configuredAuthentication === "implicit" ||
    (typeof configuredAuthentication === "object" &&
      (configuredAuthentication.apiKey !== resolvedApiKey ||
        configuredAuthentication.workspace !== resolvedWorkspace))
  ) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "blaxel",
      operation: "sandbox.create",
      message: "Blaxel uses process-global authentication and cannot mix credential pairs",
    });
  }
  if (!configuredAuthentication) {
    initialize({ apiKey: resolvedApiKey, workspace: resolvedWorkspace });
    configuredAuthentication = { apiKey: resolvedApiKey, workspace: resolvedWorkspace };
  }
}

function seconds(milliseconds?: number): number | undefined {
  return milliseconds === undefined ? undefined : Math.ceil(milliseconds / 1_000);
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export type BlaxelSandbox = SandboxInstance;
