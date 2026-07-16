import { Box, type BoxConfig, type ExecStreamChunk } from "@upstash/box";
import { SandboxError } from "../../core/errors";
import type { SandboxNetworkPolicy, SandboxProvider } from "../../core/provider";
import type {
  CommandInput,
  ProcessOutputEvent,
  RunOptions,
  SandboxProcess,
  SandboxSnapshot,
} from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupported,
} from "../../internal/provider-utils";
import { upstashCapabilities } from "../capabilities";

export type UpstashOptions = Omit<BoxConfig, "env"> & {
  /** Expose ports publicly. Set to false to return bearer-token URLs. */
  public?: boolean;
};

export { upstashCapabilities } from "../capabilities";

export function upstash(options: UpstashOptions = {}): SandboxProvider<Box> {
  const { public: publicPorts = true, ...boxOptions } = options;

  return withManagedSessions(
    {
      id: "upstash",
      capabilities: upstashCapabilities,
      async create(createOptions) {
        assertNotAborted(createOptions.signal);
        const raw = await Box.create({
          ...boxOptions,
          env: { ...createOptions.env },
          timeout: boxOptions.timeout ?? createOptions.timeout,
        });
        const remoteCwd = raw.cwd;
        const toRemotePath = (path: string) =>
          replacePathPrefix(path, createOptions.cwd, remoteCwd);
        const toVirtualPath = (path: string) =>
          replacePathPrefix(path, remoteCwd, createOptions.cwd);

        return {
          id: raw.id,
          raw,
          capabilities: upstashCapabilities,
          files: {
            async write(path, value) {
              const content = Buffer.from(await toUint8Array(value)).toString("base64");
              await raw.files.write({
                path: toRemotePath(path),
                content,
                encoding: "base64",
              });
            },
            async read(path) {
              const content = await raw.files.read(toRemotePath(path), {
                encoding: "base64",
              });
              return new Uint8Array(Buffer.from(content, "base64"));
            },
            async list(path) {
              return (await raw.files.list(toRemotePath(path))).map((entry) => ({
                name: entry.name,
                path: toVirtualPath(entry.path),
                type: entry.is_dir ? ("directory" as const) : ("file" as const),
                size: entry.size,
              }));
            },
            async mkdir(path) {
              const result = await raw.exec.command(`mkdir -p ${shellQuote(toRemotePath(path))}`);
              assertCommandSucceeded(result.exitCode, result.result, "files.mkdir");
            },
            async remove(path) {
              const result = await raw.exec.command(`rm -rf -- ${shellQuote(toRemotePath(path))}`);
              assertCommandSucceeded(result.exitCode, result.result, "files.remove");
            },
            async exists(path) {
              const result = await raw.exec.command(`test -e ${shellQuote(toRemotePath(path))}`);
              return result.exitCode === 0;
            },
          },
          async run(command, runOptions) {
            assertNotAborted(runOptions.signal);
            const started = performance.now();
            const run = await raw.exec.command(
              scopedCommand(command, runOptions, createOptions.cwd, remoteCwd),
            );
            if (runOptions.timeout !== undefined && run.exitCode === 124) {
              throw new SandboxError({
                code: "timeout",
                provider: "upstash",
                operation: "process.run",
                message: `Command timed out after ${runOptions.timeout}ms`,
              });
            }
            return {
              stdout: run.result,
              stderr: "",
              exitCode: run.exitCode ?? 1,
              success: run.exitCode === 0,
              durationMs: Math.round(performance.now() - started),
            };
          },
          async start(command, runOptions) {
            assertNotAborted(runOptions.signal);
            const handle = await raw.exec.stream(
              scopedCommand(command, runOptions, createOptions.cwd, remoteCwd),
            );
            const events: ProcessOutputEvent[] = [];
            const waiters = new Set<() => void>();
            let status: "running" | "exited" = "running";
            let exitCode = 1;
            const wake = () => {
              for (const waiter of waiters) waiter();
              waiters.clear();
            };
            const streamCompleted = consumeStream(handle, (chunk) => {
              if (chunk.type === "output") {
                events.push({
                  stream: "stdout",
                  data: chunk.data,
                  timestamp: new Date(),
                });
                wake();
              } else {
                exitCode = chunk.exitCode;
              }
            })
              .then(() => {
                if (status === "running") status = "exited";
                return { exitCode };
              })
              .catch((error: unknown) => {
                status = "exited";
                throw error;
              })
              .finally(() => {
                wake();
              });

            return {
              id: handle.id,
              async status() {
                return status;
              },
              async *output() {
                let index = 0;
                while (status === "running" || index < events.length) {
                  while (index < events.length) yield events[index++]!;
                  if (status !== "running") break;
                  await new Promise<void>((resolve) => waiters.add(resolve));
                }
              },
              async write() {
                unsupported("upstash", "process.stdin");
              },
              wait: () => streamCompleted,
              async kill() {
                unsupported("upstash", "process.cancel");
              },
            } satisfies SandboxProcess;
          },
          async expose(port) {
            const preview = await raw.getPublicURL(
              port,
              publicPorts ? undefined : { bearerToken: true },
            );
            const token = preview.token;
            return portResult(
              port,
              preview.url,
              !token,
              Boolean(token),
              token
                ? (path = "/", init = {}) =>
                    fetch(new URL(path, preview.url), {
                      ...init,
                      headers: {
                        ...Object.fromEntries(new Headers(init.headers)),
                        authorization: `Bearer ${token}`,
                      },
                    })
                : undefined,
            );
          },
          snapshots: {
            async create(snapshotOptions) {
              const snapshot = await raw.snapshot({
                name: snapshotOptions?.name ?? `sandbox-sdk-${Date.now()}`,
              });
              return {
                id: snapshot.id,
                name: snapshot.name,
                mode: "filesystem",
                createdAt: timestamp(snapshot.created_at),
              } satisfies SandboxSnapshot;
            },
            async delete(snapshot) {
              await raw.deleteSnapshot(typeof snapshot === "string" ? snapshot : snapshot.id);
            },
            async restore() {
              unsupported("upstash", "snapshot.restore");
            },
          },
          async stop() {
            await raw.delete();
          },
        };
      },
    },
    [],
    {
      stop: (sandbox) => sandbox.raw.pause(),
      resume: (sandbox) => sandbox.raw.resume(),
      destroy: (sandbox) => sandbox.raw.delete(),
      setNetworkPolicy: (sandbox, policy) => sandbox.raw.updateNetworkPolicy(networkPolicy(policy)),
    },
  );
}

async function consumeStream(
  stream: AsyncIterable<ExecStreamChunk>,
  onChunk: (chunk: ExecStreamChunk) => void,
): Promise<void> {
  for await (const chunk of stream) onChunk(chunk);
}

function scopedCommand(
  input: CommandInput,
  options: RunOptions,
  virtualCwd: string,
  remoteCwd: string,
): string {
  const environment = Object.entries(options.env ?? {}).map(([key, value]) =>
    shellQuote(`${key}=${value}`),
  );
  const command = commandString(input);
  const shell = `sh -c ${shellQuote(command)}`;
  const timed = options.timeout
    ? `timeout ${Math.max(1, Math.ceil(options.timeout / 1_000))}s ${shell}`
    : shell;
  const cwd = replacePathPrefix(options.cwd ?? virtualCwd, virtualCwd, remoteCwd);
  return `cd ${shellQuote(cwd)} && ${
    environment.length ? `env ${environment.join(" ")} ` : ""
  }${timed} 2>&1`;
}

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function assertCommandSucceeded(exitCode: number | null, output: string, operation: string): void {
  if (exitCode === 0) return;
  throw new Error(`${operation} failed${output ? `: ${output}` : ""}`);
}

function timestamp(value: number): Date {
  return new Date(value < 1_000_000_000_000 ? value * 1_000 : value);
}

function networkPolicy(policy: SandboxNetworkPolicy): import("@upstash/box").NetworkPolicy {
  if (policy.mode === "allow-all" || policy.mode === "deny-all") return { mode: policy.mode };
  if (policy.mode === "native") return policy.value as import("@upstash/box").NetworkPolicy;
  return {
    mode: "custom",
    allowedDomains: [...(policy.allowedHosts ?? [])],
    allowedCidrs: [...(policy.allowedCIDRs ?? [])],
    deniedCidrs: [...(policy.deniedCIDRs ?? [])],
  };
}

export type UpstashBox = Box;
