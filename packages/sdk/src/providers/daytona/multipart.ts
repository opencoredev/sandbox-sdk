/**
 * Reads the first part of a `multipart/form-data` response as a stream, without busboy. Daytona's toolbox
 * answers `POST /files/bulk-download` this way: one part per requested path, named `file` with the bytes or
 * `error` with a JSON body. The part's bytes come out while they arrive; the delimiter, the header block
 * and the part's end may each be split across chunks. Only the closing delimiter proves the part is
 * complete, so a body that ends before it fails as truncated.
 */
import { SandboxError } from "../../errors.js";

export interface MultipartPart {
  /** The `name` from Content-Disposition: `file` or `error` for Daytona. */
  name?: string;
  /** The `filename` from Content-Disposition: the requested path for Daytona. */
  filename?: string;
  /** Header names are lower case. */
  headers: Readonly<Record<string, string>>;
  /** The part's bytes. Cancelling it cancels the response. */
  body: ReadableStream<Uint8Array>;
}

export interface MultipartOptions {
  provider: string;
  sandboxId?: string;
  /** Largest header block in bytes. Default: 16 KiB. */
  maxHeaderBytes?: number;
}

const encoder = new TextEncoder();
const headerEnd = encoder.encode("\r\n\r\n");

/** The boundary from a `multipart/*` Content-Type, or `undefined`. */
export function boundaryOf(contentType: string | null): string | undefined {
  if (!contentType || !/^multipart\//i.test(contentType.trim())) return undefined;
  const value = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(contentType);
  return value?.[1] ?? value?.[2];
}

/** Index of `needle` in `haystack` at or after `from`, or -1. */
function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0];
  for (let i = haystack.indexOf(first ?? 0, from); i >= 0 && i + needle.length <= haystack.length; i = haystack.indexOf(first ?? 0, i + 1)) {
    let match = true;
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) { match = false; break; }
    if (match) return i;
  }
  return -1;
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (!a.byteLength) return b;
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a); out.set(b, a.byteLength);
  return out;
}
function disposition(value: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|;)\\s*${name}="([^"]*)"`, "i").exec(value) ?? new RegExp(`(?:^|;)\\s*${name}=([^;\\s]*)`, "i").exec(value);
  return match?.[1];
}

/**
 * Reads up to the first part's header block and returns the part, with its body still streaming. Rejects
 * with `provider` when the body is not multipart as declared and `unavailable` when it ends early.
 */
export async function firstPart(body: ReadableStream<Uint8Array>, boundary: string, options: MultipartOptions): Promise<MultipartPart> {
  const fail = (truncated: boolean, what: string) => new SandboxError(`${what}. The ${options.provider} download response ${truncated ? "ended early" : "is not valid multipart"}. Retry the read.`, {
    code: truncated ? "unavailable" : "provider", provider: options.provider, sandboxId: options.sandboxId, retryable: truncated,
  });
  const maxHeaderBytes = options.maxHeaderBytes ?? 16 * 1024;
  const open = encoder.encode(`--${boundary}`);
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const reader = body.getReader();
  let pending: Uint8Array = new Uint8Array();
  let done = false;
  const more = async () => {
    const next = await reader.read();
    if (next.done) { done = true; return false; }
    pending = concat(pending, next.value);
    return true;
  };
  try {
    // The first delimiter, after an optional preamble, then the header block.
    let start: number;
    while ((start = indexOf(pending, open)) < 0 || pending.length < start + open.length + 2) {
      if (pending.length > maxHeaderBytes) throw fail(false, "No part delimiter in the first bytes");
      if (!await more()) throw fail(true, "The body ended before the first part");
    }
    if (pending[start + open.length] === 0x2d && pending[start + open.length + 1] === 0x2d) throw fail(false, "The body has no parts");
    let lineEnd: number;
    while ((lineEnd = indexOf(pending, headerEnd.subarray(0, 2), start + open.length)) < 0) {
      if (pending.length > maxHeaderBytes) throw fail(false, "The part delimiter line is too long");
      if (!await more()) throw fail(true, "The body ended in the part delimiter");
    }
    let end: number;
    while ((end = indexOf(pending, headerEnd, lineEnd)) < 0) {
      if (pending.length - lineEnd > maxHeaderBytes) throw fail(false, "The part headers are too large");
      if (!await more()) throw fail(true, "The body ended in the part headers");
    }
    const headers: Record<string, string> = {};
    for (const line of new TextDecoder().decode(pending.subarray(lineEnd + 2, end)).split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const contentDisposition = headers["content-disposition"] ?? "";
    const declared = headers["content-length"] === undefined ? undefined : Number(headers["content-length"]);
    if (declared !== undefined && !(Number.isSafeInteger(declared) && declared >= 0)) throw fail(false, "The part has an invalid Content-Length");
    pending = pending.subarray(end + headerEnd.length);
    let sent = 0;
    let finished = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          for (;;) {
            // A delimiter is only one when "--" (the last part) or CRLF (another part) follows it. Daytona's
            // boundary is fixed, so a file may contain the same bytes followed by anything else: that is data.
            let at = indexOf(pending, delimiter);
            let undecided = false;
            while (at >= 0) {
              const next = at + delimiter.length;
              if (pending.length < next + 2) { undecided = true; break; }
              if ((pending[next] === 0x2d && pending[next + 1] === 0x2d) || (pending[next] === 0x0d && pending[next + 1] === 0x0a)) break;
              at = indexOf(pending, delimiter, at + 1);
            }
            if (at >= 0 && !undecided) {
              if (at) output.enqueue(pending.slice(0, at));
              sent += at;
              finished = true;
              if (declared !== undefined && declared !== sent) throw fail(false, `The part has ${sent} bytes but declares ${declared}`);
              await reader.cancel().catch(() => {});
              output.close();
              return;
            }
            // Keep a tail that could be the start of a delimiter and the two bytes after it; send the rest now.
            const safe = undecided ? at : pending.length - (delimiter.length + 1);
            if (safe > 0) {
              output.enqueue(pending.slice(0, safe));
              sent += safe;
              pending = pending.subarray(safe);
              if (declared !== undefined && sent > declared) throw fail(false, `The part is longer than its declared ${declared} bytes`);
              return;
            }
            if (done || !await more()) throw fail(true, "The body ended inside the part");
          }
        } catch (error) {
          finished = true;
          await reader.cancel().catch(() => {});
          throw error;
        }
      },
      async cancel(reason) { if (!finished) await reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return { name: disposition(contentDisposition, "name"), filename: disposition(contentDisposition, "filename"), headers, body: stream };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

/** Reads a whole stream into one array. */
export async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
    }
  } finally { reader.releaseLock(); }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}
