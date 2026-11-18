/** Instabox (https://instabox.sh, by InsForge) through its REST API. No other package to install.
 * Sources, retrieved 2026-11-18:
 * https://instabox.sh/docs/api.md and https://api.instabox.sh/v1/openapi.json
 * https://instabox.sh/docs/api/machines.md, lifecycle.md, commands.md, snapshots.md,
 * operations.md and ports.md
 * https://instabox.sh/docs/account/limits.md
 */
import { randomUUID } from "node:crypto";
import { SandboxError, describeNative, type ErrorCode } from "../../errors.js";
import type {
  CreateInput,
  ExecInput,
  ExecResult,
  FileInfo,
  Labels,
  Provider,
} from "../../provider.js";
import type { JsonValue } from "../../shared/json.js";
import { isString } from "../../shared/narrow.js";
import {
  field,
  findEntries,
  isFinished,
  keyLabel,
  parseMachinePage,
  parseEntry,
  parseExecEvent,
  parseMachine,
  parseOperation,
  parseSnapshot,
  statLine,
  toInfo,
  type Machine,
  type Operation,
} from "./api.js";
import {
  ApiFailure,
  createError,
  errorCode,
  fail,
  instaboxError,
  operationError,
  parseErrorBody,
  type CreateStage,
} from "./errors.js";

export type InstaboxCapability = "pause" | "snapshot" | "snapshot-delete" | "size";

export interface InstaboxOptions {
  /** Defaults to INSTABOX_API_KEY. Needs the images:write and images:delete scopes for snapshots. */
  apiKey?: string;
  /** Default: INSTABOX_API_URL, else https://api.instabox.sh. */
  baseUrl?: string;
  /** Template for new machines, optionally pinned as `id@version`. Default: Instabox's default, `agent-browser`. */
  template?: string;
  /** Deadline for each control-plane request. Default: 60 seconds. */
  requestTimeoutMs?: number;
  /** Deadline for create, start, pause, resume, delete and snapshot operations. Default: 5 minutes. */
  operationTimeoutMs?: number;
}

/** `box.native`: the machine ID and an authenticated request to Instabox's API. */
export interface InstaboxNative {
  readonly machineId: string;
  /** Calls `https://api.instabox.sh<path>` with this adapter's key. Writes get an `Idempotency-Key`. */
  request(input: {
    method: string;
    path: string;
    body?: JsonValue;
  }): Promise<JsonValue | undefined>;
}

export type InstaboxProvider = Provider<InstaboxNative, InstaboxCapability>;

const name = "instabox";
const workspaceRoot = "/data/workspace";

/** Pro and Builder sizes. Instabox has no 1 vCPU size, so `small` is its smallest, 2 vCPU / 4 GiB. */
const presets = {
  small: { vcpus: 2, memMiB: 4096 },
  medium: { vcpus: 4, memMiB: 8192 },
  large: { vcpus: 8, memMiB: 16384 },
} as const;

/** One guest command run once at create: /workspace on the persistent /data disk, the SDK's tmp dir, and the tools the core needs. */
const setupCommand = [
  "set -e",
  `if [ ! -e /workspace ]; then mkdir -p ${workspaceRoot}; sudo -n ln -s ${workspaceRoot} /workspace; fi`,
  "test -w /workspace/",
  "mkdir -p /tmp/.sandbox-sdk",
  "command -v python3 git tar nohup setsid >/dev/null",
].join("; ");

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Query parameters; an undefined one is left out. */
interface Query {
  readonly [name: string]: string | undefined;
}

/** `POST /v1/machines`. */
interface CreateBody {
  name: string;
  metadata: Labels;
  vcpus?: number;
  memMiB?: number;
  snapshotId?: string;
  templateId?: string;
  autoSuspendAfterSeconds?: number;
  deleteAfterSeconds?: number;
}

/** `POST /v1/machines/{id}/exec`: a shell command (`cmd`) or an argument vector (`argv`). */
type ExecBody =
  | { cmd: string; cwd?: string; envs?: Record<string, string>; stdin?: string }
  | { argv: string[] };

function quote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function absolute(path: string) {
  if (!path.startsWith("/")) throw fail(`path must be absolute: ${path}`, "invalid_argument");

  return path;
}

function sizeOf(size: CreateInput["size"]) {
  if (size === undefined) return {};

  if (isString(size)) return presets[size];

  if (size.diskGb !== undefined)
    throw fail(
      "the disk size comes with the machine size (20 GiB); omit diskGb and resize it later",
      "unsupported",
    );

  return { vcpus: size.cpu, memMiB: size.memoryMb };
}

/** 300 to 1800 seconds in whole minutes, or 0 for off. */
function idleSeconds(ms: number) {
  if (ms === 0) return 0;
  const seconds = Math.ceil(ms / 60_000) * 60;

  if (seconds < 300 || seconds > 1800)
    throw fail("idleTimeoutMs must be 0 or between 5 and 30 minutes", "unsupported");

  return seconds;
}

function lifetimeSeconds(ms: number) {
  const seconds = Math.ceil(ms / 1000);

  if (seconds < 60 || seconds > 86_400)
    throw fail("timeoutMs must be between 1 minute and 24 hours", "unsupported");

  return seconds;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Instabox through its REST API. Machines are Firecracker microVMs; `/workspace` links to the persistent `/data` disk. */
export function createInstaboxProvider(options: InstaboxOptions = {}): InstaboxProvider {
  const baseUrl = (
    options.baseUrl ??
    process.env.INSTABOX_API_URL ??
    "https://api.instabox.sh"
  ).replace(/\/+$/, "");

  const requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 300_000;
  const previews = new Map<string, string>();

  function apiKey() {
    const key = options.apiKey ?? process.env.INSTABOX_API_KEY;

    if (!key?.trim())
      throw fail("no API key; set INSTABOX_API_KEY or pass apiKey", "auth", {
        retryable: false,
      });

    return key.trim();
  }

  interface RequestInput {
    method: Method;
    path: string;
    /** What the call does, for error messages: "create", "exec", "read file". */
    operation: string;
    query?: Query;
    body?: CreateBody | (ExecBody & { timeoutSeconds: number }) | JsonValue;
    raw?: Uint8Array;
    /** Writes need one; the same key is reused across retries so a retry is never applied twice. */
    idempotent?: boolean;
    confirmDelete?: string;
    accept?: string;
    sandboxId?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  }

  function url(path: string, query?: Query) {
    const target = new URL(baseUrl + path);

    for (const [key, value] of Object.entries(query ?? {}))
      if (value !== undefined) target.searchParams.set(key, value);

    return target;
  }

  /** One request with bounded retries of retryable failures. Resolves with a successful response. */
  async function send(input: RequestInput): Promise<Response> {
    const idempotencyKey = input.idempotent ? randomUUID() : undefined;
    const deadline = Date.now() + (input.timeoutMs ?? requestTimeoutMs);

    for (let attempt = 0; ; attempt++) {
      const headers = new Headers({ "X-API-Key": apiKey() });

      if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);

      if (input.confirmDelete) headers.set("X-Confirm-Delete", input.confirmDelete);

      if (input.accept) headers.set("Accept", input.accept);
      let body: BodyInit | undefined;

      if (input.raw !== undefined) {
        headers.set("Content-Type", "application/octet-stream");
        // A copy owns a plain ArrayBuffer, which fetch's BodyInit requires.
        body = new Uint8Array(input.raw);
      } else if (input.body !== undefined) {
        headers.set("Content-Type", "application/json");
        body = JSON.stringify(input.body);
      }

      const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
      const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
      let response: Response;

      try {
        response = await fetch(url(input.path, input.query), {
          method: input.method,
          headers,
          body,
          signal,
        });
      } catch (error) {
        const kept = describeNative(error, { code: "outcome_unknown", known: true });

        if (input.signal?.aborted)
          throw fail(`${input.operation} aborted`, "aborted", {
            sandboxId: input.sandboxId,
            cause: kept.cause,
          });

        if (timeout.aborted)
          throw fail(`${input.operation} timed out`, "timeout", {
            sandboxId: input.sandboxId,
            retryable: true,
            cause: kept.cause,
          });

        // A network failure before any answer: safe to retry reads and idempotent writes.
        if ((input.method === "GET" || idempotencyKey) && attempt < 4) {
          await sleep(250 * 2 ** attempt, input.signal);
          continue;
        }

        // A read changed nothing; a write without an answer may have been applied.
        const code = input.method === "GET" ? "unavailable" : "outcome_unknown";

        throw fail(`${input.operation}: the connection failed`, code, {
          sandboxId: input.sandboxId,
          retryable: true,
          cause: kept.cause,
        });
      }

      if (response.ok) return response;
      const text = await response.text();
      let parsed: JsonValue | undefined;

      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }

      const failure = parseErrorBody(parsed) ?? {
        code: "unknown",
        retryable: response.status >= 500,
        retryAfterSeconds: undefined,
        requestId: undefined,
      };

      // 429s (start rate, the 32-request exec limit) and retryable 5xx are refused before any effect.
      const retryable = failure.retryable || response.status === 429;
      const header = Number(response.headers.get("retry-after"));
      const waitMs = 1000 * (failure.retryAfterSeconds ?? (Number.isFinite(header) ? header : 0));
      const backoff = Math.max(waitMs, 500 * 2 ** Math.min(attempt, 5));

      if (retryable && attempt < 8 && Date.now() + backoff < deadline) {
        await sleep(backoff, input.signal);

        if (input.signal?.aborted) throw fail(`${input.operation} aborted`, "aborted");
        continue;
      }

      throw new ApiFailure(response.status, failure);
    }
  }

  async function json(input: RequestInput): Promise<JsonValue | undefined> {
    try {
      const response = await send(input);
      const text = await response.text();
      const value: JsonValue | undefined = text ? JSON.parse(text) : undefined;

      return value;
    } catch (error) {
      throw instaboxError(error, input.operation, input.sandboxId);
    }
  }

  /** Long-polls an asynchronous change until it succeeds or fails. */
  async function settle(first: Operation, sandboxId: string): Promise<Operation> {
    let op = first;
    const deadline = Date.now() + operationTimeoutMs;

    while (!isFinished(op)) {
      if (Date.now() > deadline)
        throw fail(`operation ${op.id} did not finish in time`, "timeout", {
          sandboxId,
          retryable: true,
        });
      op = parseOperation(
        await json({
          method: "GET",
          path: `/v1/operations/${encodeURIComponent(op.id)}`,
          operation: "operation status",
          query: { wait: "25s" },
          sandboxId,
          timeoutMs: 40_000,
        }),
      );
    }

    if (op.state === "failed")
      throw operationError({ operationId: op.id, errorCode: op.errorCode, sandboxId });

    return op;
  }

  async function getMachine(id: string): Promise<Machine> {
    return parseMachine(
      await json({
        method: "GET",
        path: `/v1/machines/${encodeURIComponent(id)}`,
        operation: "connect",
        sandboxId: id,
      }),
    );
  }

  async function listMachines(labels: Labels): Promise<Machine[]> {
    const machines: Machine[] = [];
    let cursor: string | null = null;

    do {
      const target = url("/v1/machines");

      for (const [key, value] of Object.entries(labels))
        target.searchParams.append("metadata", `${key}:${value}`);
      target.searchParams.set("limit", "200");

      if (cursor) target.searchParams.set("cursor", cursor);

      const page = parseMachinePage(
        await json({ method: "GET", path: target.pathname + target.search, operation: "list" }),
      );

      machines.push(...page.machines);
      cursor = page.nextCursor;
    } while (cursor);

    // Match exactly, in case the server's filter is looser than equality.
    return machines.filter(
      (machine) =>
        machine.state !== "deleting" &&
        Object.entries(labels).every(([key, value]) => machine.metadata[key] === value),
    );
  }

  async function lifecycle(id: string, action: "suspend" | "resume" | "start") {
    const op = await json({
      method: "POST",
      path: `/v1/machines/${encodeURIComponent(id)}/${action}`,
      operation: action === "suspend" ? "pause" : action,
      idempotent: true,
      sandboxId: id,
    });

    await settle(parseOperation(op), id);
  }

  /** Streams one guest command over SSE. Closing the stream kills the command's process group. */
  async function stream(
    id: string,
    body: ExecBody,
    input: Pick<ExecInput, "signal" | "onChunk"> & { timeoutMs: number },
  ): Promise<ExecResult> {
    const clientTimeout = new AbortController();
    const timer = setTimeout(() => clientTimeout.abort(), input.timeoutMs);

    const signal = input.signal
      ? AbortSignal.any([input.signal, clientTimeout.signal])
      : clientTimeout.signal;

    let response: Response;

    try {
      response = await send({
        method: "POST",
        path: `/v1/machines/${encodeURIComponent(id)}/exec`,
        operation: "exec",
        body: {
          ...body,
          // The server's own limit backs up the client deadline; at most 10 minutes.
          timeoutSeconds: Math.min(600, Math.max(1, Math.ceil(input.timeoutMs / 1000) + 1)),
        },
        accept: "text/event-stream",
        sandboxId: id,
        signal,
        timeoutMs: input.timeoutMs + 30_000,
      });
    } catch (error) {
      clearTimeout(timer);

      if (signal.aborted) return { exitCode: null, timedOut: true };

      throw instaboxError(error, "exec", id);
    }

    const reader = response.body?.getReader();

    if (!reader) {
      clearTimeout(timer);
      throw fail("exec returned no stream", "provider", { sandboxId: id });
    }

    const decoder = new TextDecoder();
    let buffer = "";
    // A stream read to its end leaves the keep-alive connection reusable; cancelling it costs the next exec a TLS handshake.
    let drained = false;

    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;

        try {
          chunk = await reader.read();
        } catch (error) {
          if (signal.aborted) return { exitCode: null, timedOut: true };

          throw fail("exec stream broke", "outcome_unknown", {
            sandboxId: id,
            cause: describeNative(error, { code: "outcome_unknown", known: true }).cause,
          });
        }

        if (chunk.done) {
          drained = true;
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary = buffer.indexOf("\n\n");

        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf("\n\n");
          let event = "message";
          const data: string[] = [];

          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          }

          if (!data.length) continue;
          const parsed = parseExecEvent(event, data.join("\n"));

          if (!parsed) continue;

          switch (parsed.kind) {
            case "stdout":
            case "stderr":
              if (parsed.text) input.onChunk({ stream: parsed.kind, text: parsed.text });
              break;
            case "exit":
              drained = await drain(reader);

              return { exitCode: parsed.exitCode, timedOut: parsed.timedOut };
            case "error":
              throw fail(`exec failed (${parsed.code})`, errorCode(0, parsed.code), {
                sandboxId: id,
              });
            default: {
              const exhaustive: never = parsed;
              throw fail(`unknown exec event ${String(exhaustive)}`);
            }
          }
        }
      }

      if (signal.aborted) return { exitCode: null, timedOut: true };

      throw fail("exec stream ended without an exit event", "outcome_unknown", {
        sandboxId: id,
      });
    } finally {
      clearTimeout(timer);

      // Cancelling the response closes the connection, which kills the command if it still runs.
      if (!drained) await reader.cancel().catch(() => undefined);
    }
  }

  /** After the exit event the server ends the stream at once; read briefly to that end, else give up on reuse. */
  async function drain(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const deadline = Date.now() + 1000;

    try {
      while (Date.now() < deadline) {
        const timeout = new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), Math.max(1, deadline - Date.now())),
        );

        const next = await Promise.race([reader.read(), timeout]);

        if (next === "timeout") return false;

        if (next.done) return true;
      }
    } catch {
      return false;
    }

    return false;
  }

  /** A short helper command with no output streaming; fails on an exit code not in `allowed`. */
  async function guest(id: string, argv: string[], allowed: readonly number[] = [0]) {
    let stdout = "";
    let stderr = "";

    const result = await stream(
      id,
      { argv },
      {
        timeoutMs: 60_000,
        onChunk(chunk) {
          if (chunk.stream === "stdout") stdout += chunk.text;
          else stderr += chunk.text;
        },
      },
    );

    if (result.timedOut) throw fail(`${argv[0]} timed out`, "timeout", { sandboxId: id });

    if (result.exitCode === null || !allowed.includes(result.exitCode))
      throw fail(
        `${argv[0]} failed (exit ${result.exitCode}): ${stderr.trim().slice(0, 300)}`,
        "provider",
        { sandboxId: id },
      );

    return { exitCode: result.exitCode, stdout };
  }

  async function destroy(id: string) {
    try {
      const op = await json({
        method: "DELETE",
        path: `/v1/machines/${encodeURIComponent(id)}`,
        operation: "destroy",
        idempotent: true,
        confirmDelete: id,
        sandboxId: id,
      });

      await settle(parseOperation(op), id);
    } catch (error) {
      if (error instanceof SandboxError && error.code === "not_found") return;
      throw error;
    } finally {
      for (const key of previews.keys()) if (key.startsWith(`${id}:`)) previews.delete(key);
    }
  }

  /** After this call admitted machine `id`: delete it, and report the failure with its evidence. */
  async function abandon(id: string, stage: CreateStage, cause: unknown): Promise<never> {
    let cleanupCode: ErrorCode | undefined;

    try {
      await destroy(id);
    } catch (cleanup) {
      cleanupCode = cleanup instanceof SandboxError ? cleanup.code : "provider";
    }

    throw createError(cause, { sandboxId: id, stage, cleanupCode });
  }

  const provider: InstaboxProvider = {
    name,
    keyMode: "best-effort",
    commandShell: "bash",
    capabilities: new Set<InstaboxCapability>(["pause", "snapshot", "snapshot-delete", "size"]),

    async create(input) {
      if (input.network !== undefined && input.network !== "all")
        throw fail("network policies are not supported", "unsupported");
      const labels: Labels = { ...input.labels };

      if (input.key !== undefined) labels[keyLabel] = input.key;

      if (Object.keys(labels).length > 32)
        throw fail("at most 32 labels (one is used for the key)", "unsupported");
      const fromSnapshot = input.from?.startsWith("sn_") ? input.from : undefined;
      const template = fromSnapshot ? undefined : (input.from ?? options.template);
      // Without a size, a snapshot takes the plan's default size, not its source's.
      const size = sizeOf(input.size ?? (fromSnapshot ? "medium" : undefined));

      const body: CreateBody = {
        name: `sbx-${randomUUID().slice(0, 13).replace("-", "")}`,
        metadata: labels,
        ...size,
      };

      if (fromSnapshot) body.snapshotId = fromSnapshot;
      else if (template) body.templateId = template;

      if (input.idleTimeoutMs !== undefined)
        body.autoSuspendAfterSeconds = idleSeconds(input.idleTimeoutMs);

      if (input.timeoutMs !== undefined) body.deleteAfterSeconds = lifetimeSeconds(input.timeoutMs);

      const op = parseOperation(
        await json({
          method: "POST",
          path: "/v1/machines",
          operation: "create",
          body,
          idempotent: true,
          signal: input.signal,
        }),
      );

      const id = op.machineId;
      let stage: CreateStage = "operation";

      try {
        await settle(op, id);
        stage = "prepare";
        await guest(id, ["bash", "-c", setupCommand]);
        stage = "read";

        return toInfo(await getMachine(id));
      } catch (error) {
        return abandon(id, stage, error);
      }
    },

    async find(key) {
      const [first] = await listMachines({ [keyLabel]: key });

      return first ? toInfo(first) : undefined;
    },

    async connect(id) {
      return toInfo(await getMachine(id));
    },

    async list(labels) {
      return (await listMachines(labels)).map(toInfo);
    },

    destroy,

    async exec(id, input) {
      const body: ExecBody = { cmd: input.command, cwd: input.cwd, envs: input.env };

      // Instabox takes up to 1 MiB of stdin inline; stage anything larger in a guest file.
      if (input.stdin !== undefined) {
        const bytes = new TextEncoder().encode(input.stdin);

        if (bytes.byteLength <= 1024 * 1024)
          return stream(id, { ...body, stdin: input.stdin }, input);
        const staged = `/tmp/.sandbox-sdk/stdin-${randomUUID()}`;

        await provider.files.write(id, staged, bytes);
        const cmd = `exec < ${quote(staged)}; rm -f ${quote(staged)}; ${input.command}`;

        return stream(id, { ...body, cmd }, input);
      }

      return stream(id, body, input);
    },

    files: {
      writeCreatesParents: true,
      writeSupportsMode: true,

      async read(id, path) {
        try {
          const response = await send({
            method: "GET",
            path: `/v1/machines/${encodeURIComponent(id)}/files/content`,
            operation: "read file",
            query: { path: absolute(path) },
            sandboxId: id,
            timeoutMs: 300_000,
          });

          return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          if (error instanceof ApiFailure && error.status === 404)
            throw fail(`no such file: ${path}`, "file_not_found", { sandboxId: id });

          if (error instanceof ApiFailure && error.body.code === "not_a_file")
            throw fail(`${path} is a directory`, "invalid_argument", { sandboxId: id });
          throw instaboxError(error, "read file", id);
        }
      },

      async write(id, path, data, writeOptions) {
        const mode = writeOptions?.mode;

        const query: Query = {
          path: absolute(path),
          parents: "true",
          mode: mode === undefined ? undefined : `0${(mode & 0o7777).toString(8)}`,
        };

        try {
          await send({
            method: "PUT",
            path: `/v1/machines/${encodeURIComponent(id)}/files`,
            operation: "write file",
            query,
            raw: data,
            sandboxId: id,
            timeoutMs: 300_000,
          });
        } catch (error) {
          if (error instanceof ApiFailure && error.body.code === "not_a_file")
            throw fail(`${path} is a directory`, "invalid_argument", { sandboxId: id });
          throw instaboxError(error, "write file", id);
        }
      },

      async list(id, path) {
        let value: JsonValue | undefined;

        try {
          value = await json({
            method: "GET",
            path: `/v1/machines/${encodeURIComponent(id)}/files`,
            operation: "list files",
            query: { path: absolute(path) },
            sandboxId: id,
          });
        } catch (error) {
          if (error instanceof SandboxError && error.code === "not_found")
            throw fail(`no such directory: ${path}`, "file_not_found", { sandboxId: id });
          throw error;
        }

        if (field(value, "type") !== "dir")
          throw fail(`${path} is not a directory`, "invalid_argument", { sandboxId: id });
        const entries = field(value, "entries");

        if (!Array.isArray(entries))
          throw fail("directory listing has no entries", "provider", { sandboxId: id });

        // The API caps a listing at 5000 entries; list larger directories in the guest.
        if (entries.length >= 5000) {
          const { stdout } = await guest(id, [
            "find",
            absolute(path),
            "-mindepth",
            "1",
            "-maxdepth",
            "1",
            "-printf",
            "%P\\0%y\\0%s\\0%T@\\0",
          ]);

          return findEntries(path, stdout);
        }

        return entries.map((entry): FileInfo => parseEntry(path, entry));
      },

      async stat(id, path) {
        const { exitCode, stdout } = await guest(
          id,
          ["stat", "-c", "%F|%s|%.3Y", "--", absolute(path)],
          [0, 1],
        );

        if (exitCode !== 0)
          throw fail(`no such file: ${path}`, "file_not_found", { sandboxId: id });

        return statLine(path, stdout.trim());
      },

      async remove(id, path, removeOptions) {
        const target = absolute(path);

        const { exitCode } = await guest(
          id,
          [
            "bash",
            "-c",
            'test -e "$1" || test -L "$1" || exit 3; rm -f $2 -- "$1"',
            "remove",
            target,
            removeOptions.recursive ? "-r" : "-d",
          ],
          [0, 3],
        );

        if (exitCode === 3)
          throw fail(`no such file: ${path}`, "file_not_found", { sandboxId: id });
      },

      async mkdir(id, path) {
        await guest(id, ["mkdir", "-p", "--", absolute(path)]);
      },
    },

    async previewUrl(id, port) {
      const cached = previews.get(`${id}:${port}`);

      if (cached) return { url: cached };

      const value = await json({
        method: "POST",
        path: `/v1/machines/${encodeURIComponent(id)}/ports`,
        operation: "publish port",
        body: { port },
        sandboxId: id,
      });

      const published = field(value, "url");

      if (!isString(published))
        throw fail("publishing the port returned no URL", "provider", { sandboxId: id });
      previews.set(`${id}:${port}`, published);

      return { url: published };
    },

    native(id) {
      return {
        machineId: id,
        request: ({ method, path, body }) => {
          const verb = method.toUpperCase();

          if (
            verb !== "GET" &&
            verb !== "POST" &&
            verb !== "PUT" &&
            verb !== "PATCH" &&
            verb !== "DELETE"
          )
            throw fail(`unsupported method ${method}`, "invalid_argument");

          return json({
            method: verb,
            path,
            operation: "native request",
            body,
            idempotent: verb !== "GET",
            sandboxId: id,
          });
        },
      };
    },

    async pause(id) {
      await lifecycle(id, "suspend");
    },

    async resume(id) {
      const machine = await getMachine(id);

      await lifecycle(id, machine.state === "stopped" ? "start" : "resume");
    },

    async snapshot(id, snapshotOptions) {
      if (snapshotOptions?.expiresInMs)
        throw fail("snapshots are kept until deleted; omit expiresInMs", "unsupported", {
          sandboxId: id,
        });

      let snapshot = parseSnapshot(
        await json({
          method: "POST",
          path: `/v1/machines/${encodeURIComponent(id)}/snapshots`,
          operation: "snapshot",
          body: { name: `sbx-${randomUUID()}` },
          idempotent: true,
          sandboxId: id,
          timeoutMs: operationTimeoutMs,
        }),
      );

      const deadline = Date.now() + operationTimeoutMs;

      while (snapshot.status === "pending") {
        if (Date.now() > deadline)
          throw fail(`snapshot ${snapshot.id} is still pending`, "timeout", { sandboxId: id });
        await sleep(500);
        snapshot = parseSnapshot(
          await json({
            method: "GET",
            path: `/v1/snapshots/${encodeURIComponent(snapshot.id)}`,
            operation: "snapshot status",
            sandboxId: id,
          }),
        );
      }

      if (snapshot.status !== "ready")
        throw fail(`snapshot ${snapshot.id} ended ${snapshot.status}`, "provider", {
          sandboxId: id,
        });

      return { id: snapshot.id };
    },

    async deleteSnapshot(snapshotId) {
      try {
        await json({
          method: "DELETE",
          path: `/v1/snapshots/${encodeURIComponent(snapshotId)}`,
          operation: "delete snapshot",
          idempotent: true,
          confirmDelete: snapshotId,
        });

        return true;
      } catch (error) {
        if (error instanceof SandboxError && error.code === "not_found") return false;
        throw error;
      }
    },
  };

  return provider;
}
