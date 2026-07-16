import { Sandbox as E2BSandbox } from "e2b";
import { normalizeError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type { ProcessOutputEvent, SandboxProcess, SandboxSnapshot } from "../../core/types";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupported,
} from "../../internal/provider-utils";
import { e2bCapabilities } from "../capabilities";
import { withManagedSessions } from "../../internal/managed-provider";

export interface E2BOptions {
  apiKey?: string;
  template?: string;
  timeout?: number;
}

export { e2bCapabilities } from "../capabilities";

export function e2b(options: E2BOptions = {}): SandboxProvider<E2BSandbox> {
  return withManagedSessions(
    {
      id: "e2b",
      capabilities: e2bCapabilities,
      async create(createOptions) {
        const create = {
          apiKey: options.apiKey,
          timeoutMs: options.timeout ?? createOptions.timeout,
          envs: { ...createOptions.env },
          signal: createOptions.signal,
        };
        const raw = options.template
          ? await E2BSandbox.create(options.template, create)
          : await E2BSandbox.create(create);
        try {
          await raw.files.makeDir(createOptions.cwd);
        } catch (error) {
          await raw.kill().catch(() => undefined);
          throw error;
        }
        return {
          id: raw.sandboxId,
          raw,
          capabilities: e2bCapabilities,
          files: {
            async write(path, value) {
              await raw.files.write(path, Uint8Array.from(await toUint8Array(value)).buffer);
            },
            read: (path) => raw.files.read(path, { format: "bytes" }),
            async list(path) {
              return (await raw.files.list(path)).map((entry) => ({
                name: entry.name,
                path: entry.path,
                type:
                  entry.type === "file"
                    ? ("file" as const)
                    : entry.type === "dir"
                      ? ("directory" as const)
                      : ("unknown" as const),
                size: entry.size,
              }));
            },
            async mkdir(path) {
              await raw.files.makeDir(path);
            },
            remove: (path) => raw.files.remove(path),
            exists: (path) => raw.files.exists(path),
          },
          async run(command, runOptions) {
            try {
              const started = performance.now();
              const result = await raw.commands.run(commandString(command), {
                cwd: runOptions.cwd,
                envs: { ...runOptions.env },
                timeoutMs: runOptions.timeout,
                signal: runOptions.signal,
              });
              return {
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                success: result.exitCode === 0,
                durationMs: Math.round(performance.now() - started),
              };
            } catch (error) {
              throw normalizeError("e2b", "process.run", error);
            }
          },
          async start(command, runOptions) {
            const events: ProcessOutputEvent[] = [];
            const waiters = new Set<() => void>();
            let running = true;
            const push = (stream: "stdout" | "stderr", data: string) => {
              events.push({ stream, data, timestamp: new Date() });
              for (const wake of waiters) wake();
              waiters.clear();
            };
            const handle = await raw.commands.run(commandString(command), {
              cwd: runOptions.cwd,
              envs: { ...runOptions.env },
              timeoutMs: runOptions.timeout,
              signal: runOptions.signal,
              background: true,
              stdin: true,
              onStdout: (data) => push("stdout", data),
              onStderr: (data) => push("stderr", data),
            });
            const completed = handle.wait().then((result) => ({ exitCode: result.exitCode }));
            const finish = () => {
              running = false;
              for (const wake of waiters) wake();
              waiters.clear();
            };
            void completed.then(finish, finish);
            const process: SandboxProcess = {
              id: String(handle.pid),
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
              write: (value) => handle.sendStdin(value),
              wait: () => completed,
              async kill() {
                await handle.kill();
                running = false;
              },
            };
            return process;
          },
          async expose(port) {
            const host = raw.getHost(port);
            const url = `https://${host}`;
            const token = raw.trafficAccessToken;
            return portResult(
              port,
              url,
              !token,
              Boolean(token),
              token
                ? (path = "/", init = {}) =>
                    fetch(new URL(path, url), {
                      ...init,
                      headers: {
                        ...Object.fromEntries(new Headers(init.headers)),
                        "x-access-token": token,
                      },
                    })
                : undefined,
            );
          },
          snapshots: {
            async create(snapshotOptions) {
              const snapshot = await raw.createSnapshot({ name: snapshotOptions?.name });
              return {
                id: snapshot.snapshotId,
                name: snapshot.names[0],
                mode: "template",
              } as SandboxSnapshot;
            },
            async delete(snapshot) {
              await E2BSandbox.deleteSnapshot(
                typeof snapshot === "string" ? snapshot : snapshot.id,
                {
                  apiKey: options.apiKey,
                },
              );
            },
            async restore() {
              unsupported("e2b", "snapshot.restore");
            },
          },
          async stop() {
            await raw.kill();
          },
        };
      },
    },
    [],
    {
      stop: async (sandbox) => {
        await sandbox.raw.pause();
      },
      resume: async (sandbox) => {
        await sandbox.raw.connect();
      },
      destroy: async (sandbox) => {
        await sandbox.raw.kill();
      },
    },
  );
}

export type { E2BSandbox };
