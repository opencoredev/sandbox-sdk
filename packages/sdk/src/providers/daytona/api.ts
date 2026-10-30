/**
 * Daytona over HTTP, for the adapter and `box.native`. Two planes:
 * - `api`: the control plane (`https://app.daytona.io/api`): sandboxes, snapshots, previews.
 * - `toolbox`: the per-sandbox daemon behind Daytona's proxy, `<toolboxProxyUrl>/<sandboxId>`: files and
 *   processes. Each sandbox DTO names its proxy URL; when one doesn't, `GET /sandbox/{id}/toolbox-proxy-url`
 *   does. The newest URL seen for a sandbox wins, as in the official SDK.
 * Both take the same bearer credential, plus `X-Daytona-Organization-ID` with a JWT.
 */
import { SandboxError } from "../../errors.js";
import {
  createDeadline,
  createHttpClient,
  sleep,
  type Deadline,
  type Fetch,
  type HttpClient,
} from "../../http.js";
import { httpHooks } from "./errors.js";
import { boundaryOf, firstPart, readAll } from "./multipart.js";

export type DaytonaPlane = "api" | "toolbox";

/** The fields of Daytona's SandboxDto the adapter reads. */
export interface SandboxDto {
  id: string;
  state?: string;
  labels: Record<string, string>;
  createdAt?: string;
  public?: boolean;
  cpu?: number;
  memory?: number;
  disk?: number;
  toolboxProxyUrl?: string;
}

/** The fields of the toolbox's FileInfo the adapter reads. */
export interface FileDto {
  name: string;
  isDir: boolean;
  size?: number;
  mode?: string;
  modifiedAt?: string;
  modTime?: string;
}

export interface Credentials {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
}

export interface DaytonaHttpOptions {
  /** Read per request, so the environment applies as it was at first use. */
  baseUrl: () => string;
  credentials: () => Credentials;
  requestTimeoutMs: number;
  /** Values to keep out of errors besides the credentials. */
  secrets: () => Iterable<string>;
  fetch?: Fetch;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optional = <T>(value: unknown, test: (cause: unknown) => cause is T): T | undefined =>
  test(value) ? value : undefined;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

function malformed(what: string, sandboxId?: string): SandboxError {
  return new SandboxError(
    `Daytona returned ${what} the adapter cannot read. Check the Daytona API version.`,
    { code: "provider", provider: "daytona", sandboxId },
  );
}

/** Validates a SandboxDto. */
export function sandboxDto(value: unknown): SandboxDto {
  if (!record(value) || !isString(value.id) || !value.id) throw malformed("a sandbox");

  const labels = record(value.labels)
    ? Object.fromEntries(
        Object.entries(value.labels).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

  return {
    id: value.id,
    labels,
    state: optional(value.state, isString),
    createdAt: optional(value.createdAt, isString),
    public: optional(value.public, isBoolean),
    cpu: optional(value.cpu, isNumber),
    memory: optional(value.memory, isNumber),
    disk: optional(value.disk, isNumber),
    toolboxProxyUrl: optional(value.toolboxProxyUrl, isString),
  };
}

function fileDto(value: unknown, sandboxId: string): FileDto {
  if (!record(value) || !isString(value.name) || !isBoolean(value.isDir))
    throw malformed("file information", sandboxId);

  return {
    name: value.name,
    isDir: value.isDir,
    size: optional(value.size, isNumber),
    mode: optional(value.mode, isString),
    modifiedAt: optional(value.modifiedAt, isString),
    modTime: optional(value.modTime, isString),
  };
}

/** States a waiting sandbox can't leave on its own. */
const failedStates = new Set(["error", "build_failed"]);

// The SDK's poll cadence without its event socket: 100 ms for five seconds, then up to 1 s.
const pollDelay = (elapsed: number, previous: number) =>
  elapsed < 5_000 ? 100 : Math.min(previous * 1.1, 1_000);

export function daytonaHttp(options: DaytonaHttpOptions) {
  /** Newest toolbox proxy URL per sandbox. */
  const proxies = new Map<string, string>();

  const remember = (dto: SandboxDto) => {
    if (dto.toolboxProxyUrl) proxies.set(dto.id, dto.toolboxProxyUrl);

    return dto;
  };

  const auth = (): Record<string, string> => {
    const { apiKey, jwtToken, organizationId } = options.credentials();

    return apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : {
          authorization: `Bearer ${jwtToken ?? ""}`,
          "x-daytona-organization-id": organizationId ?? "",
        };
  };

  const http: HttpClient<DaytonaPlane> = createHttpClient<DaytonaPlane>({
    provider: "daytona",
    label: "Daytona",
    defaultPlane: "api",
    timeoutMs: options.requestTimeoutMs,
    fetch: options.fetch,
    authHint:
      "Set DAYTONA_API_KEY to a valid Daytona API key, or DAYTONA_JWT_TOKEN with DAYTONA_ORGANIZATION_ID.",
    secrets: () => {
      const { apiKey, jwtToken } = options.credentials();

      return [apiKey, jwtToken, ...options.secrets()];
    },
    ...httpHooks(() => {
      const { apiKey, jwtToken } = options.credentials();

      return [apiKey, jwtToken, ...options.secrets()].filter(isString);
    }),
    planes: {
      api: { baseUrl: options.baseUrl, auth, headers: { accept: "application/json" } },
      toolbox: {
        async baseUrl({ sandboxId, signal }) {
          if (sandboxId === undefined)
            throw new SandboxError(
              "The toolbox plane belongs to one sandbox. Use box.native, or pass the sandbox to a sandbox-bound client.",
              { code: "invalid_argument", provider: "daytona" },
            );
          let proxy = proxies.get(sandboxId);

          if (proxy === undefined) {
            const body = await http.json({
              method: "GET",
              path: "/sandbox/{sandboxId}/toolbox-proxy-url",
              params: { sandboxId },
              sandboxId,
              signal,
            });

            if (!record(body) || !isString(body.url) || !body.url)
              throw malformed("a toolbox proxy URL", sandboxId);
            proxy = body.url;
            proxies.set(sandboxId, proxy);
          }

          return `${proxy.replace(/\/+$/, "")}/${encodeURIComponent(sandboxId)}`;
        },
        auth,
      },
    },
  });

  async function get(id: string, deadline?: Deadline): Promise<SandboxDto> {
    return remember(
      sandboxDto(
        await http.json({
          method: "GET",
          path: "/sandbox/{sandboxId}",
          params: { sandboxId: id },
          sandboxId: id,
          deadline,
        }),
      ),
    );
  }

  /**
   * Polls until `done(state)` holds. A failed state rejects with `provider`; `gone` decides what a 404
   * means (deletion waits treat it as done). The deadline rejects with `timeout` or `aborted`.
   */
  async function waitFor(
    id: string,
    done: (state: string | undefined) => boolean,
    deadline: Deadline,
    what: string,
    gone = false,
  ): Promise<SandboxDto | undefined> {
    const started = Date.now();
    let delay = 100;

    for (;;) {
      let dto: SandboxDto;

      try {
        dto = await get(id, deadline);
      } catch (error) {
        if (gone && error instanceof SandboxError && error.code === "not_found") return undefined;
        throw error;
      }

      if (done(dto.state)) return dto;

      if (dto.state !== undefined && failedStates.has(dto.state))
        throw new SandboxError(
          `Sandbox ${what} failed with state ${dto.state}. Inspect the sandbox in the Daytona dashboard.`,
          { code: "provider", provider: "daytona", sandboxId: id },
        );
      delay = pollDelay(Date.now() - started, delay);
      await sleep(Math.min(delay, Math.max(1, deadline.remaining())), deadline, "daytona");
    }
  }

  const lifecycle = (timeoutMs: number, signal?: AbortSignal) => createDeadline(timeoutMs, signal);

  const post = async (id: string, action: string, deadline: Deadline, body?: unknown) =>
    remember(
      sandboxDto(
        await http.json({
          method: "POST",
          path: `/sandbox/{sandboxId}/${action}`,
          params: { sandboxId: id },
          sandboxId: id,
          body,
          deadline,
        }),
      ),
    );

  const control = {
    get,
    waitFor,
    async create(body: Record<string, unknown>, deadline: Deadline): Promise<SandboxDto> {
      return remember(
        sandboxDto(await http.json({ method: "POST", path: "/sandbox", body, deadline })),
      );
    },
    async *list(labels: Record<string, string>): AsyncGenerator<SandboxDto> {
      let cursor: string | undefined;

      do {
        const page = await http.json({
          method: "GET",
          path: "/sandbox",
          query: { labels: JSON.stringify(labels), cursor },
        });

        if (!record(page) || !Array.isArray(page.items)) throw malformed("a sandbox list");

        for (const item of page.items) yield remember(sandboxDto(item));
        cursor = isString(page.nextCursor) && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor !== undefined);
    },
    /** Deletes, then with `wait` polls until the sandbox is gone or destroyed. */
    async remove(id: string, wait: boolean, timeoutMs = 60_000): Promise<void> {
      const deadline = lifecycle(timeoutMs);

      const body = await http.json({
        method: "DELETE",
        path: "/sandbox/{sandboxId}",
        params: { sandboxId: id },
        sandboxId: id,
        deadline,
      });

      proxies.delete(id);

      if (!wait || (record(body) && body.state === "destroyed")) return;
      await waitFor(id, (state) => state === "destroyed", deadline, "deletion", true);
    },
    /** A best-effort delete after an abort, with its own short deadline. */
    async cleanup(id: string): Promise<void> {
      await http.cleanup({
        method: "DELETE",
        path: "/sandbox/{sandboxId}",
        params: { sandboxId: id },
        sandboxId: id,
      });
      proxies.delete(id);
    },
    async stop(id: string, timeoutMs = 60_000) {
      const deadline = lifecycle(timeoutMs);
      const dto = await post(id, "stop", deadline);

      if (dto.state !== "stopped" && dto.state !== "destroyed")
        await waitFor(
          id,
          (state) => state === "stopped" || state === "destroyed",
          deadline,
          "stop",
          true,
        );
    },
    async start(id: string, timeoutMs = 60_000) {
      const deadline = lifecycle(timeoutMs);
      const dto = await post(id, "start", deadline);

      if (dto.state !== "started")
        await waitFor(id, (state) => state === "started", deadline, "start");
    },
    async resize(
      id: string,
      resources: { cpu: number; memory: number; disk: number },
      timeoutMs = 60_000,
    ) {
      const deadline = lifecycle(timeoutMs);
      const dto = await post(id, "resize", deadline, resources);

      if (dto.state === "resizing")
        await waitFor(id, (state) => state !== "resizing", deadline, "resize");
    },
    /** Starts a snapshot and waits until the sandbox leaves `snapshotting`. */
    async snapshot(id: string, name: string, timeoutMs: number) {
      const deadline = lifecycle(timeoutMs);
      await post(id, "snapshot", deadline, { name });
      await waitFor(id, (state) => state !== "snapshotting", deadline, "snapshot");
    },
    async previewLink(id: string, port: number): Promise<{ url: string; token: string }> {
      const body = await http.json({
        method: "GET",
        path: "/sandbox/{sandboxId}/ports/{port}/preview-url",
        params: { sandboxId: id, port },
        sandboxId: id,
      });

      if (!record(body) || !isString(body.url) || !isString(body.token))
        throw malformed("a preview link", id);

      return { url: body.url, token: body.token };
    },
  };

  return { http, control, toolbox: (id: string) => toolbox(http, control, id) };
}

export type DaytonaControl = ReturnType<typeof daytonaHttp>["control"];

/** Toolbox calls for one sandbox: what `exec.ts`, `buffered.ts` and the file operations use. */
export interface Toolbox {
  readonly id: string;
  readonly fs: {
    /** Writes `data` to the absolute `path`, creating parent directories. */
    upload(data: Uint8Array, path: string): Promise<void>;
    /** Reads the absolute `path`. A missing file is `file_not_found`. */
    download(path: string): Promise<Uint8Array>;
    /** Streams the absolute `path`. The signal and deadline cover the whole body. */
    downloadStream(
      path: string,
      options: { signal: AbortSignal; timeoutMs: number },
    ): Promise<ReadableStream<Uint8Array>>;
    deleteFile(path: string, recursive?: boolean): Promise<void>;
    createFolder(path: string, mode: string): Promise<void>;
    setFilePermissions(path: string, mode: string): Promise<void>;
    getFileDetails(path: string): Promise<FileDto>;
    listFiles(path: string): Promise<FileDto[]>;
  };
  readonly process: {
    /** Runs `command` and returns its combined output. `timeoutSec` is enforced in the sandbox; the request waits 5 s longer. */
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutSec?: number,
    ): Promise<{ exitCode: number; result: string }>;
    /** Runs Python code from the request body, so large code avoids argv limits. */
    codeRun(code: string, timeoutSec: number): Promise<{ exitCode: number; result: string }>;
    createSession(session: string): Promise<void>;
    executeSessionCommand(
      session: string,
      request: { command: string; runAsync: boolean; suppressInputEcho: boolean },
    ): Promise<{ cmdId?: string }>;
    getSessionCommand(session: string, command: string): Promise<{ exitCode?: number }>;
    /** Follows a session command's combined output until it ends or `signal` fires. Text is decoded across chunks. */
    followSessionCommandLogs(
      session: string,
      command: string,
      onText: (text: string) => void,
      signal: AbortSignal,
    ): Promise<void>;
    deleteSession(session: string): Promise<void>;
  };
  /** Stops the sandbox and waits until it is stopped. */
  stop(): Promise<void>;
}

const execBufferMs = 5_000;

function toolbox(http: HttpClient<DaytonaPlane>, control: DaytonaControl, id: string): Toolbox {
  const base = { plane: "toolbox" as const, sandboxId: id };

  const call = (
    method: "GET" | "POST" | "DELETE",
    path: string,
    extra: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      params?: Record<string, string>;
      timeoutMs?: number;
    } = {},
  ) => http.request({ ...base, method, path, ...extra });

  const result = (value: unknown) => {
    if (!record(value)) throw malformed("a command result", id);

    return {
      exitCode: isNumber(value.exitCode) ? value.exitCode : 0,
      result: isString(value.result) ? value.result : "",
    };
  };

  /** Opens `POST /files/bulk-download` for one path and returns the file part's body; an error part rejects. */
  async function open(
    path: string,
    settings: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<ReadableStream<Uint8Array>> {
    const response = await http.stream({
      ...base,
      method: "POST",
      path: "/files/bulk-download",
      body: { paths: [path] },
      readOnly: true,
      signal: settings.signal,
      ...(settings.timeoutMs === undefined ? undefined : { timeoutMs: settings.timeoutMs }),
    });

    const boundary = boundaryOf(response.headers.get("content-type"));

    if (!boundary || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw malformed("a download that is not multipart", id);
    }

    const part = await firstPart(response.body, boundary, { provider: "daytona", sandboxId: id });

    if (part.name === "file") return part.body;

    if (part.name !== "error") {
      await part.body.cancel().catch(() => {});
      throw malformed(`a download part named ${JSON.stringify(part.name ?? "").slice(0, 32)}`, id);
    }

    // An error part carries the daemon's usual error JSON: map it like the same failure on its own route.
    const text = new TextDecoder().decode((await readAll(part.body)).subarray(0, 64 * 1024));
    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }

    const status = record(json) && isNumber(json.statusCode) ? json.statusCode : 500;
    const code = record(json) && isString(json.code) ? json.code : undefined;
    const message = record(json) && isString(json.message) ? json.message : text;

    const missing =
      code === "FILE_NOT_FOUND" ||
      status === 404 ||
      (status === 400 && /no such file or directory|\bnot found\b/i.test(message));

    throw new SandboxError(
      `Daytona POST /files/bulk-download failed (HTTP ${status}${code && /^[A-Z_]{1,64}$/.test(code) ? ` ${code}` : ""}).`,
      {
        code: missing
          ? "file_not_found"
          : status === 400
            ? "invalid_argument"
            : status === 401 || status === 403
              ? "auth"
              : "provider",
        provider: "daytona",
        sandboxId: id,
      },
    );
  }

  return {
    id,
    fs: {
      async upload(data, path) {
        const form = new FormData();
        form.append("files[0].path", path);
        form.append("files[0].file", new Blob([Uint8Array.from(data)]), path);
        await call("POST", "/files/bulk-upload", { body: form });
      },
      async download(path) {
        return readAll(await open(path));
      },
      downloadStream: (path, settings) => open(path, settings),
      async deleteFile(path, recursive) {
        await call("DELETE", "/files", { query: { path, recursive } });
      },
      async createFolder(path, mode) {
        await call("POST", "/files/folder", { query: { path, mode } });
      },
      async setFilePermissions(path, mode) {
        await call("POST", "/files/permissions", { query: { path, mode } });
      },
      async getFileDetails(path) {
        return fileDto((await call("GET", "/files/info", { query: { path } })).json(), id);
      },
      async listFiles(path) {
        const body = (await call("GET", "/files", { query: { path } })).json();

        if (!Array.isArray(body)) throw malformed("a file list", id);

        return body.map((item) => fileDto(item, id));
      },
    },
    process: {
      async executeCommand(command, cwd, env, timeoutSec) {
        return result(
          (
            await call("POST", "/process/execute", {
              body: {
                command,
                cwd,
                timeout: timeoutSec,
                envs: env && Object.keys(env).length ? env : undefined,
              },
              ...(timeoutSec ? { timeoutMs: timeoutSec * 1000 + execBufferMs } : undefined),
            })
          ).json(),
        );
      },
      async codeRun(code, timeoutSec) {
        return result(
          (
            await call("POST", "/process/code-run", {
              body: { code, language: "python", timeout: timeoutSec },
              timeoutMs: timeoutSec * 1000 + execBufferMs,
            })
          ).json(),
        );
      },
      async createSession(session) {
        await call("POST", "/process/session", { body: { sessionId: session } });
      },
      async executeSessionCommand(session, request) {
        const body = (
          await call("POST", "/process/session/{session}/exec", {
            params: { session },
            body: request,
          })
        ).json();

        return { cmdId: record(body) && isString(body.cmdId) ? body.cmdId : undefined };
      },
      async getSessionCommand(session, command) {
        const body = (
          await call("GET", "/process/session/{session}/command/{command}", {
            params: { session, command },
          })
        ).json();

        return {
          exitCode: record(body) && isNumber(body.exitCode) ? body.exitCode : undefined,
        };
      },
      async followSessionCommandLogs(session, command, onText, signal) {
        // No startup or idle timeout: a silent command sends nothing for as long as it runs. The caller's
        // wait loop owns the deadline and aborts `signal` when it is done.
        const response = await http.stream({
          ...base,
          method: "GET",
          path: "/process/session/{session}/command/{command}/logs",
          params: { session, command },
          query: { follow: true },
          signal,
          startupTimeoutMs: 2 ** 31 - 1,
        });

        if (!response.body) return;
        const decoder = new TextDecoder();
        const reader = response.body.getReader();

        try {
          for (;;) {
            const { done, value } = await reader.read();

            if (done) break;
            const text = decoder.decode(value, { stream: true });

            if (text) onText(text);
          }

          const rest = decoder.decode();

          if (rest) onText(rest);
        } finally {
          await reader.cancel().catch(() => {});
        }
      },
      async deleteSession(session) {
        await call("DELETE", "/process/session/{session}", { params: { session } });
      },
    },
    stop: () => control.stop(id),
  };
}
