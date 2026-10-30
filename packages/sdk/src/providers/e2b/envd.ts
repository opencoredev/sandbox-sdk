/**
 * envd, the daemon inside every E2B sandbox, spoken over the shared HTTP client. Mirrors what `e2b` 2.56 sends:
 *
 * - Files are plain HTTP: `GET /files?path=&username=` returns the bytes, `POST /files` takes multipart `file`
 *   fields whose file names are the paths.
 * - Filesystem and process calls are Connect RPC with the JSON codec. Unary: `POST /{service}/{method}` with a
 *   JSON body. Server streams (`Start`, `Connect`): one envelope in, envelopes out, ending with an end frame.
 * - The user travels as Basic auth with an empty password on Start and the filesystem calls, and as the
 *   `username` query parameter on `/files`. Process Connect, SendInput, SendSignal, CloseStdin and List take none.
 * - Protobuf JSON: `bytes` fields are base64, int64 fields are strings, defaults (exit code 0, empty lists) are
 *   left out, enums are names.
 */
import { isNumber, isString } from "../../shared/narrow.js";
import { SandboxError } from "../../errors.js";
import type { HttpClient } from "../../http.js";
import {
  connectEnvelope,
  connectEnvelopes,
  streamFault,
  type ConnectFrame,
} from "../../streams.js";
import { rpcError } from "./errors.js";

export type E2BPlane = "api" | "envd";

/** What the API returns for a created or connected sandbox: what envd calls need. */
export interface Connection {
  sandboxId: string;
  envdVersion: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
  /** The sandbox's domain from the API, else the configured one. */
  domain: string;
}

/** Numeric dotted compare, as the SDK's compare-versions use. Pre-release suffixes count as their numeric part. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const have = version.split(/[.+-]/).map(Number);
  const want = minimum.split(".").map(Number);

  for (let i = 0; i < want.length; i++) {
    const a = Number.isFinite(have[i]) ? (have[i] ?? 0) : 0;
    const b = want[i] ?? 0;

    if (a !== b) return a > b;
  }

  return true;
}

/** The envd versions the SDK checks before it uses a feature. */
export const envdGates = {
  minimum: "0.1.0",
  stdinFlag: "0.3.0",
  defaultUser: "0.4.0",
  closeStdin: "0.5.2",
} as const;

export interface EntryInfo {
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  /** Epoch ms, when envd sent one. */
  modifiedTime?: number;
}

export interface StartOptions {
  /** Run as `/bin/bash -l -c <command>`, as `commands.run` does. */
  command: string;
  cwd?: string;
  envs?: Record<string, string>;
  user: string;
  /** Keep stdin open for SendInput. envd before 0.3.0 always opens it and rejects an explicit `false`. */
  stdin: boolean;
  /** envd's own deadline for the whole command (`Connect-Timeout-Ms`); it kills the command when it passes. 0 is none. */
  timeoutMs: number;
  onStdout?(text: string): void;
  onStderr?(text: string): void;
  /** Cancels startup only. Once the start event arrives, use `kill` or `disconnect`. */
  signal?: AbortSignal;
  /**
   * Called with the Start's tag when startup failed in a way that leaves the outcome unknown (aborted, timed
   * out, connection lost): the process may be running. The caller finds it by tag and stops it.
   */
  abandon?(tag: string): Promise<void>;
}

/** A running command, like the SDK's CommandHandle. */
export interface Command {
  readonly pid: number;
  /** The exit code once the end event arrived: envd reports -1 for a signalled process. */
  readonly exitCode: number | undefined;
  /** Resolves with the exit code. Rejects when the stream fails or is disconnected before the end event. */
  wait(): Promise<number>;
  /** SIGKILL to this pid only. `false` when envd no longer knows it. */
  kill(): Promise<boolean>;
  sendStdin(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  /** Stop reading without signalling the process. No callback fires after this. */
  disconnect(): void;
}

export interface ProcessEntry {
  pid: number;
  tag?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fileTypes: Readonly<Record<string, EntryInfo["type"]>> = {
  FILE_TYPE_FILE: "file",
  FILE_TYPE_DIRECTORY: "dir",
  FILE_TYPE_SYMLINK: "symlink",
};

const base64 = /^[A-Za-z0-9+/_-]*={0,2}$/;
const connectJson = "application/connect+json";

/** proto3 JSON integers: a number or a decimal string. Absent is 0. */
function decodeInt(value: unknown): number | undefined {
  if (value === undefined) return 0;
  const number = isString(value) && /^-?\d+$/.test(value) ? Number(value) : value;

  return isNumber(number) && Number.isSafeInteger(number) ? number : undefined;
}

/** An EntryInfo from envd, or undefined for a type the SDK skips too. */
function parseEntry(value: unknown): EntryInfo | undefined {
  if (!isRecord(value) || !isString(value.path)) return undefined;

  const type =
    value.isSymlink === true ? "symlink" : isString(value.type) ? fileTypes[value.type] : undefined;

  if (type === undefined) return undefined;

  const modified = isString(value.modifiedTime) ? Date.parse(value.modifiedTime) : Number.NaN;

  return {
    path: value.path,
    type,
    size: decodeInt(value.size) ?? 0,
    ...(Number.isFinite(modified) ? { modifiedTime: modified } : {}),
  };
}

type ProcessEvent =
  | { kind: "start"; pid: number }
  | { kind: "data"; stream: "stdout" | "stderr"; bytes: Uint8Array }
  | { kind: "end"; exitCode: number }
  /** Keepalives, pty data and oneof members this client does not know. */
  | { kind: "other" };

/** One StartResponse or ConnectResponse (`{ event: ProcessEvent }`), or undefined when it is malformed. */
function parseEvent(message: unknown): ProcessEvent | undefined {
  const event = isRecord(message) ? message.event : undefined;

  if (!isRecord(event)) return undefined;
  const { start, data, end } = event;

  if (isRecord(start)) {
    const pid = decodeInt(start.pid);

    return pid === undefined || pid <= 0 ? undefined : { kind: "start", pid };
  }

  if (isRecord(data)) {
    for (const stream of ["stdout", "stderr"] as const) {
      const value = data[stream];

      if (value === undefined) continue;

      if (!isString(value) || !base64.test(value)) return undefined;

      return { kind: "data", stream, bytes: new Uint8Array(Buffer.from(value, "base64")) };
    }

    return { kind: "other" };
  }

  if (isRecord(end)) {
    const exitCode = decodeInt(end.exitCode);

    return exitCode === undefined ? undefined : { kind: "end", exitCode };
  }

  return { kind: "other" };
}

function malformed(sandboxId: string, what: string): SandboxError {
  return new SandboxError(`E2B envd sent ${what}. The command stream cannot be read further.`, {
    code: "provider",
    provider: "e2b",
    sandboxId,
  });
}

/** The envd calls the adapter uses, on the client's `envd` plane. */
export function createEnvd(options: {
  http: HttpClient<E2BPlane>;
  connection: (sandboxId: string) => Connection;
  startupTimeoutMs: number;
}) {
  const { http, connection, startupTimeoutMs: startupMs } = options;

  const basic = (user: string) => ({
    authorization: `Basic ${Buffer.from(`${user}:`).toString("base64")}`,
  });

  /** Before envd 0.4.0 an omitted user meant "user"; the adapter always names one, so only the header form matters. */
  async function unary(
    sandboxId: string,
    method: string,
    message: unknown,
    options: { user?: string; readOnly?: boolean } = {},
  ): Promise<unknown> {
    return http.json({
      method: "POST",
      plane: "envd",
      path: `/${method}`,
      sandboxId,
      body: message,
      ...(options.user === undefined ? {} : { headers: basic(options.user) }),
      ...(options.readOnly ? { readOnly: true } : {}),
    });
  }

  const signal = (
    sandboxId: string,
    target: { pid: number } | { tag: string },
    name: "SIGNAL_SIGKILL" | "SIGNAL_SIGTERM",
  ) => unary(sandboxId, "process.Process/SendSignal", { process: target, signal: name });

  /** Opens Start or Connect and reads up to the start event; the rest is read in the background. */
  async function open(
    sandboxId: string,
    rpc: "Start" | "Connect",
    message: unknown,
    options: Omit<StartOptions, "command" | "cwd" | "envs" | "user" | "stdin"> & {
      headers?: Record<string, string>;
      tag?: string;
    },
  ): Promise<Command> {
    const method = `process.Process/${rpc}`;
    const controller = new AbortController();
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, startupMs);

    const cancel = () => controller.abort();

    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener("abort", cancel, { once: true });

    const settleStartup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    };

    /** Sends the call and reads its first frame, which must be the start event. */
    const startup = async (): Promise<{
      frames: AsyncGenerator<ConnectFrame, void, undefined>;
      pid: number;
    }> => {
      const response = await http.stream({
        // Connect reattaches to a running process and changes nothing, so a broken stream is a lost read, not an unknown outcome.
        method: "POST",
        plane: "envd",
        path: `/${method}`,
        sandboxId,
        body: connectEnvelope(message),
        signal: controller.signal,
        startupTimeoutMs: startupMs,
        readOnly: rpc === "Connect",
        headers: {
          "content-type": connectJson,
          "keepalive-ping-interval": "50",
          ...(options.timeoutMs > 0 ? { "connect-timeout-ms": String(options.timeoutMs) } : {}),
          ...options.headers,
        },
      });

      if (!(response.headers.get("content-type") ?? "").startsWith(connectJson) || !response.body) {
        await response.body?.cancel().catch(() => {});
        throw malformed(sandboxId, "a response that is not a Connect stream");
      }

      const frames = connectEnvelopes(response.body, {
        provider: "e2b",
        sandboxId,
        signal: controller.signal,
      });

      try {
        const first = await frames.next();

        if (first.done) throw malformed(sandboxId, "an empty stream");

        if (first.value.kind === "end") {
          // envd rejected the call (bad cwd, unknown user, unknown pid): nothing started.
          if (first.value.error)
            throw rpcError({ code: first.value.error.code, method, sandboxId });
          throw malformed(sandboxId, "an end frame before the start event");
        }

        const event = parseEvent(first.value.message);

        if (event?.kind !== "start") throw malformed(sandboxId, "no start event first");

        return { frames, pid: event.pid };
      } catch (error) {
        await frames.return();
        throw error;
      }
    };

    let started: Awaited<ReturnType<typeof startup>>;

    try {
      started = await startup();
    } catch (error) {
      settleStartup();

      const unknown =
        timedOut ||
        streamFault(error) !== undefined ||
        (error instanceof SandboxError &&
          ["aborted", "timeout", "outcome_unknown"].includes(error.code));

      const tag = options.tag;

      const cleaned =
        unknown && tag !== undefined && options.abandon
          ? await options.abandon(tag).then(
              () => true,
              () => false,
            )
          : true;

      if (!cleaned)
        throw new SandboxError(
          `E2B ${method} failed before its start event, and stopping a command that may have started failed too. It may still be running.`,
          { code: "outcome_unknown", provider: "e2b", sandboxId },
        );

      if (timedOut)
        throw new SandboxError(
          `E2B ${method} sent no start event within ${startupMs} ms, so the command may or may not have started. It was stopped if it did.`,
          { code: "outcome_unknown", provider: "e2b", sandboxId },
        );

      if (options.signal?.aborted)
        throw new SandboxError("Command start aborted. The signal was cancelled.", {
          code: "aborted",
          provider: "e2b",
          sandboxId,
        });
      throw error;
    }

    const { frames, pid } = started;
    settleStartup();

    const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    let disconnected = false;
    let exitCode: number | undefined;

    const emit = (stream: "stdout" | "stderr", text: string) => {
      if (!text || disconnected) return;

      if (stream === "stdout") options.onStdout?.(text);
      else options.onStderr?.(text);
    };

    const reading = (async (): Promise<number> => {
      try {
        for await (const frame of frames) {
          if (frame.kind === "end") {
            if (frame.error) throw rpcError({ code: frame.error.code, method, sandboxId });
            continue;
          }

          const event = parseEvent(frame.message);

          if (event === undefined) throw malformed(sandboxId, "a malformed process event");

          if (event.kind === "data")
            emit(event.stream, decoders[event.stream].decode(event.bytes, { stream: true }));
          else if (event.kind === "end") {
            exitCode = event.exitCode;

            for (const stream of ["stdout", "stderr"] as const)
              emit(stream, decoders[stream].decode());
          }
        }
      } catch (error) {
        for (const stream of ["stdout", "stderr"] as const) emit(stream, decoders[stream].decode());

        if (disconnected)
          throw new SandboxError(
            "Disconnected from the E2B command. It keeps running; reconnect to wait for it.",
            { code: "aborted", provider: "e2b", sandboxId },
          );
        throw error;
      }

      if (exitCode === undefined)
        throw new SandboxError("The E2B command stream ended without the command's result.", {
          code: "provider",
          provider: "e2b",
          sandboxId,
        });

      return exitCode;
    })();

    reading.catch(() => {});

    return {
      pid,
      get exitCode() {
        return exitCode;
      },
      wait: () => reading,
      async kill() {
        try {
          await signal(sandboxId, { pid }, "SIGNAL_SIGKILL");

          return true;
        } catch (error) {
          if (error instanceof SandboxError && error.code === "not_found") return false;
          throw error;
        }
      },
      async sendStdin(data) {
        await unary(sandboxId, "process.Process/SendInput", {
          process: { pid },
          input: { stdin: Buffer.from(data).toString("base64") },
        });
      },
      async closeStdin() {
        const { envdVersion } = connection(sandboxId);

        if (!versionAtLeast(envdVersion, envdGates.closeStdin))
          throw new SandboxError(
            `envd ${envdVersion.slice(0, 16)} cannot close stdin. Rebuild the template to pick up a newer envd.`,
            { code: "unsupported", provider: "e2b", sandboxId },
          );
        await unary(sandboxId, "process.Process/CloseStdin", { process: { pid } });
      },
      disconnect() {
        disconnected = true;
        controller.abort();
      },
    };
  }

  return {
    files: {
      async read(sandboxId: string, path: string, user: string): Promise<Uint8Array> {
        return (
          await http.request({
            method: "GET",
            plane: "envd",
            path: "/files",
            sandboxId,
            query: { path, username: user },
            maxBytes: Number.POSITIVE_INFINITY,
          })
        ).body;
      },
      /** One multipart request, as the SDK sends buffered data. A single file also names its path in the query. */
      async write(
        sandboxId: string,
        files: readonly { path: string; data: Uint8Array | string }[],
        user: string,
      ): Promise<void> {
        const form = new FormData();

        for (const file of files)
          form.append(
            "file",
            new Blob([isString(file.data) ? file.data : new Uint8Array(file.data)]),
            file.path,
          );
        const single = files.length === 1 ? files[0]?.path : undefined;
        await http.request({
          method: "POST",
          plane: "envd",
          path: "/files",
          sandboxId,
          body: form,
          query: { ...(single === undefined ? {} : { path: single }), username: user },
        });
      },
    },
    fs: {
      async stat(sandboxId: string, path: string, user: string): Promise<EntryInfo> {
        const body = await unary(
          sandboxId,
          "filesystem.Filesystem/Stat",
          { path },
          { user, readOnly: true },
        );

        const entry = parseEntry(isRecord(body) ? body.entry : undefined);

        if (!entry) throw malformed(sandboxId, "a Stat answer without a known entry");

        return entry;
      },
      async list(sandboxId: string, path: string, user: string): Promise<EntryInfo[]> {
        const body = await unary(
          sandboxId,
          "filesystem.Filesystem/ListDir",
          { path, depth: 1 },
          { user, readOnly: true },
        );

        const entries = isRecord(body) && Array.isArray(body.entries) ? body.entries : [];

        return entries.map(parseEntry).filter((entry) => entry !== undefined);
      },
      /** Creates parents too. An existing directory is not an error, as in the SDK. */
      async mkdir(sandboxId: string, path: string, user: string): Promise<void> {
        try {
          await unary(sandboxId, "filesystem.Filesystem/MakeDir", { path }, { user });
        } catch (error) {
          if (!(error instanceof SandboxError && /\balready_exists\b/.test(error.message)))
            throw error;
        }
      },
      async remove(sandboxId: string, path: string, user: string): Promise<void> {
        await unary(sandboxId, "filesystem.Filesystem/Remove", { path }, { user });
      },
    },
    process: {
      /** Every Start carries a fresh tag, so a start whose outcome is unknown can still be found and stopped. */
      async start(sandboxId: string, options: StartOptions): Promise<Command> {
        const { envdVersion } = connection(sandboxId);

        if (!options.stdin && !versionAtLeast(envdVersion, envdGates.stdinFlag))
          throw new SandboxError(
            `envd ${envdVersion.slice(0, 16)} always opens stdin. Rebuild the template to pick up a newer envd.`,
            { code: "unsupported", provider: "e2b", sandboxId },
          );
        const tag = `sandbox-sdk-${crypto.randomUUID()}`;

        const message = {
          process: {
            cmd: "/bin/bash",
            args: ["-l", "-c", options.command],
            envs: options.envs ?? {},
            ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          },
          stdin: options.stdin,
          tag,
        };

        return open(sandboxId, "Start", message, { ...options, tag, headers: basic(options.user) });
      },
      /** Reattach to a running process. Output printed while detached is lost: envd does not buffer it. */
      connect(sandboxId: string, pid: number): Promise<Command> {
        return open(sandboxId, "Connect", { process: { pid } }, { timeoutMs: 0 });
      },
      async list(sandboxId: string): Promise<ProcessEntry[]> {
        const body = await unary(sandboxId, "process.Process/List", {}, { readOnly: true });
        const processes = isRecord(body) && Array.isArray(body.processes) ? body.processes : [];

        return processes.filter(isRecord).flatMap((item) => {
          const pid = decodeInt(item.pid);

          return pid === undefined
            ? []
            : [{ pid, ...(isString(item.tag) ? { tag: item.tag } : {}) }];
        });
      },
      signal,
    },
  };
}

export type Envd = ReturnType<typeof createEnvd>;
