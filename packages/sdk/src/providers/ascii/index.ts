import {
  BoxApi,
  Configuration,
  ResponseError,
  type Box,
  type ConfigurationParameters,
  type SnapshotSummary,
} from "@asciidev/box-sdk";
import { SandboxError, type SandboxErrorCode } from "../../core/errors";
import type { SandboxProvider } from "../../core/provider";
import type {
  CommandInput,
  CommandResult,
  ProcessOutputEvent,
  RunOptions,
  SandboxDirectoryEntry,
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
import { asciiCapabilities } from "../capabilities";

const defaultBaseUrl = "https://ascii.dev/api/box/v1";
const defaultReadyTimeoutMs = 300_000;
const defaultPollIntervalMs = 1_000;
const ansiEscape = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export interface AsciiOptions {
  /** Box API key. Defaults to BOX_API_KEY. */
  apiKey?: string;
  /** Box v1 API base URL. Defaults to BOX_BASE_URL or Ascii's production API. */
  baseUrl?: string;
  /** Automatic archival TTL in seconds. Pass null to disable automatic archival. */
  ttlSeconds?: number | null;
  /** Withhold account-level secrets and credentials from the Box. */
  noEnv?: boolean;
  /** Expose ports publicly instead of using Box's protected URLs. */
  public?: boolean;
  /** Maximum time to wait for provisioning, archival, resume, and snapshots. */
  readyTimeoutMs?: number;
  /** Polling interval for lifecycle and background-process operations. */
  pollIntervalMs?: number;
  /** Additional official SDK configuration, useful for custom fetch implementations. */
  configuration?: Omit<ConfigurationParameters, "accessToken" | "basePath">;
}

/** Native Ascii handle retained on `sandbox.raw`. */
export interface AsciiBox {
  readonly id: string;
  readonly api: BoxApi;
  get(options?: { signal?: AbortSignal }): Promise<Box>;
  archive(options?: { signal?: AbortSignal }): Promise<void>;
  resume(options?: { signal?: AbortSignal }): Promise<Box>;
  remove(options?: { signal?: AbortSignal }): Promise<void>;
}

export { asciiCapabilities } from "../capabilities";

export function ascii(options: AsciiOptions = {}): SandboxProvider<AsciiBox> {
  const readyTimeoutMs = options.readyTimeoutMs ?? defaultReadyTimeoutMs;
  const pollIntervalMs = options.pollIntervalMs ?? defaultPollIntervalMs;
  const api = new BoxApi(
    new Configuration({
      ...options.configuration,
      basePath: options.baseUrl ?? process.env.BOX_BASE_URL ?? defaultBaseUrl,
      accessToken: options.apiKey ?? process.env.BOX_API_KEY,
    }),
  );

  const provider: SandboxProvider<AsciiBox> = {
    id: "ascii",
    capabilities: asciiCapabilities,
    async create(createOptions) {
      assertNotAborted(createOptions.signal);
      const created = await asciiCall("sandbox.create", () =>
        api.create(
          {
            createBoxRequest: {
              ttlSeconds: options.ttlSeconds,
              noEnv: options.noEnv,
              env: { ...createOptions.env },
            },
          },
          requestInit(createOptions.signal),
        ),
      );
      const id = created.box.id;
      const raw = createRawBox(api, id, readyTimeoutMs, pollIntervalMs);

      try {
        await waitForReady(api, id, {
          timeoutMs: createOptions.timeout ?? readyTimeoutMs,
          intervalMs: pollIntervalMs,
          signal: createOptions.signal,
        });
      } catch (error) {
        try {
          await raw.remove();
        } catch (cleanupError) {
          if (error instanceof Error)
            Object.defineProperty(error, "cleanupError", { value: cleanupError });
        }
        throw error;
      }

      const execute = (command: CommandInput, runOptions: RunOptions) =>
        runCommand(api, id, createOptions.cwd, command, runOptions);

      return {
        id,
        raw,
        capabilities: asciiCapabilities,
        files: {
          async write(path, value) {
            const content = Buffer.from(await toUint8Array(value)).toString("base64");
            await asciiCall("files.write", () =>
              api.writeFile(
                {
                  boxId: id,
                  fileWriteRequest: {
                    path: toRemotePath(path, createOptions.cwd),
                    content,
                    encoding: "base64",
                  },
                },
                requestInit(),
              ),
            );
          },
          async read(path) {
            const result = await asciiCall("files.read", () =>
              api.readFile({
                boxId: id,
                path: toRemotePath(path, createOptions.cwd),
                encoding: "base64",
              }),
            );
            return new Uint8Array(Buffer.from(result.content, "base64"));
          },
          async list(path) {
            const remotePath = toRemotePath(path, createOptions.cwd);
            const result = await execute(
              `find ${shellQuote(remotePath)} -mindepth 1 -maxdepth 1 -printf '%f\\0%y\\0%s\\0'`,
              {},
            );
            assertCommandSucceeded(result, "files.list");
            return parseDirectoryEntries(result.stdout, path);
          },
          async mkdir(path) {
            const result = await execute(
              `mkdir -p -- ${shellQuote(toRemotePath(path, createOptions.cwd))}`,
              {},
            );
            assertCommandSucceeded(result, "files.mkdir");
          },
          async remove(path) {
            const result = await execute(
              `rm -rf -- ${shellQuote(toRemotePath(path, createOptions.cwd))}`,
              {},
            );
            assertCommandSucceeded(result, "files.remove");
          },
          async exists(path) {
            const result = await execute(
              `test -e ${shellQuote(toRemotePath(path, createOptions.cwd))}`,
              {},
            );
            return result.exitCode === 0;
          },
        },
        run: execute,
        start: (command, runOptions) =>
          startProcess(api, id, createOptions.cwd, command, runOptions, pollIntervalMs),
        async expose(port) {
          const registration = await execute(
            `host ${port} ${options.public ? "--public" : "--private"}`,
            { timeout: 60_000 },
          );
          assertCommandSucceeded(registration, "ports.expose");
          const resolved = await execute(`host url ${port}${options.public ? " --public" : ""}`, {
            timeout: 60_000,
          });
          assertCommandSucceeded(resolved, "ports.expose");
          const nativeUrl = extractUrl(resolved.stdout);
          const parsed = new URL(nativeUrl);
          const token = rawQueryValue(nativeUrl, "_token");
          parsed.searchParams.delete("_token");
          const cleanUrl = parsed.toString();
          return portResult(
            port,
            cleanUrl,
            !token,
            Boolean(token),
            token
              ? (path = "/", init = {}) => {
                  const target = new URL(path, cleanUrl);
                  const hash = target.hash;
                  target.hash = "";
                  const separator = target.search ? "&" : "?";
                  return fetchProtectedPreview(
                    `${target.href}${separator}_token=${token}${hash}`,
                    init,
                  );
                }
              : undefined,
          );
        },
        snapshots: {
          async create(snapshotOptions) {
            const previous = await latestSnapshot(api, id);
            await raw.archive();
            let snapshot: SnapshotSummary;
            try {
              await waitForArchived(api, id, {
                timeoutMs: readyTimeoutMs,
                intervalMs: pollIntervalMs,
              });
              snapshot = await waitForSnapshot(api, id, previous?.id, {
                timeoutMs: readyTimeoutMs,
                intervalMs: pollIntervalMs,
              });
            } finally {
              await raw.resume();
            }
            return {
              id: snapshot.id,
              name: snapshotOptions?.name,
              mode: "filesystem",
              createdAt: snapshot.createdAt,
            } satisfies SandboxSnapshot;
          },
          async delete() {
            unsupported("ascii", "snapshot.delete");
          },
          async restore() {
            unsupported("ascii", "snapshot.restore");
          },
        },
        stop: () => raw.remove(),
      };
    },
  };

  return withManagedSessions(provider, [], {
    stop: (sandbox) => sandbox.raw.archive(),
    resume: (sandbox) => sandbox.raw.resume().then(() => undefined),
    destroy: (sandbox) => sandbox.raw.remove(),
  });
}

function createRawBox(api: BoxApi, id: string, timeoutMs: number, intervalMs: number): AsciiBox {
  return {
    id,
    api,
    async get(options) {
      return (
        await asciiCall("raw.get", () => api.get({ boxId: id }, requestInit(options?.signal)))
      ).box;
    },
    async archive(options) {
      await asciiCall("raw.archive", () => api.stop({ boxId: id }, requestInit(options?.signal)));
      await waitForArchived(api, id, {
        timeoutMs,
        intervalMs,
        signal: options?.signal,
      });
    },
    async resume(options) {
      await asciiCall("raw.resume", () => api.resume({ boxId: id }, requestInit(options?.signal)));
      return waitForReady(api, id, {
        timeoutMs,
        intervalMs,
        signal: options?.signal,
      });
    },
    async remove(options) {
      await removeBox(api, id, {
        timeoutMs,
        intervalMs,
        signal: options?.signal,
      });
    },
  };
}

async function removeBox(api: BoxApi, boxId: string, options: PollOptions): Promise<void> {
  try {
    await asciiCall("raw.remove", () => api.remove({ boxId }, requestInit(options.signal)));
    return;
  } catch (error) {
    if (
      !(error instanceof SandboxError) ||
      error.code !== "conflict" ||
      !error.message.toLowerCase().includes("snapshot")
    )
      throw error;
  }

  const [box, previous] = await Promise.all([
    asciiCall("raw.get", () => api.get({ boxId }, requestInit(options.signal))).then(
      (result) => result.box,
    ),
    latestSnapshot(api, boxId),
  ]);
  if (box.state === "archived") {
    await asciiCall("raw.resume", () => api.resume({ boxId }, requestInit(options.signal)));
    await waitForReady(api, boxId, options);
    await asciiCall("raw.archive", () => api.stop({ boxId }, requestInit(options.signal)));
  } else if (box.state !== "archiving") {
    await asciiCall("raw.archive", () => api.stop({ boxId }, requestInit(options.signal)));
  }
  await waitForArchived(api, boxId, options);
  await waitForSnapshot(api, boxId, previous?.id, options);
  await asciiCall("raw.remove", () => api.remove({ boxId }, requestInit(options.signal)));
}

async function runCommand(
  api: BoxApi,
  boxId: string,
  virtualCwd: string,
  input: CommandInput,
  options: RunOptions,
): Promise<CommandResult> {
  assertNotAborted(options.signal);
  const started = performance.now();
  const command = commandWithEnvironment(input, options.env);
  const timeoutSeconds =
    options.timeout === undefined
      ? undefined
      : Math.min(60, Math.max(1, Math.ceil(options.timeout / 1_000)));
  const result = await asciiCall("process.run", () =>
    api.command(
      {
        boxId,
        commandRequest: {
          command,
          cwd: remoteCwd(toRemotePath(options.cwd ?? virtualCwd, virtualCwd)),
          timeoutSeconds,
        },
      },
      requestInit(options.signal),
    ),
  );
  if (result.timedOut) {
    throw new SandboxError({
      code: "timeout",
      provider: "ascii",
      operation: "process.run",
      message: `Command timed out after ${timeoutSeconds ?? 30}s`,
    });
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode ?? 1,
    success: result.success,
    signal: result.signal ?? undefined,
    durationMs:
      result.startedAt && result.finishedAt
        ? result.finishedAt.getTime() - result.startedAt.getTime()
        : Math.round(performance.now() - started),
  };
}

async function startProcess(
  api: BoxApi,
  boxId: string,
  virtualCwd: string,
  input: CommandInput,
  options: RunOptions,
  pollIntervalMs: number,
): Promise<SandboxProcess> {
  assertNotAborted(options.signal);
  const processId = crypto.randomUUID();
  const work = `.sandbox-sdk/processes/${processId}`;
  const remoteCwd = toRemotePath(options.cwd ?? virtualCwd, virtualCwd);
  const command = commandWithEnvironment(input, options.env);
  const timedCommand = options.timeout
    ? `timeout ${Math.max(1, Math.ceil(options.timeout / 1_000))}s sh -lc ${shellQuote(command)}`
    : `sh -lc ${shellQuote(command)}`;
  const inner = [
    'work="$1"',
    'cwd="$2"',
    `cd "$cwd" && ${timedCommand}`,
    "code=$?",
    'printf "%s" "$code" > "$work/exit"',
    'exit "$code"',
  ].join("; ");
  const bootstrap = [
    "root=$(pwd -P)",
    `work="$root/${work}"`,
    `cwd="$root/${remoteCwd === "." ? "" : remoteCwd}"`,
    'mkdir -p "$work"',
    ': > "$work/stdout"',
    ': > "$work/stderr"',
    `nohup setsid sh -c ${shellQuote(inner)} sandbox-sdk "$work" "$cwd" > "$work/stdout" 2> "$work/stderr" < /dev/null & printf "%s" "$!"`,
  ].join("; ");
  const started = await runCommand(api, boxId, virtualCwd, bootstrap, {});
  assertCommandSucceeded(started, "process.start");
  const pid = started.stdout.trim();
  if (!/^\d+$/.test(pid)) throw new Error(`process.start returned an invalid pid: ${pid}`);
  let killed = false;

  const readExitCode = async (): Promise<number | undefined> => {
    const value = await readOptionalFile(api, boxId, `${work}/exit`);
    if (!value) return undefined;
    const parsed = Number.parseInt(new TextDecoder().decode(value).trim(), 10);
    return Number.isFinite(parsed) ? parsed : 1;
  };

  return {
    id: processId,
    async status() {
      if ((await readExitCode()) !== undefined) return killed ? "killed" : "exited";
      const status = await runCommand(api, boxId, virtualCwd, `kill -0 ${pid}`, {});
      return status.exitCode === 0 ? "running" : "unknown";
    },
    async *output() {
      const offsets = { stdout: 0, stderr: 0 };
      let exitObserved = false;
      for (;;) {
        assertNotAborted(options.signal);
        const [stdout, stderr, exitCode] = await Promise.all([
          readOptionalFile(api, boxId, `${work}/stdout`),
          readOptionalFile(api, boxId, `${work}/stderr`),
          readExitCode(),
        ]);
        for (const [stream, bytes] of [
          ["stdout", stdout],
          ["stderr", stderr],
        ] as const) {
          if (bytes && bytes.byteLength > offsets[stream]) {
            const data = bytes.slice(offsets[stream]);
            offsets[stream] = bytes.byteLength;
            yield {
              stream,
              data,
              timestamp: new Date(),
            } satisfies ProcessOutputEvent;
          }
        }
        if (exitCode !== undefined) {
          if (exitObserved) return;
          exitObserved = true;
        } else {
          exitObserved = false;
        }
        await delay(pollIntervalMs, options.signal);
      }
    },
    async write() {
      unsupported("ascii", "process.stdin");
    },
    async wait() {
      for (;;) {
        assertNotAborted(options.signal);
        const exitCode = await readExitCode();
        if (exitCode !== undefined) return { exitCode };
        await delay(pollIntervalMs, options.signal);
      }
    },
    async kill(signal = "SIGTERM") {
      if (!/^SIG[A-Z0-9]+$/.test(signal)) {
        throw new SandboxError({
          code: "invalid_input",
          provider: "ascii",
          operation: "process.cancel",
          message: `Invalid process signal: ${signal}`,
        });
      }
      const signalName = signal.slice(3);
      const result = await runCommand(
        api,
        boxId,
        virtualCwd,
        `kill -s ${shellQuote(signalName)} -- -${pid} 2>/dev/null || kill -s ${shellQuote(signalName)} ${pid} 2>/dev/null || true; printf ${shellQuote(String(signalExitCode(signalName)))} > ${shellQuote(`${work}/exit`)}`,
        {},
      );
      assertCommandSucceeded(result, "process.cancel");
      killed = true;
    },
  };
}

function commandWithEnvironment(
  input: CommandInput,
  environment?: Readonly<Record<string, string>>,
): string {
  const command = commandString(input);
  const entries = Object.entries(environment ?? {});
  if (!entries.length) return command;
  const assignments = entries.map(([key, value]) => shellQuote(`${key}=${value}`)).join(" ");
  return `env ${assignments} sh -lc ${shellQuote(command)}`;
}

function parseDirectoryEntries(stdout: string, path: string): SandboxDirectoryEntry[] {
  const fields = stdout.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3 !== 0) throw new Error("files.list returned malformed output");
  const base = path.replace(/\/$/, "");
  const entries: SandboxDirectoryEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const name = fields[index]!;
    const nativeType = fields[index + 1]!;
    const size = Number.parseInt(fields[index + 2]!, 10);
    entries.push({
      name,
      path: `${base}/${name}`.replace(/\/{2,}/g, "/"),
      type:
        nativeType === "f"
          ? "file"
          : nativeType === "d"
            ? "directory"
            : nativeType === "l"
              ? "symlink"
              : "unknown",
      ...(nativeType === "f" && Number.isFinite(size) ? { size } : {}),
    });
  }
  return entries;
}

function toRemotePath(path: string, virtualRoot: string): string {
  if (path === virtualRoot) return ".";
  if (path.startsWith(`${virtualRoot}/`)) return path.slice(virtualRoot.length + 1);
  return path.replace(/^\/+/, "") || ".";
}

function remoteCwd(path: string): string | undefined {
  return path === "." ? undefined : path;
}

function signalExitCode(signal: string): number {
  const numbers: Record<string, number> = {
    HUP: 1,
    INT: 2,
    QUIT: 3,
    KILL: 9,
    TERM: 15,
  };
  return 128 + (numbers[signal] ?? 15);
}

function extractUrl(output: string): string {
  const plain = output.replaceAll(ansiEscape, "");
  const match = plain.match(/https:\/\/[^\s]+/);
  if (!match) throw new Error("ports.expose did not return an HTTPS URL");
  return match[0];
}

function rawQueryValue(url: string, name: string): string | undefined {
  const query = url.slice(url.indexOf("?") + 1).split("#", 1)[0] ?? "";
  const prefix = `${encodeURIComponent(name)}=`;
  return query
    .split("&")
    .find((field) => field.startsWith(prefix))
    ?.slice(prefix.length);
}

async function fetchProtectedPreview(url: string, init: RequestInit): Promise<Response> {
  if (init.redirect === "manual" || init.redirect === "error") return fetch(url, init);
  let target = new URL(url);
  let request = { ...init, redirect: "manual" as const };
  const cookies = new Map<string, string>();
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const response = await fetch(target, request);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || !location) return response;
    for (const value of responseCookies(response.headers)) {
      const pair = value.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (pair && separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    const next = new URL(location, target);
    const headers = new Headers(request.headers);
    if (next.origin === target.origin && cookies.size)
      headers.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    else headers.delete("cookie");
    const method = request.method?.toUpperCase();
    const switchToGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST");
    request = switchToGet
      ? { ...request, method: "GET", body: undefined, headers }
      : { ...request, headers };
    target = next;
  }
  throw new SandboxError({
    code: "unavailable",
    provider: "ascii",
    operation: "ports.request",
    message: "Ascii preview exceeded the redirect limit",
  });
}

function responseCookies(headers: Headers): string[] {
  const extended = headers as Headers & { getSetCookie?: () => string[] };
  return (
    extended.getSetCookie?.() ?? (headers.get("set-cookie") ? [headers.get("set-cookie")!] : [])
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function assertCommandSucceeded(result: CommandResult, operation: string): void {
  if (result.success) return;
  throw new SandboxError({
    code: "process_failed",
    provider: "ascii",
    operation,
    message: `${operation} failed with exit code ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`,
  });
}

async function readOptionalFile(
  api: BoxApi,
  boxId: string,
  path: string,
): Promise<Uint8Array | undefined> {
  try {
    const result = await api.readFile({ boxId, path, encoding: "base64" });
    return new Uint8Array(Buffer.from(result.content, "base64"));
  } catch (error) {
    if (responseStatus(error) === 404) return undefined;
    const normalized = await normalizeAsciiError("files.read", error);
    if (
      normalized.code === "invalid_input" &&
      /enoent|no such file or directory/i.test(normalized.message)
    )
      return undefined;
    throw normalized;
  }
}

async function latestSnapshot(api: BoxApi, boxId: string): Promise<SnapshotSummary | null> {
  return (await asciiCall("snapshot.latest", () => api.getLatestBoxSnapshot({ boxId }))).snapshot;
}

async function waitForReady(api: BoxApi, boxId: string, options: PollOptions): Promise<Box> {
  return poll(options, async () => {
    const box = (
      await asciiCall("sandbox.wait", () => api.get({ boxId }, requestInit(options.signal)))
    ).box;
    if (["ready", "idle", "running"].includes(box.state)) return box;
    if (["archived", "archiving", "error"].includes(box.state))
      throw new Error(`Box entered terminal state ${box.state}`);
  });
}

async function waitForArchived(api: BoxApi, boxId: string, options: PollOptions): Promise<Box> {
  return poll(options, async () => {
    const box = (
      await asciiCall("sandbox.archive", () => api.get({ boxId }, requestInit(options.signal)))
    ).box;
    if (box.state === "archived") return box;
    if (box.state === "error") throw new Error("Box entered terminal state error");
  });
}

async function waitForSnapshot(
  api: BoxApi,
  boxId: string,
  previousId: string | undefined,
  options: PollOptions,
): Promise<SnapshotSummary> {
  return poll(options, async () => {
    const snapshot = await latestSnapshot(api, boxId);
    return snapshot && snapshot.id !== previousId ? snapshot : undefined;
  });
}

interface PollOptions {
  timeoutMs: number;
  intervalMs: number;
  signal?: AbortSignal;
}

async function poll<T>(options: PollOptions, read: () => Promise<T | undefined>): Promise<T> {
  const deadline =
    options.timeoutMs === 0 ? Number.POSITIVE_INFINITY : Date.now() + options.timeoutMs;
  for (;;) {
    assertNotAborted(options.signal);
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new SandboxError({
        code: "timeout",
        provider: "ascii",
        operation: "sandbox.wait",
        message: `Timed out waiting for Box after ${options.timeoutMs}ms`,
      });
    }
    await delay(options.intervalMs, options.signal);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function requestInit(signal?: AbortSignal): RequestInit | undefined {
  return signal ? { signal } : undefined;
}

async function asciiCall<T>(operation: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw await normalizeAsciiError(operation, error);
  }
}

async function normalizeAsciiError(operation: string, error: unknown): Promise<SandboxError> {
  if (error instanceof SandboxError) return error;
  const status = responseStatus(error);
  const code = statusCode(status);
  let detail: string | undefined;
  const response = responseFromError(error);
  if (response) {
    try {
      const body = (await response.clone().json()) as {
        error?: { message?: string; code?: string };
        message?: string;
      };
      detail = body.error?.message ?? body.message ?? body.error?.code;
    } catch {
      // Preserve the SDK's error when the response is not JSON.
    }
  }
  const fallback = error instanceof Error ? error.message : "Unknown Ascii Box error";
  return new SandboxError({
    code,
    provider: "ascii",
    operation,
    message: detail ?? fallback,
    cause: error,
  });
}

function responseFromError(error: unknown): Response | undefined {
  if (error instanceof ResponseError) return error.response;
  if (
    typeof error === "object" &&
    error !== null &&
    "response" in error &&
    error.response instanceof Response
  )
    return error.response;
  return undefined;
}

function responseStatus(error: unknown): number | undefined {
  return responseFromError(error)?.status;
}

function statusCode(status: number | undefined): SandboxErrorCode {
  if (status === 400 || status === 422) return "invalid_input";
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 408 || status === 504) return "timeout";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  if (status !== undefined && status >= 500) return "unavailable";
  return "internal";
}
