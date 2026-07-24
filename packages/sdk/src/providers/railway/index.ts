import {
  Sandbox as RailwaySandbox,
  type ExecHandle,
  type ExecSignal,
  type SandboxTemplate,
} from "railway";
import { SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { ProcessOutputEvent, SandboxProcess, SandboxSnapshot } from "../../core/types";
import { commandString, unsupported } from "../../internal/provider-utils";
import { railwayCapabilities } from "../capabilities";

interface RailwayBaseOptions {
  /** Railway API token. Defaults to RAILWAY_API_TOKEN. */
  token?: string;
  /** Railway environment id. Defaults to RAILWAY_ENVIRONMENT_ID. */
  environmentId?: string;
  /** Minutes before Railway destroys an idle sandbox. */
  idleTimeoutMinutes?: number;
  /** Whether the sandbox can access the environment's private network. */
  networkIsolation?: "ISOLATED" | "PRIVATE";
}

export type RailwayOptions = RailwayBaseOptions &
  ({ checkpoint?: string; template?: never } | { checkpoint?: never; template?: SandboxTemplate });

export { railwayCapabilities } from "../capabilities";

export function railway(options: RailwayOptions = {}): SandboxProvider<RailwaySandbox> {
  const credentials = {
    token: options.token,
    environmentId: options.environmentId,
  };

  return {
    id: "railway",
    capabilities: railwayCapabilities,
    async create(createOptions) {
      assertNotAborted(createOptions.signal);
      const createConfig = {
        ...credentials,
        idleTimeoutMinutes: options.idleTimeoutMinutes,
        networkIsolation: options.networkIsolation,
        env: { ...createOptions.env },
      };
      const pending = options.checkpoint
        ? RailwaySandbox.create(options.checkpoint, createConfig)
        : options.template
          ? RailwaySandbox.create(options.template, createConfig)
          : RailwaySandbox.create(createConfig);
      const raw = await awaitCreation(pending, createOptions.signal, createOptions.timeout);
      try {
        await raw.files.mkdir(createOptions.cwd);
      } catch (error) {
        await raw.destroy().catch(() => undefined);
        throw error;
      }

      return {
        id: raw.id,
        raw,
        capabilities: railwayCapabilities,
        files: {
          async write(path, value) {
            await raw.files.write(path, value);
          },
          read: (path) => raw.files.read(path, { format: "bytes" }),
          async list(path) {
            return (await raw.files.list(path)).map((entry) => ({
              name: entry.name,
              path: `${path.replace(/\/$/, "")}/${entry.name}`,
              type: entry.isDir ? ("directory" as const) : ("file" as const),
              size: entry.isDir ? undefined : entry.size,
            }));
          },
          mkdir: (path) => raw.files.mkdir(path),
          async remove(path) {
            const result = await raw.exec(
              commandString({ command: "rm", args: ["-rf", "--", path] }),
            );
            if (result.exitCode !== 0) {
              throw new Error(`files.remove failed: ${result.stderr || result.stdout}`);
            }
          },
          exists: (path) => raw.files.exists(path),
        },
        async run(command, runOptions) {
          assertNotAborted(runOptions.signal);
          const started = performance.now();
          const handle = raw.exec(commandString(command), {
            cwd: runOptions.cwd,
            env: { ...runOptions.env },
            timeoutSec: timeoutSeconds(runOptions.timeout),
          });
          const removeAbort = bindAbort(handle, runOptions.signal);
          try {
            const result = await handle;
            if (result.timedOut) {
              throw new SandboxError({
                code: "timeout",
                provider: "railway",
                operation: "process.run",
                message: `Command timed out after ${runOptions.timeout}ms`,
              });
            }
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode ?? -1,
              success: result.exitCode === 0,
              signal: result.exitCode === null ? "unknown" : undefined,
              durationMs: Math.round(performance.now() - started),
            };
          } finally {
            removeAbort();
          }
        },
        async start(command, runOptions) {
          assertNotAborted(runOptions.signal);
          const events: ProcessOutputEvent[] = [];
          const waiters = new Set<() => void>();
          let state: "running" | "exited" | "killed" = "running";
          const wake = () => {
            for (const waiter of waiters) waiter();
            waiters.clear();
          };
          const push = (stream: "stdout" | "stderr", data: string) => {
            events.push({ stream, data, timestamp: new Date() });
            wake();
          };
          const handle = raw.exec(commandString(command), {
            cwd: runOptions.cwd,
            env: { ...runOptions.env },
            timeoutSec: timeoutSeconds(runOptions.timeout),
            onStdout: (chunk) => push("stdout", chunk),
            onStderr: (chunk) => push("stderr", chunk),
          });
          const removeAbort = bindAbort(handle, runOptions.signal);
          const completed = handle
            .then((result) => ({ exitCode: result.exitCode ?? -1 }))
            .finally(() => {
              if (state === "running") state = "exited";
              removeAbort();
              wake();
            });
          const id = await handle.sessionName;

          return {
            id,
            async status() {
              return state;
            },
            async *output() {
              let index = 0;
              while (state === "running" || index < events.length) {
                while (index < events.length) yield events[index++]!;
                if (state !== "running") break;
                await new Promise<void>((resolve) => waiters.add(resolve));
              }
            },
            async write() {
              unsupported("railway", "process.stdin");
            },
            wait: () => completed,
            async kill(signal = "SIGTERM") {
              const nativeSignal = signal.replace(/^SIG/, "") as ExecSignal;
              await handle.kill(nativeSignal);
              state = "killed";
              wake();
            },
          } satisfies SandboxProcess;
        },
        async expose() {
          unsupported("railway", "ports.expose");
        },
        snapshots: {
          async create(snapshotOptions) {
            const checkpoint = await raw.checkpoint(
              snapshotOptions?.name ?? `sandbox-sdk-${Date.now()}`,
            );
            return {
              id: checkpoint.id,
              name: checkpoint.key,
              mode: "filesystem",
              createdAt: new Date(checkpoint.createdAt),
            } satisfies SandboxSnapshot;
          },
          async delete(snapshot) {
            await RailwaySandbox.deleteCheckpoint(
              typeof snapshot === "string" ? snapshot : snapshot.id,
              credentials,
            );
          },
          async restore() {
            unsupported("railway", "snapshot.restore");
          },
        },
        async stop() {
          await raw.destroy();
        },
      };
    },
  };
}

function timeoutSeconds(timeout?: number): number | undefined {
  return timeout === undefined ? undefined : Math.max(1, Math.ceil(timeout / 1_000));
}

function bindAbort(handle: ExecHandle, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  const abort = () => void handle.kill("TERM").catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

async function awaitCreation(
  promise: Promise<RailwaySandbox>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<RailwaySandbox> {
  if (!signal && timeoutMs === undefined) return promise;
  return new Promise<RailwaySandbox>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (timer) clearTimeout(timer);
      callback();
    };
    const onAbort = () =>
      finish(() => reject(signal?.reason ?? new DOMException("Aborted", "AbortError")));
    const timer = timeoutMs
      ? setTimeout(
          () => finish(() => reject(new Error(`Sandbox creation timed out after ${timeoutMs}ms`))),
          timeoutMs,
        )
      : undefined;
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (sandbox) => {
        if (settled) {
          void sandbox.destroy().catch(() => undefined);
          return;
        }
        finish(() => resolve(sandbox));
      },
      (error) => finish(() => reject(error)),
    );
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export type { RailwaySandbox, SandboxTemplate as RailwaySandboxTemplate };
