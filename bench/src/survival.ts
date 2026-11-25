import { z } from "zod";
import { DeadlineError, deadline } from "./timing.js";
import { failureOutcome, failureSignal, type FailureOutcome } from "./failure.js";
import { lookupSchema, type LookupEvidence } from "./existence.js";
import type { SurvivalPlan } from "./scenarios.js";

/**
 * The heartbeat: one command that prints the kernel's boot ID. Any reply proves the sandbox runs
 * and answers; a changed boot ID proves the guest rebooted (state lost) between two heartbeats.
 */
export const heartbeatCommand = "cat /proc/sys/kernel/random/boot_id";

const bootIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The heartbeat's reply as a boot ID, or an error: an empty or garbled reply is no answer. */
export function parseBootId(output: string) {
  const bootId = output.trim();

  if (!bootIdPattern.test(bootId))
    throw new Error(`Heartbeat reply is not a boot ID: ${JSON.stringify(bootId.slice(0, 80))}`);

  return bootId.toLowerCase();
}

/**
 * Offsets from the window start at which heartbeats are due: 0, interval, 2 x interval, ..., and
 * always the window's end, so a member survives only if it answered at the end. `parseV2` only
 * accepts windows that are whole intervals, so every slot is an interval apart; an irregular plan
 * (from older evidence) still gets its end slot, which can follow the one before it too closely.
 */
export function heartbeatOffsets(plan: SurvivalPlan): number[] {
  const offsets = Array.from(
    { length: Math.floor(plan.windowMs / plan.intervalMs) + 1 },
    (_, i) => i * plan.intervalMs,
  );

  if (offsets.at(-1) !== plan.windowMs) offsets.push(plan.windowMs);

  return offsets;
}

/** How late a timer may fire before its heartbeat no longer counts as sent on its slot. */
export function graceMs(plan: SurvivalPlan) {
  return Math.min(plan.intervalMs / 4, 250);
}

/** Native states that mean the sandbox is no longer running, whatever its record still says. */
const deadStates = /^(exited|stopped|dead|error|errored|failed|killed|terminated|deleted)$/i;

/** A heartbeat that was sent: answered, or missed with the exact lookup made after it. */
export type SentHeartbeat =
  | { kind: "ok"; atMs: number; latencyMs: number; bootId: string }
  | {
      kind: "missed";
      atMs: number;
      latencyMs: number;
      /** The heartbeat's own deadline expired, rather than the call failing. */
      timedOut: boolean;
      failure: FailureOutcome;
      /** The exact native lookup made after the miss, when there was time for one. */
      lookup: LookupEvidence | null;
    };

export type Heartbeat =
  | SentHeartbeat
  /**
   * A slot that passed unsent and is never replayed late: `busy` while an earlier call or lookup
   * was still running, `deadline` when the member's deadline left no room for the call, `late`
   * when the host's own timer woke past the slot's grace. Only `busy` counts against the provider.
   */
  | { kind: "skipped"; atMs: number; reason: "busy" | "deadline" | "late" };

export type DeathReason = "absent" | "dead-state" | "not-found" | "rebooted";

export type SurvivalVerdict =
  | { kind: "survived" }
  /** `evidence` is the heartbeat whose answer or lookup proved the death. */
  | { kind: "died"; atMs: number; reason: DeathReason; evidence: SentHeartbeat }
  /**
   * `missed` counts unanswered slots, busy skips included. `evidence` is the miss the verdict
   * rests on, by `missPrecedence`: the first proven provider failure, else the first typed quota
   * refusal, else the first miss.
   */
  | {
      kind: "unresponsive";
      missed: number;
      firstMissAtMs: number;
      recovered: boolean;
      evidence: Extract<SentHeartbeat, { kind: "missed" }>;
    }
  /** No verdict: the run was stopped, or the member's deadline cut the window short. */
  | { kind: "interrupted"; atMs: number; reason: "stopped" | "deadline" };

/**
 * Why a heartbeat proves the sandbox died, or null when it may still be alive. Exact lifecycle
 * evidence wins: a lookup that finds the sandbox present in a live state outweighs an exec error,
 * even `not_found`. The SDK's `not_found` decides only when no lookup answered.
 */
export function deathReason(heartbeat: Heartbeat, firstBootId: string | null): DeathReason | null {
  switch (heartbeat.kind) {
    case "skipped":
      return null;
    case "ok":
      return firstBootId !== null && heartbeat.bootId !== firstBootId ? "rebooted" : null;
    case "missed": {
      const { lookup } = heartbeat;

      if (lookup?.result === "not-found" || lookup?.result === "terminal") return "absent";

      if (lookup?.result === "present")
        return lookup.nativeState && deadStates.test(lookup.nativeState) ? "dead-state" : null;

      return heartbeat.failure.code === "not_found" ? "not-found" : null;
    }

    default: {
      const exhaustive: never = heartbeat;

      return exhaustive;
    }
  }
}

/**
 * What a missed heartbeat's error proves: a provider failure, a typed quota refusal, or neither
 * (see `failureSignal`: an HTTP status decides over the SDK code). A timed-out miss carries no
 * error code, so it is never a quota refusal.
 */
export function missKind(failure: FailureOutcome): "provider" | "quota" | "unknown" {
  return failureSignal(failure);
}

/**
 * Which miss decides an unresponsive verdict, strongest first. A proven death outranks all of
 * them (see `classifyHeartbeats`); then a provider failure, then a typed quota refusal, then an
 * error that proves neither. A member is an account limit only when no miss proved more.
 */
export const missPrecedence = ["provider", "quota", "unknown"] as const;

/**
 * The verdict for one member's window. A death ends the window. Otherwise any missed or skipped
 * slot makes the member unresponsive, recovered or not. Survival needs every slot answered,
 * through the one at the window's end. Anything else (stopped, or out of time) is no verdict.
 */
export function classifyHeartbeats(
  heartbeats: readonly Heartbeat[],
  expected: number,
  stopped = false,
): SurvivalVerdict {
  let firstBootId: string | null = null;

  for (const heartbeat of heartbeats) {
    const reason = deathReason(heartbeat, firstBootId);

    if (reason && heartbeat.kind !== "skipped")
      return { kind: "died", atMs: heartbeat.atMs, reason, evidence: heartbeat };

    if (heartbeat.kind === "ok") firstBootId ??= heartbeat.bootId;
  }

  const missed = heartbeats.flatMap((h) => (h.kind === "missed" ? [h] : []));
  const busy = heartbeats.filter((h) => h.kind === "skipped" && h.reason === "busy");
  const first = missed[0];

  if (first)
    return {
      kind: "unresponsive",
      missed: missed.length + busy.length,
      firstMissAtMs: first.atMs,
      recovered: heartbeats.filter((h) => h.kind !== "skipped").at(-1)?.kind === "ok",
      evidence:
        missPrecedence
          .map((kind) => missed.find((h) => missKind(h.failure) === kind))
          .find((h) => h !== undefined) ?? first,
    };

  if (heartbeats.length === expected && heartbeats.every((h) => h.kind === "ok"))
    return { kind: "survived" };

  return {
    kind: "interrupted",
    atMs: heartbeats.at(-1)?.atMs ?? 0,
    reason: stopped ? "stopped" : "deadline",
  };
}

export interface WindowInput {
  plan: SurvivalPlan;
  /** Runs the heartbeat command and resolves with its trimmed output (the boot ID). */
  heartbeat: (signal: AbortSignal) => Promise<string>;
  /** Exact, read-only native lookup within `timeoutMs`, made only after a missed heartbeat. */
  lookup: (timeoutMs: number) => Promise<LookupEvidence>;
  /** Each heartbeat's own deadline, and each lookup's; capped at the interval. */
  heartbeatTimeoutMs: number;
  /**
   * `performance.now()` by which every heartbeat and lookup must have finished, leaving the
   * member's cleanup reserve intact (see `survivalEndBy`). Nothing starts that could run past it.
   */
  endBy: number;
  /** Ends the window early (the run was interrupted). */
  stop: AbortSignal;
  sanitize: (text: string) => string;
  /** Tracks calls past their deadlines, so cleanup can wait for them to settle. */
  track: <T>(work: Promise<T>) => Promise<T>;
}

/** A heartbeat that had no answer within its deadline: no error code or status, by design. */
function timeoutFailure(callMs: number): FailureOutcome {
  return { kind: "failure", note: `Heartbeat had no reply within ${Math.round(callMs)} ms` };
}

/** Wait `ms`, or less if `signal` fires first. */
function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();

    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };

    const timer = setTimeout(done, Math.ceil(ms));
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Send heartbeats on schedule from now through the window. A slot that passes while an earlier
 * miss is still being handled is recorded as skipped, never sent late, so a slow provider cannot
 * stretch the window: everything finishes by `endBy`. Stops at the first proof of death.
 */
export async function heartbeatWindow(input: WindowInput) {
  const { plan, stop, endBy } = input;
  const offsets = heartbeatOffsets(plan);
  const callMs = Math.min(input.heartbeatTimeoutMs, plan.intervalMs);
  // Timers fire a little late; a slot sent within this grace still counts as on time.
  const grace = graceMs(plan);
  const start = performance.now();
  const heartbeats: Heartbeat[] = [];
  let firstBootId: string | null = null;
  let stopped = false;

  for (const offset of offsets) {
    const due = start + offset;

    if (stop.aborted) {
      stopped = true;
      break;
    }

    if (performance.now() > due + grace) {
      heartbeats.push({ kind: "skipped", atMs: offset, reason: "busy" });
      continue;
    }

    if (Math.max(due, performance.now()) + callMs > endBy) {
      heartbeats.push({ kind: "skipped", atMs: offset, reason: "deadline" });
      continue;
    }

    // Timers can fire a fraction of a millisecond early; never send a heartbeat before it is due.
    while (!stop.aborted && performance.now() < due) await sleep(due - performance.now(), stop);

    if (stop.aborted) {
      stopped = true;
      break;
    }

    // The timer may wake late: check again, so nothing is sent past the deadline or off its slot.
    if (performance.now() + callMs > endBy) {
      heartbeats.push({ kind: "skipped", atMs: offset, reason: "deadline" });
      continue;
    }

    if (performance.now() > due + grace) {
      heartbeats.push({ kind: "skipped", atMs: offset, reason: "late" });
      continue;
    }

    const atMs = performance.now() - start;
    let heartbeat: SentHeartbeat;

    try {
      const bootId = await deadline(callMs, (signal) =>
        input.track(input.heartbeat(AbortSignal.any([signal, stop]))),
      );

      const latencyMs = performance.now() - start - atMs;

      // Judged by when the reply arrived: a deadline timer that fires late changes nothing.
      if (latencyMs > callMs) throw new DeadlineError(`Heartbeat replied after ${callMs} ms`);
      heartbeat = { kind: "ok", atMs, latencyMs, bootId };
    } catch (error) {
      if (stop.aborted) {
        stopped = true;
        break;
      }

      const latencyMs = performance.now() - start - atMs;
      const lookupMs = Math.min(callMs, endBy - performance.now());
      // Anything that arrives after the deadline is a timeout, whatever it says: a late refusal
      // proves nothing about quota, however late the deadline's own timer fired.
      const timedOut = error instanceof DeadlineError || latencyMs > callMs;

      const lookupStart = performance.now();

      // Judged by when the answer arrived, as the heartbeat is: a late answer proves nothing.
      const lookup =
        lookupMs > 0
          ? await deadline(lookupMs, () => input.track(input.lookup(lookupMs)))
              .then((found) => (performance.now() - lookupStart > lookupMs ? null : found))
              .catch(() => null)
          : null;

      heartbeat = {
        kind: "missed",
        atMs,
        latencyMs,
        timedOut,
        failure: timedOut ? timeoutFailure(callMs) : failureOutcome(error, input.sanitize),
        lookup,
      };
    }

    heartbeats.push(heartbeat);

    if (deathReason(heartbeat, firstBootId)) break;

    if (heartbeat.kind === "ok") firstBootId ??= heartbeat.bootId;
  }

  return {
    heartbeats,
    expected: offsets.length,
    /** Each heartbeat's deadline: a reply later than this is a miss. */
    heartbeatTimeoutMs: callMs,
    elapsedMs: performance.now() - start,
    verdict: classifyHeartbeats(heartbeats, offsets.length, stopped),
  };
}

export type WindowResult = Awaited<ReturnType<typeof heartbeatWindow>>;

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** What a deciding heartbeat showed, in words. */
function evidenceNote(h: SentHeartbeat) {
  if (h.kind === "ok") return `boot ID changed to ${h.bootId}`;

  const lookup = h.lookup
    ? `exact lookup ${h.lookup.result}${h.lookup.nativeState ? ` (${h.lookup.nativeState})` : ""}`
    : "no exact lookup";

  return `${lookup}; heartbeat ${h.failure.code ?? "error"}: ${h.failure.note}`;
}

/**
 * The failure a dead or unresponsive member's row records, from the evidence that decided it.
 * A death was proved by lifecycle evidence, so its row carries none of the heartbeat's error
 * codes: an earlier rate-limited heartbeat cannot turn a proven death into an account limit.
 * An unresponsive member's row carries its deciding miss's error, so it is an account limit only
 * when every miss was rate-limited.
 */
export function survivalFailure(result: WindowResult, stage: string): FailureOutcome | null {
  const { verdict } = result;

  switch (verdict.kind) {
    case "died":
      return {
        kind: "failure",
        note: `Died at ${seconds(verdict.atMs)} (${verdict.reason}): ${evidenceNote(verdict.evidence)}`,
        stage,
      };
    case "unresponsive":
      return {
        ...verdict.evidence.failure,
        note: `Unresponsive: ${verdict.missed} of ${result.expected} heartbeats missed, first at ${seconds(verdict.firstMissAtMs)}${verdict.recovered ? ", recovered" : ""}: ${evidenceNote(verdict.evidence)}`,
        stage,
      };
    case "survived":
    case "interrupted":
      return null;
    default: {
      const exhaustive: never = verdict;

      return exhaustive;
    }
  }
}

/** Compact record of one heartbeat for a sample's details: times rounded to milliseconds. */
function compact(h: Heartbeat) {
  switch (h.kind) {
    case "ok":
      return {
        kind: h.kind,
        atMs: Math.round(h.atMs),
        latencyMs: Math.round(h.latencyMs),
        bootId: h.bootId,
      };
    case "skipped":
      return { kind: h.kind, atMs: Math.round(h.atMs), reason: h.reason };
    case "missed":
      return {
        kind: h.kind,
        atMs: Math.round(h.atMs),
        latencyMs: Math.round(h.latencyMs),
        timedOut: h.timedOut,
        note: h.failure.note.slice(0, 300),
        code: h.failure.code,
        httpStatus: h.failure.cause?.httpStatus,
        lookup: h.lookup,
      };
    default: {
      const exhaustive: never = h;

      return exhaustive;
    }
  }
}

/** Heartbeat record for a sample's details, with the verdict and the evidence that decided it. */
export function heartbeatDetails(result: WindowResult) {
  const { verdict } = result;

  return {
    verdict:
      verdict.kind === "died" || verdict.kind === "unresponsive"
        ? { ...verdict, evidence: compact(verdict.evidence) }
        : verdict,
    expected: result.expected,
    heartbeatTimeoutMs: result.heartbeatTimeoutMs,
    ok: result.heartbeats.filter((h) => h.kind === "ok").length,
    missed: result.heartbeats.filter((h) => h.kind === "missed").length,
    skipped: result.heartbeats.filter((h) => h.kind === "skipped").length,
    heartbeats: result.heartbeats.map(compact),
  };
}

const compactSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    atMs: z.number().finite().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    bootId: z.string(),
  }),
  z.object({
    kind: z.literal("skipped"),
    atMs: z.number().finite().nonnegative(),
    reason: z.enum(["busy", "deadline", "late"]),
  }),
  z.object({
    kind: z.literal("missed"),
    atMs: z.number().finite().nonnegative(),
    latencyMs: z.number().finite().nonnegative(),
    timedOut: z.boolean(),
    note: z.string(),
    code: z.string().optional(),
    httpStatus: z.number().int().optional(),
    lookup: lookupSchema.nullable(),
  }),
]);

/** What a window row's details hold for publication to recompute its verdict. */
export const windowEvidenceSchema = z.object({
  plan: z.object({ windowMs: z.number().positive(), intervalMs: z.number().positive() }),
  verdict: z.object({ kind: z.enum(["survived", "died", "unresponsive", "interrupted"]) }),
  heartbeatTimeoutMs: z.number().positive(),
  heartbeats: z.array(compactSchema),
});

export type WindowEvidence = z.infer<typeof windowEvidenceSchema>;

/**
 * A recorded heartbeat as the verdict rules read it. A miss marked timed out, or whose reply came
 * after `heartbeatTimeoutMs`, is a timeout: its recorded code and status are not read.
 */
function expand(h: z.infer<typeof compactSchema>, heartbeatTimeoutMs: number): Heartbeat {
  switch (h.kind) {
    case "ok":
    case "skipped":
      return h;
    case "missed": {
      if (h.timedOut || h.latencyMs > heartbeatTimeoutMs)
        return { ...h, timedOut: true, failure: timeoutFailure(heartbeatTimeoutMs) };
      const failure: FailureOutcome = { kind: "failure", note: h.note };

      if (h.code !== undefined) failure.code = h.code;

      if (h.httpStatus !== undefined) failure.cause = { httpStatus: h.httpStatus };

      return { ...h, failure };
    }

    default: {
      const exhaustive: never = h;

      return exhaustive;
    }
  }
}

/** Why publication refuses a member's window evidence. */
export type InvalidEvidence =
  | "unreadable"
  | "plan-mismatch"
  | "off-slot"
  | "late-reply"
  | "bad-boot-id"
  | "verdict-mismatch";

/** Whose failure a decided window is, in the failure taxonomy's terms. */
export type WindowFailure = "provider-operation" | "provider-account-limit";

export type MemberEvidence =
  | {
      kind: "valid";
      verdict: SurvivalVerdict["kind"];
      /** Null for a survivor or an interrupted window. */
      failure: WindowFailure | null;
    }
  | { kind: "invalid"; reason: InvalidEvidence };

/**
 * A member's verdict and failure class, recomputed from its raw heartbeat records alone; the
 * row's stored outcome and failure class are never read. The window must have run the cohort's
 * plan, every heartbeat must sit on its slot, every answer must be a boot ID received within the
 * heartbeat deadline, and the verdict the row recorded must be the one the heartbeats give.
 * Anything else is invalid evidence, left out of publication; so are details that do not parse
 * as `windowEvidenceSchema` (`unreadable`), which the caller checks.
 */
export function memberEvidence(
  evidence: WindowEvidence,
  cohortPlan: SurvivalPlan | null,
): MemberEvidence {
  const { plan, heartbeats, heartbeatTimeoutMs, verdict: recorded } = evidence;

  if (heartbeatTimeoutMs > plan.intervalMs) return { kind: "invalid", reason: "unreadable" };

  if (
    !cohortPlan ||
    plan.windowMs !== cohortPlan.windowMs ||
    plan.intervalMs !== cohortPlan.intervalMs
  )
    return { kind: "invalid", reason: "plan-mismatch" };
  const offsets = heartbeatOffsets(plan);

  if (heartbeats.length > offsets.length) return { kind: "invalid", reason: "off-slot" };

  for (const [index, h] of heartbeats.entries()) {
    const offset = offsets[index] ?? Infinity;

    // Recorded times are rounded to the millisecond.
    if (h.atMs < offset - 1 || (h.kind !== "skipped" && h.atMs > offset + graceMs(plan) + 1))
      return { kind: "invalid", reason: "off-slot" };

    if (h.kind !== "ok") continue;

    if (!bootIdPattern.test(h.bootId)) return { kind: "invalid", reason: "bad-boot-id" };

    if (h.latencyMs > heartbeatTimeoutMs) return { kind: "invalid", reason: "late-reply" };
  }

  const verdict = classifyHeartbeats(
    heartbeats.map((h) => expand(h, heartbeatTimeoutMs)),
    offsets.length,
  );

  if (verdict.kind !== recorded.kind) return { kind: "invalid", reason: "verdict-mismatch" };

  switch (verdict.kind) {
    case "survived":
    case "interrupted":
      return { kind: "valid", verdict: verdict.kind, failure: null };
    case "died":
      return { kind: "valid", verdict: verdict.kind, failure: "provider-operation" };
    case "unresponsive":
      return {
        kind: "valid",
        verdict: verdict.kind,
        failure:
          missKind(verdict.evidence.failure) === "quota"
            ? "provider-account-limit"
            : "provider-operation",
      };
    default: {
      const exhaustive: never = verdict;

      return exhaustive;
    }
  }
}
