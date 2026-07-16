import { Daytona, type Sandbox as DaytonaSandbox } from "@daytona/sdk";
import { randomUUID } from "node:crypto";
import { normalizeError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { ProcessOutputEvent, SandboxProcess } from "../../core/types";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { daytonaCapabilities } from "../capabilities";
import { withManagedSessions } from "../../internal/managed-provider";

export interface DaytonaOptions {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  image?: string;
  language?: string;
  name?: string;
  public?: boolean;
}

export { daytonaCapabilities } from "../capabilities";

export function daytona(options: DaytonaOptions = {}): SandboxProvider<DaytonaSandbox> {
  return withManagedSessions(
    {
      id: "daytona",
      capabilities: daytonaCapabilities,
      async create(createOptions) {
        const client = new Daytona({
          apiKey: options.apiKey,
          apiUrl: options.apiUrl,
          target: options.target,
        });
        const raw = await client.create(
          {
            ...(options.image ? { image: options.image } : {}),
            language: options.language,
            name: options.name,
            public: options.public,
            envVars: { ...createOptions.env },
          },
          {
            timeout: createOptions.timeout ? Math.ceil(createOptions.timeout / 1_000) : undefined,
          },
        );
        let remoteCwd: string;
        try {
          const nativeWorkDir = (await raw.getWorkDir()) ?? createOptions.cwd;
          remoteCwd = `${nativeWorkDir.replace(/\/$/, "")}/${createOptions.cwd.replace(/^\/+/, "")}`;
          try {
            await raw.fs.getFileDetails(remoteCwd);
          } catch (error) {
            if (!isDaytonaNotFound(error, "sandbox.create.cwd")) throw error;
            await raw.fs.createFolder(remoteCwd, "755");
          }
        } catch (error) {
          await client.delete(raw);
          throw error;
        }
        const toRemotePath = (path: string) =>
          replacePathPrefix(path, createOptions.cwd, remoteCwd);
        const toVirtualPath = (path: string) =>
          replacePathPrefix(path, remoteCwd, createOptions.cwd);
        return {
          id: raw.id,
          raw,
          capabilities: daytonaCapabilities,
          files: {
            async write(path, value) {
              await raw.fs.uploadFile(Buffer.from(await toUint8Array(value)), toRemotePath(path));
            },
            async read(path) {
              return new Uint8Array(await raw.fs.downloadFile(toRemotePath(path)));
            },
            async list(path) {
              const remotePath = toRemotePath(path);
              return (await raw.fs.listFiles(remotePath)).map((entry) => ({
                name: entry.name,
                path: toVirtualPath(entry.path ?? `${remotePath.replace(/\/$/, "")}/${entry.name}`),
                type: entry.isDir ? ("directory" as const) : ("file" as const),
                size: entry.size,
              }));
            },
            async mkdir(path) {
              await raw.fs.createFolder(toRemotePath(path), "755");
            },
            async remove(path) {
              await raw.fs.deleteFile(toRemotePath(path), true);
            },
            async exists(path) {
              try {
                await raw.fs.getFileDetails(toRemotePath(path));
                return true;
              } catch (error) {
                if (isDaytonaNotFound(error, "files.exists")) return false;
                throw error;
              }
            },
          },
          async run(command, runOptions) {
            try {
              const started = performance.now();
              const result = await raw.process.executeCommand(
                commandString(command),
                toRemotePath(runOptions.cwd!),
                { ...runOptions.env },
                runOptions.timeout ? Math.ceil(runOptions.timeout / 1_000) : undefined,
              );
              return {
                stdout: result.result,
                stderr: "",
                exitCode: result.exitCode,
                success: result.exitCode === 0,
                durationMs: Math.round(performance.now() - started),
              };
            } catch (error) {
              throw normalizeError("daytona", "process.run", error);
            }
          },
          async start(command, runOptions) {
            const sessionId = `sandbox-sdk-${randomUUID()}`;
            await raw.process.createSession(sessionId);
            const response = await raw.process.executeSessionCommand(
              sessionId,
              {
                command: sessionCommand(
                  commandString(command),
                  toRemotePath(runOptions.cwd!),
                  runOptions.env,
                ),
                runAsync: true,
                suppressInputEcho: true,
              },
              runOptions.timeout ? Math.ceil(runOptions.timeout / 1_000) : undefined,
            );
            const commandId = response.cmdId;
            const events: ProcessOutputEvent[] = [];
            const waiters = new Set<() => void>();
            let running = true;
            let killed = false;
            let exitCode = 1;
            let resolveKilled!: () => void;
            const killedPromise = new Promise<void>((resolve) => {
              resolveKilled = resolve;
            });
            const push = (stream: "stdout" | "stderr", data: string) => {
              events.push({ stream, data, timestamp: new Date() });
              for (const wake of waiters) wake();
              waiters.clear();
            };
            const completed = raw.process
              .getSessionCommandLogs(
                sessionId,
                commandId,
                (data) => push("stdout", data),
                (data) => push("stderr", data),
              )
              .then(async () => {
                const info = await raw.process.getSessionCommand(sessionId, commandId);
                exitCode = info.exitCode ?? 1;
              })
              .catch((error) => {
                if (!killed) throw error;
              })
              .finally(() => {
                running = false;
                for (const wake of waiters) wake();
                waiters.clear();
              });
            const process: SandboxProcess = {
              id: commandId,
              async status() {
                if (killed) return "killed";
                if (!running) return "exited";
                const commandInfo = await raw.process.getSessionCommand(sessionId, commandId);
                return commandInfo.exitCode == null ? "running" : "exited";
              },
              async *output() {
                let index = 0;
                while (running || index < events.length) {
                  while (index < events.length) yield events[index++]!;
                  if (!running) break;
                  await new Promise<void>((resolve) => waiters.add(resolve));
                }
              },
              write: (value) =>
                raw.process.sendSessionCommandInput(
                  sessionId,
                  commandId,
                  typeof value === "string" ? value : new TextDecoder().decode(value),
                ),
              async wait() {
                await Promise.race([completed, killedPromise]);
                return { exitCode };
              },
              async kill() {
                killed = true;
                try {
                  await raw.process.deleteSession(sessionId);
                } catch (error) {
                  killed = false;
                  throw error;
                }
                exitCode = 137;
                running = false;
                resolveKilled();
                for (const wake of waiters) wake();
                waiters.clear();
              },
            };
            return process;
          },
          async expose(port) {
            const preview = await raw.getPreviewLink(port);
            return portResult(port, preview.url, raw.public, !raw.public, (path = "/", init = {}) =>
              fetch(new URL(path, preview.url), {
                ...init,
                headers: {
                  ...Object.fromEntries(new Headers(init.headers)),
                  ...(preview.token ? { "x-daytona-preview-token": preview.token } : {}),
                },
              }),
            );
          },
          snapshots: unsupportedSnapshots("daytona"),
          async stop() {
            await client.delete(raw);
          },
        };
      },
    },
    [],
    {
      stop: (sandbox) => sandbox.raw.stop(),
      resume: (sandbox) => sandbox.raw.start(),
      destroy: (sandbox) => sandbox.raw.delete(),
    },
  );
}

export type { DaytonaSandbox };

function isDaytonaNotFound(error: unknown, operation: string): boolean {
  if (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    error.statusCode === 404
  ) {
    return true;
  }
  return normalizeError("daytona", operation, error).code === "not_found";
}

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  const prefix = `${from.replace(/\/$/, "")}/`;
  return path.startsWith(prefix) ? `${to.replace(/\/$/, "")}/${path.slice(prefix.length)}` : path;
}

function sessionCommand(
  command: string,
  cwd: string,
  env: Readonly<Record<string, string>> | undefined,
): string {
  const assignments = Object.entries(env ?? {}).map(([key, value]) =>
    shellQuote(`${key}=${value}`),
  );
  return `cd ${shellQuote(cwd)} && ${assignments.length ? `env ${assignments.join(" ")} ` : ""}${command}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
