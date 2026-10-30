/**
 * Frame readers for streamed provider responses: NDJSON, server-sent events and Connect envelopes. The Connect
 * codec and {@link streamFault} are public through `/provider`; the NDJSON and SSE readers stay internal.
 *
 * Each reads a `ReadableStream<Uint8Array>` and yields frames as an async iterable. Frames are split on bytes,
 * so a UTF-8 character or a frame header split across chunks is reassembled. Every frame is bounded
 * (`maxFrameBytes`, default 16 MiB). Leaving a `for await` early (break, return, throw) cancels the body.
 *
 * Failures are SandboxErrors; {@link streamFault} says which protocol fault it was, so an adapter can resume
 * a `disconnected` or `truncated` stream and give up on the rest:
 * - `disconnected`: reading the body failed (the connection dropped).
 * - `truncated`: the body ended inside a frame, or before the protocol's terminal frame.
 * - `frame_too_large`: a frame is larger than `maxFrameBytes`.
 * - `malformed`: a frame is not valid for the protocol.
 */
import type { JsonValue } from "./shared/json.js";
import { isObject, isString } from "./shared/narrow.js";
import { SandboxError, nativeDetail } from "./errors.js";

export type StreamFault = "disconnected" | "truncated" | "frame_too_large" | "malformed";

export interface StreamOptions {
  /** Provider name on errors. */
  provider: string;
  sandboxId?: string;
  /** Largest frame in bytes. Default: 16 MiB. */
  maxFrameBytes?: number;
  /** Stop reading, cancel the body and reject with `aborted`. */
  signal?: AbortSignal;
}

const faults = new WeakMap<SandboxError, StreamFault>();

/** The protocol fault behind a stream error, or `undefined` for any other error. */
export function streamFault(cause: unknown): StreamFault | undefined {
  return cause instanceof SandboxError ? faults.get(cause) : undefined;
}

const faultCodes = {
  disconnected: "unavailable",
  truncated: "unavailable",
  frame_too_large: "unsupported",
  malformed: "provider",
} as const;

function fault(
  kind: StreamFault,
  message: string,
  options: StreamOptions,
  cause?: unknown,
): SandboxError {
  const error = new SandboxError(
    `${message}. The stream from ${options.provider} cannot be read further.`,
    {
      code: faultCodes[kind],
      provider: options.provider,
      sandboxId: options.sandboxId,
      retryable: kind === "disconnected" || kind === "truncated",
      cause: cause === undefined ? undefined : (nativeDetail(cause) ?? kind),
    },
  );

  faults.set(error, kind);

  return error;
}

/** Growable byte queue: append chunks, find a byte, take a prefix. Avoids re-copying on every chunk. */
class Bytes {
  private chunks: Uint8Array[] = [];
  private head = 0;
  length = 0;
  push(chunk: Uint8Array) {
    if (chunk.byteLength) {
      this.chunks.push(chunk);
      this.length += chunk.byteLength;
    }
  }
  /** Index of the first byte matching `test` at or after `from`, or -1. */
  find(test: (byte: number) => boolean, from = 0): number {
    let base = 0;

    for (let c = 0; c < this.chunks.length; c++) {
      const chunk = this.chunks[c]!;
      const start = c === 0 ? this.head : 0;
      const size = chunk.byteLength - start;

      if (from < base + size)
        for (let i = Math.max(start, start + from - base); i < chunk.byteLength; i++)
          if (test(chunk[i]!)) return base + i - start;
      base += size;
    }

    return -1;
  }
  at(index: number): number | undefined {
    let rest = index;

    for (let c = 0; c < this.chunks.length; c++) {
      const chunk = this.chunks[c]!;
      const start = c === 0 ? this.head : 0;

      if (rest < chunk.byteLength - start) return chunk[start + rest];
      rest -= chunk.byteLength - start;
    }

    return undefined;
  }
  /** Removes and returns the first `count` bytes. */
  take(count: number): Uint8Array {
    const out = new Uint8Array(count);
    let filled = 0;

    while (filled < count) {
      const chunk = this.chunks[0]!;
      const n = Math.min(count - filled, chunk.byteLength - this.head);
      out.set(chunk.subarray(this.head, this.head + n), filled);
      filled += n;
      this.head += n;

      if (this.head === chunk.byteLength) {
        this.chunks.shift();
        this.head = 0;
      }
    }

    this.length -= count;

    return out;
  }
}

/** Reads chunks with abort and cancel-on-exit. */
async function* chunks(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const reader = body.getReader();
  const { signal } = options;
  let finished = false;

  const abort = () => {
    void reader.cancel(signal?.reason).catch(() => {});
  };

  signal?.addEventListener("abort", abort, { once: true });

  try {
    if (signal?.aborted) throw aborted(options);

    for (;;) {
      let result: ReadableStreamReadResult<Uint8Array>;

      try {
        result = await reader.read();
      } catch (error) {
        finished = true;

        if (signal?.aborted) throw aborted(options);

        // The HTTP client already mapped it (timeout, aborted, lost connection); keep its code, mark the fault.
        // A write's lost connection is `outcome_unknown` rather than `unavailable`, but the stream dropped all the same.
        if (error instanceof SandboxError) {
          if (error.code === "unavailable" || error.code === "outcome_unknown")
            faults.set(error, "disconnected");
          throw error;
        }

        throw fault("disconnected", "The connection dropped mid-stream", options, error);
      }

      if (signal?.aborted) {
        finished = true;
        throw aborted(options);
      }

      if (result.done) {
        finished = true;

        return;
      }

      yield result.value;
    }
  } finally {
    signal?.removeEventListener("abort", abort);

    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function aborted(options: StreamOptions) {
  return new SandboxError("Stream aborted. The signal was cancelled.", {
    code: "aborted",
    provider: options.provider,
    sandboxId: options.sandboxId,
  });
}

const utf8 = new TextDecoder();

/** The UTF-8 length of `text` in bytes, without encoding it. A lone surrogate counts as U+FFFD (3 bytes). */
function utf8Length(text: string): number {
  let bytes = 0;

  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);

    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (
      unit >= 0xd800 &&
      unit < 0xdc00 &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }

  return bytes;
}

const defaultMax = 16 * 1024 * 1024;

/**
 * Newline-delimited JSON: one value per `\n`-terminated line (`\r\n` too). Blank lines are skipped. A last line
 * without a newline is accepted when it parses as JSON; otherwise it is `truncated`.
 */
export async function* ndjson(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions,
): AsyncGenerator<JsonValue | undefined, void, undefined> {
  const max = options.maxFrameBytes ?? defaultMax;
  const buffer = new Bytes();

  const parse = (line: Uint8Array, last: boolean): JsonValue | undefined => {
    const text = utf8.decode(line).replace(/\r$/, "");

    try {
      return JSON.parse(text);
    } catch {
      throw last
        ? fault("truncated", "The stream ended inside a JSON line", options)
        : fault("malformed", "A line is not valid JSON", options);
    }
  };

  for await (const chunk of chunks(body, options)) {
    const from = buffer.length;
    buffer.push(chunk);

    for (
      let end = buffer.find((byte) => byte === 10, from);
      end >= 0;
      end = buffer.find((byte) => byte === 10)
    ) {
      if (end > max) throw fault("frame_too_large", `A JSON line exceeds ${max} bytes`, options);
      const line = buffer.take(end + 1).subarray(0, end);

      if (line.some((byte) => byte !== 13 && byte !== 32 && byte !== 9)) yield parse(line, false);
    }

    if (buffer.length > max)
      throw fault("frame_too_large", `A JSON line exceeds ${max} bytes`, options);
  }

  if (buffer.length) {
    const line = buffer.take(buffer.length);

    if (line.some((byte) => byte !== 13 && byte !== 32 && byte !== 9)) yield parse(line, true);
  }
}

/** One server-sent event. */
export interface ServerSentEvent {
  /** The `event:` field. Default: `"message"`. */
  event: string;
  /** The `data:` lines joined with `\n`. */
  data: string;
  /** The last event ID seen so far (`id:` persists across events), for a `Last-Event-ID` resume. */
  id?: string;
  /** The `retry:` reconnection time in ms, when this event set one. */
  retry?: number;
}

/**
 * Server-sent events (the WHATWG `text/event-stream` format): `\n`, `\r\n` or `\r` line ends, `:` comments,
 * multi-line `data`, and `id` that persists. Events with no `data` line are not dispatched, as in browsers.
 * A body that ends inside an event (no blank line after it) is `truncated`, unless `lenientEnd` dispatches it.
 */
export async function* sse(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions & { lenientEnd?: boolean },
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const max = options.maxFrameBytes ?? defaultMax;
  const buffer = new Bytes();
  let first = true;
  let skipLf = false;
  let lastId: string | undefined;
  let event = "";
  let data: string[] = [];
  let dataBytes = 0;
  let retry: number | undefined;
  let pending = false;

  const dispatch = (): ServerSentEvent | undefined => {
    let out: ServerSentEvent | undefined;

    // Optional fields stay absent when the stream never set them.
    if (data.length) {
      out = { event: event || "message", data: data.join("\n") };

      if (lastId !== undefined) out.id = lastId;

      if (retry !== undefined) out.retry = retry;
    }

    event = "";
    data = [];
    dataBytes = 0;
    retry = undefined;
    pending = false;

    return out;
  };

  const field = (line: string) => {
    if (line.startsWith(":")) return;
    pending = true;
    const colon = line.indexOf(":");
    const name = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + (line[colon + 1] === " " ? 2 : 1));

    if (name === "data") {
      // The event's data is the lines joined with "\n": count its UTF-8 bytes, separators included.
      dataBytes += utf8Length(value) + (data.length ? 1 : 0);

      if (dataBytes > max) throw fault("frame_too_large", `An event exceeds ${max} bytes`, options);
      data.push(value);
    } else if (name === "event") event = value;
    else if (name === "id") {
      if (!value.includes("\0")) lastId = value;
    } else if (name === "retry") {
      if (/^\d+$/.test(value)) retry = Number(value);
    }
  };

  for await (const chunk of chunks(body, options)) {
    buffer.push(chunk);

    for (;;) {
      if (skipLf && buffer.length) {
        if (buffer.at(0) === 10) buffer.take(1);
        skipLf = false;
      }

      const end = buffer.find((byte) => byte === 10 || byte === 13);

      if (end < 0) break;

      if (end > max) throw fault("frame_too_large", `An event line exceeds ${max} bytes`, options);
      const raw = buffer.take(end + 1);

      if (raw[end] === 13) skipLf = true;
      let line = utf8.decode(raw.subarray(0, end));

      if (first) {
        line = line.replace(/^﻿/, "");
        first = false;
      }

      if (line === "") {
        const out = dispatch();

        if (out) yield out;
      } else field(line);
    }

    if (buffer.length > max)
      throw fault("frame_too_large", `An event line exceeds ${max} bytes`, options);
  }

  if (buffer.length || pending) {
    if (!options.lenientEnd) throw fault("truncated", "The stream ended inside an event", options);

    if (buffer.length) field(utf8.decode(buffer.take(buffer.length)));
    const out = dispatch();

    if (out) yield out;
  }
}

/** A Connect streaming frame: a message, or the end-of-stream frame with the outcome. */
export type ConnectFrame =
  | { kind: "message"; message: JsonValue | undefined }
  | {
      kind: "end";
      error?: { code: string; message?: string; details?: unknown[] };
      metadata?: Record<string, string[]>;
    };

/**
 * Connect protocol server-stream envelopes (JSON codec): a flags byte, a 4-byte big-endian length, then the
 * payload. Flag `0x02` marks the end-of-stream frame (`{ error?, metadata? }`), which must come last. A body
 * that ends without it is `truncated`; compressed frames (`0x01`) are `malformed`, since none is negotiated.
 */
export async function* connectEnvelopes(
  body: ReadableStream<Uint8Array>,
  options: StreamOptions,
): AsyncGenerator<ConnectFrame, void, undefined> {
  const max = options.maxFrameBytes ?? defaultMax;
  const buffer = new Bytes();
  const source = chunks(body, options);

  /** Reads until `size` bytes are buffered. False when the body ended first. */
  const fill = async (size: number): Promise<boolean> => {
    while (buffer.length < size) {
      const next = await source.next();

      if (next.done) return false;
      buffer.push(next.value);
    }

    return true;
  };

  try {
    for (let ended = false; ;) {
      if (!(await fill(5))) {
        if (buffer.length)
          throw fault("truncated", "The stream ended inside a Connect frame header", options);

        if (!ended)
          throw fault(
            "truncated",
            "The stream ended before the Connect end-of-stream frame",
            options,
          );

        return;
      }

      if (ended)
        throw fault("malformed", "A Connect frame followed the end-of-stream frame", options);
      const header = buffer.take(5);
      const flags = header[0]!;
      const size = new DataView(header.buffer, header.byteOffset, 5).getUint32(1);

      if (flags & 0x01)
        throw fault(
          "malformed",
          "A Connect frame is compressed, but no compression was negotiated",
          options,
        );

      if (flags & ~0x03) throw fault("malformed", "A Connect frame has unknown flags", options);

      if (size > max)
        throw fault("frame_too_large", `A Connect frame exceeds ${max} bytes`, options);

      if (!(await fill(size)))
        throw fault("truncated", "The stream ended inside a Connect frame", options);
      const payload = json(buffer.take(size));

      if (flags & 0x02) {
        ended = true;
        yield end(payload);
      } else yield { kind: "message", message: payload };
    }
  } finally {
    // Cancels the body when the caller stops early or a frame is bad.
    await source.return();
  }

  function json(bytes: Uint8Array): JsonValue | undefined {
    try {
      return JSON.parse(utf8.decode(bytes));
    } catch {
      throw fault("malformed", "A Connect frame is not valid JSON", options);
    }
  }

  function end(value: JsonValue | undefined): ConnectFrame {
    if (!isObject(value) || value === null)
      throw fault("malformed", "The Connect end-of-stream frame is not an object", options);
    const error: unknown = "error" in value ? value.error : undefined;
    const metadata: unknown = "metadata" in value ? value.metadata : undefined;
    const frame: ConnectFrame = { kind: "end" };

    if (error !== undefined) {
      if (!isObject(error) || error === null)
        throw fault("malformed", "The Connect end-of-stream error is not an object", options);
      const code: unknown = "code" in error ? error.code : undefined;
      const message: unknown = "message" in error ? error.message : undefined;
      const details: unknown = "details" in error ? error.details : undefined;

      if (!isString(code))
        throw fault("malformed", "The Connect end-of-stream error has no code", options);
      const endError: NonNullable<typeof frame.error> = { code };

      if (isString(message)) endError.message = message;

      if (Array.isArray(details)) endError.details = details;
      frame.error = endError;
    }

    if (isObject(metadata)) {
      const entries = Object.entries(metadata).filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) && entry[1].every((item) => isString(item)),
      );

      frame.metadata = Object.fromEntries(entries);
    }

    return frame;
  }
}

/** Encodes one Connect envelope with a JSON payload, for a streaming request body. */
export function connectEnvelope(message: JsonValue | undefined, end = false): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + payload.byteLength);
  out[0] = end ? 0x02 : 0x00;
  new DataView(out.buffer).setUint32(1, payload.byteLength);
  out.set(payload, 5);

  return out;
}
