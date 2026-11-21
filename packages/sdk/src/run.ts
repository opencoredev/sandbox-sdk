import { posix } from "node:path";
import type { OutputChunk, Provider } from "./provider.js";
import { invalid, Redactor, type SandboxError } from "./errors.js";
import type { RunHandle, RunOptions, RunResult } from "./types.js";
import { quote } from "./shared/shell.js";

// Providers built on run.ts helpers import quote from here.
export { quote };

/** Every SDK command carries this variable, and so does every descendant that keeps its environment. */
export const activityTag = "SANDBOX_SDK_RUN";

export const defaults = {
  CI: "1",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  DEBIAN_FRONTEND: "noninteractive",
  TERM: "dumb",
  NO_COLOR: "1",
  [activityTag]: "1",
};

export const pathOf = (path = ".") => posix.resolve("/workspace", path);
export const secretRecoveryCommand = `if [ -f /tmp/.sandbox-sdk/secret-names.json ]; then cat /tmp/.sandbox-sdk/secret-names.json || exit 1; printf '\\000'; env -0; fi`;

// Anonymous-pipe relays keep activity alive until inherited stdout/stderr close.
// Close the routing descriptors in the user shell: only its actual output pipes
// should keep the relays alive. Every child remains in the adapter's process group.
// The marker is a file whose last write is the exit status; mkdir runs only once per sandbox.
const activityScript = `[ -d "\${2%/*}" ] || (umask 077; mkdir -p "\${2%/*}") || exit 1
trap 'rm -f -- "$2"' EXIT
: > "$2" || exit 1
{ { "$3" -c "$1" 3>&- 4>&-; printf '%s\\n' "$?" > "$2"; } 2>&1 >&3 | cat >&4; } 3>&1 4>&2 | cat
read -r code < "$2"
exit "$code"`;

const activityCommand = (command: string, path: string, shell = "sh") =>
  `sh -c ${quote(activityScript)} sh ${quote(command)} ${quote(path)} ${quote(shell)}`;

// procActivity adapters: the tagged outer shell waits for the command's own shell, so a command that
// execs into a program that clears its environment (sudo, env -i) still has a tagged parent while it runs.
// Tagged cat relays carry stdout and stderr, so a background child that cleared its environment but
// holds the output keeps a tagged reader alive until it closes. The status returns on fd 6, not a file.
const taggedScript = `exec 7>&1
c=$({ { { "$2" -c "$1" 3>&- 4>&- 6>&- 7>&-; echo "$?" >&6; } 2>&1 >&3 | cat >&4; } 3>&1 4>&2 | cat >&7; } 6>&1)
exit "\${c:-1}"`;

const taggedCommand = (command: string, shell = "sh") =>
  `sh -c ${quote(taggedScript)} sh ${quote(command)} ${quote(shell)}`;

/**
 * Idle scan for procActivity adapters. Exit 0 only when every live process is readable and none carries
 * the tag; any other outcome means busy. Processes the exec user cannot read are re-read through
 * passwordless sudo (root reads root-owned processes); a process nobody can read keeps the sandbox busy.
 */
export const activityScanCommand = `t=${activityTag}=1
set -- /proc/[0-9]*/environ
[ -e "$1" ] || exit 2
grep -s -q -a -F -e "$t" -- "$@"; c=$?
[ "$c" = 0 ] && exit 10
[ "$c" = 1 ] && exit 0
[ "$c" = 2 ] || exit 2
u=
for f in "$@"; do
  grep -s -q -a -F -e "$t" -- "$f"; c=$?
  [ "$c" = 0 ] && exit 10
  [ "$c" = 2 ] && [ -d "\${f%/environ}" ] && u="$u $f"
done
[ -z "$u" ] && exit 0
[ "$(id -u)" = 0 ] && exit 11
sudo -n sh -c 'for f; do grep -s -q -a -F -e "$0" -- "$f"; c=$?; [ "$c" = 0 ] && exit 10; [ "$c" = 2 ] && [ -d "\${f%/environ}" ] && exit 11; done; exit 0' "$t" $u </dev/null 2>/dev/null`;

// Guest markers cover independent SDK clients after launch. This registry also
// covers transport setup/queueing before the guest can publish its marker.
const activeRuns = new Map<string, Map<string, number>>();

export const isRunActive = (provider: string, id: string) =>
  (activeRuns.get(provider)?.get(id) ?? 0) > 0;

function trackRun(provider: string, id: string) {
  let runs = activeRuns.get(provider);

  if (!runs) {
    runs = new Map();
    activeRuns.set(provider, runs);
  }

  const counts = runs;
  counts.set(id, (counts.get(id) ?? 0) + 1);

  return () => {
    const count = (counts.get(id) ?? 1) - 1;

    if (count) counts.set(id, count);
    else counts.delete(id);

    if (!counts.size) activeRuns.delete(provider);
  };
}

export class BufferCap {
  private headParts: Buffer[] = [];
  private headBytes = 0;
  private tailParts: Buffer[] = [];
  private tailHead = 0;
  private tailBytes = 0;
  total = 0;
  constructor(readonly limit: number) {}
  add(text: string) {
    const data = Buffer.from(text);
    this.total += data.length;
    const headSize = Math.ceil(this.limit / 2);
    const tailLimit = this.limit - headSize;
    const take = Math.min(data.length, headSize - this.headBytes);

    if (take > 0) {
      this.headParts.push(take === data.length ? data : data.subarray(0, take));
      this.headBytes += take;
    }

    const rest = take > 0 ? data.subarray(take) : data;

    if (rest.length > 0 && tailLimit > 0) {
      if (rest.length >= tailLimit) {
        this.tailParts = [rest.subarray(rest.length - tailLimit)];
        this.tailHead = 0;
        this.tailBytes = tailLimit;
      } else {
        this.tailParts.push(rest);
        this.tailBytes += rest.length;

        while (this.tailBytes > tailLimit && this.tailHead < this.tailParts.length) {
          const front = this.tailParts[this.tailHead];

          if (!front) break;
          const excess = this.tailBytes - tailLimit;

          if (front.length <= excess) {
            this.tailBytes -= front.length;
            this.tailHead += 1;
          } else {
            this.tailParts[this.tailHead] = front.subarray(excess);
            this.tailBytes -= excess;
          }
        }

        if (this.tailHead > 1024 && this.tailHead * 2 >= this.tailParts.length) {
          this.tailParts = this.tailParts.slice(this.tailHead);
          this.tailHead = 0;
        }
      }
    }
  }
  get truncated() {
    return this.total > this.limit;
  }
  text() {
    const headBuf = this.headParts.length
      ? Buffer.concat(this.headParts, this.headBytes)
      : Buffer.alloc(0);

    const tailSlice = this.tailHead ? this.tailParts.slice(this.tailHead) : this.tailParts;
    const tailBuf = tailSlice.length ? Buffer.concat(tailSlice, this.tailBytes) : Buffer.alloc(0);

    if (!this.truncated) return Buffer.concat([headBuf, tailBuf]).toString();
    // Decode the head in streaming mode to discard an incomplete trailing code point.
    const head = new TextDecoder().decode(headBuf, { stream: true });
    let start = 0;

    while (start < tailBuf.length && ((tailBuf[start] ?? 0) & 0xc0) === 0x80) start++;
    const tail = tailBuf.subarray(start).toString();

    return (
      head +
      `\n[${this.total - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes cut]\n` +
      tail
    );
  }
}

/** Bounded independent subscriptions; slow consumers see the most recent 1 MB. */
export class OutputBus {
  private listeners = new Set<(chunk?: OutputChunk) => void>();
  private ended = false;
  private failure: SandboxError | undefined;
  emit(chunk: OutputChunk) {
    for (const listener of this.listeners) listener(chunk);
  }
  fail(error: SandboxError) {
    this.failure = error;
    this.end();
  }
  end() {
    this.ended = true;

    for (const listener of this.listeners) listener();
  }
  async *stream(): AsyncGenerator<OutputChunk> {
    const queue: OutputChunk[] = [];
    let bytes = 0;
    let wake = () => {};

    const listener = (chunk?: OutputChunk) => {
      if (chunk) {
        const text =
          Buffer.byteLength(chunk.text) > 1_048_576
            ? Buffer.from(chunk.text).subarray(-1_048_576).toString()
            : chunk.text;

        queue.push({ ...chunk, text });
        bytes += Buffer.byteLength(text);

        while (bytes > 1_048_576 && queue.length > 1)
          bytes -= Buffer.byteLength(queue.shift()?.text ?? "");
      }

      wake();
    };

    this.listeners.add(listener);

    try {
      while (!this.ended || queue.length) {
        const next = queue.shift();

        if (next) {
          bytes -= Buffer.byteLength(next.text);
          yield next;
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }

      if (this.failure) throw this.failure;
    } finally {
      this.listeners.delete(listener);
    }
  }
}

/** Hold suffixes so secrets split between transport chunks never escape. */
export function chunkRedactor(
  redactor: Redactor,
  emit: (chunk: OutputChunk) => void,
  interleaved = false,
) {
  const marker = "[REDACTED]";

  interface QueuedChunk {
    stream: OutputChunk["stream"];
    text: string;
    parts?: string[];
    len: number;
    bytes: number;
  }

  const queue: QueuedChunk[] = [];
  let queuedBytes = 0;
  let dropped = false;
  let cleanKey = "";
  let cleanLen = 0;
  const holdZeroAt = new Set<number>();
  const streamLen: Record<OutputChunk["stream"], number> = { stdout: 0, stderr: 0 };
  const streamBytes: Record<OutputChunk["stream"], number> = { stdout: 0, stderr: 0 };
  let totalLen = 0;
  const stallTail: Record<OutputChunk["stream"], string> = { stdout: "", stderr: "" };
  let stallTailAll = "";
  const emittedTail: Record<OutputChunk["stream"], string> = { stdout: "", stderr: "" };
  let markerAdjSecret: boolean | undefined;
  let markerAdjSecretsLen = -1;

  function tailKeep(): number {
    let maxLeft = 0;

    for (const p of redactor.streamChainLeft) if (p.length > maxLeft) maxLeft = p.length;

    for (const p of redactor.streamHoldLeft) if (p.length > maxLeft) maxLeft = p.length;

    return redactor.maxLength + marker.length * 2 + maxLeft + 2;
  }

  function materialize(chunk: QueuedChunk): string {
    if (chunk.parts) {
      chunk.text = chunk.text ? chunk.text + chunk.parts.join("") : chunk.parts.join("");
      chunk.parts = undefined;
    }

    return chunk.text;
  }

  function syncStats() {
    streamLen.stdout = 0;
    streamLen.stderr = 0;
    streamBytes.stdout = 0;
    streamBytes.stderr = 0;
    totalLen = 0;
    stallTail.stdout = "";
    stallTail.stderr = "";
    stallTailAll = "";
    const keep = tailKeep();

    for (const entry of queue) {
      const text = materialize(entry);
      streamLen[entry.stream] += text.length;
      streamBytes[entry.stream] += entry.bytes;
      totalLen += text.length;
      stallTail[entry.stream] = (stallTail[entry.stream] + text).slice(-keep);
      stallTailAll = (stallTailAll + text).slice(-keep);
    }
  }

  function hasAdjacentMarkerSecret(): boolean {
    const count = redactor.secrets.length;

    if (markerAdjSecret === undefined || markerAdjSecretsLen !== count) {
      markerAdjSecret = redactor.hasMatch(marker + marker);
      markerAdjSecretsLen = count;
    }

    return markerAdjSecret;
  }

  const failClosedEmitted: Record<OutputChunk["stream"], boolean> = {
    stdout: false,
    stderr: false,
  };

  function emitSafe(chunk: OutputChunk) {
    if (!chunk.text) return;

    if (interleaved || failClosedEmitted[chunk.stream]) {
      const prev = emittedTail[chunk.stream];
      let out = chunk.text;

      if (prev && !redactor.hasMatch(prev) && redactor.hasMatch(prev + out)) {
        const combined = redactor.text(prev + out);

        out = combined.startsWith(prev)
          ? combined.slice(prev.length)
          : combined.includes(marker)
            ? marker
            : combined;
      }

      const maxTail = Math.max(redactor.maxLength, marker.length);
      const nextTail = prev + out;

      if (nextTail.length > maxTail) {
        let cut = nextTail.length - maxTail;
        const snapped = snapBeforeMarker(nextTail, cut);

        if (snapped < cut) cut = snapped;
        emittedTail[chunk.stream] = nextTail.slice(cut);
      } else {
        emittedTail[chunk.stream] = nextTail;
      }

      if (out) emit({ stream: chunk.stream, text: out });

      return;
    }

    emit(chunk);
  }

  function setChunkText(chunk: QueuedChunk, text: string) {
    const nextBytes = text ? Buffer.byteLength(text) : 0;
    queuedBytes += nextBytes - chunk.bytes;
    chunk.text = text;
    chunk.parts = undefined;
    chunk.len = text.length;
    chunk.bytes = nextBytes;
  }

  function resetStall() {
    cleanKey = "";
    cleanLen = 0;
    holdZeroAt.clear();
  }

  /** Prefix of raw text that does not end with a proper prefix of `[REDACTED]`. */
  function rawPrefixLength(text: string): number {
    for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
      if (text.startsWith(marker.slice(0, length), text.length - length)) {
        return text.length - length;
      }
    }

    return text.length;
  }

  /** Snap `pos` left of any `[REDACTED]` marker it currently splits (strictly O(1)). */
  function snapBeforeMarker(text: string, pos: number): number {
    const from = Math.max(0, pos - (marker.length - 1));

    for (let index = from; index < pos; index++) {
      if (text.startsWith(marker, index)) return index;
    }

    return pos;
  }

  /** Pull `pos` left over any marker-adjacent prefix so emitting `[0, pos)` cannot leave
   * a leading fragment that combines with a future `[REDACTED]` marker into a secret. */
  function pullLeftForMarker(text: string, pos: number): number {
    let safe = snapBeforeMarker(text, pos);
    const fullLeft = redactor.streamChainLeft;
    const partialLeft = redactor.streamHoldLeft;

    if (safe <= 0 || (fullLeft.length === 0 && partialLeft.length === 0)) return safe;

    if (fullLeft.length > 0) {
      let pulled = true;

      while (pulled && safe > 0) {
        pulled = false;

        for (const prefix of fullLeft) {
          if (safe >= prefix.length && text.startsWith(prefix, safe - prefix.length)) {
            safe -= prefix.length;
            pulled = true;
            break;
          }
        }

        if (pulled) {
          safe = snapBeforeMarker(text, safe);

          if (safe >= marker.length && text.startsWith(marker, safe - marker.length))
            safe -= marker.length;
        }
      }
    }

    if (safe > 0 && partialLeft.length > 0) {
      for (const prefix of partialLeft) {
        if (safe >= prefix.length && text.startsWith(prefix, safe - prefix.length)) {
          safe -= prefix.length;
          safe = snapBeforeMarker(text, safe);
          break;
        }
      }
    }

    return snapBeforeMarker(text, safe);
  }

  /** Earliest raw cutoff where a trailing suffix is a strict prefix of a secret not already
   * covered by an earlier complete match in `segments`. Keeps nested/longer secrets raw until
   * future chunks resolve them so an inner shorter secret cannot redact first and expose the
   * outer secret's prefix. */
  function rawHoldCutoff(
    text: string,
    segments: readonly {
      readonly redacted: boolean;
      readonly start: number;
      readonly end: number;
    }[],
  ): number {
    const secrets = redactor.secrets;
    let searchFrom = Math.max(0, text.length - (redactor.maxLength - 1));

    while (searchFrom < text.length) {
      let hit = -1;

      for (let index = searchFrom; index < text.length; index++) {
        const suffix = text.slice(index);

        if (secrets.some((secret) => secret.length > suffix.length && secret.startsWith(suffix))) {
          hit = index;
          break;
        }
      }

      if (hit < 0) return text.length;

      const covering = segments.find((seg) => seg.redacted && seg.start < hit && seg.end > hit);

      if (covering) {
        searchFrom = covering.end;
        continue;
      }

      let cutoff = pullLeftForMarker(text, hit);

      while (cutoff > 0) {
        const split = segments.find(
          (seg) => seg.redacted && seg.start < cutoff && seg.end > cutoff,
        );

        if (!split) break;
        cutoff = pullLeftForMarker(text, split.start);
      }

      return cutoff;
    }

    return text.length;
  }

  function safePrefixLength(text: string, useHoldZero: boolean, offset = 0) {
    const secrets = redactor.secrets;
    const windowStart = Math.max(0, text.length - (redactor.maxLength - 1));
    let safe = text.length;

    for (let index = windowStart; index < text.length; index++) {
      const suffix = text.slice(index);

      if (secrets.some((secret) => secret.startsWith(suffix))) {
        safe = index;
        break;
      }
    }

    if (safe === text.length) return { safe: offset + text.length, pulledFrom: -1 };

    safe = snapBeforeMarker(text, safe);
    const initialSafe = safe;

    // Hold trailing characters that could extend left from a future marker, while keeping
    // any marker whole so neither half leaks an inside-marker secret. Chain only on full
    // left/around prefixes (`streamChainLeft`) and pull a partial prefix (`streamHoldLeft`) at most once.
    const fullLeft = redactor.streamChainLeft;
    const partialLeft = redactor.streamHoldLeft;
    let usedPartial = false;

    if (initialSafe > 0 && (fullLeft.length > 0 || partialLeft.length > 0)) {
      if (fullLeft.length > 0) {
        let pulled = true;

        while (pulled && safe > 0) {
          if (useHoldZero && holdZeroAt.has(offset + safe)) {
            return { safe: 0, pulledFrom: offset + initialSafe };
          }

          pulled = false;

          for (const prefix of fullLeft) {
            if (safe >= prefix.length && text.startsWith(prefix, safe - prefix.length)) {
              safe -= prefix.length;
              pulled = true;
              break;
            }
          }

          if (pulled) {
            safe = snapBeforeMarker(text, safe);

            if (safe >= marker.length && text.startsWith(marker, safe - marker.length))
              safe -= marker.length;
          }
        }
      }

      if (safe > 0 && partialLeft.length > 0) {
        if (useHoldZero && holdZeroAt.has(offset + safe)) {
          return { safe: 0, pulledFrom: offset + initialSafe };
        }

        for (const prefix of partialLeft) {
          if (safe >= prefix.length && text.startsWith(prefix, safe - prefix.length)) {
            safe -= prefix.length;
            safe = snapBeforeMarker(text, safe);
            usedPartial = true;
            break;
          }
        }
      }
    }

    const snapped = snapBeforeMarker(text, safe);

    if (snapped === 0) {
      if (offset === 0 || (!usedPartial && useHoldZero && holdZeroAt.has(offset))) {
        return { safe: 0, pulledFrom: initialSafe > 0 ? offset + initialSafe : -1 };
      }

      return { safe: offset, pulledFrom: -1 };
    }

    if (!usedPartial && useHoldZero && holdZeroAt.has(offset + snapped)) {
      return { safe: 0, pulledFrom: initialSafe > 0 ? offset + initialSafe : -1 };
    }

    return { safe: offset + snapped, pulledFrom: -1 };
  }

  /** Emit a slice `[start, end)` of `head` attributed to the original chunks' streams. */
  function emitMappedRange(chunks: readonly OutputChunk[], start: number, end: number) {
    if (end <= start) return;
    let offset = 0;

    for (const chunk of chunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.text.length;
      offset = chunkEnd;

      if (chunkEnd <= start) continue;

      if (chunkStart >= end) break;
      const sliceStart = Math.max(start, chunkStart) - chunkStart;
      const sliceEnd = Math.min(end, chunkEnd) - chunkStart;
      const piece = chunk.text.slice(sliceStart, sliceEnd);

      if (piece) emitSafe({ stream: chunk.stream, text: piece });
    }
  }

  /** Stream of the chunk containing `pos` in `chunks`. */
  function streamAt(chunks: readonly OutputChunk[], pos: number, fallback: OutputChunk["stream"]) {
    let offset = 0;

    for (const chunk of chunks) {
      const end = offset + chunk.text.length;

      if (pos < end) return chunk.stream;
      offset = end;
    }

    return fallback;
  }

  /** Distinct consecutive stream runs overlapping `[start, end)` in arrival order. */
  function streamsInRange(
    chunks: readonly OutputChunk[],
    start: number,
    end: number,
    fallback: OutputChunk["stream"],
  ): OutputChunk["stream"][] {
    const runs: OutputChunk["stream"][] = [];
    let offset = 0;

    for (const chunk of chunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.text.length;
      offset = chunkEnd;

      if (chunkEnd <= start) continue;

      if (chunkStart >= end) break;

      if (runs.at(-1) !== chunk.stream) runs.push(chunk.stream);
    }

    return runs.length > 0 ? runs : [streamAt(chunks, start, fallback)];
  }

  /** Streams that contain a `[REDACTED]` marker inside `[start, end)`. */
  function streamsWithMarkerInRange(
    chunks: readonly OutputChunk[],
    start: number,
    end: number,
  ): OutputChunk["stream"][] {
    const found: OutputChunk["stream"][] = [];
    let offset = 0;

    for (const chunk of chunks) {
      const chunkStart = offset;
      const chunkEnd = offset + chunk.text.length;
      offset = chunkEnd;

      if (chunkEnd <= start) continue;

      if (chunkStart >= end) break;
      const sliceStart = Math.max(start, chunkStart) - chunkStart;
      const sliceEnd = Math.min(end, chunkEnd) - chunkStart;

      if (chunk.text.slice(sliceStart, sliceEnd).includes(marker) && !found.includes(chunk.stream))
        found.push(chunk.stream);
    }

    return found;
  }

  /** Emit redacted segments up to `limit` characters while preserving exact stream attribution. */
  function emitRedactedSegments(
    chunks: readonly OutputChunk[],
    segments: readonly {
      readonly text: string;
      readonly redacted: boolean;
      readonly start: number;
      readonly end: number;
    }[],
    limit: number,
    fallbackStream: OutputChunk["stream"],
  ) {
    if (limit <= 0) return;

    if (!interleaved || chunks.every((chunk) => chunk.stream === fallbackStream)) {
      let remaining = limit;
      let text = "";

      for (const seg of segments) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, seg.text.length);
        text += seg.text.slice(0, take);
        remaining -= take;
      }

      if (text) emitSafe({ stream: fallbackStream, text });

      return;
    }

    let remaining = limit;

    for (const seg of segments) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, seg.text.length);

      if (take <= 0) continue;

      if (seg.redacted) {
        const piece = seg.text.slice(0, take);
        const startStream = streamAt(chunks, seg.start, fallbackStream);
        const absorbed = streamsWithMarkerInRange(chunks, seg.start, seg.end);

        const runs = absorbed.some((stream) => stream !== startStream)
          ? streamsInRange(chunks, seg.start, seg.end, fallbackStream)
          : [startStream];

        if (runs.length > 1 && hasAdjacentMarkerSecret()) {
          const afterStream = streamAt(chunks, seg.end, runs[0] ?? fallbackStream);
          const chosen = runs.includes(afterStream) ? afterStream : (runs[0] ?? fallbackStream);
          emitSafe({ stream: chosen, text: piece });
        } else {
          for (const stream of runs) {
            emitSafe({ stream, text: piece });
          }
        }
      } else {
        const piece = seg.text.slice(0, take);

        if (piece.includes(marker)) {
          const parts = piece.split(marker);
          let localOffset = 0;

          for (let partIndex = 0; partIndex < parts.length; partIndex++) {
            if (partIndex > 0) {
              emitMappedRange(
                chunks,
                seg.start + localOffset,
                seg.start + localOffset + marker.length,
              );
              localOffset += marker.length;
            }

            const part = parts[partIndex];

            if (part) {
              emitMappedRange(
                chunks,
                seg.start + localOffset,
                seg.start + localOffset + part.length,
              );
              localOffset += part.length;
            }
          }
        } else {
          emitMappedRange(chunks, seg.start, seg.start + take);
        }
      }

      remaining -= take;
    }
  }

  /** Build per-stream chunks for the unemitted suffix of `segments` starting at `offset`. */
  function heldRedactedChunks(
    chunks: readonly OutputChunk[],
    segments: readonly {
      readonly text: string;
      readonly redacted: boolean;
      readonly start: number;
      readonly end: number;
    }[],
    offset: number,
    fallbackStream: OutputChunk["stream"],
  ): QueuedChunk[] {
    const out: QueuedChunk[] = [];
    let cursor = 0;

    const append = (stream: OutputChunk["stream"], text: string) => {
      if (!text) return;
      const prev = out.at(-1);

      if (prev && prev.stream === stream) {
        prev.text += text;
        prev.len += text.length;
        prev.bytes += Buffer.byteLength(text);
      } else {
        out.push({ stream, text, len: text.length, bytes: Buffer.byteLength(text) });
      }
    };

    for (const seg of segments) {
      const segEnd = cursor + seg.text.length;

      if (segEnd <= offset) {
        cursor = segEnd;
        continue;
      }

      const skip = Math.max(0, offset - cursor);
      const piece = seg.text.slice(skip);
      cursor = segEnd;

      if (!piece) continue;

      if (seg.redacted) {
        append(streamAt(chunks, seg.start, fallbackStream), piece);
      } else {
        let rangeOffset = 0;
        const sliceStart = seg.start + skip;
        const sliceEnd = sliceStart + piece.length;

        for (const chunk of chunks) {
          const chunkStart = rangeOffset;
          const chunkEnd = rangeOffset + chunk.text.length;
          rangeOffset = chunkEnd;

          if (chunkEnd <= sliceStart) continue;

          if (chunkStart >= sliceEnd) break;
          const from = Math.max(sliceStart, chunkStart) - chunkStart;
          const to = Math.min(sliceEnd, chunkEnd) - chunkStart;
          append(chunk.stream, chunk.text.slice(from, to));
        }
      }
    }

    return out;
  }

  function consumeFrom(indices: readonly number[], count: number) {
    let remaining = count;

    for (const index of indices) {
      const chunk = queue[index];

      if (!chunk || remaining <= 0) break;
      const take = Math.min(remaining, chunk.text.length);
      setChunkText(chunk, chunk.text.slice(take));
      remaining -= take;
    }
  }

  function replaceSelected(
    indices: readonly number[],
    text: string,
    stream?: OutputChunk["stream"],
  ) {
    const firstIdx = indices[0];

    if (firstIdx !== undefined && queue[firstIdx]) {
      setChunkText(queue[firstIdx], text);

      if (stream !== undefined) queue[firstIdx].stream = stream;
    }

    for (let i = 1; i < indices.length; i++) {
      const idx = indices[i];

      if (idx !== undefined && queue[idx]) setChunkText(queue[idx], "");
    }
  }

  function pruneEmpty() {
    let write = 0;

    for (let read = 0; read < queue.length; read++) {
      const item = queue[read];

      if (item?.len) queue[write++] = item;
    }

    queue.length = write;
  }

  function drain(final = false) {
    if (final && !interleaved && queue.length > 1) {
      const parts: Record<OutputChunk["stream"], string[]> = { stdout: [], stderr: [] };

      for (const chunk of queue) parts[chunk.stream].push(materialize(chunk));
      const stdoutRaw = parts.stdout.join("");
      const stderrRaw = parts.stderr.join("");

      const byStream = {
        stdout: redactor.redactSegments(stdoutRaw),
        stderr: redactor.redactSegments(stderrRaw),
      };

      if (byStream.stdout.text === stdoutRaw && byStream.stderr.text === stderrRaw) {
        for (const chunk of queue) emitSafe({ stream: chunk.stream, text: chunk.text });
      } else {
        const cursor: Record<
          OutputChunk["stream"],
          { origOffset: number; consumed: number; segIdx: number }
        > = {
          stdout: { origOffset: 0, consumed: 0, segIdx: 0 },
          stderr: { origOffset: 0, consumed: 0, segIdx: 0 },
        };

        for (const chunk of queue) {
          const state = cursor[chunk.stream];
          const segs = byStream[chunk.stream].segments;
          const cStart = state.origOffset;
          const cEnd = cStart + chunk.len;
          state.origOffset = cEnd;

          if (cEnd <= state.consumed) continue;
          let out = "";

          while (state.segIdx < segs.length) {
            const seg = segs[state.segIdx];

            if (!seg || seg.start >= cEnd) break;

            if (seg.end <= state.consumed) {
              state.segIdx++;
              continue;
            }

            if (seg.redacted) {
              out += seg.text;
              state.consumed = seg.end;
              state.segIdx++;

              if (seg.end >= cEnd) break;
            } else {
              const from = Math.max(cStart, state.consumed, seg.start);
              const to = Math.min(cEnd, seg.end);

              if (to > from) {
                out += seg.text.slice(from - seg.start, to - seg.start);
                state.consumed = to;
              }

              if (seg.end <= cEnd) state.segIdx++;
              else break;
            }
          }

          if (out) emitSafe({ stream: chunk.stream, text: out });
        }
      }

      queue.length = 0;
      queuedBytes = 0;
      resetStall();
      syncStats();

      return;
    }

    let headIdx = 0;
    let dirtyStats = false;
    const cleanSafeBudget: Record<OutputChunk["stream"], number> = { stdout: -1, stderr: -1 };

    type StreamDrainPlan = {
      readonly segments: readonly {
        readonly text: string;
        readonly redacted: boolean;
        readonly start: number;
        readonly end: number;
      }[];
      readonly safe: number;
      origOffset: number;
      origConsumed: number;
      outCursor: number;
      segIdx: number;
    };

    const streamPlan: Record<OutputChunk["stream"], StreamDrainPlan | undefined> = {
      stdout: undefined,
      stderr: undefined,
    };

    const flushPlanDebts = () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const plan = streamPlan[stream];

        if (!plan) continue;
        let debt = plan.origConsumed - plan.origOffset;

        for (let i = headIdx; i < queue.length && debt > 0; i++) {
          const chunk = queue[i];

          if (!chunk || chunk.stream !== stream || !chunk.len) continue;
          const text = materialize(chunk);
          const drop = Math.min(debt, text.length);
          setChunkText(chunk, text.slice(drop));
          debt -= drop;
          dirtyStats = true;
        }

        streamPlan[stream] = undefined;
      }
    };

    while (headIdx < queue.length) {
      const first = queue[headIdx];

      if (!first) break;

      if (!first.len) {
        headIdx++;
        continue;
      }

      if (!interleaved && cleanSafeBudget[first.stream] > 0) {
        const budget = cleanSafeBudget[first.stream];
        const take = Math.min(budget, first.len);
        const text = materialize(first);
        emitSafe({ stream: first.stream, text: text.slice(0, take) });
        setChunkText(first, text.slice(take));
        cleanSafeBudget[first.stream] = budget - take;
        dirtyStats = true;

        if (!first.len) headIdx++;
        continue;
      }

      if (!interleaved) {
        const plan = streamPlan[first.stream];

        if (plan) {
          const text = materialize(first);
          const cStart = plan.origOffset;
          const cEnd = cStart + text.length;

          if (cEnd <= plan.origConsumed) {
            plan.origOffset = cEnd;
            setChunkText(first, "");
            dirtyStats = true;
            headIdx++;
            continue;
          }

          if (plan.outCursor >= plan.safe) {
            const drop = Math.max(0, plan.origConsumed - cStart);

            if (drop > 0) {
              setChunkText(first, text.slice(drop));
              dirtyStats = true;
            }

            streamPlan[first.stream] = undefined;
            continue;
          }

          let out = "";

          while (plan.segIdx < plan.segments.length && plan.outCursor < plan.safe) {
            const seg = plan.segments[plan.segIdx];

            if (!seg || seg.start >= cEnd) break;

            if (seg.end <= plan.origConsumed) {
              plan.segIdx++;
              continue;
            }

            if (seg.redacted) {
              if (plan.outCursor + seg.text.length > plan.safe) break;
              out += seg.text;
              plan.outCursor += seg.text.length;
              plan.origConsumed = seg.end;
              plan.segIdx++;

              if (seg.end >= cEnd) break;
            } else {
              const from = Math.max(cStart, plan.origConsumed, seg.start);
              const maxOrig = Math.min(cEnd, seg.end) - from;
              const take = Math.min(maxOrig, plan.safe - plan.outCursor);

              if (take > 0) {
                out += seg.text.slice(from - seg.start, from - seg.start + take);
                plan.outCursor += take;
                plan.origConsumed = from + take;
              }

              if (plan.origConsumed >= seg.end) plan.segIdx++;
              else break;
            }
          }

          if (out) emitSafe({ stream: first.stream, text: out });

          if (plan.origConsumed >= cEnd) {
            plan.origOffset = cEnd;
            setChunkText(first, "");
            dirtyStats = true;
            headIdx++;
          } else {
            const drop = Math.max(0, plan.origConsumed - cStart);

            if (drop > 0) {
              setChunkText(first, text.slice(drop));
              dirtyStats = true;
            }

            plan.origOffset = plan.origConsumed;
            streamPlan[first.stream] = undefined;
          }

          continue;
        }
      }

      const compactAndFlushPlans = () => {
        flushPlanDebts();

        if (headIdx > 0) {
          queue.splice(0, headIdx);
          headIdx = 0;
        }

        dirtyStats = false;
        pruneEmpty();
        syncStats();
      };

      if (interleaved && (headIdx > 0 || dirtyStats)) {
        compactAndFlushPlans();
      }

      const stallKey = interleaved ? "*" : first.stream;
      const rawLen = interleaved ? totalLen : streamLen[first.stream];
      const selBytes = interleaved ? queuedBytes : streamBytes[first.stream];

      if (
        !final &&
        !dirtyStats &&
        headIdx === 0 &&
        cleanKey === stallKey &&
        cleanLen > 0 &&
        selBytes <= 1_048_576 &&
        queuedBytes <= 1_048_576
      ) {
        const tail = interleaved ? stallTailAll : stallTail[first.stream];
        const tailRawSafe = rawPrefixLength(tail);
        const fastRawSafe = rawLen - (tail.length - tailRawSafe);
        const headTail = tailRawSafe === tail.length ? tail : tail.slice(0, tailRawSafe);
        const baseOffset = fastRawSafe - headTail.length;

        if (fastRawSafe >= cleanLen && baseOffset <= cleanLen && !redactor.hasMatch(headTail)) {
          const fastSafe = safePrefixLength(headTail, true, baseOffset);

          if (fastSafe.safe === 0) {
            cleanLen = fastRawSafe;

            if (fastSafe.pulledFrom >= 0) holdZeroAt.add(fastSafe.pulledFrom);
            break;
          }
        }
      }

      const indices: number[] = [];

      for (let i = headIdx; i < queue.length; i++) {
        const entry = queue[i];

        if (entry && entry.len && (interleaved || entry.stream === first.stream)) indices.push(i);
      }

      const selected: QueuedChunk[] = [];
      let selectedBytes = 0;

      for (const idx of indices) {
        const entry = queue[idx];

        if (entry) {
          materialize(entry);
          selected.push(entry);
          selectedBytes += entry.bytes;
        }
      }

      const raw =
        selected.length === 1
          ? (selected[0]?.text ?? "")
          : selected.map((entry) => entry.text).join("");

      let contiguousLen = raw.length;

      if (!interleaved) {
        contiguousLen = 0;

        for (let i = headIdx; i < queue.length; i++) {
          const chunk = queue[i];

          if (!chunk || !chunk.len) continue;

          if (chunk.stream !== first.stream) break;
          contiguousLen += chunk.len;
        }
      }

      let rawSafe = final ? raw.length : rawPrefixLength(raw);
      let head = rawSafe === raw.length ? raw : raw.slice(0, rawSafe);

      const canReuseClean =
        !final &&
        !dirtyStats &&
        headIdx === 0 &&
        cleanKey === stallKey &&
        cleanLen > 0 &&
        head.length >= cleanLen;

      const tailWindow = canReuseClean
        ? head.slice(Math.max(0, cleanLen - redactor.maxLength))
        : head;

      const hasSecret = canReuseClean ? redactor.hasMatch(tailWindow) : true;

      let redactedResult = hasSecret
        ? redactor.redactSegments(head)
        : {
            text: head,
            segments: head ? [{ text: head, redacted: false, start: 0, end: head.length }] : [],
          };

      let redacted = redactedResult.text;

      if (!final && redacted !== head) {
        const rawCutoff = rawHoldCutoff(head, redactedResult.segments);

        if (rawCutoff < head.length) {
          rawSafe = rawCutoff;
          head = rawSafe === 0 ? "" : raw.slice(0, rawSafe);
          redactedResult = head ? redactor.redactSegments(head) : { text: "", segments: [] };
          redacted = redactedResult.text;
        }
      }

      const safeCheck = final
        ? { safe: redacted.length, pulledFrom: -1 }
        : safePrefixLength(redacted, redacted === head && canReuseClean && head.length >= cleanLen);

      const safe = safeCheck.safe;

      if (redacted === head) {
        if (safe === 0) {
          if (headIdx > 0 || dirtyStats) {
            compactAndFlushPlans();
            continue;
          }

          if (!final && selectedBytes > 1_048_576) {
            dropped = true;
            replaceSelected(indices, marker);
            pruneEmpty();
            resetStall();
            syncStats();
            break;
          }

          if (queuedBytes <= 1_048_576) {
            cleanKey = stallKey;
            cleanLen = head.length;

            if (safeCheck.pulledFrom >= 0) holdZeroAt.add(safeCheck.pulledFrom);
            break;
          }

          // A stalled stream must not retain arbitrary output from another stream.
          // Conservatively redact its ambiguous prefix in one pass, preserving arrival order.
          dropped = true;
          failClosedEmitted[first.stream] = true;
          emitSafe({ stream: first.stream, text: marker });
          replaceSelected(indices, "");
          pruneEmpty();
          resetStall();
          syncStats();
          continue;
        }

        resetStall();

        if (!interleaved) {
          cleanSafeBudget[first.stream] = safe;
          continue;
        }

        // In interleaved mode, drain up to `safe` characters across the queue.
        let remaining = safe;

        for (const index of indices) {
          const chunk = queue[index];

          if (!chunk || !remaining) break;
          const take = Math.min(remaining, chunk.text.length);
          emitSafe({ stream: chunk.stream, text: chunk.text.slice(0, take) });
          setChunkText(chunk, chunk.text.slice(take));
          remaining -= take;
        }
      } else {
        resetStall();

        if (!interleaved && contiguousLen < raw.length && safe > 0) {
          streamPlan[first.stream] = {
            segments: redactedResult.segments,
            safe,
            origOffset: 0,
            origConsumed: 0,
            outCursor: 0,
            segIdx: 0,
          };

          continue;
        }

        if (headIdx > 0 || dirtyStats) {
          compactAndFlushPlans();
          continue;
        }

        if (safe > 0) emitRedactedSegments(selected, redactedResult.segments, safe, first.stream);
        const heldRedacted = redacted.slice(safe);
        const heldRaw = raw.slice(rawSafe);

        if (!final && Buffer.byteLength(heldRedacted) + Buffer.byteLength(heldRaw) > 1_048_576) {
          dropped = true;
          replaceSelected(indices, marker);
          pruneEmpty();
          syncStats();
          break;
        }

        if (interleaved) {
          const heldChunks = heldRedacted
            ? heldRedactedChunks(selected, redactedResult.segments, safe, first.stream)
            : [];

          consumeFrom(indices, rawSafe);

          for (let i = heldChunks.length - 1; i >= 0; i--) {
            const piece = heldChunks[i];

            if (piece) {
              queue.unshift(piece);
              queuedBytes += piece.bytes;
            }
          }
        } else if (contiguousLen < raw.length) {
          // Keep any unconsumed segments that start past the contiguous front run at their
          // original later queue positions so intervening chunks of the other stream keep order.
          let frontHeld = "";
          let consumedOrig = 0;
          let outCursor = 0;

          for (const seg of redactedResult.segments) {
            const segOutEnd = outCursor + seg.text.length;

            if (seg.start >= contiguousLen) break;

            if (segOutEnd > safe) {
              const skip = Math.max(0, safe - outCursor);
              frontHeld += seg.text.slice(skip);
            }

            consumedOrig = Math.max(consumedOrig, seg.end);
            outCursor = segOutEnd;
          }

          if (consumedOrig > 0) {
            consumeFrom(indices, Math.min(consumedOrig, rawSafe));

            if (frontHeld) {
              const bytes = Buffer.byteLength(frontHeld);
              queue.unshift({
                stream: first.stream,
                text: frontHeld,
                len: frontHeld.length,
                bytes,
              });
              queuedBytes += bytes;
            }
          } else {
            replaceSelected(indices, heldRedacted + heldRaw, first.stream);
          }
        } else {
          replaceSelected(indices, heldRedacted + heldRaw, first.stream);
        }
      }

      pruneEmpty();
      syncStats();

      if (!final && safe === 0) break;
    }

    flushPlanDebts();

    if (headIdx > 0 || dirtyStats) {
      if (headIdx > 0) queue.splice(0, headIdx);
      pruneEmpty();
      syncStats();
    }
  }

  return {
    push(chunk: OutputChunk) {
      if (!redactor.secrets.length) {
        emit(chunk);

        return;
      }

      if (!chunk.text) return;
      const bytes = Buffer.byteLength(chunk.text);
      const keep = tailKeep();
      streamLen[chunk.stream] += chunk.text.length;
      streamBytes[chunk.stream] += bytes;
      totalLen += chunk.text.length;
      stallTail[chunk.stream] = (stallTail[chunk.stream] + chunk.text).slice(-keep);
      stallTailAll = (stallTailAll + chunk.text).slice(-keep);
      const prev = queue.at(-1);

      if (prev && prev.stream === chunk.stream) {
        if (prev.parts) prev.parts.push(chunk.text);
        else prev.parts = [chunk.text];
        prev.len += chunk.text.length;
        prev.bytes += bytes;
      } else {
        queue.push({ stream: chunk.stream, text: chunk.text, len: chunk.text.length, bytes });
      }

      queuedBytes += bytes;
      drain();
    },
    flush() {
      drain(true);
    },
    get truncated() {
      return dropped;
    },
  };
}

/** `guard` runs before each command: it throws when the handle is closed and waits for secret recovery. baseEnv is read per command. */
export function makeRun(
  provider: Provider,
  id: string,
  redactor: Redactor,
  baseEnv: Record<string, string>,
  count: (bytes: number) => void,
  guard: () => void | Promise<void> = () => {},
) {
  return (command: string, initial: RunOptions = {}): RunHandle => {
    let options = { ...initial };
    let promise: Promise<RunResult> | undefined;
    const bus = new OutputBus();

    const begin = (streaming = false) =>
      (promise ??= execute(streaming).catch((error) => {
        const mapped = redactor.error(error, provider.name, id);
        bus.fail(mapped);
        throw mapped;
      }));

    async function execute(streaming: boolean): Promise<RunResult> {
      await guard();
      const timeoutMs = options.timeoutMs ?? 120_000;
      const max = options.maxOutputBytes ?? 1_048_576;

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(max) || max < 1)
        invalid("timeoutMs and maxOutputBytes must be positive");
      const cwd = pathOf(options.cwd);
      const started = Date.now();

      const stdout = new BufferCap(max),
        stderr = new BufferCap(max),
        output = new BufferCap(max * 2);

      const controller = new AbortController();
      let timedOut = options.signal?.aborted ?? false;

      const abort = () => {
        timedOut = true;
        controller.abort();
      };

      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      const activePath = `/tmp/.sandbox-sdk/runs/${crypto.randomUUID()}`;
      let completed = false;
      const finish = trackRun(provider.name, id);

      const interleaved = chunkRedactor(
        redactor,
        (chunk) => {
          output.add(chunk.text);
          bus.emit(chunk);
        },
        true,
      );

      const filter = chunkRedactor(redactor, (chunk) => {
        (chunk.stream === "stdout" ? stdout : stderr).add(chunk.text);
        interleaved.push(chunk);
      });

      try {
        if (timedOut) controller.abort();

        const result = timedOut
          ? { exitCode: null, timedOut: true }
          : await provider.exec(id, {
              // Pass the exact command as an argument to a fresh shell. User exit,
              // exec, traps, comments and stdin cannot bypass the parent's cleanup.
              // Marker mode drains both pipes before removing activity: background descendants
              // can retain stdout/stderr after the command shell itself has exited. procActivity
              // adapters need no marker: idle scans find the tag in every live descendant.
              command: provider.inlineActivity
                ? command
                : provider.procActivity
                  ? taggedCommand(command, provider.commandShell)
                  : activityCommand(command, activePath, provider.commandShell),
              cwd,
              env: { ...baseEnv, ...options.env, ...defaults },
              stdin: options.stdin,
              timeoutMs,
              signal: controller.signal,
              streaming,
              envMode: options.env === undefined ? "sandbox" : undefined,
              activityPath: provider.inlineActivity ? activePath : undefined,
              onChunk: (chunk) => filter.push(chunk),
            });

        completed =
          result.exitCode !== null &&
          result.exitCode >= 0 &&
          result.exitCode < 128 &&
          !result.timedOut &&
          !controller.signal.aborted;
        timedOut ||= result.timedOut;
        filter.flush();
        interleaved.flush();
        count(stdout.total + stderr.total);

        return {
          ok: !timedOut && result.exitCode === 0,
          exitCode: timedOut ? null : result.exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          output: output.text(),
          durationMs: Date.now() - started,
          truncated:
            stdout.truncated ||
            stderr.truncated ||
            output.truncated ||
            filter.truncated ||
            interleaved.truncated,
          timedOut,
          cwd,
          command: redactor.text(command),
        };
      } catch (error) {
        filter.flush();
        interleaved.flush();
        const mapped = redactor.error(error, provider.name, id);
        bus.fail(mapped);
        throw mapped;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);

        // Backup for the guest's own EXIT trap, which a kill can skip. The run's result stands.
        if (!completed && !provider.inlineActivity && !provider.procActivity)
          await Promise.resolve()
            .then(() => provider.files.remove(id, activePath, { recursive: true }))
            .catch(() => {});
        finish();
        bus.end();
      }
    }

    const handle: RunHandle = {
      [Symbol.toStringTag]: "RunHandle",
      // oxlint-disable-next-line unicorn/no-thenable -- RunHandle is a lazy Promise in the public API.
      then(onfulfilled, onrejected) {
        return begin().then(onfulfilled, onrejected);
      },
      catch(onrejected) {
        return begin().catch(onrejected);
      },
      finally(onfinally) {
        return begin().finally(onfinally);
      },
      [Symbol.asyncIterator]() {
        const iterator = bus.stream();
        // Subscribe before synchronous provider chunks can arrive.
        const first = iterator.next();
        // The bus rethrows the failure to the iterator.
        void begin(true).catch(() => {});
        let initial = true;

        return {
          next: () => {
            if (initial) {
              initial = false;

              return first;
            }

            return iterator.next();
          },
          return: () => iterator.return(undefined),
        };
      },
      cwd(path) {
        if (promise) invalid("Run already started");
        options.cwd = path;

        return handle;
      },
      env(env) {
        if (promise) invalid("Run already started");
        options.env = { ...options.env, ...env };

        return handle;
      },
      timeout(timeoutMs) {
        if (promise) invalid("Run already started");
        options.timeoutMs = timeoutMs;

        return handle;
      },
    };

    return handle;
  };
}
