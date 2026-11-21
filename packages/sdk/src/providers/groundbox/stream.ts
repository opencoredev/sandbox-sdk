/**
 * Groundbox's exec stream, `GET /v1/sandboxes/{id}/exec/stream`: a WebSocket that takes a `start`
 * message and answers with `stdout` and `stderr` chunks in the order the command wrote them, then
 * one `exit` or `error`. The key goes in the upgrade request's Authorization header, which the
 * WebSocket of Node 22 and Bun can send (a browser's cannot). A stream that is not resumable ends
 * its command when it closes; `kill` ends the command and everything it started.
 */
import type { ExecResult, OutputChunk, Terminal } from "../../provider.js";
import { isJsonObject, type JsonValue } from "../../shared/json.js";
import { isNumber, isString } from "../../shared/narrow.js";
import { errorCode, fail } from "./errors.js";

/** What the adapter sends first: a command for `sh -c` and where it runs. */
export interface StreamStart {
  cmd: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout_s: number;
  stdin?: boolean;
  tty?: boolean;
  rows?: number;
  cols?: number;
}

export interface Dial {
  /** `wss://api.groundbox.dev/v1/sandboxes/<id>/exec/stream`. */
  url: string;
  headers: Record<string, string>;
  sandboxId: string;
}

/** Stdin goes in pieces well under any frame limit. */
const stdinPiece = 256 * 1024;

/** What the adapter sends after `start`. */
type ClientMessage =
  | { type: "stdin"; data: string }
  | { type: "stdin_end" }
  | { type: "resize"; rows: number; cols: number }
  | { type: "kill" };

export function hasWebSocket() {
  return typeof WebSocket !== "undefined";
}

type ServerMessage =
  | { type: "stdout" | "stderr"; data: string }
  | { type: "exit"; exitCode: number; timedOut: boolean }
  | { type: "error"; code: string | undefined }
  | { type: "other" };

function parse(text: string): ServerMessage {
  let value: JsonValue | undefined;

  try {
    value = JSON.parse(text);
  } catch {
    return { type: "other" };
  }

  if (!isJsonObject(value)) return { type: "other" };
  const type = value.type;

  if (type === "stdout" || type === "stderr")
    return { type, data: isString(value.data) ? value.data : "" };

  if (type === "exit")
    return {
      type,
      exitCode: isNumber(value.exit_code) ? value.exit_code : -1,
      timedOut: value.timed_out === true,
    };

  if (type === "error") return { type, code: isString(value.code) ? value.code : undefined };

  return { type: "other" };
}

/** Opens the socket and resolves once it is open. */
function open(dial: Dial, signal?: AbortSignal): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(fail("command aborted", "aborted", { sandboxId: dial.sandboxId }));

    // SAFETY: Node 22's WebSocket (undici) and Bun's both take `{ headers }` as the second argument; the
    // DOM typing only knows protocols. hasWebSocket() was checked by the caller.
    const HeaderSocket: new (url: string, init: { headers: Record<string, string> }) => WebSocket =
      WebSocket as never;

    const ws = new HeaderSocket(dial.url, { headers: dial.headers });

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

    // A refused upgrade (a bad key, a sandbox that is gone) is an `error` and may never be a `close`.
    const onError = () => {
      cleanup();
      reject(
        fail(
          "the command stream could not be opened; check the sandbox ID and the API key",
          "unavailable",
          {
            sandboxId: dial.sandboxId,
            retryable: true,
          },
        ),
      );
    };

    const onClose = (event: CloseEvent) => {
      cleanup();
      reject(
        fail(`the command stream closed before it opened (code ${event.code})`, "unavailable", {
          sandboxId: dial.sandboxId,
          retryable: true,
        }),
      );
    };

    const onAbort = () => {
      cleanup();
      ws.addEventListener("error", () => {});
      ws.close();
      reject(fail("command aborted", "aborted", { sandboxId: dial.sandboxId }));
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
    ws.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stdin in pieces of at most `size` UTF-16 units. A piece never ends on the first half of a
 * surrogate pair, so each frame carries whole code points.
 */
export function stdinPieces(stdin: string, size = stdinPiece): string[] {
  const pieces: string[] = [];

  for (let offset = 0; offset < stdin.length;) {
    let end = Math.min(stdin.length, offset + size);
    const last = stdin.charCodeAt(end - 1);

    // A high surrogate at the cut: keep it with its low half in the next piece.
    if (end < stdin.length && end - offset > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    pieces.push(stdin.slice(offset, end));
    offset = end;
  }

  return pieces;
}

function sendStdin(ws: WebSocket, stdin: string) {
  for (const data of stdinPieces(stdin)) ws.send(JSON.stringify({ type: "stdin", data }));
  ws.send(JSON.stringify({ type: "stdin_end" }));
}

/** How long a killed command has to report its exit before the socket is closed anyway. */
const killGraceMs = 5000;

/**
 * Runs one command over the stream. An abort sends `kill` and waits for the command's exit (or the
 * socket's close) before settling, so the process group is gone when this returns.
 */
export async function streamExec(
  dial: Dial,
  start: StreamStart,
  input: { stdin?: string; signal?: AbortSignal; onChunk(chunk: OutputChunk): void },
): Promise<ExecResult> {
  let ws: WebSocket;

  try {
    ws = await open(dial, input.signal);
  } catch (error) {
    if (input.signal?.aborted) return { exitCode: null, timedOut: true };
    throw error;
  }

  return new Promise<ExecResult>((resolve, reject) => {
    let killed = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: ExecResult | Error) => {
      clearTimeout(grace);
      input.signal?.removeEventListener("abort", onAbort);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      ws.addEventListener("error", () => {});

      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close(1000);

      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    const onAbort = () => {
      if (killed) return;
      killed = true;

      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "kill" }));
      grace = setTimeout(() => finish({ exitCode: null, timedOut: true }), killGraceMs);
    };

    const onMessage = (event: MessageEvent) => {
      const message = parse(isString(event.data) ? event.data : String(event.data));

      switch (message.type) {
        case "stdout":
        case "stderr":
          if (message.data && !killed) input.onChunk({ stream: message.type, text: message.data });
          break;
        case "exit":
          finish(
            killed || message.timedOut
              ? { exitCode: null, timedOut: true }
              : { exitCode: message.exitCode, timedOut: false },
          );
          break;
        case "error":
          finish(
            killed
              ? { exitCode: null, timedOut: true }
              : fail(
                  `the command stream failed${message.code ? ` (${message.code})` : ""}`,
                  errorCode(message.code) ?? "provider",
                  { sandboxId: dial.sandboxId },
                ),
          );
          break;
        case "other":
          break;
        default: {
          const exhaustive: never = message;
          throw fail(`unknown stream message ${String(exhaustive)}`);
        }
      }
    };

    // The command ends with a stream that is not resumable, so a close before `exit` means it is gone.
    const onClose = () =>
      finish(
        killed
          ? { exitCode: null, timedOut: true }
          : fail("the command stream closed before the command ended", "unavailable", {
              sandboxId: dial.sandboxId,
              retryable: true,
            }),
      );

    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    ws.send(JSON.stringify({ type: "start", ...start, stdin: input.stdin !== undefined }));

    if (input.stdin !== undefined) sendStdin(ws, input.stdin);

    if (input.signal?.aborted) onAbort();
  });
}

/** A shell on a terminal of its own in the sandbox: `start` with `tty`, typed input as `stdin`, `resize`. */
export async function streamTerminal(dial: Dial, start: StreamStart): Promise<Terminal> {
  const ws = await open(dial);
  const listeners = new Set<(data: string) => void>();
  let exit: { exitCode: number | null } | undefined;
  let settle: ((result: { exitCode: number | null }) => void) | undefined;

  const exited = new Promise<{ exitCode: number | null }>((resolve) => {
    settle = resolve;
  });

  const onMessage = (event: MessageEvent) => {
    const message = parse(isString(event.data) ? event.data : String(event.data));

    if (message.type === "stdout" || message.type === "stderr") {
      for (const listener of listeners) listener(message.data);
    } else if (message.type === "exit") end({ exitCode: message.exitCode });
    else if (message.type === "error") end({ exitCode: null });
  };

  const onClose = () => end({ exitCode: null });
  const onError = () => {};

  // Once the shell has ended, the socket is closed and detached whatever the server does next.
  function end(result: { exitCode: number | null }) {
    if (exit) return;
    exit = result;
    ws.removeEventListener("message", onMessage);
    ws.removeEventListener("close", onClose);
    listeners.clear();

    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
    settle?.(result);
  }

  ws.addEventListener("message", onMessage);
  ws.addEventListener("close", onClose);
  ws.addEventListener("error", onError);
  ws.send(JSON.stringify({ type: "start", ...start, tty: true, stdin: true }));

  const send = (message: ClientMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };

  return {
    write(data) {
      if (data) send({ type: "stdin", data });
    },
    resize(cols, rows) {
      send({ type: "resize", rows, cols });
    },
    onData(callback) {
      listeners.add(callback);

      return () => listeners.delete(callback);
    },
    close() {
      if (exit) return;
      send({ type: "kill" });

      // Closing on purpose (code 1000) ends the command too; end() closes the socket.
      end({ exitCode: null });
    },
    wait: () => exited,
  };
}
