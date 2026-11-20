import { DeadlineError, deadline } from "./timing.js";
import { failureOutcome, type FailureOutcome } from "./failure.js";
import type { LookupEvidence } from "./existence.js";
import type { SurvivalPlan } from "./scenarios.js";

/**
 * The heartbeat: one command that prints the kernel's boot ID. Any reply proves the sandbox runs
 * and answers; a changed boot ID proves the guest rebooted (state lost) between two heartbeats.
 */
export const heartbeatCommand = "cat /proc/sys/kernel/random/boot_id";

/** The heartbeat's reply as a boot ID, or an error: an empty or garbled reply is no answer. */
export function parseBootId(output: string) {
  const bootId = output.trim();

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId))
    throw new Error(`Heartbeat reply is not a boot ID: ${JSON.stringify(bootId.slice(0, 80))}`);

  return bootId.toLowerCase();
}

/**
 * Offsets from the window start at which heartbeats are due: 0, interval, 2 x interval, ..., and
 * always the window's end, so a member survives only if it answered at the end.
 */
export function heartbeatOffsets(plan: SurvivalPlan): number[] {
  const offsets = Array.from(
    { length: Math.floor(plan.windowMs / plan.intervalMs) + 1 },
    (_, i) => i * plan.intervalMs,
  );

  if (offsets.at(-1) !== plan.windowMs) offsets.push(plan.windowMs);

  return offsets;
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
   * A slot that passed unsent and is never replayed late: `busy` while an earlier miss's call or
   * lookup was still running, `deadline` when the member's deadline left no room for the call.
   */
  | { kind: "skipped"; atMs: number; reason: "busy" | "deadline" };

export type DeathReason = "absent" | "dead-state" | "not-found" | "rebooted";

export type SurvivalVerdict =
  | { kind: "survived" }
  /** `evidence` is the heartbeat whose answer or lookup proved the death. */
  | { kind: "died"; atMs: number; reason: DeathReason; evidence: SentHeartbeat }
  /**
   * `missed` counts unanswered slots, skipped ones included. `evidence` is the miss the verdict
   * rests on: the first that was not a rate limit, else the first miss.
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
      evidence: missed.find((h) => h.failure.code !== "quota") ?? first,
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
  const graceMs = Math.min(plan.intervalMs / 4, 250);
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

    if (performance.now() > due + graceMs) {
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

    const atMs = performance.now() - start;
    let heartbeat: SentHeartbeat;

    try {
      const bootId = await deadline(callMs, (signal) =>
        input.track(input.heartbeat(AbortSignal.any([signal, stop]))),
      );

      heartbeat = { kind: "ok", atMs, latencyMs: performance.now() - start - atMs, bootId };
    } catch (error) {
      if (stop.aborted) {
        stopped = true;
        break;
      }

      const latencyMs = performance.now() - start - atMs;
      const lookupMs = Math.min(callMs, endBy - performance.now());

      const lookup =
        lookupMs > 0
          ? await deadline(lookupMs, () => input.track(input.lookup(lookupMs))).catch(() => null)
          : null;

      heartbeat = {
        kind: "missed",
        atMs,
        latencyMs,
        timedOut: error instanceof DeadlineError,
        failure: failureOutcome(error, input.sanitize),
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
      return { kind: h.kind, atMs: Math.round(h.atMs), latencyMs: Math.round(h.latencyMs) };
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
    ok: result.heartbeats.filter((h) => h.kind === "ok").length,
    missed: result.heartbeats.filter((h) => h.kind === "missed").length,
    skipped: result.heartbeats.filter((h) => h.kind === "skipped").length,
    heartbeats: result.heartbeats.map(compact),
  };
}
