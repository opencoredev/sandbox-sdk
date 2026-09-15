import {
  TenkiSandbox,
  type ExecResult,
  type ProcessRunHandle,
  type Session as TenkiSession,
  type Template,
  type TemplateImageRef,
  type VolumeMountConfig,
} from "@tenkicloud/sandbox";
import {
  isSandboxError,
  normalizeError,
  SandboxError,
  type SandboxErrorCode,
} from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type {
  CommandInput,
  ProcessOutputEvent,
  SandboxProcess,
  SandboxSnapshot,
} from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import { portResult, toUint8Array, unsupported } from "../../internal/provider-utils";
import { tenkiCapabilities } from "../capabilities";

/** Root of the guest file API. Paths outside it are rejected by the Tenki guest agent. */
const GUEST_HOME = "/home/tenki";
/** How long to keep draining stdout/stderr after the process exited before giving up on the pipes. */
const OUTPUT_DRAIN_GRACE_MS = 1_000;
const decoder = new TextDecoder();

interface TenkiBaseOptions {
  /** Workspace API key. Defaults to TENKI_API_KEY or TENKI_AUTH_TOKEN. */
  authToken?: string;
  /** API endpoint. Defaults to TENKI_API_ENDPOINT or https://api.tenki.cloud. */
  baseUrl?: string;
  /** Reuse an existing client instead of constructing one from authToken and baseUrl. */
  client?: TenkiSandbox;
  /** Session name shown in the Tenki dashboard. */
  name?: string;
  /** vCPUs, 1 to 16. Defaults to 2. */
  cpuCores?: number;
  /** Memory in MB, 512 to 65536. Defaults to 4096. */
  memoryMb?: number;
  /** Root disk size in GB. */
  diskSizeGb?: number;
  /** Minutes of inactivity before Tenki pauses the session. */
  idleTimeoutMinutes?: number;
  /** Maximum session lifetime in milliseconds. Ignored when sticky is true. */
  maxDurationMs?: number;
  /** Keep the session running without idle pauses or a maximum duration. */
  sticky?: boolean;
  /** Allow inbound traffic so ports can be exposed. Defaults to true. */
  allowInbound?: boolean;
  /** Allow outbound network access from the guest. Defaults to true. */
  allowOutbound?: boolean;
  /** Free-form key-value pairs attached to the session. */
  metadata?: Record<string, string>;
  tags?: string[];
  /** Persistent volumes to attach at creation. */
  volumes?: VolumeMountConfig[];
  /** GitHub token for private clones through the native git helpers. */
  githubToken?: string;
  /** Maximum time to wait for the session to become ready. Defaults to the createSandbox timeout. */
  waitTimeoutMs?: number;
}

export type TenkiOptions = TenkiBaseOptions &
  (
    | { image?: string | TemplateImageRef; snapshotId?: never; fromTemplateSpec?: never }
    | { image?: never; snapshotId?: string; fromTemplateSpec?: never }
    | { image?: never; snapshotId?: never; fromTemplateSpec?: string | Template }
  );

export { tenkiCapabilities } from "../capabilities";

export function tenki(options: TenkiOptions = {}): SandboxProvider<TenkiSession> {
  let client: TenkiSandbox | undefined;
  const getClient = () =>
    (client ??=
      options.client ??
      new TenkiSandbox({ authToken: options.authToken, baseUrl: options.baseUrl }));

  const provider: SandboxProvider<TenkiSession> = {
    id: "tenki",
    capabilities: tenkiCapabilities,
    async create(createOptions) {
      assertNotAborted(createOptions.signal);
      const raw = await guard("sandbox.create", () =>
        awaitCreation(
          getClient().create({
            name: options.name,
            cpuCores: options.cpuCores,
            memoryMb: options.memoryMb,
            diskSizeGb: options.diskSizeGb,
            idleTimeoutMinutes: options.idleTimeoutMinutes,
            maxDurationMs: options.maxDurationMs,
            sticky: options.sticky,
            allowInbound: options.allowInbound,
            allowOutbound: options.allowOutbound,
            metadata: options.metadata,
            tags: options.tags,
            volumes: options.volumes,
            githubToken: options.githubToken,
            image: options.image,
            snapshotId: options.snapshotId,
            fromTemplateSpec: options.fromTemplateSpec,
            env: { ...createOptions.env },
            waitReady: true,
            waitTimeoutMs: options.waitTimeoutMs ?? createOptions.timeout,
          }),
          createOptions.signal,
          createOptions.timeout,
        ),
      );
      let mapPath: (path: string) => string;
      try {
        mapPath = await guard("sandbox.create", () =>
          prepareWorkingDirectory(raw, createOptions.cwd),
        );
      } catch (error) {
        await raw.closeIfOpen().catch(() => undefined);
        throw error;
      }
      const guestPath = (path: string, operation: string) => {
        const mapped = mapPath(path);
        if (mapped !== GUEST_HOME && !mapped.startsWith(`${GUEST_HOME}/`)) {
          throw new SandboxError({
            code: "invalid_input",
            provider: "tenki",
            operation,
            message: `Tenki's file API cannot reach ${path}; use a path under ${createOptions.cwd} or ${GUEST_HOME}, or run a command instead`,
          });
        }
        return mapped;
      };

      return {
        id: raw.id,
        raw,
        capabilities: tenkiCapabilities,
        files: {
          write: (path, value) =>
            guard("files.write", async () =>
              raw.writeFile(guestPath(path, "files.write"), await toUint8Array(value)),
            ),
          read: (path) => guard("files.read", () => raw.readFile(guestPath(path, "files.read"))),
          list: (path) =>
            guard("files.list", async () => {
              const parent = path.replace(/\/$/, "");
              return (await raw.list(guestPath(path, "files.list"), { includeHidden: true })).map(
                (entry) => {
                  const name = entry.path.split("/").pop() ?? entry.path;
                  return {
                    name,
                    path: `${parent}/${name}`,
                    type: entry.isSymlink
                      ? ("symlink" as const)
                      : entry.isDir
                        ? ("directory" as const)
                        : ("file" as const),
                    size: entry.isDir ? undefined : Number(entry.size),
                  };
                },
              );
            }),
          mkdir: (path) => guard("files.mkdir", () => raw.mkdir(guestPath(path, "files.mkdir"))),
          remove: (path) =>
            guard("files.remove", () => raw.remove(guestPath(path, "files.remove"))),
          exists: (path) =>
            guard("files.exists", async () => {
              try {
                await raw.stat(guestPath(path, "files.exists"));
                return true;
              } catch (error) {
                if (error instanceof Error && error.name === "FileNotFoundError") return false;
                throw error;
              }
            }),
        },
        run: (command, runOptions) =>
          guard("process.run", async () => {
            assertNotAborted(runOptions.signal);
            const [executable, ...args] = toArgv(command);
            const result = await raw.exec(executable!, {
              args,
              cwd: runOptions.cwd,
              env: commandEnv(runOptions.cwd, runOptions.env),
              timeoutMs: runOptions.timeout,
              signal: runOptions.signal,
            });
            if (result.status === "TIMED_OUT") {
              throw new SandboxError({
                code: "timeout",
                provider: "tenki",
                operation: "process.run",
                message: `Command timed out after ${runOptions.timeout}ms`,
              });
            }
            return {
              stdout: decoder.decode(result.stdout),
              stderr: decoder.decode(result.stderr) || launchFailure(result),
              exitCode: result.exitCode,
              success: result.exitCode === 0,
              signal: result.reason === "signaled" ? "unknown" : undefined,
              durationMs: result.durationMs,
            };
          }),
        start: (command, runOptions) =>
          guard("process.start", async () => {
            assertNotAborted(runOptions.signal);
            const events: ProcessOutputEvent[] = [];
            const waiters = new Set<() => void>();
            let state: "running" | "exited" | "killed" = "running";
            let killRequested = false;
            const wake = () => {
              for (const waiter of waiters) waiter();
              waiters.clear();
            };
            const handle = raw.run(toArgv(command), {
              cwd: runOptions.cwd,
              env: commandEnv(runOptions.cwd, runOptions.env),
              timeoutMs: runOptions.timeout,
              signal: runOptions.signal,
            });
            const readers = [handle.stdout.getReader(), handle.stderr.getReader()] as const;
            const pump = async (
              reader: ReadableStreamDefaultReader<Uint8Array>,
              name: "stdout" | "stderr",
            ) => {
              const streamDecoder = new TextDecoder();
              for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                events.push({
                  stream: name,
                  data: streamDecoder.decode(value, { stream: true }),
                  timestamp: new Date(),
                });
                wake();
              }
            };
            const pumps = Promise.allSettled([
              pump(readers[0], "stdout"),
              pump(readers[1], "stderr"),
            ]);
            const completed = (async () => {
              try {
                const result = await handle;
                // A pipe inherited by a lingering child can stay open after exit; do not hang on it.
                await Promise.race([pumps, sleep(OUTPUT_DRAIN_GRACE_MS)]);
                for (const reader of readers) void reader.cancel().catch(() => undefined);
                return { exitCode: result.exitCode };
              } finally {
                if (state === "running") state = killRequested ? "killed" : "exited";
                wake();
              }
            })();
            const settled = completed.then(
              () => undefined,
              () => undefined,
            );
            let stdin: WritableStreamDefaultWriter<Uint8Array> | undefined;
            // A launch failure arrives as an exit frame with no `started` frame, so `pid` alone never settles.
            const launched = await Promise.race([
              handle.pid.then((pid) => ({ pid })),
              Promise.resolve(handle).then((result) => ({ result })),
            ]);
            if (!("pid" in launched)) {
              const detail = launchFailure(launched.result);
              throw new SandboxError({
                code: "process_failed",
                provider: "tenki",
                operation: "process.start",
                message: `Process exited with code ${launched.result.exitCode} before it started${detail ? `: ${detail}` : ""}`,
              });
            }
            const id = String(launched.pid);

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
              async write(value) {
                stdin ??= handle.stdin.getWriter();
                await stdin.write(
                  typeof value === "string" ? new TextEncoder().encode(value) : value,
                );
              },
              wait: () => completed,
              async kill(signal = "SIGTERM") {
                killRequested = true;
                await handle.signal(signal);
                // Let the exit and drain path finish so an active output() iterator sees the trailing frames.
                await Promise.race([settled, sleep(2 * OUTPUT_DRAIN_GRACE_MS)]);
              },
            } satisfies SandboxProcess;
          }),
        expose: (port) =>
          guard("ports.expose", async () => {
            const exposed = await raw.exposePort(port);
            return portResult(port, exposed.previewUrl, true, false);
          }),
        snapshots: {
          create: (snapshotOptions) =>
            guard("snapshot.create", async () => {
              const snapshot = await getClient().createSnapshotAndWait(raw.id, {
                name: snapshotOptions?.name ?? `sandbox-sdk-${Date.now()}`,
              });
              return {
                id: snapshot.id,
                name: snapshot.name,
                mode: "memory",
                createdAt: snapshot.createdAt,
              } satisfies SandboxSnapshot;
            }),
          delete: (snapshot) =>
            guard("snapshot.delete", async () => {
              await getClient().deleteSnapshot(
                typeof snapshot === "string" ? snapshot : snapshot.id,
              );
            }),
          async restore() {
            unsupported("tenki", "snapshot.restore");
          },
        },
        stop: () => guard("sandbox.stop", () => raw.closeIfOpen()),
      };
    },
  };

  return withManagedSessions(provider, [], {
    stop: (sandbox) =>
      guard("managed.stop", async () => {
        await sandbox.raw.pause();
        await sandbox.raw.waitPaused();
      }),
    resume: (sandbox) =>
      guard("managed.resume", async () => {
        await sandbox.raw.resume();
        await sandbox.raw.waitResumed();
      }),
    destroy: (sandbox) => guard("managed.destroy", () => sandbox.raw.closeIfOpen()),
  });
}

/**
 * Tenki's file API only reaches `/home/tenki`, while exec can use any directory. A cwd outside the
 * home is backed by a real directory under it, with the cwd itself symlinked to that mirror, so
 * commands and file operations observe the same tree.
 */
async function prepareWorkingDirectory(
  raw: TenkiSession,
  cwd: string,
): Promise<(path: string) => string> {
  if (cwd === GUEST_HOME || cwd.startsWith(`${GUEST_HOME}/`)) {
    await raw.mkdir(cwd);
    return (path) => path;
  }
  if (cwd === "/") {
    throw new SandboxError({
      code: "invalid_input",
      provider: "tenki",
      operation: "sandbox.create",
      message: `Tenki cannot use / as the working directory; pass a path such as /workspace or ${GUEST_HOME}/project`,
    });
  }
  const mirror = `${GUEST_HOME}${cwd}`;
  const result = await raw.exec("sh", {
    args: ["-c", LINK_WORKING_DIRECTORY],
    env: { SANDBOX_SDK_CWD: cwd, SANDBOX_SDK_MIRROR: mirror },
  });
  if (result.exitCode !== 0) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "tenki",
      operation: "sandbox.create",
      message: `Cannot map working directory ${cwd} into ${GUEST_HOME}: ${
        decoder.decode(result.stderr).trim() ||
        launchFailure(result) ||
        `exit code ${result.exitCode}`
      }`,
    });
  }
  return (path) => replacePathPrefix(path, cwd, mirror);
}

const LINK_WORKING_DIRECTORY = `set -eu
mkdir -p "$SANDBOX_SDK_MIRROR"
if [ -L "$SANDBOX_SDK_CWD" ]; then
  [ "$(readlink -f "$SANDBOX_SDK_CWD")" = "$SANDBOX_SDK_MIRROR" ] || {
    echo "$SANDBOX_SDK_CWD is a symlink to another location" >&2
    exit 1
  }
elif [ -e "$SANDBOX_SDK_CWD" ]; then
  echo "$SANDBOX_SDK_CWD already exists in the guest and is not reachable by the Tenki file API" >&2
  exit 1
else
  sudo -n mkdir -p "$(dirname "$SANDBOX_SDK_CWD")"
  sudo -n ln -s "$SANDBOX_SDK_MIRROR" "$SANDBOX_SDK_CWD"
fi
`;

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

/** Shells derive `pwd` from getcwd() unless PWD names the same directory, so the symlinked cwd is passed along. */
function commandEnv(
  cwd: string | undefined,
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return cwd ? { PWD: cwd, ...env } : { ...env };
}

function toArgv(command: CommandInput): string[] {
  if (typeof command === "string") return ["bash", "-c", command];
  return [command.command, ...(command.args ?? [])];
}

/** The guest reports launch failures such as a missing cwd through `reason` with no stderr. */
function launchFailure(result: Pick<ExecResult, "exitCode" | "reason">): string {
  if (result.exitCode !== -1 || !result.reason) return "";
  return ["exit", "signaled", "timeout", "grace_timeout"].includes(result.reason)
    ? ""
    : result.reason;
}

const errorCodes: Record<string, SandboxErrorCode> = {
  MissingAuthTokenError: "authentication",
  InvalidAuthTokenError: "authentication",
  UnauthorizedError: "authentication",
  PermissionDeniedError: "permission",
  SessionNotFoundError: "not_found",
  FileNotFoundError: "not_found",
  SnapshotNotFoundError: "not_found",
  VolumeNotFoundError: "not_found",
  TemplateNotFoundError: "not_found",
  RegistryImageNotFoundError: "not_found",
  CommandTimeoutError: "timeout",
  WaitReadyFailedError: "timeout",
  PrimitiveTimeoutError: "timeout",
  RateLimitedError: "rate_limited",
  QuotaExceededError: "unavailable",
  CapacityUnavailableError: "unavailable",
  DataPlaneNotReadyError: "unavailable",
  SessionTerminatedError: "terminated",
  SessionExpiredError: "terminated",
  InvalidStateError: "conflict",
  VolumeInUseError: "conflict",
  TemplateExistsError: "conflict",
  InvalidResourceConfigError: "invalid_input",
  InboundDisabledError: "invalid_input",
  PortLimitExceededError: "invalid_input",
  InvalidTemplateSpecError: "invalid_input",
  CapabilityUnavailableError: "unsupported",
  SnapshotFailedError: "internal",
  TemplateRuntimeFailedError: "internal",
};

export function normalizeTenkiError(operation: string, error: unknown): SandboxError {
  if (isSandboxError(error)) return error;
  const code = error instanceof Error ? errorCodes[error.name] : undefined;
  if (!code) return normalizeError("tenki", operation, error);
  return new SandboxError({
    code,
    provider: "tenki",
    operation,
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

async function guard<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw normalizeTenkiError(operation, error);
  }
}

/**
 * Bounds session creation by the abort signal and timeout. A session that is admitted after the
 * caller gave up is terminated so it does not keep billing. Readiness failures carry the live
 * session on the error and receive the same cleanup.
 */
async function awaitCreation(
  promise: Promise<TenkiSession>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<TenkiSession> {
  const closeLate = (error: unknown) => {
    const session = (error as { session?: TenkiSession } | null)?.session;
    if (session && typeof session.closeIfOpen === "function") {
      void session.closeIfOpen().catch(() => undefined);
    }
  };
  if (!signal && timeoutMs === undefined) {
    return promise.catch((error: unknown) => {
      closeLate(error);
      throw error;
    });
  }
  return new Promise<TenkiSession>((resolve, reject) => {
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
      (session) => {
        if (settled) {
          void session.closeIfOpen().catch(() => undefined);
          return;
        }
        finish(() => resolve(session));
      },
      (error: unknown) => {
        closeLate(error);
        finish(() => reject(error));
      },
    );
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export type { TenkiSession, TenkiSandbox as TenkiClient, ProcessRunHandle as TenkiProcessHandle };
