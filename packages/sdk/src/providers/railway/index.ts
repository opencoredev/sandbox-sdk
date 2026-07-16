import { Sandbox as RailwaySandbox } from "railway";
import { normalizeError, SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { ProcessOutputEvent, SandboxProcess, SandboxSnapshot } from "../../core/types";
import { commandString, toUint8Array, unsupported } from "../../internal/provider-utils";
import { withManagedSessions } from "../../internal/managed-provider";
import { railwayCapabilities } from "../capabilities";

export interface RailwayOptions {
  /** Railway API token. Defaults to `RAILWAY_API_TOKEN`. */
  token?: string;
  /** Target environment. Defaults to `RAILWAY_ENVIRONMENT_ID`. */
  environmentId?: string;
  /** Minutes of idle time before Railway auto-destroys the sandbox. */
  idleTimeoutMinutes?: number;
  /** `ISOLATED` (default, egress only) or `PRIVATE` (joins the environment network). */
  networkIsolation?: "ISOLATED" | "PRIVATE";
}

export { railwayCapabilities } from "../capabilities";

export function railway(options: RailwayOptions = {}): SandboxProvider<RailwaySandbox> {
  return withManagedSessions(
    {
      id: "railway",
      capabilities: railwayCapabilities,
      async create(createOptions) {
        const idleTimeoutMinutes =
          options.idleTimeoutMinutes ??
          (createOptions.timeout ? Math.max(1, Math.ceil(createOptions.timeout / 60_000)) : undefined);
        const raw = await RailwaySandbox.create({
          token: options.token,
          environmentId: options.environmentId,
          idleTimeoutMinutes,
          networkIsolation: options.networkIsolation,
          env: { ...createOptions.env },
        });
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
              await raw.files.write(path, await toUint8Array(value));
            },
            async read(path) {
              const result = await raw.files.read(path, { format: "bytes" });
              return result instanceof Uint8Array ? result : new Uint8Array(result);
            },
            async list(path) {
              const entries = await raw.files.list(path);
              const base = path.replace(/\/$/, "");
              return entries.map((entry) => ({
                name: entry.name,
                path: `${base}/${entry.name}`,
                type: entry.isDir ? ("directory" as const) : ("file" as const),
                size: entry.size,
              }));
            },
            mkdir: (path) => raw.files.mkdir(path),
            remove: (path) => raw.files.remove(path),
            exists: (path) => raw.files.exists(path),
          },
          async run(command, runOptions) {
            try {
              assertNotAborted(runOptions.signal, "process.run");
              const started = performance.now();
              const handle = raw.exec(commandString(command), {
                cwd: runOptions.cwd,
                env: runOptions.env ? { ...runOptions.env } : undefined,
                timeoutSec: runOptions.timeout ? Math.ceil(runOptions.timeout / 1_000) : undefined,
              });
              const result = await withAbort(handle, runOptions.signal, async () => {
                await handle.kill();
              });
              return {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode ?? 1,
                success: result.exitCode === 0,
                durationMs: Math.round(performance.now() - started),
              };
            } catch (error) {
              throw normalizeError("railway", "process.run", error);
            }
          },
          async start(command, runOptions) {
            assertNotAborted(runOptions.signal, "process.start");
            const events: ProcessOutputEvent[] = [];
            const waiters = new Set<() => void>();
            let running = true;
            const push = (stream: "stdout" | "stderr", data: string) => {
              events.push({ stream, data, timestamp: new Date() });
              for (const wake of waiters) wake();
              waiters.clear();
            };
            const handle = raw.exec(commandString(command), {
              cwd: runOptions.cwd,
              env: runOptions.env ? { ...runOptions.env } : undefined,
              timeoutSec: runOptions.timeout ? Math.ceil(runOptions.timeout / 1_000) : undefined,
              onStdout: (data) => push("stdout", data),
              onStderr: (data) => push("stderr", data),
            });
            const completed = handle.then((result) => ({
              exitCode: result.exitCode ?? 1,
            }));
            const finish = () => {
              running = false;
              for (const wake of waiters) wake();
              waiters.clear();
            };
            void completed.then(finish, finish);
            const abort = () => {
              void handle.kill();
              finish();
            };
            runOptions.signal?.addEventListener("abort", abort, { once: true });
            void completed.finally(() => runOptions.signal?.removeEventListener("abort", abort));
            const process: SandboxProcess = {
              id: await handle.sessionName,
              async status() {
                return running ? "running" : "exited";
              },
              async *output() {
                let index = 0;
                while (running || index < events.length) {
                  while (index < events.length) yield events[index++]!;
                  if (!running) break;
                  await new Promise<void>((resolve) => waiters.add(resolve));
                }
              },
              async write() {
                unsupported("railway", "process.stdin");
              },
              wait: () => completed,
              async kill() {
                await handle.kill();
                finish();
              },
            };
            return process;
          },
          async expose() {
            unsupported("railway", "ports.expose");
          },
          snapshots: {
            async create(snapshotOptions) {
              const fork = await raw.fork();
              return {
                id: fork.id,
                name: snapshotOptions?.name,
                mode: "fork",
              } satisfies SandboxSnapshot;
            },
            async delete(snapshot) {
              const id = typeof snapshot === "string" ? snapshot : snapshot.id;
              const target = await RailwaySandbox.connect(id, {
                token: options.token,
                environmentId: options.environmentId,
              });
              await target.destroy();
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
    },
    [],
    {
      destroy: async (sandbox) => {
        await sandbox.raw.destroy();
      },
    },
  );
}

export type { RailwaySandbox };

function assertNotAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw interrupted(operation);
}

function interrupted(operation: string): SandboxError {
  return new SandboxError({
    code: "terminated",
    provider: "railway",
    operation,
    message: "Operation was aborted",
  });
}

async function withAbort<T>(
  work: PromiseLike<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void | Promise<void>,
): Promise<T> {
  if (!signal) return await work;
  if (signal.aborted) {
    await onAbort();
    throw interrupted("process.run");
  }
  return await new Promise<T>((resolve, reject) => {
    const abort = () => {
      void Promise.resolve(onAbort()).finally(() => reject(interrupted("process.run")));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
