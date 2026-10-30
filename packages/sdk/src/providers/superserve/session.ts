/**
 * `exec/connect`: a command session over the runtime's global WebSocket (Node 22, Bun), as
 * @superserve/sdk 0.11.4's `commands.spawn` speaks it. A browser-style WebSocket cannot send headers, so the
 * access token and routing hint travel as subprotocols: `superserve.exec.v1`, `token.<token>`, `route.<hint>`.
 *
 * Frames: the client sends a JSON start frame, then stdin as binary frames with channel byte 0 (32 KiB at
 * most), then `{"type":"stdin_close"}`. The server sends stdout and stderr as binary frames with channel byte
 * 1 or 2, and JSON lifecycle frames; `{"finished":true,"exit_code":n}` ends the command.
 */
import { isNumber, isObject, isString } from "../../shared/narrow.js";
import { failure } from "./errors.js";
import type { Route } from "./routes.js";

const subprotocol = "superserve.exec.v1";
const stdinChunkBytes = 32 * 1024;

// Bounded like the SDK's sync exec response; the supervisor prints a small page here.
const maxOutputBytes = 10 * 1024 * 1024;
const encoder = new TextEncoder();

export interface SessionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface Session {
  readonly stdin: { write(data: string | Uint8Array): void; close(): void };
  /** Resolves when the command finishes; rejects when the connection ends first. */
  wait(): Promise<SessionResult>;
  /** Sends SIGTERM, closes the socket and settles the session. Never rejects. */
  close(): Promise<void>;
}

export interface SpawnOptions {
  sandboxId: string;
  url: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Aborts only the connection setup. */
  startupSignal?: AbortSignal;
  /** The route to dial with, activating first when needed. */
  route(signal: AbortSignal | undefined): Promise<Route>;
  /** A newer route after a failed dial. */
  refresh(used: Route, signal: AbortSignal | undefined): Promise<Route>;
  /** Scrubs credentials from server-supplied text. */
  redact(text: string): string;
}

const aborted = (sandboxId: string) => failure("Command startup aborted", "aborted", sandboxId);

/** Opens a session. A dial that fails is retried once with a fresh route, like the SDK's `dialWithResume`. */
export async function spawn(options: SpawnOptions): Promise<Session> {
  if (typeof WebSocket === "undefined")
    throw failure(
      "Superserve commands with stdin need a global WebSocket (Node 22 or later, or Bun)",
      "unsupported",
      options.sandboxId,
    );
  const signal = options.startupSignal;

  if (signal?.aborted) throw aborted(options.sandboxId);
  let route = await options.route(signal);
  let ws: WebSocket;

  try {
    ws = await dial(options, route);
  } catch {
    if (signal?.aborted) throw aborted(options.sandboxId);
    route = await options.refresh(route, signal);
    ws = await dial(options, route);
  }

  if (signal?.aborted) {
    ws.close();
    throw aborted(options.sandboxId);
  }

  ws.send(
    JSON.stringify({
      command: options.command,
      ...(options.env === undefined ? undefined : { env: options.env }),
      ...(options.timeoutMs === undefined
        ? undefined
        : { timeout_s: Math.ceil(options.timeoutMs / 1000) }),
    }),
  );

  return session(ws, options);
}

function dial(options: SpawnOptions, route: Route): Promise<WebSocket> {
  const { sandboxId, startupSignal: signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted(sandboxId));

    const ws = new WebSocket(options.url, [
      subprotocol,
      `token.${route.token}`,
      ...(route.hint ? [`route.${route.hint}`] : []),
    ]);

    ws.binaryType = "arraybuffer";

    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };

    const onOpen = () => {
      cleanup();
      resolve(ws);
    };

    // Node 22 reports a refused upgrade (such as a stale token) with `error` and may never send `close`.
    const onError = () => {
      cleanup();
      reject(
        failure("Superserve exec/connect could not open the connection", "unavailable", sandboxId),
      );
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(
        failure(
          `Superserve exec/connect closed before it opened (code ${event.code})`,
          "unavailable",
          sandboxId,
        ),
      );
    };

    const onAbort = () => {
      cleanup();
      ws.addEventListener("error", () => {});
      ws.close();
      reject(aborted(sandboxId));
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function session(ws: WebSocket, options: SpawnOptions): Session {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const output = { stdout: "", stderr: "" };
  let received = 0;
  let settle: { resolve(result: SessionResult): void; reject(error: Error): void } | undefined;

  const result = new Promise<SessionResult>((resolve, reject) => {
    settle = { resolve, reject };
  });

  result.catch(() => {});

  const flush = () => {
    output.stdout += decoders.stdout.decode();
    output.stderr += decoders.stderr.decode();
  };

  const finish = (exitCode: number) => {
    const s = settle;
    settle = undefined;
    flush();
    s?.resolve({ exitCode, ...output });
  };

  const fail = (error: Error) => {
    const s = settle;
    settle = undefined;
    flush();
    s?.reject(error);

    if (ws.readyState <= WebSocket.OPEN) ws.close();
  };

  const open = () => ws.readyState === WebSocket.OPEN;

  ws.addEventListener("message", (event: MessageEvent) => {
    if (isString(event.data)) {
      let frame: unknown;

      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }

      if (!isObject(frame) || frame === null) return;
      const error: unknown = "error" in frame ? frame.error : undefined;

      if (isString(error)) output.stderr += error;

      if (("finished" in frame ? frame.finished : undefined) === true) {
        const code: unknown = "exit_code" in frame ? frame.exit_code : undefined;
        finish(isNumber(code) ? code : 0);
      }

      return;
    }

    if (!(event.data instanceof ArrayBuffer)) return;
    const view = new Uint8Array(event.data);

    if (!view.length) return;
    received += view.length;

    if (received > maxOutputBytes)
      return fail(
        failure(
          `Superserve exec/connect sent more than ${maxOutputBytes} bytes of output`,
          "unsupported",
          options.sandboxId,
        ),
      );
    const channel = view[0] === 1 ? "stdout" : view[0] === 2 ? "stderr" : undefined;

    if (channel) output[channel] += decoders[channel].decode(view.subarray(1), { stream: true });
  });
  ws.addEventListener("close", (event: CloseEvent) => {
    const detail =
      event.code === 1009
        ? "a frame exceeded the server's size limit"
        : event.reason
          ? options.redact(event.reason).slice(0, 200)
          : `close code ${event.code}`;

    fail(
      failure(
        `Superserve exec/connect closed before the command finished (${detail})`,
        "provider",
        options.sandboxId,
      ),
    );
  });
  ws.addEventListener("error", () =>
    fail(
      failure(
        "Superserve exec/connect failed before the command finished",
        "provider",
        options.sandboxId,
      ),
    ),
  );

  const kill = () => {
    if (open()) ws.send(JSON.stringify({ type: "signal", name: "SIGTERM" }));
  };

  return {
    stdin: {
      write(data) {
        if (!open()) return;
        const bytes = isString(data) ? encoder.encode(data) : data;

        for (let offset = 0; offset < bytes.length; offset += stdinChunkBytes) {
          const chunk = bytes.subarray(offset, offset + stdinChunkBytes);
          const frame = new Uint8Array(chunk.length + 1);
          frame.set(chunk, 1);
          ws.send(frame);
        }
      },
      close() {
        if (open()) ws.send(JSON.stringify({ type: "stdin_close" }));
      },
    },
    wait: () => result,
    async close() {
      kill();
      // Settle now: a socket that never reports `close` must not hold the caller.
      fail(
        failure(
          "Superserve exec/connect session closed by the client",
          "aborted",
          options.sandboxId,
        ),
      );
      await result.then(
        () => {},
        () => {},
      );
    },
  };
}
