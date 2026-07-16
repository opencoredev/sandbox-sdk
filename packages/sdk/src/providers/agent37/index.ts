import { randomUUID } from "node:crypto";
import { SandboxError, type SandboxErrorCode } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type {
  CommandInput,
  ProcessOutputEvent,
  ProcessStatus,
  RunOptions,
  SandboxDirectoryEntry,
  SandboxProcess,
} from "../../core/types";
import { withManagedSessions } from "../../internal/managed-provider";
import {
  commandString,
  portResult,
  toUint8Array,
  unsupported,
  unsupportedSnapshots,
} from "../../internal/provider-utils";
import { agent37Capabilities } from "../capabilities";

const DEFAULT_BASE_URL = "https://api.agent37.com/v1";
const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 500;
const OUTPUT_CHUNK_BYTES = 262_144;
/** The platform kills any exec call at 280 seconds; longer jobs must run in the background. */
const EXEC_CAP_MS = 280_000;

export interface Agent37Options {
  /** Workspace API key (`sk_live_...`). Defaults to `AGENT37_API_KEY`. */
  apiKey?: string;
  /**
   * Template to create instances from: a system template such as `agent37-hermes`,
   * `agent37-hermes-small`, or `agent37-openclaw` (optionally version-pinned with `@<tag>`), or
   * one of your workspace templates. Omitted, the platform default (`agent37-hermes`) is used.
   * A workspace template must be built on an Agent37 gateway-bearing base image (such as
   * `hermes-base`): the adapter needs the in-instance gateway for boot detection and file
   * operations, so an image without it makes `create()` time out.
   */
  template?: string;
  /** Instance shape, for example `{ cpu: 2, memory: 4, disk: 6 }`. Omitted fields use template defaults. */
  resources?: { cpu?: number; memory?: number; disk?: number };
  /** A label stored on the instance. */
  name?: string;
  /**
   * Checkpoint the instance when idle; it bills disk-only while sleeping. The platform measures
   * idleness on instance-URL traffic only, so command-heavy workloads can still fall asleep.
   * Sandbox operations wake a sleeping instance automatically, at the cost of one slower
   * operation after each sleep.
   */
  autoSleep?: boolean;
  /** Idle seconds before auto-sleep, from 60 to 86400. Only meaningful with `autoSleep`. */
  idleTimeoutSeconds?: number;
  /**
   * Expose ports at permanent unauthenticated public-port URLs. Defaults to false, which derives
   * key-authenticated preview URLs and keeps the key inside `ExposedPort.request()`.
   */
  public?: boolean;
  /** Hosting API base URL. */
  baseUrl?: string;
}

/** The Agent37 instance object returned by the Hosting API. */
export interface Agent37InstanceRecord {
  id: string;
  status: string;
  template: string;
  resources: { cpu: number; memory: number; disk: number };
  url: string;
  public_ports: Array<{ port: number; url: string; prefix: string | null; created: number }>;
  name: string | null;
  user: string | null;
  metadata: Record<string, unknown> | null;
  auto_sleep: boolean;
  idle_timeout_seconds: number;
  created: number;
}

export interface Agent37ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Native escape hatch for the Agent37 instance behind a sandbox. */
export interface Agent37Sandbox {
  /** The most recent instance object observed from the Hosting API. */
  readonly instance: Agent37InstanceRecord;
  /** Requests `https://api.agent37.com/v1/instances/{id}{path}` with Bearer authentication. */
  hosting(path: string, init?: RequestInit): Promise<Response>;
  /** Requests `{instance.url}{path}` (the in-instance gateway) with `X-Agent37-Key` authentication. */
  gateway(path: string, init?: RequestInit): Promise<Response>;
  /** Runs a shell command through the Hosting API exec endpoint. */
  exec(command: string): Promise<Agent37ExecResult>;
  /** Halts the instance. Disk persists and bills alone until `start()`. */
  stop(): Promise<void>;
  /** Starts a stopped instance and waits for its gateway to answer. */
  start(): Promise<void>;
  /** Recreates the container from the same image and data. */
  restart(): Promise<void>;
  /** Deletes the instance permanently. */
  delete(): Promise<void>;
}

export { agent37Capabilities } from "../capabilities";

/**
 * Agent37 provider. Runs sandboxes on persistent Agent37 instances over the Hosting and
 * gateway REST APIs with no native SDK dependency.
 */
export function agent37(options: Agent37Options = {}): SandboxProvider<Agent37Sandbox> {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  const publicPorts = options.public ?? false;

  return withManagedSessions(
    {
      id: "agent37",
      capabilities: agent37Capabilities,
      async create(createOptions) {
        assertNotAborted(createOptions.signal);
        const apiKey = options.apiKey ?? process.env.AGENT37_API_KEY;
        if (!apiKey) {
          throw new SandboxError({
            code: "authentication",
            provider: "agent37",
            operation: "sandbox.create",
            message: "Set AGENT37_API_KEY or pass apiKey to agent37()",
          });
        }
        const bootTimeout = createOptions.timeout ?? DEFAULT_BOOT_TIMEOUT_MS;
        const api = new Agent37Api(baseUrl, apiKey);
        let instance = await api.request<Agent37InstanceRecord>("sandbox.create", "/instances", {
          method: "POST",
          body: JSON.stringify({
            ...(options.template ? { template: options.template } : {}),
            ...(options.resources ? { resources: options.resources } : {}),
            ...(options.name ? { name: options.name } : {}),
            ...(options.autoSleep !== undefined ? { auto_sleep: options.autoSleep } : {}),
            ...(options.idleTimeoutSeconds !== undefined
              ? { idle_timeout_seconds: options.idleTimeoutSeconds }
              : {}),
          }),
          signal: createOptions.signal,
        });

        const hosting = (path: string, init?: RequestInit) =>
          api.fetch(`/instances/${instance.id}${path}`, init);
        const gateway = (path: string, init: RequestInit = {}) =>
          fetch(new URL(path, instance.url), {
            ...init,
            headers: {
              ...Object.fromEntries(new Headers(init.headers)),
              "x-agent37-key": apiKey,
            },
          });
        const gatewayJson = async <T>(operation: string, path: string, init?: RequestInit) =>
          api.parse<T>(operation, await gateway(path, init));
        const execOnce = async (command: string): Promise<Agent37ExecResult> => {
          const result = await api.request<{
            exit_code: number;
            stdout: string;
            stderr: string;
            truncated: boolean;
          }>("process.run", `/instances/${instance.id}/exec`, {
            method: "POST",
            body: JSON.stringify({ command }),
          });
          return {
            exitCode: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          };
        };
        const exec = async (command: string): Promise<Agent37ExecResult> => {
          try {
            return await execOnce(command);
          } catch (error) {
            // Exec refuses non-running instances and never wakes a sleeper, but any request to
            // the instance URL does. Probe the gateway (held until the instance restores) and
            // retry once; a stopped instance does not wake this way, so its error passes through.
            if (!(error instanceof SandboxError) || error.code !== "invalid_input") throw error;
            let woke = false;
            try {
              const health = await gateway("/v1/health");
              await health.arrayBuffer().catch(() => {});
              woke = health.ok;
            } catch {
              woke = false;
            }
            if (!woke) throw error;
            return await execOnce(command);
          }
        };
        const waitForGateway = async (operation: string, signal?: AbortSignal) => {
          const deadline = Date.now() + bootTimeout;
          while (true) {
            assertNotAborted(signal);
            try {
              const response = await gateway("/v1/health", { signal });
              if (response.ok) {
                const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
                if (body?.ok) return;
              } else {
                await response.arrayBuffer().catch(() => {});
              }
            } catch (error) {
              if (signal?.aborted) throw error;
            }
            if (Date.now() >= deadline) {
              throw new SandboxError({
                code: "timeout",
                provider: "agent37",
                operation,
                message: `Instance ${instance.id} gateway did not become healthy within ${bootTimeout}ms`,
              });
            }
            await sleep(1_000, signal);
          }
        };

        const raw: Agent37Sandbox = {
          get instance() {
            return instance;
          },
          hosting,
          gateway,
          exec,
          async stop() {
            await api.request("sandbox.stop", `/instances/${instance.id}/stop`, {
              method: "POST",
            });
            instance = { ...instance, status: "stopped" };
          },
          async start() {
            await api.request("sandbox.resume", `/instances/${instance.id}/start`, {
              method: "POST",
            });
            await waitForGateway("sandbox.resume");
            instance = { ...instance, status: "running" };
          },
          async restart() {
            await api.request("sandbox.restart", `/instances/${instance.id}/restart`, {
              method: "POST",
            });
            await waitForGateway("sandbox.restart");
          },
          async delete() {
            try {
              await api.request("sandbox.stop", `/instances/${instance.id}`, {
                method: "DELETE",
              });
            } catch (error) {
              if (!(error instanceof SandboxError) || error.code !== "not_found") throw error;
            }
            instance = { ...instance, status: "deleted" };
          },
        };

        let remoteCwd: string;
        try {
          await waitForGateway("sandbox.create", createOptions.signal);
          const workspace = await gatewayJson<{ path: string }>("sandbox.create", "/v1/files", {
            signal: createOptions.signal,
          });
          remoteCwd = workspace.path;
        } catch (error) {
          await raw.delete().catch(() => {});
          throw error;
        }

        const toRemotePath = (path: string) =>
          replacePathPrefix(path, createOptions.cwd, remoteCwd);
        const toVirtualPath = (path: string) =>
          replacePathPrefix(path, remoteCwd, createOptions.cwd);
        const scoped = (command: CommandInput, runOptions: RunOptions) =>
          scopedCommand(command, withEnv(createOptions, runOptions), createOptions.cwd, remoteCwd);

        return {
          id: instance.id,
          raw,
          capabilities: agent37Capabilities,
          files: {
            async write(path, value) {
              const query = new URLSearchParams({ path: toRemotePath(path), overwrite: "true" });
              await gatewayJson("files.write", `/v1/files/content?${query}`, {
                method: "PUT",
                body: new Uint8Array(await toUint8Array(value)),
              });
            },
            async read(path) {
              const query = new URLSearchParams({ path: toRemotePath(path) });
              const response = await gateway(`/v1/files/content?${query}`);
              if (!response.ok) await api.raise("files.read", response);
              return new Uint8Array(await response.arrayBuffer());
            },
            async list(path) {
              const query = new URLSearchParams({ path: toRemotePath(path) });
              const listing = await gatewayJson<{
                entries: Array<{ name: string; path: string; type: string; size: number | null }>;
              }>("files.list", `/v1/files?${query}`);
              return listing.entries.map(
                (entry): SandboxDirectoryEntry => ({
                  name: entry.name,
                  path: toVirtualPath(entry.path),
                  type:
                    entry.type === "file" || entry.type === "directory" || entry.type === "symlink"
                      ? entry.type
                      : "unknown",
                  size: entry.size ?? undefined,
                }),
              );
            },
            async mkdir(path) {
              const query = new URLSearchParams({ path: toRemotePath(path) });
              await gatewayJson("files.mkdir", `/v1/files/dir?${query}`, { method: "POST" });
            },
            async remove(path) {
              const remote = toRemotePath(path);
              if (remote === "/") {
                throw new SandboxError({
                  code: "invalid_input",
                  provider: "agent37",
                  operation: "files.remove",
                  message: "Cannot remove the instance filesystem root",
                });
              }
              const query = new URLSearchParams({ path: remote });
              await gatewayJson("files.remove", `/v1/files?${query}`, { method: "DELETE" });
            },
            async exists(path) {
              const result = await exec(`test -e ${shellQuote(toRemotePath(path))}`);
              return result.exitCode === 0;
            },
          },
          async run(command, runOptions) {
            assertNotAborted(runOptions.signal);
            const started = performance.now();
            let result: Agent37ExecResult;
            try {
              result = await exec(scoped(command, runOptions));
            } catch (error) {
              const elapsed = performance.now() - started;
              if (
                error instanceof SandboxError &&
                error.code === "unavailable" &&
                elapsed >= EXEC_CAP_MS - 15_000
              ) {
                throw new SandboxError({
                  code: "timeout",
                  provider: "agent37",
                  operation: "process.run",
                  message:
                    "Command exceeded the 280-second Agent37 exec cap; run longer jobs with processes.start()",
                  cause: error,
                });
              }
              throw error;
            }
            if (runOptions.timeout !== undefined && result.exitCode === 124) {
              throw new SandboxError({
                code: "timeout",
                provider: "agent37",
                operation: "process.run",
                message: `Command timed out after ${runOptions.timeout}ms`,
              });
            }
            return {
              stdout: result.stdout,
              stderr: result.stderr,
              exitCode: result.exitCode,
              success: result.exitCode === 0,
              durationMs: Math.round(performance.now() - started),
            };
          },
          async start(command, runOptions) {
            assertNotAborted(runOptions.signal);
            const dir = `/tmp/.sandbox-sdk/${randomUUID()}`;
            const outputPath = `${dir}/output`;
            const exitPath = `${dir}/exit`;
            const inner = scoped(command, runOptions);
            const wrapper = `${inner} > ${shellQuote(outputPath)} 2>&1; echo $? > ${shellQuote(exitPath)}`;
            const daemonized = `sh -c ${shellQuote(wrapper)} </dev/null >/dev/null 2>&1 &`;
            const launcher =
              `mkdir -p ${shellQuote(dir)} && ` +
              `if command -v setsid >/dev/null 2>&1; then g=group; setsid ${daemonized} else g=solo; ${daemonized} fi; ` +
              `echo "$! $g"`;
            const launched = await exec(launcher);
            const [pidText, grouping] = launched.stdout.trim().split(" ");
            const pid = Number.parseInt(pidText ?? "", 10);
            if (launched.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
              throw new SandboxError({
                code: "process_failed",
                provider: "agent37",
                operation: "process.start",
                message: `Failed to start background process${launched.stderr ? `: ${launched.stderr}` : ""}`,
              });
            }
            return backgroundProcess({
              pid,
              hasGroup: grouping === "group",
              outputPath,
              exitPath,
              exec,
            });
          },
          async expose(port) {
            validatePort(port);
            if (publicPorts) {
              let entry: { port: number; url: string };
              try {
                entry = await api.request<{ port: number; url: string }>(
                  "ports.expose",
                  `/instances/${instance.id}/public-ports`,
                  { method: "POST", body: JSON.stringify({ port }) },
                );
              } catch (error) {
                if (!(error instanceof SandboxError) || error.code !== "conflict") throw error;
                const current = await api.request<Agent37InstanceRecord>(
                  "ports.expose",
                  `/instances/${instance.id}`,
                );
                const existing = current.public_ports.find((candidate) => candidate.port === port);
                if (!existing) throw error;
                entry = existing;
              }
              return portResult(port, entry.url, true, false);
            }
            const url = previewUrl(instance.url, port);
            return portResult(port, url, false, true, (path = "/", init = {}) =>
              fetch(new URL(path, url), {
                ...init,
                headers: {
                  ...Object.fromEntries(new Headers(init.headers)),
                  "x-agent37-key": apiKey,
                },
              }),
            );
          },
          snapshots: unsupportedSnapshots("agent37"),
          async stop() {
            await raw.delete();
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

class Agent37Api {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
  }

  async request<T = unknown>(operation: string, path: string, init?: RequestInit): Promise<T> {
    return this.parse<T>(operation, await this.fetch(path, init));
  }

  async parse<T>(operation: string, response: Response): Promise<T> {
    if (!response.ok) await this.raise(operation, response);
    return (await response.json()) as T;
  }

  async raise(operation: string, response: Response): Promise<never> {
    const body = (await response.json().catch(() => null)) as {
      error?: string | { code?: string; message?: string };
      message?: string;
    } | null;
    const envelope = typeof body?.error === "object" ? body.error : undefined;
    const code = typeof body?.error === "string" ? body.error : envelope?.code;
    const message =
      envelope?.message ??
      body?.message ??
      `Agent37 request failed with HTTP ${response.status}${code ? ` (${code})` : ""}`;
    throw new SandboxError({
      code: mapErrorCode(response.status, code),
      provider: "agent37",
      operation,
      message,
      retryable: code ? RETRYABLE_CODES.has(code) : undefined,
    });
  }
}

const RETRYABLE_CODES = new Set([
  "try_again",
  "capacity_unavailable",
  "no_capacity",
  "wake_timeout",
  "wake_failed",
  "container_unreachable",
  "upstream_unreachable",
  "instance_saturated",
  "host_mesh_not_ready",
  "rate_limited",
  "upstream_timeout",
]);

const ERROR_CODE_MAP: Record<string, SandboxErrorCode> = {
  invalid_api_key: "authentication",
  forbidden: "permission",
  tier_limit: "permission",
  insufficient_balance: "permission",
  instance_suspended: "permission",
  not_found: "not_found",
  file_not_found: "not_found",
  rate_limited: "rate_limited",
  upstream_timeout: "timeout",
  wake_timeout: "unavailable",
};

function mapErrorCode(status: number, code: string | undefined): SandboxErrorCode {
  if (code && ERROR_CODE_MAP[code]) return ERROR_CODE_MAP[code];
  if (status === 400 || status === 413 || status === 422) return "invalid_input";
  if (status === 401) return "authentication";
  if (status === 402 || status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 409 || status === 412) return "conflict";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "internal";
}

function backgroundProcess(context: {
  pid: number;
  hasGroup: boolean;
  outputPath: string;
  exitPath: string;
  exec: (command: string) => Promise<Agent37ExecResult>;
}): SandboxProcess {
  const { pid, hasGroup, outputPath, exitPath, exec } = context;
  let killed = false;
  let finished: { exitCode: number } | undefined;

  const probe = async (): Promise<{ exitCode: number } | undefined> => {
    if (finished) return finished;
    const result = await exec(
      `if [ -f ${shellQuote(exitPath)} ]; then printf 'exit %s' "$(cat ${shellQuote(exitPath)})"; ` +
        `elif kill -0 ${pid} 2>/dev/null; then printf running; else printf gone; fi`,
    );
    const report = result.stdout.trim();
    if (report.startsWith("exit ")) {
      const exitCode = Number.parseInt(report.slice(5), 10);
      finished = { exitCode: Number.isInteger(exitCode) ? exitCode : 1 };
    } else if (report === "gone") {
      // The wrapper died before writing an exit file: the process group was killed.
      killed = true;
      finished = { exitCode: 137 };
    }
    return finished;
  };

  const readChunk = async (offset: number): Promise<Uint8Array> => {
    const result = await exec(
      `tail -c +${offset + 1} ${shellQuote(outputPath)} 2>/dev/null | head -c ${OUTPUT_CHUNK_BYTES} | base64`,
    );
    const encoded = result.stdout.replace(/\s+/g, "");
    if (!encoded) return new Uint8Array(0);
    return new Uint8Array(Buffer.from(encoded, "base64"));
  };

  return {
    id: String(pid),
    async status(): Promise<ProcessStatus> {
      const result = await probe();
      if (!result) return "running";
      return killed || result.exitCode === 137 || result.exitCode === 143 ? "killed" : "exited";
    },
    async *output(): AsyncIterable<ProcessOutputEvent> {
      let offset = 0;
      while (true) {
        const result = await probe();
        let chunk = await readChunk(offset);
        while (chunk.byteLength > 0) {
          offset += chunk.byteLength;
          yield { stream: "stdout", data: chunk, timestamp: new Date() };
          chunk = await readChunk(offset);
        }
        if (result) return;
        await sleep(POLL_INTERVAL_MS);
      }
    },
    async write() {
      unsupported("agent37", "process.stdin");
    },
    async wait() {
      while (true) {
        const result = await probe();
        if (result) return result;
        await sleep(POLL_INTERVAL_MS);
      }
    },
    async kill(signal = "SIGTERM") {
      if (finished) return;
      killed = true;
      const name = signal === "SIGKILL" || signal === "KILL" || signal === "9" ? "KILL" : "TERM";
      // `kill -s NAME -- -pid` is the group-kill spelling dash accepts. Without setsid there is
      // no dedicated group, so take down the wrapper's children before the wrapper itself.
      const target = hasGroup
        ? `kill -s ${name} -- -${pid} 2>/dev/null || kill -s ${name} ${pid} 2>/dev/null`
        : `pkill -${name} -P ${pid} 2>/dev/null; kill -s ${name} ${pid} 2>/dev/null`;
      await exec(`${target}; true`);
    },
  };
}

function previewUrl(instanceUrl: string, port: number): string {
  const url = new URL(instanceUrl);
  const [label, ...rest] = url.hostname.split(".");
  return `https://${label}-${port}.${rest.join(".")}`;
}

function withEnv(
  createOptions: { env: Readonly<Record<string, string>> },
  runOptions: RunOptions,
): RunOptions {
  return { ...runOptions, env: { ...createOptions.env, ...runOptions.env } };
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
  const shell = `sh -c ${shellQuote(commandString(input))}`;
  const timed = options.timeout
    ? `timeout ${Math.max(1, Math.ceil(options.timeout / 1_000))}s ${shell}`
    : shell;
  const cwd = replacePathPrefix(options.cwd ?? virtualCwd, virtualCwd, remoteCwd);
  return `cd ${shellQuote(cwd)} && ${
    environment.length ? `env ${environment.join(" ")} ` : ""
  }${timed}`;
}

function replacePathPrefix(path: string, from: string, to: string): string {
  if (path === from) return to;
  if (path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "agent37",
      operation: "ports.expose",
      message: `Invalid port: ${port}`,
    });
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
