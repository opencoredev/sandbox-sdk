import { Sandbox as E2BSandbox } from "e2b";
import { defineAdapter } from "../../core/adapter";
import { normalizeError } from "../../core/errors";
import type { SandboxRuntime } from "../../core/provider";
import type {
  ProcessOutputEvent,
  SandboxProcess,
  SandboxSnapshot,
  SandboxSummary,
} from "../../core/types";
import {
  assertNotAborted,
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

export function e2b(options: E2BOptions = {}): import("../../core/adapter").SandboxAdapter<E2BSandbox> {
  const buildRuntime = (raw: E2BSandbox): SandboxRuntime<E2BSandbox> => {
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
        async stat(path) {
          const info = await raw.files.getInfo(path);
          return {
            path,
            type: info.symlinkTarget
              ? ("symlink" as const)
              : info.type === "file"
                ? ("file" as const)
                : info.type === "dir"
                  ? ("directory" as const)
                  : ("unknown" as const),
            size: info.size,
            modifiedAt: info.modifiedTime,
          };
        },
        async move(source, destination) {
          await raw.files.rename(source, destination);
        },
        async watch(path, onEvent, watchOptions) {
          const handle = await raw.files.watchDir(
            path,
            (event) => {
              onEvent({
                type: event.type === "write" ? "modify" : event.type,
                path: event.name.startsWith("/")
                  ? event.name
                  : `${path.replace(/\/$/, "")}/${event.name}`,
              });
            },
            { recursive: watchOptions.recursive, signal: watchOptions.signal },
          );
          return { stop: () => handle.stop() };
        },
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
          await E2BSandbox.deleteSnapshot(typeof snapshot === "string" ? snapshot : snapshot.id, {
            apiKey: options.apiKey,
          });
        },
        async restore() {
          unsupported("e2b", "snapshot.restore");
        },
      },
      extendTimeout: (ms) => raw.setTimeout(ms),
      async info() {
        const info = await raw.getInfo();
        return {
          state: info.state === "running" ? ("running" as const) : ("paused" as const),
          createdAt: info.startedAt,
          template: info.templateId,
        };
      },
      async metrics() {
        const rows = await raw.getMetrics();
        return rows.map((row) => ({
          cpuMs: row.cpuUsedPct,
          memoryBytes: row.memUsed,
          timestamp: row.timestamp,
        }));
      },
      pty: {
        async create(ptyOptions) {
          const chunks: Uint8Array[] = [];
          let notify: (() => void) | undefined;
          let done = false;
          const handle = await raw.pty.create({
            cols: ptyOptions?.cols ?? 80,
            rows: ptyOptions?.rows ?? 24,
            cwd: ptyOptions?.cwd,
            envs: ptyOptions?.env ? { ...ptyOptions.env } : undefined,
            onData(data) {
              chunks.push(data);
              notify?.();
            },
          });
          void handle.wait().finally(() => {
            done = true;
            notify?.();
          });
          return {
            pid: handle.pid,
            write: async (data) => {
              const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
              await raw.pty.sendInput(handle.pid, bytes);
            },
            resize: async (cols, rows) => {
              await raw.pty.resize(handle.pid, { cols, rows });
            },
            async *output() {
              while (!done || chunks.length > 0) {
                const next = chunks.shift();
                if (next) {
                  yield next;
                  continue;
                }
                await new Promise<void>((resolve) => {
                  notify = resolve;
                });
              }
            },
            wait: async () => {
              try {
                const result = await handle.wait();
                return { exitCode: result.exitCode ?? 0 };
              } catch {
                return { exitCode: handle.exitCode ?? 1 };
              }
            },
            kill: async () => {
              await handle.kill();
            },
          };
        },
      },
      async destroy() {
        await raw.kill();
      },
      async stop() {
        if (typeof raw.pause === "function") await raw.pause();
        else await raw.kill();
      },
    };
  };
  return defineAdapter(
    withManagedSessions(
    {
      id: "e2b",
      capabilities: e2bCapabilities,
      async create(createOptions) {
        assertNotAborted(createOptions.signal);
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
        return buildRuntime(raw);
      },
      async connect(connectOptions) {
        const raw = await E2BSandbox.connect(connectOptions.id, {
          apiKey: options.apiKey,
          signal: connectOptions.signal,
        });
        await raw.files.makeDir(connectOptions.cwd).catch(() => undefined);
        return buildRuntime(raw);
      },
      async list(listOptions) {
        const paginator = E2BSandbox.list({ apiKey: options.apiKey });
        const summaries: SandboxSummary[] = [];
        while (paginator.hasNext) {
          const items = await paginator.nextItems({ signal: listOptions?.signal });
          for (const item of items) {
            summaries.push({
              id: item.sandboxId,
              provider: "e2b",
              name: item.name,
              state: item.state === "running" ? "running" : "paused",
              createdAt: item.startedAt,
            });
          }
        }
        return summaries;
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
    ),
  );
}

export type { E2BSandbox };
