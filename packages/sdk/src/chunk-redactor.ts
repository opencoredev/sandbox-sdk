import type { OutputChunk } from "./provider.js";
import type { Redactor } from "./errors.js";

interface RedactSpan {
  readonly redacted: boolean;
  readonly start: number;
  readonly end: number;
}

interface RedactSegment extends RedactSpan {
  readonly text: string;
}

const MAX_HOLD_BYTES = 1_048_576;

/**
 * Hold suffixes so secrets split between transport chunks never escape.
 *
 * Core invariants:
 * 1. Raw-first holdback: ambiguous trailing prefixes (secrets, marker fragments, nested/cross-secret
 *    overlaps, and right-of-marker suffixes) remain raw in the queue until resolved or flushed, so
 *    streamed output matches batch `Redactor.text()` across arbitrary chunk splits.
 * 2. Linear stall tracking: when a stream stalls with `safe === 0` and no match, `stallKmp` advances
 *    KMP states only across newly arrived bytes (`O(|secrets| * |delta|)`), avoiding suffix rescans.
 * 3. Bounded memory: if a held suffix or cross-stream backlog exceeds `MAX_HOLD_BYTES` (1 MiB),
 *    the held prefix fails closed to `[REDACTED]` and sets `truncated = true`, then normal streaming resumes.
 * 4. Stream attribution: non-interleaved mode isolates `stdout`/`stderr` while preserving arrival order;
 *    interleaved mode attributes emitted ranges back to their originating stream chunks.
 */
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
  const endTail: Record<OutputChunk["stream"], string> = { stdout: "", stderr: "" };
  let endTailAll = "";
  const chainTail: Record<OutputChunk["stream"], string> = { stdout: "", stderr: "" };
  let chainTailAll = "";

  interface StallKmp {
    readonly secrets: readonly string[];
    readonly matched: Int32Array;
    readonly stream: OutputChunk["stream"] | "*";
  }

  let stallKmp: StallKmp | undefined;
  let stallDelta: string[] = [];
  const emittedTail: Record<OutputChunk["stream"], string> = { stdout: "", stderr: "" };
  let markerAdjSecret: boolean | undefined;
  let markerAdjSecretsLen = -1;

  function chainKeep(): number {
    let maxLeft = 0;

    for (const p of redactor.streamChainLeft) if (p.length > maxLeft) maxLeft = p.length;

    if (maxLeft === 0) return 0;

    return Math.min(4096, maxLeft + marker.length * 2 + 2);
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
    endTail.stdout = "";
    endTail.stderr = "";
    endTailAll = "";
    chainTail.stdout = "";
    chainTail.stderr = "";
    chainTailAll = "";
    const endCap = marker.length - 1;
    const cKeep = chainKeep();

    for (const entry of queue) {
      const text = materialize(entry);
      streamLen[entry.stream] += text.length;
      streamBytes[entry.stream] += entry.bytes;
      totalLen += text.length;
      endTail[entry.stream] = (endTail[entry.stream] + text).slice(-endCap);
      endTailAll = (endTailAll + text).slice(-endCap);

      if (cKeep > 0) {
        chainTail[entry.stream] = (chainTail[entry.stream] + text).slice(-cKeep);
        chainTailAll = (chainTailAll + text).slice(-cKeep);
      }
    }
  }

  const kmpTables = new Map<string, Int32Array>();

  function kmpTable(secret: string): Int32Array {
    let table = kmpTables.get(secret);

    if (table) return table;

    table = new Int32Array(secret.length);
    let matched = 0;

    for (let index = 1; index < secret.length; index++) {
      while (matched > 0 && secret.charCodeAt(index) !== secret.charCodeAt(matched)) {
        matched = table[matched - 1] ?? 0;
      }

      if (secret.charCodeAt(index) === secret.charCodeAt(matched)) matched++;
      table[index] = matched;
    }

    kmpTables.set(secret, table);

    return table;
  }

  /** Earliest index >= `searchFrom` whose suffix up to `endLimit` is a prefix of any secret, in O(L) time. */
  function earliestSecretPrefix(
    text: string,
    searchFrom: number,
    secrets: readonly string[],
    strictProper: boolean,
    endLimit = text.length,
  ): number {
    if (searchFrom >= endLimit) return -1;

    let bestLen = 0;

    for (const secret of secrets) {
      const maxMatch = strictProper ? secret.length - 1 : secret.length;

      if (maxMatch <= bestLen) continue;

      const start = Math.max(searchFrom, endLimit - maxMatch);

      if (endLimit - start <= bestLen) continue;

      const firstAt = text.indexOf(secret.charAt(0), start);

      if (firstAt === -1 || firstAt >= endLimit || endLimit - firstAt <= bestLen) continue;

      const table = kmpTable(secret);
      let matched = 0;

      for (let index = firstAt; index < endLimit; index++) {
        const code = text.charCodeAt(index);

        while (matched > 0 && (matched === maxMatch || secret.charCodeAt(matched) !== code)) {
          matched = table[matched - 1] ?? 0;
        }

        if (matched < maxMatch && secret.charCodeAt(matched) === code) matched++;
      }

      if (matched > bestLen) bestLen = matched;
    }

    return bestLen > 0 ? endLimit - bestLen : -1;
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
    stallKmp = undefined;
    stallDelta = [];
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

    if (safe <= 0 || fullLeft.length === 0) return safe;

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

    if (safe > 0) {
      const partialHit = earliestSecretPrefix(text, 0, fullLeft, true, safe);

      if (partialHit >= 0 && partialHit < safe) safe = snapBeforeMarker(text, partialHit);
    }

    return snapBeforeMarker(text, safe);
  }

  /** Earliest raw cutoff where a trailing suffix is a strict prefix of a secret not already
   * covered by an earlier complete match in `segments`. Keeps nested/longer secrets raw until
   * future chunks resolve them so an inner shorter secret cannot redact first and expose the
   * outer secret's prefix. */
  function rawHoldCutoff(text: string, segments: readonly RedactSpan[]): number {
    const secrets = redactor.secrets;
    let earliest = text.length;

    // If a trailing contiguous run of redacted matches ends right at `text.length` and
    // any segment in that run (or the text immediately preceding it) ends with a
    // marker-chaining left prefix (for example `Y[REDACTED]Y` followed by `[REDACTED]bab`
    // when `Y[REDACTED]Y` is an around-marker secret), keep the entire run raw so a future
    // chunk (such as `Y`) can merge across the shared boundary character.
    const lastSeg = segments.at(-1);

    if (lastSeg?.redacted && lastSeg.end === text.length && redactor.streamChainLeft.length > 0) {
      let chainIdx = segments.length - 1;
      let chainStart = lastSeg.start;
      let matchesChainLeft = redactor.streamChainLeft.some((prefix) => text.endsWith(prefix));

      while (chainIdx > 0) {
        const prev = segments[chainIdx - 1];

        if (!prev?.redacted || prev.end !== chainStart) break;

        if (
          !matchesChainLeft &&
          redactor.streamChainLeft.some((prefix) => text.slice(0, prev.end).endsWith(prefix))
        ) {
          matchesChainLeft = true;
        }

        chainStart = prev.start;
        chainIdx -= 1;
      }

      if (
        !matchesChainLeft &&
        chainStart > 0 &&
        redactor.streamChainLeft.some((prefix) => text.slice(0, chainStart).endsWith(prefix))
      ) {
        matchesChainLeft = true;
      }

      if (matchesChainLeft) {
        let chainCutoff = pullLeftForMarker(text, chainStart);

        while (chainCutoff > 0) {
          const split = segments.find(
            (seg) => seg.redacted && seg.start < chainCutoff && seg.end > chainCutoff,
          );

          if (!split) break;
          chainCutoff = pullLeftForMarker(text, split.start);
        }

        if (chainCutoff < earliest) earliest = chainCutoff;
      }
    }

    // If any redacted segment is followed by a raw tail that is a strict prefix of a
    // right-of-marker suffix (for example `b` + `[REDACTED]ba` on `bb`), hold from that
    // segment raw so later chunks can complete the marker-expanded secret identically to batch.
    const rightSuffixes = redactor.streamRightSuffixes;

    if (rightSuffixes.length > 0) {
      const maxRight = rightSuffixes[0]?.length ?? 0;

      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];

        if (!seg) continue;

        const tailLen = text.length - seg.end;

        if (tailLen >= maxRight) break;

        if (!seg.redacted || tailLen === 0) continue;

        const tail = text.slice(seg.end);

        if (rightSuffixes.some((suffix) => suffix.length > tailLen && suffix.startsWith(tail))) {
          let rightCutoff = pullLeftForMarker(text, seg.start);

          while (rightCutoff > 0) {
            const split = segments.find(
              (item) => item.redacted && item.start < rightCutoff && item.end > rightCutoff,
            );

            if (!split) break;
            rightCutoff = pullLeftForMarker(text, split.start);
          }

          if (rightCutoff < earliest) earliest = rightCutoff;
        }
      }
    }

    let searchFrom = Math.max(0, text.length - (redactor.maxLength - 1));

    while (searchFrom < text.length) {
      const hit = earliestSecretPrefix(text, searchFrom, secrets, true);

      if (hit < 0) return earliest;

      const covering = segments.find((seg) => seg.redacted && seg.start < hit && seg.end > hit);

      if (covering) {
        const coveringText = text.slice(covering.start, covering.end);

        const otherSecrets =
          secrets.length > 1 ? secrets.filter((secret) => secret !== coveringText) : [];

        const crossHit =
          otherSecrets.length > 0
            ? earliestSecretPrefix(text, covering.start + 1, otherSecrets, true)
            : -1;

        if (crossHit < 0 || crossHit >= covering.end) {
          searchFrom = covering.end;
          continue;
        }
      }

      let cutoff = pullLeftForMarker(text, covering ? covering.start : hit);

      while (cutoff > 0) {
        const split = segments.find(
          (seg) => seg.redacted && seg.start < cutoff && seg.end > cutoff,
        );

        if (!split) break;
        cutoff = pullLeftForMarker(text, split.start);
      }

      return Math.min(earliest, cutoff);
    }

    return earliest;
  }

  function safePrefixLength(text: string, useHoldZero: boolean, offset = 0) {
    const secrets = redactor.secrets;
    const windowStart = Math.max(0, text.length - (redactor.maxLength - 1));
    const hit = earliestSecretPrefix(text, windowStart, secrets, false);
    let safe = hit < 0 ? text.length : hit;

    if (safe === text.length) return { safe: offset + text.length, pulledFrom: -1 };

    safe = snapBeforeMarker(text, safe);
    const initialSafe = safe;

    // Hold trailing characters that could extend left from a future marker, while keeping
    // any marker whole so neither half leaks an inside-marker secret. Chain only on full
    // left/around prefixes (`streamChainLeft`) and pull a strict partial prefix at most once.
    const fullLeft = redactor.streamChainLeft;
    let usedPartial = false;

    if (initialSafe > 0 && fullLeft.length > 0) {
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

      if (safe > 0) {
        if (useHoldZero && holdZeroAt.has(offset + safe)) {
          return { safe: 0, pulledFrom: offset + initialSafe };
        }

        const partialHit = earliestSecretPrefix(text, 0, fullLeft, true, safe);

        if (partialHit >= 0 && partialHit < safe) {
          safe = snapBeforeMarker(text, partialHit);
          usedPartial = true;
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
    segments: readonly RedactSegment[],
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

  /** Compute the redacted output offset corresponding to a raw prefix cutoff `rawLimit`. */
  function outputOffsetForRaw(segments: readonly RedactSegment[], rawLimit: number): number {
    let out = 0;

    for (const seg of segments) {
      if (seg.start >= rawLimit) break;

      if (seg.redacted) {
        if (seg.end > rawLimit) break;
        out += seg.text.length;
      } else {
        out += Math.min(seg.end, rawLimit) - seg.start;
      }
    }

    return out;
  }

  /** Compute the raw prefix length in `head` that corresponds to `safe` emitted characters. */
  function rawOffsetForSafe(segments: readonly RedactSegment[], safe: number): number {
    let remaining = safe;
    let orig = 0;

    for (const seg of segments) {
      if (remaining <= 0) break;

      if (seg.redacted) {
        if (remaining < seg.text.length) break;
        remaining -= seg.text.length;
        orig = seg.end;
      } else {
        const take = Math.min(remaining, seg.text.length);
        remaining -= take;
        orig = seg.start + take;
      }
    }

    return orig;
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
      readonly segments: readonly RedactSegment[];
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
        selBytes <= MAX_HOLD_BYTES &&
        queuedBytes <= MAX_HOLD_BYTES &&
        stallKmp !== undefined &&
        stallKmp.stream === stallKey &&
        stallKmp.secrets === redactor.secrets
      ) {
        const tailEnd = interleaved ? endTailAll : endTail[first.stream];

        if (rawPrefixLength(tailEnd) === tailEnd.length) {
          const delta = stallDelta;
          stallDelta = [];

          if (delta.length === 0) break;

          const { secrets, matched } = stallKmp;
          let hitFull = false;
          let bestLen = 0;

          for (let sIdx = 0; sIdx < secrets.length; sIdx++) {
            const secret = secrets[sIdx];

            if (!secret) continue;
            const table = kmpTable(secret);
            let m = matched[sIdx] ?? 0;

            for (const piece of delta) {
              for (let i = 0; i < piece.length; i++) {
                const code = piece.charCodeAt(i);

                while (m > 0 && secret.charCodeAt(m) !== code) {
                  m = table[m - 1] ?? 0;
                }

                if (secret.charCodeAt(m) === code) {
                  m++;

                  if (m === secret.length) {
                    hitFull = true;
                    break;
                  }
                }
              }

              if (hitFull) break;
            }

            if (hitFull) break;
            matched[sIdx] = m;

            if (m > bestLen) bestLen = m;
          }

          if (!hitFull) {
            const hit = bestLen > 0 ? rawLen - bestLen : rawLen;

            if (hit === 0) {
              cleanLen = rawLen;
              break;
            }

            if (bestLen > 0 && holdZeroAt.has(hit)) {
              cleanLen = rawLen;
              break;
            }

            if (bestLen > 0 && redactor.streamChainLeft.length > 0) {
              const cTail = interleaved ? chainTailAll : chainTail[first.stream];
              const cBase = rawLen - cTail.length;

              if (hit >= cBase && hit < rawLen) {
                const fastSafe = safePrefixLength(cTail, true, cBase);

                if (fastSafe.safe === 0) {
                  cleanLen = rawLen;

                  if (fastSafe.pulledFrom >= 0) holdZeroAt.add(fastSafe.pulledFrom);
                  break;
                }
              }
            }
          }

          stallKmp = undefined;
        } else {
          stallKmp = undefined;
          stallDelta = [];
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

      const redacted = redactedResult.text;

      const rawCutoff =
        !final && redacted !== head ? rawHoldCutoff(head, redactedResult.segments) : head.length;

      const safeCheck = final
        ? { safe: redacted.length, pulledFrom: -1 }
        : safePrefixLength(redacted, redacted === head && canReuseClean && head.length >= cleanLen);

      let safe = safeCheck.safe;

      if (!final && rawCutoff < head.length) {
        const cap = snapBeforeMarker(
          redacted,
          outputOffsetForRaw(redactedResult.segments, rawCutoff),
        );

        if (cap < safe) safe = cap;
      }

      if (redacted === head) {
        if (safe === 0) {
          if (headIdx > 0 || dirtyStats) {
            compactAndFlushPlans();
            continue;
          }

          if (!final && selectedBytes > MAX_HOLD_BYTES) {
            dropped = true;
            replaceSelected(indices, marker);
            pruneEmpty();
            resetStall();
            syncStats();
            break;
          }

          if (queuedBytes <= MAX_HOLD_BYTES) {
            cleanKey = stallKey;
            cleanLen = head.length;

            if (safeCheck.pulledFrom >= 0) holdZeroAt.add(safeCheck.pulledFrom);

            if (rawSafe === raw.length && head.length > 0) {
              const secrets = redactor.secrets;
              const matched = new Int32Array(secrets.length);

              for (let sIdx = 0; sIdx < secrets.length; sIdx++) {
                const secret = secrets[sIdx];

                if (!secret) continue;
                const table = kmpTable(secret);
                const start = Math.max(0, head.length - (secret.length - 1));
                let m = 0;

                for (let i = start; i < head.length; i++) {
                  const code = head.charCodeAt(i);

                  while (m > 0 && secret.charCodeAt(m) !== code) {
                    m = table[m - 1] ?? 0;
                  }

                  if (secret.charCodeAt(m) === code) m++;
                }

                matched[sIdx] = m;
              }

              stallKmp = { secrets, matched, stream: stallKey };
              stallDelta = [];
            } else {
              stallKmp = undefined;
              stallDelta = [];
            }

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

        if (safe === 0) {
          if (!final && selectedBytes > MAX_HOLD_BYTES) {
            dropped = true;
            replaceSelected(indices, marker);
            pruneEmpty();
            resetStall();
            syncStats();
            break;
          }

          if (!final && queuedBytes > MAX_HOLD_BYTES) {
            dropped = true;
            failClosedEmitted[first.stream] = true;
            emitSafe({ stream: first.stream, text: marker });
            replaceSelected(indices, "");
            pruneEmpty();
            resetStall();
            syncStats();
            continue;
          }

          break;
        }

        emitRedactedSegments(selected, redactedResult.segments, safe, first.stream);
        const consumedRaw = final ? rawSafe : rawOffsetForSafe(redactedResult.segments, safe);
        consumeFrom(indices, consumedRaw);
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
      const endCap = marker.length - 1;
      const cKeep = chainKeep();
      streamLen[chunk.stream] += chunk.text.length;
      streamBytes[chunk.stream] += bytes;
      totalLen += chunk.text.length;
      endTail[chunk.stream] = (endTail[chunk.stream] + chunk.text).slice(-endCap);
      endTailAll = (endTailAll + chunk.text).slice(-endCap);

      if (cKeep > 0) {
        chainTail[chunk.stream] = (chainTail[chunk.stream] + chunk.text).slice(-cKeep);
        chainTailAll = (chainTailAll + chunk.text).slice(-cKeep);
      }

      if (stallKmp && (stallKmp.stream === "*" || stallKmp.stream === chunk.stream)) {
        stallDelta.push(chunk.text);
      }

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
