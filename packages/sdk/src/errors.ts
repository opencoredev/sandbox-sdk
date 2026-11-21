import type { InspectOptionsStylized, inspect as nodeInspect } from "node:util";
import { isBoolean, isNumber, isObject, isString } from "./shared/narrow.js";

/**
 * Why a {@link SandboxError} was thrown. A non-zero exit, a command timeout, or an
 * aborted `run` is never an error; those resolve with `ok: false`.
 *
 * - `auth`: credentials are missing or rejected.
 * - `not_found`: the sandbox or handle no longer exists, or the handle was closed.
 * - `quota`: a provider limit or billing stopped the request. Usually retryable.
 * - `unavailable`: the provider is down or unreachable. Usually retryable.
 * - `unsupported`: the provider cannot do what was asked (size, network policy, lifetime).
 * - `timeout`: a provider operation or a readiness check took too long.
 * - `aborted`: your `AbortSignal` fired.
 * - `outcome_unknown`: the request may or may not have happened.
 * - `process_exited`: a background process exited before it was ready.
 * - `port_not_ready`: a preview did not answer with a 2xx before `waitMs` ran out.
 * - `edit_not_found` / `edit_not_unique`: `files.edit` matched zero or several times.
 * - `file_not_found`: the path does not exist.
 * - `invalid_argument`: the input is invalid. Retrying will not help.
 * - `provider`: any other provider or adapter failure.
 */
export type ErrorCode =
  | "auth"
  | "not_found"
  | "quota"
  | "unavailable"
  | "unsupported"
  | "timeout"
  | "aborted"
  | "outcome_unknown"
  | "process_exited"
  | "port_not_ready"
  | "edit_not_found"
  | "edit_not_unique"
  | "file_not_found"
  | "invalid_argument"
  | "provider";

/** Second argument to the {@link SandboxError} constructor. */
export interface ErrorOptions {
  code: ErrorCode;
  /** Provider name. Default: `"unknown"`. */
  provider?: string;
  sandboxId?: string;
  /** Whether the same call can succeed on retry. Default: `false`. */
  retryable?: boolean;
  /** The next step, on its own. Default: a generic step for `code`. */
  hint?: string;
  /** How long the provider asked callers to wait before retrying, from its `Retry-After`. */
  retryAfterMs?: number;
  cause?: unknown;
}

const hints: Record<ErrorCode, string> = {
  auth: "Set the provider's API key environment variable or pass it to the provider factory.",
  not_found: "Create a new sandbox, or pass a key to createSandbox so it recreates one for you.",
  quota: "Wait and retry, destroy unused sandboxes with reapSandboxes, or raise the provider plan.",
  unavailable: "Retry with backoff. Check the provider's status page if it persists.",
  unsupported: "Remove the option or choose a provider that supports it. Check box.capabilities.",
  timeout: "Retry, or raise the relevant timeout option.",
  aborted: "Retry with a fresh AbortSignal if you still need the result.",
  outcome_unknown: "Check the sandbox state before retrying. If in doubt, destroy it.",
  process_exited:
    "Read the exit code and log tail in the message, fix the command, and start it again.",
  port_not_ready:
    "Check that the server listens on 0.0.0.0 and the right port, then read its logs.",
  edit_not_found: "Read the file again and use text that is in it.",
  edit_not_unique: "Add surrounding lines to find so it matches exactly once.",
  file_not_found: "Check the path. Relative paths resolve against /workspace.",
  invalid_argument: "Fix the input. Retrying the same call will not help.",
  provider: "Read the message and cause. Report it if it looks like an SDK bug.",
};

/**
 * The only error type the SDK throws. Branch on `code` and `retryable`; show `hint` to users.
 * Secrets registered with the sandbox are redacted from `message`, `hint`, and `cause`.
 */
export class SandboxError extends Error {
  /** What kind of failure this is. */
  readonly code: ErrorCode;
  /** Whether the same call can succeed if you retry it. */
  readonly retryable: boolean;
  /** The next step, on its own, for logs and UIs. */
  readonly hint: string;
  /** Provider name, or `"unknown"`. */
  readonly provider: string;
  /** The sandbox involved, when there is one. */
  readonly sandboxId?: string;
  /** How long the provider asked callers to wait before retrying, when it said. {@link withRetry} honours it. */
  readonly retryAfterMs?: number;
  constructor(message: string, options: ErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "SandboxError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.hint = options.hint ?? hints[options.code] ?? hints.provider;
    this.provider = options.provider ?? "unknown";
    this.sandboxId = options.sandboxId;
    this.retryAfterMs = options.retryAfterMs;
  }
  static {
    // The published build is minified, so the class itself is named something like `e`. Node prints
    // the constructor name next to `name`, which showed uncaught errors as `e [SandboxError]`.
    Object.defineProperty(this, "name", { value: "SandboxError" });
  }
  /** How Node prints the error (console.log, uncaught): `SandboxError [code]: message`, the stack, then the fields. */
  [Symbol.for("nodejs.util.inspect.custom")](
    _depth: number,
    options: InspectOptionsStylized,
    inspect: typeof nodeInspect,
  ): string {
    const stack = this.stack ?? "";
    const frames = stack.indexOf("\n    at ") >= 0 ? stack.slice(stack.indexOf("\n    at ")) : "";

    const fields =
      this.retryAfterMs === undefined
        ? {
            code: this.code,
            provider: this.provider,
            sandboxId: this.sandboxId,
            retryable: this.retryable,
            hint: this.hint,
            cause: this.cause,
          }
        : {
            code: this.code,
            provider: this.provider,
            sandboxId: this.sandboxId,
            retryable: this.retryable,
            retryAfterMs: this.retryAfterMs,
            hint: this.hint,
            cause: this.cause,
          };

    return `SandboxError [${this.code}]: ${this.message}${frames} ${inspect(fields, options)}`;
  }
}

/** @internal Whether an error says the path or the sandbox does not exist. */
export function isNotFound(
  error: unknown,
): error is SandboxError & { code: "file_not_found" | "not_found" } {
  return (
    error instanceof SandboxError && (error.code === "file_not_found" || error.code === "not_found")
  );
}

const redactedMarker = "[REDACTED]";

/** Errors whose provider details were intentionally withheld before secret recovery completed. */
export const withheldErrors = new WeakSet<SandboxError>();

/** Timeout errors created by `ProcessHandle.wait()`'s own deadline timer. */
export const waitDeadlineErrors = new WeakSet<SandboxError>();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** @internal One segment of a redacted string mapped back to its original `[start, end)` range. */
export interface RedactedSegment {
  readonly text: string;
  readonly redacted: boolean;
  readonly start: number;
  readonly end: number;
}

/** @internal Redacted text together with its source-mapped segments. */
export interface RedactedText {
  readonly text: string;
  readonly segments: RedactedSegment[];
}

/** @internal Redacts registered secrets from text and errors. */
export class Redactor {
  private values = new Set<string>();
  private primaryPattern: RegExp | undefined;
  private markerSubPattern: RegExp | undefined;
  private leftPrefixes: string[] = [];
  private rightSuffixes: string[] = [];
  private aroundPairs: [string, string][] = [];
  private chainLeft: string[] = [];
  private holdLeft: string[] = [];
  private cachedSecrets: string[] = [];
  private cachedMaxLength = 1;
  private compiled = false;
  add(values: Iterable<string>) {
    for (const value of values)
      if (value && !this.values.has(value)) {
        this.values.add(value);
        this.compiled = false;
      }
  }
  private compile() {
    if (this.compiled) return;
    const outside: string[] = [];
    const inside: string[] = [];

    for (const secret of this.values) {
      if (redactedMarker.includes(secret)) inside.push(secret);
      else outside.push(secret);
    }

    outside.sort((a, b) => b.length - a.length);
    this.primaryPattern =
      outside.length > 0 ? new RegExp(outside.map(escapeRegExp).join("|"), "g") : undefined;

    const left = new Set<string>();
    const right = new Set<string>();
    const hold = new Set<string>();
    const around: [string, string][] = [];

    for (const secret of outside) {
      // Include full-marker overlap (overlap === redactedMarker.length) when the secret
      // starts or ends with `[REDACTED]` plus additional text.
      const limit = Math.min(secret.length - 1, redactedMarker.length);

      for (let overlap = 1; overlap <= limit; overlap++) {
        if (redactedMarker.endsWith(secret.slice(0, overlap))) right.add(secret.slice(overlap));

        if (redactedMarker.startsWith(secret.slice(secret.length - overlap))) {
          const prefix = secret.slice(0, secret.length - overlap);
          left.add(prefix);

          for (let len = 1; len <= prefix.length; len++) hold.add(prefix.slice(0, len));
        }
      }

      // Capture secrets containing `[REDACTED]` in the middle (e.g. `X[REDACTED]Y`) so
      // batch expansion stays linear and streaming holds the leading prefix `X`.
      let markerAt = secret.indexOf(redactedMarker);

      while (markerAt !== -1) {
        const before = secret.slice(0, markerAt);
        const after = secret.slice(markerAt + redactedMarker.length);

        if (before) {
          for (let len = 1; len <= before.length; len++) hold.add(before.slice(0, len));
        }

        if (before && after) around.push([before, after]);

        markerAt = secret.indexOf(redactedMarker, markerAt + 1);
      }
    }

    this.leftPrefixes = [...left].sort((a, b) => b.length - a.length);
    this.rightSuffixes = [...right].sort((a, b) => b.length - a.length);
    this.aroundPairs = around;
    this.chainLeft = [...new Set([...left, ...around.map(([before]) => before)])].sort(
      (a, b) => b.length - a.length,
    );
    this.holdLeft = [...hold].sort((a, b) => b.length - a.length);
    this.cachedSecrets = [...this.values].sort((a, b) => b.length - a.length);
    this.cachedMaxLength = Math.max(1, ...this.cachedSecrets.map((item) => item.length));

    if (inside.length > 0) {
      const alternatives = [...new Set([...inside, redactedMarker])].sort(
        (a, b) => b.length - a.length,
      );

      this.markerSubPattern = new RegExp(alternatives.map(escapeRegExp).join("|"), "g");
    } else this.markerSubPattern = undefined;

    this.compiled = true;
  }
  private findPrimarySpans(next: string): [number, number][] {
    if (!this.primaryPattern) return [];

    // Phase 1: locate all existing `[REDACTED]` markers so matched spans absorb overlapped markers.
    const markers: [number, number][] = [];
    let pos = next.indexOf(redactedMarker);

    while (pos !== -1) {
      markers.push([pos, pos + redactedMarker.length]);
      pos = next.indexOf(redactedMarker, pos + redactedMarker.length);
    }

    // Store `[start, end, leftMarker]` per span so leftward merges skip already-absorbed markers in O(1).
    const spans: [number, number, number][] = [];
    this.primaryPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let scanMarker = 0;

    while ((match = this.primaryPattern.exec(next)) !== null) {
      let start = match.index;
      let end = start + match[0].length;

      while (scanMarker < markers.length && (markers[scanMarker]?.[1] ?? 0) <= start) {
        scanMarker++;
      }

      let leftMarker = scanMarker;
      let rightMarker = scanMarker;

      const absorbMarkers = () => {
        let expanded = true;

        while (expanded) {
          expanded = false;

          while (leftMarker > 0 && (markers[leftMarker - 1]?.[1] ?? 0) > start) {
            leftMarker--;
            const marker = markers[leftMarker];

            if (marker) {
              if (marker[0] < start) {
                start = marker[0];
                expanded = true;
              }

              if (marker[1] > end) {
                end = marker[1];
                expanded = true;
              }
            }
          }

          while (rightMarker < markers.length && (markers[rightMarker]?.[0] ?? 0) < end) {
            const marker = markers[rightMarker];
            rightMarker++;

            if (marker) {
              if (marker[0] < start) {
                start = marker[0];
                expanded = true;
              }

              if (marker[1] > end) {
                end = marker[1];
                expanded = true;
              }
            }
          }
        }
      };

      absorbMarkers();

      // Phase 2: greedily expand right/left/around suffixes & prefixes that would form new
      // secret matches against the replacement `[REDACTED]`, then merge overlapping spans.
      let grew = true;

      while (grew) {
        grew = false;

        for (const suffix of this.rightSuffixes) {
          if (end < next.length && next.startsWith(suffix, end)) {
            end += suffix.length;
            absorbMarkers();
            grew = true;
            break;
          }
        }

        for (const prefix of this.leftPrefixes) {
          if (start >= prefix.length && next.startsWith(prefix, start - prefix.length)) {
            start -= prefix.length;
            absorbMarkers();
            grew = true;
            break;
          }
        }

        for (const [before, after] of this.aroundPairs) {
          if (
            start >= before.length &&
            end + after.length <= next.length &&
            next.startsWith(before, start - before.length) &&
            next.startsWith(after, end)
          ) {
            start -= before.length;
            end += after.length;
            absorbMarkers();
            grew = true;
            break;
          }
        }

        while (spans.length > 0) {
          const previous = spans.at(-1);

          if (!previous || start > previous[1]) break;
          spans.pop();
          start = Math.min(start, previous[0]);
          leftMarker = Math.min(leftMarker, previous[2]);
          absorbMarkers();
          grew = true;
        }
      }

      spans.push([start, end, leftMarker]);
      scanMarker = rightMarker;

      if (this.primaryPattern.lastIndex < end) this.primaryPattern.lastIndex = end;
    }

    return spans.map(([start, end]) => [start, end]);
  }
  private findMarkerSubSpans(next: string): [number, number][] {
    if (!this.markerSubPattern) return [];
    const spans: [number, number][] = [];
    this.markerSubPattern.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = this.markerSubPattern.exec(next)) !== null) {
      if (match[0] !== redactedMarker) spans.push([match.index, match.index + match[0].length]);
    }

    return spans;
  }
  /**
   * Replaces every registered secret with `[REDACTED]`. Secrets that are not substrings of
   * `[REDACTED]` run without exempting literal markers, while secrets inside `[REDACTED]` match
   * whole markers verbatim. Passes repeat to a fixed point so neither literal markers nor
   * replacement-created boundaries can retain a secret substring, and redacting twice is a no-op.
   */
  text(value: string): string {
    if (this.values.size === 0) return value;
    this.compile();
    let result = value;

    for (let pass = 0; pass < 512; pass++) {
      let next = result;
      const spans = this.findPrimarySpans(next);

      if (spans.length > 0) {
        let out = "";
        let cursor = 0;

        for (const [start, end] of spans) {
          out += next.slice(cursor, start) + redactedMarker;
          cursor = end;
        }

        next = out + next.slice(cursor);
      }

      if (this.markerSubPattern) next = next.replace(this.markerSubPattern, redactedMarker);

      if (next === result) return result;
      result = next;
    }

    // Secrets that keep re-forming past the pass budget fail closed cleanly.
    return redactedMarker;
  }
  /** Redact `value` and return each output segment mapped back to its original `[start, end)` range. */
  redactSegments(value: string): RedactedText {
    if (this.values.size === 0 || !value) {
      return {
        text: value,
        segments: value ? [{ text: value, redacted: false, start: 0, end: value.length }] : [],
      };
    }

    this.compile();
    let result = value;

    let segments: RedactedSegment[] = [
      { text: value, redacted: false, start: 0, end: value.length },
    ];

    const applySpans = (
      current: string,
      currentSegments: RedactedSegment[],
      spans: readonly [number, number][],
    ): RedactedText => {
      if (spans.length === 0) return { text: current, segments: currentSegments };
      const nextSegments: RedactedSegment[] = [];
      let segIndex = 0;
      let segOffset = 0;

      const emitUnchanged = (from: number, to: number) => {
        if (to <= from) return;

        while (segIndex < currentSegments.length) {
          const seg = currentSegments[segIndex];

          if (!seg) break;
          const segEnd = segOffset + seg.text.length;

          if (segEnd <= from) {
            segOffset = segEnd;
            segIndex++;
            continue;
          }

          if (segOffset >= to) break;
          const sliceStart = Math.max(from, segOffset) - segOffset;
          const sliceEnd = Math.min(to, segEnd) - segOffset;
          const piece = seg.text.slice(sliceStart, sliceEnd);

          if (piece) {
            nextSegments.push(
              seg.redacted
                ? { text: piece, redacted: true, start: seg.start, end: seg.end }
                : {
                    text: piece,
                    redacted: false,
                    start: seg.start + sliceStart,
                    end: seg.start + sliceEnd,
                  },
            );
          }

          if (segEnd <= to) {
            segOffset = segEnd;
            segIndex++;
          } else break;
        }
      };

      const consumeReplaced = (from: number, to: number) => {
        let origStart = value.length;
        let origEnd = 0;

        while (segIndex < currentSegments.length) {
          const seg = currentSegments[segIndex];

          if (!seg) break;
          const segEnd = segOffset + seg.text.length;

          if (segEnd <= from) {
            segOffset = segEnd;
            segIndex++;
            continue;
          }

          if (segOffset >= to) break;
          const sliceStart = Math.max(from, segOffset) - segOffset;
          const sliceEnd = Math.min(to, segEnd) - segOffset;
          const pieceStart = seg.redacted ? seg.start : seg.start + sliceStart;
          const pieceEnd = seg.redacted ? seg.end : seg.start + sliceEnd;

          if (pieceStart < origStart) origStart = pieceStart;

          if (pieceEnd > origEnd) origEnd = pieceEnd;

          if (segEnd <= to) {
            segOffset = segEnd;
            segIndex++;
          } else break;
        }

        nextSegments.push({
          text: redactedMarker,
          redacted: true,
          start: origStart,
          end: origEnd,
        });
      };

      let cursor = 0;
      let out = "";

      for (const [start, end] of spans) {
        emitUnchanged(cursor, start);
        consumeReplaced(start, end);
        out += current.slice(cursor, start) + redactedMarker;
        cursor = end;
      }

      emitUnchanged(cursor, current.length);

      return { text: out + current.slice(cursor), segments: nextSegments };
    };

    for (let pass = 0; pass < 512; pass++) {
      let next = result;
      let nextSegments = segments;
      const primarySpans = this.findPrimarySpans(next);

      if (primarySpans.length > 0) {
        const applied = applySpans(next, nextSegments, primarySpans);
        next = applied.text;
        nextSegments = applied.segments;
      }

      const subSpans = this.findMarkerSubSpans(next);

      if (subSpans.length > 0) {
        const applied = applySpans(next, nextSegments, subSpans);
        next = applied.text;
        nextSegments = applied.segments;
      }

      if (next === result) return { text: result, segments };
      result = next;
      segments = nextSegments;
    }

    return {
      text: redactedMarker,
      segments: [{ text: redactedMarker, redacted: true, start: 0, end: value.length }],
    };
  }
  hasMatch(value: string): boolean {
    if (this.values.size === 0 || !value) return false;
    this.compile();

    if (this.primaryPattern) {
      this.primaryPattern.lastIndex = 0;

      if (this.primaryPattern.test(value)) return true;
    }

    if (this.markerSubPattern) {
      this.markerSubPattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = this.markerSubPattern.exec(value)) !== null) {
        if (match[0] !== redactedMarker) return true;
      }
    }

    return false;
  }
  get secrets(): readonly string[] {
    this.compile();

    return this.cachedSecrets;
  }
  get maxLength(): number {
    this.compile();

    return this.cachedMaxLength;
  }
  get overlapLeft(): readonly string[] {
    this.compile();

    return this.leftPrefixes;
  }
  get streamChainLeft(): readonly string[] {
    this.compile();

    return this.chainLeft;
  }
  get streamHoldLeft(): readonly string[] {
    this.compile();

    return this.holdLeft;
  }
  /** Map any thrown value to a scrubbed SandboxError. */
  error(cause: unknown, provider: string, sandboxId?: string): SandboxError {
    if (cause instanceof SandboxError && withheldErrors.has(cause)) return cause;
    const safeProvider = scrubCredentials(this.text(provider));

    const scrubId = (id: string | undefined) =>
      id === undefined ? undefined : scrubCredentials(this.text(id));

    if (cause instanceof SandboxError) {
      // Adapters build these from native text, so scrub them too. Messages keep their lines and length: log tails live there.
      const mapped = new SandboxError(scrubCredentials(this.text(cause.message)), {
        code: cause.code,
        retryable: cause.retryable,
        retryAfterMs: cause.retryAfterMs,
        hint: scrubCredentials(this.text(cause.hint)),
        provider: safeProvider,
        // Create paths know no ID yet; keep the one an adapter named, such as a box it could not delete.
        sandboxId: scrubId(sandboxId ?? cause.sandboxId),
        // Do not preserve arbitrary native objects: they may contain credentials in fields or cycles.
        // Adapter evidence (see evidenceCause) keeps its fields as the JSON in its message.
        cause:
          cause.cause === undefined
            ? undefined
            : scrubCause(
                cause.cause instanceof Error ? cause.cause.message : String(cause.cause),
                (text) => this.text(text),
              ),
      });

      if (waitDeadlineErrors.has(cause)) waitDeadlineErrors.add(mapped);

      return mapped;
    }

    // A raw failure reached the core, usually an SDK or adapter bug. Its scrubbed text is the only clue, so keep it in both places.
    const message = scrub(
      this.text(
        cause instanceof Error ? cause.message : isString(cause) ? cause : "Non-Error value thrown",
      ),
    );

    return new SandboxError(
      `${message}. Provider request failed. Check the provider settings and retry.`,
      {
        code: "provider",
        hint: hints.provider,
        provider: safeProvider,
        sandboxId: scrubId(sandboxId),
        cause: nativeDetail(cause, (text) => this.text(text)),
      },
    );
  }
}

/** Credential-shaped text in native messages: URLs (which can carry tokens), auth headers, and key=value pairs. */
const credentialPatterns: [RegExp, string][] = [
  [/https?:\/\/[^\s"'<>]+/gi, "[URL REDACTED]"],
  [
    /(\bauthorization["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n;]+)/gi,
    "$1[REDACTED]",
  ],
  [
    /\bBearer\s+(?:\\+"(?:\\.|[^"\\])*\\+"|\\+'(?:\\.|[^'\\])*\\+'|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"',;]+)/gi,
    "Bearer [REDACTED]",
  ],
  [
    /((?:["']?(?:api[-_]?key|access[-_]?token|token|password|secret)["']?)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
    "$1[REDACTED]",
  ],
];

export function scrubCredentials(text: string): string {
  for (const [pattern, replacement] of credentialPatterns)
    text = text.replace(pattern, replacement);

  return text;
}

/** @internal Removes credential-shaped text (URLs, auth headers, key=value secrets, control characters) and bounds the length. */
export function scrub(text: string, max = 1000): string {
  return scrubCredentials(text)
    .replace(/\p{Cc}+/gu, " ")
    .slice(0, max);
}

type EvidenceValue = string | number | boolean | null;

/** Evidence keys that name a credential, as the whole-text credential patterns match them. */
const credentialKey = /(?:api[-_]?key|token|password|secret|authorization)$/i;

/** The fields of a flat JSON object, the form {@link evidenceCause} writes. Undefined for any other text. */
function evidenceFields(text: string): [string, EvidenceValue][] | undefined {
  if (!text.startsWith("{")) return undefined;
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }

  if (!isObject(parsed) || Array.isArray(parsed)) return undefined;
  const fields: [string, EvidenceValue][] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (!(isString(value) || isNumber(value) || isBoolean(value) || value === null))
      return undefined;
    fields.push([key, value]);
  }

  return fields;
}

/**
 * Redacts and scrubs a SandboxError's cause text. Adapter evidence ({@link evidenceCause}) is a flat
 * JSON object, so each decoded string field is redacted, scrubbed and then bounded on its own: a secret
 * JSON-escaped in the text is still found, a credential pattern can't swallow the JSON around it, and
 * the length bound can't cut the JSON or leave part of a secret. Any other text is handled whole.
 */
function scrubCause(text: string, redact: (text: string) => string): string {
  const fields = evidenceFields(text);

  if (fields === undefined) return scrub(redact(text));

  const clean = fields.map(([key, value]): [string, EvidenceValue] => {
    const name = scrub(redact(key)).slice(0, 64);

    // A field named like a credential is one, as the whole-text scrub treats `"token": …`, whatever its type.
    if (credentialKey.test(key) && value !== null) return [name, "[REDACTED]"];

    if (isString(value)) return [name, scrub(redact(value))];

    // A number or boolean that is a registered secret is redacted too; any other keeps its type.
    return [name, value !== null && redact(String(value)) !== String(value) ? "[REDACTED]" : value];
  });

  const fit = (entries: [string, EvidenceValue][], bound: number) =>
    JSON.stringify(
      Object.fromEntries(
        entries.map(([key, value]) => [key, isString(value) ? value.slice(0, bound) : value]),
      ),
    );

  for (const bound of [300, 120, 40]) {
    const json = fit(clean, bound);

    if (json.length <= 1000) return json;
  }

  // Too many fields to fit: drop whole fields from the end until it does, so it stays valid JSON.
  const kept = [...clean];

  while (kept.length > 0 && fit(kept, 40).length > 1000) kept.pop();

  return fit(kept, 40);
}

/**
 * `Name: message` of a native failure, redacted, scrubbed and bounded, with up to two nested causes.
 * Undefined for thrown values that are not Errors, which carry no message to keep.
 */
export function nativeDetail(
  cause: unknown,
  redact: (text: string) => string = (text) => text,
  depth = 0,
): string | undefined {
  if (!(cause instanceof Error)) return undefined;
  const text = scrub(redact(cause.message ? `${cause.name}: ${cause.message}` : cause.name));
  const nested = depth < 2 ? nativeDetail(cause.cause, redact, depth + 1) : undefined;

  return nested === undefined ? text : `${text}; caused by ${nested}`;
}

const meanings: Record<ErrorCode, string> = {
  auth: "the credentials are missing or were rejected",
  not_found: "the sandbox does not exist",
  quota: "a provider limit or billing stopped the request",
  unavailable: "the service is down or unreachable",
  unsupported: "the provider cannot do what was asked",
  timeout: "the operation took too long",
  aborted: "the request was aborted",
  outcome_unknown: "the request may or may not have happened",
  process_exited: "the process exited before it was ready",
  port_not_ready: "the port did not become ready",
  edit_not_found: "the text to replace was not found",
  edit_not_unique: "the text to replace matched more than once",
  file_not_found: "the path does not exist",
  invalid_argument: "the provider rejected the request as invalid",
  provider: "the provider returned an unexpected error",
};

/** What {@link describeNative} keeps: text for the message, and the error's cause. */
export interface NativeDescription {
  detail?: string;
  cause?: string;
}

/**
 * What an adapter keeps from a native failure. Only a failure the adapter did not recognize
 * (`code` is `provider`, unless `known` says otherwise) and that carries no `status` keeps its text:
 * that is an SDK bug or a network error, and the text is the only clue. A recognized error type or a response may carry server text that
 * echoes the request, so it keeps only its name and status. `detail` is the kept text, for the message;
 * `cause` is the detail, or else the name and status.
 */
export function describeNative(
  cause: unknown,
  options: { code: ErrorCode; known?: boolean; status?: string; redact?: (text: string) => string },
): NativeDescription {
  const known = options.known ?? options.code !== "provider";

  const detail =
    !known && options.status === undefined ? nativeDetail(cause, options.redact) : undefined;

  const label = [cause instanceof Error ? cause.name : undefined, options.status]
    .filter((part) => part !== undefined)
    .join(" ");

  return { detail, cause: detail ?? (label || undefined) };
}

/**
 * @internal Bounded machine fields an adapter copies from a native failure, each already checked
 * against an allowlist and the secrets it knows. Never a response's body, headers or URL, and a
 * response's message only as `providerMessage`; `native` is at most the scrubbed text
 * {@link describeNative} keeps.
 */
export interface NativeEvidence {
  operation?: string;
  status?: number;
  providerCode?: string | number;
  requestId?: string;
  source?: string;
  nativeName?: string;
  native?: string;
  /** The provider's name for `providerCode`, such as gRPC `FAILED_PRECONDITION`. */
  providerStatus?: string;
  /** A machine-readable reason the provider attached, such as boxd's `x-boxd-error-reason` trailer. */
  providerReason?: string;
  /**
   * The provider's own text for a failed control-plane call (create, pause, resume, snapshot), redacted,
   * scrubbed and bounded. Never kept for guest file or command calls, whose text can echo user paths.
   */
  providerMessage?: string;
  /** Luxor create: the session this call created, and how far it got. */
  admittedByThisCall?: true;
  stage?: string;
  sandboxId?: string;
  state?: string;
  cleanupCode?: ErrorCode;
}

/**
 * @internal The one form an adapter passes {@link NativeEvidence} to the core in: the `cause` of its
 * SandboxError, an Error whose message is the fields as JSON. {@link Redactor.error} reduces every
 * cause to its message, so the JSON is what reaches users; the fields stay readable on the adapter's
 * own error.
 */
export function evidenceCause(evidence: NativeEvidence): Error & NativeEvidence {
  return Object.assign(new Error(JSON.stringify(evidence)), evidence);
}

/** A redact function for values an adapter knows, such as its API key. Empty values are skipped. */
export function redacting(values: Iterable<string | undefined>): (text: string) => string {
  const redactor = new Redactor();

  for (const value of values) if (value) redactor.add([value]);

  return (text) => redactor.text(text);
}

/** Why an adapter request failed, as a clause, never the code itself: the kept detail, or what `code` means. */
export function reason(code: ErrorCode, detail?: string): string {
  return detail ?? meanings[code];
}

/**
 * @internal The shared HTTP status mapper. Provider hooks refine it (a 404 for a missing file, a stale route).
 * A 504 is a timeout; the HTTP client turns it into `outcome_unknown` for a request that may have had an effect.
 */
export function statusCode(status: number): ErrorCode {
  if (status === 400 || status === 422) return "invalid_argument";

  if (status === 401 || status === 403) return "auth";

  if (status === 402 || status === 429) return "quota";

  if (status === 404 || status === 410) return "not_found";

  if (status === 408 || status === 504) return "timeout";

  if (status === 413) return "unsupported";

  if (status >= 500 && status <= 599) return "unavailable";

  return "provider";
}

/** @internal Throws an `invalid_argument` SandboxError. */
export function invalid(message: string): never {
  throw new SandboxError(`${message}. The request is invalid. Check the supplied options.`, {
    code: "invalid_argument",
  });
}
