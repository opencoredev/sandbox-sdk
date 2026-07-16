import { Sandbox as VercelSandbox, Snapshot as VercelSnapshot } from "@vercel/sandbox";
import { normalizeError, SandboxError } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type {
  CommandInput,
  ProcessOutputEvent,
  SandboxProcess,
  SandboxSnapshot,
} from "../../core/types";
import { portResult, toUint8Array, unsupported } from "../../internal/provider-utils";
import { vercelCapabilities } from "../capabilities";
import { withManagedSessions } from "../../internal/managed-provider";

interface VercelBaseOptions {
  runtime?: "node24" | "node22" | "node26" | "python3.13" | (string & {});
  name?: string;
  ports?: number[];
  persistent?: boolean;
}

export type VercelOptions = VercelBaseOptions &
  (
    | { token: string; teamId: string; projectId: string }
    | { token?: never; teamId?: never; projectId?: never }
  );

export { vercelCapabilities } from "../capabilities";

export function vercel(options: VercelOptions = {}): SandboxProvider<VercelSandbox> {
  return withManagedSessions(
    {
      id: "vercel",
      capabilities: vercelCapabilities,
      async create(createOptions) {
        const credentials =
          options.token && options.teamId && options.projectId
            ? {
                token: options.token,
                teamId: options.teamId,
                projectId: options.projectId,
              }
            : {};
        const exposed = new Set(options.ports ?? []);
        const raw = await VercelSandbox.create({
          ...credentials,
          runtime: options.runtime ?? "node24",
          name: options.name,
          ports: [...exposed],
          persistent: options.persistent,
          timeout: createOptions.timeout,
          env: { ...createOptions.env },
          signal: createOptions.signal,
        });
        const snapshots = new Map<string, VercelSnapshot>();
        await raw.fs.mkdir(createOptions.cwd, { recursive: true });
        return {
          id: raw.name,
          raw,
          capabilities: vercelCapabilities,
          files: {
            async write(path, value) {
              await raw.fs.writeFile(path, await toUint8Array(value));
            },
            async read(path) {
              return new Uint8Array(await raw.fs.readFile(path));
            },
            async list(path) {
              const entries = await raw.fs.readdir(path, {
                withFileTypes: true,
              });
              return Promise.all(
                entries.map(async (entry) => {
                  const entryPath = `${path.replace(/\/$/, "")}/${entry.name}`;
                  const info = await raw.fs.lstat(entryPath);
                  return {
                    name: entry.name,
                    path: entryPath,
                    type: entry.isFile()
                      ? ("file" as const)
                      : entry.isDirectory()
                        ? ("directory" as const)
                        : entry.isSymbolicLink()
                          ? ("symlink" as const)
                          : ("unknown" as const),
                    size: entry.isFile() ? info.size : undefined,
                  };
                }),
              );
            },
            async mkdir(path) {
              await raw.fs.mkdir(path, { recursive: true });
            },
            async remove(path) {
              await raw.fs.rm(path, { recursive: true, force: true });
            },
            exists: (path) => raw.fs.exists(path),
          },
          async run(command, runOptions) {
            try {
              const result = await runCommand(raw, command, runOptions, false);
              const [stdout, stderr] = await Promise.all([
                result.stdout({ signal: runOptions.signal }),
                result.stderr({ signal: runOptions.signal }),
              ]);
              if (
                runOptions.timeout !== undefined &&
                result.exitCode === 137 &&
                result.durationMs !== undefined &&
                result.durationMs >= runOptions.timeout
              ) {
                throw new SandboxError({
                  code: "timeout",
                  provider: "vercel",
                  operation: "process.run",
                  message: `Command timed out after ${runOptions.timeout}ms`,
                });
              }
              return {
                stdout,
                stderr,
                exitCode: result.exitCode,
                success: result.exitCode === 0,
                durationMs: result.durationMs,
              };
            } catch (error) {
              throw normalizeError("vercel", "process.run", error);
            }
          },
          async start(command, runOptions) {
            const handle = await runCommand(raw, command, runOptions, true);
            const events: ProcessOutputEvent[] = [];
            let running = true;
            const stream = handle.logs({ signal: runOptions.signal });
            const completed = handle.wait().then((result) => ({ exitCode: result.exitCode }));
            const process: SandboxProcess = {
              id: handle.cmdId,
              async status() {
                return running ? "running" : "exited";
              },
              async *output() {
                try {
                  for await (const event of stream) {
                    const normalized = {
                      stream: event.stream,
                      data: event.data,
                      timestamp: new Date(),
                    } satisfies ProcessOutputEvent;
                    events.push(normalized);
                    yield normalized;
                  }
                } finally {
                  running = false;
                }
              },
              async write() {
                unsupported("vercel", "process.stdin");
              },
              wait: () => completed,
              async kill(signal = "SIGTERM") {
                await handle.kill(signal as Parameters<typeof handle.kill>[0]);
                running = false;
              },
            };
            return process;
          },
          async expose(port) {
            if (!exposed.has(port)) {
              exposed.add(port);
              await raw.update({ ports: [...exposed] });
            }
            const url = raw.domain(port);
            return portResult(port, url, true, false);
          },
          snapshots: {
            async create() {
              const snapshot = await raw.snapshot();
              snapshots.set(snapshot.snapshotId, snapshot);
              return {
                id: snapshot.snapshotId,
                mode: "filesystem",
                createdAt: snapshot.createdAt,
              } satisfies SandboxSnapshot;
            },
            async delete(snapshot) {
              const id = typeof snapshot === "string" ? snapshot : snapshot.id;
              const native =
                snapshots.get(id) ?? (await VercelSnapshot.get({ snapshotId: id, ...credentials }));
              await native.delete();
              snapshots.delete(id);
            },
            async restore() {
              unsupported("vercel", "snapshot.restore");
            },
          },
          async stop() {
            if (raw.status !== "stopped") await raw.stop();
          },
        };
      },
    },
    options.ports,
    {
      stop: async (sandbox) => {
        await sandbox.raw.stop();
      },
      destroy: (sandbox) => sandbox.raw.delete(),
      setPorts: (sandbox, ports, signal) => sandbox.raw.update({ ports: [...ports] }, { signal }),
      setNetworkPolicy: (sandbox, policy) =>
        sandbox.raw.update({
          networkPolicy:
            policy.mode === "allow-all" || policy.mode === "deny-all"
              ? policy.mode
              : policy.mode === "native"
                ? (policy.value as import("@vercel/sandbox").NetworkPolicy)
                : { allow: [...(policy.allowedHosts ?? [])] },
        }),
    },
  );
}

async function runCommand(
  raw: VercelSandbox,
  input: CommandInput,
  options: import("../../core/types").RunOptions,
  detached: false,
): Promise<import("@vercel/sandbox").CommandFinished>;
async function runCommand(
  raw: VercelSandbox,
  input: CommandInput,
  options: import("../../core/types").RunOptions,
  detached: true,
): Promise<import("@vercel/sandbox").Command>;
async function runCommand(
  raw: VercelSandbox,
  input: CommandInput,
  options: import("../../core/types").RunOptions,
  detached: boolean,
) {
  const command = typeof input === "string" ? { command: "/bin/sh", args: ["-lc", input] } : input;
  return raw.runCommand({
    cmd: command.command,
    args: [...(command.args ?? [])],
    cwd: options.cwd,
    env: { ...options.env },
    signal: options.signal,
    timeoutMs: options.timeout,
    detached,
  });
}

export type { VercelSandbox };
