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

/** Offsets from the window start at which heartbeats are due: 0, interval, ..., up to the window. */
export function heartbeatOffsets(plan: SurvivalPlan): number[] {
  return Array.from(
    { length: Math.floor(plan.windowMs / plan.intervalMs) + 1 },
    (_, i) => i * plan.intervalMs,
  );
}

/** Native states that mean the sandbox is no longer running, whatever its record still says. */
const deadStates = /^(exited|stopped|dead|error|errored|failed|killed|terminated|deleted)$/i;

export type Heartbeat =
  | { kind: "ok"; atMs: number; latencyMs: number; bootId: string }
  | {
      kind: "missed";
      atMs: number;
      latencyMs: number;
      /** The heartbeat's own deadline expired, rather than the call failing. */
      timedOut: boolean;
      failure: FailureOutcome;
      /** The exact native lookup made after the miss, when there was one. */
      lookup: LookupEvidence | null;
    };

export type DeathReason = "absent" | "dead-state" | "not-found" | "rebooted";

export type SurvivalVerdict =
  | { kind: "survived" }
  | { kind: "died"; atMs: number; reason: DeathReason }
  | { kind: "unresponsive"; missed: number; firstMissAtMs: number; recovered: boolean }
  /** The run was stopped (SIGINT/SIGTERM) before the window ended; not an observation. */
  | { kind: "interrupted"; atMs: number };

/** Why a heartbeat proves the sandbox died, or null when it may still be alive. */
export function deathReason(heartbeat: Heartbeat, firstBootId: string | null): DeathReason | null {
  if (heartbeat.kind === "ok")
    return firstBootId !== null && heartbeat.bootId !== firstBootId ? "rebooted" : null;

  if (heartbeat.lookup?.result === "not-found" || heartbeat.lookup?.result === "terminal")
    return "absent";

  if (heartbeat.lookup?.nativeState && deadStates.test(heartbeat.lookup.nativeState))
    return "dead-state";

  return heartbeat.failure.code === "not_found" ? "not-found" : null;
}

/**
 * The verdict for one member's window. A death ends the window. Otherwise any missed heartbeat
 * makes the member unresponsive, recovered or not. A run stopped early yields no verdict on a
 * member that had not already died or missed a heartbeat.
 */
export function classifyHeartbeats(
  heartbeats: readonly Heartbeat[],
  expected: number,
): SurvivalVerdict {
  let firstBootId: string | null = null;

  for (const heartbeat of heartbeats) {
    const reason = deathReason(heartbeat, firstBootId);

    if (reason) return { kind: "died", atMs: heartbeat.atMs, reason };

    if (heartbeat.kind === "ok") firstBootId ??= heartbeat.bootId;
  }

  const missed = heartbeats.filter((h) => h.kind === "missed");
  const first = missed[0];

  if (first)
    return {
      kind: "unresponsive",
      missed: missed.length,
      firstMissAtMs: first.atMs,
      recovered: heartbeats.at(-1)?.kind === "ok",
    };

  if (heartbeats.length < expected)
    return { kind: "interrupted", atMs: heartbeats.at(-1)?.atMs ?? 0 };

  return { kind: "survived" };
}

export interface WindowInput {
  plan: SurvivalPlan;
  /** Runs the heartbeat command and resolves with its trimmed output (the boot ID). */
  heartbeat: (signal: AbortSignal) => Promise<string>;
  /** Exact, read-only native lookup, made only after a missed heartbeat. */
  lookup: () => Promise<LookupEvidence>;
  /** Each heartbeat's own deadline; capped at the interval so heartbeats never overlap. */
  heartbeatTimeoutMs: number;
  /** Ends the window early (the run was interrupted). */
  stop: AbortSignal;
  sanitize: (text: string) => string;
  /** Tracks the heartbeat call past its deadline, so cleanup can wait for it to settle. */
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
 * Send heartbeats on schedule from now through the window. A late heartbeat delays only itself:
 * the next is still due at its own offset. Stops at the first proof of death.
 */
export async function heartbeatWindow(input: WindowInput) {
  const { plan, stop } = input;
  const offsets = heartbeatOffsets(plan);
  const timeoutMs = Math.min(input.heartbeatTimeoutMs, plan.intervalMs);
  const start = performance.now();
  const heartbeats: Heartbeat[] = [];
  let firstBootId: string | null = null;

  for (const offset of offsets) {
    // Timers can fire a fraction of a millisecond early; never send a heartbeat before it is due.
    while (!stop.aborted && performance.now() < start + offset)
      await sleep(start + offset - performance.now(), stop);

    if (stop.aborted) break;
    const atMs = performance.now() - start;
    let heartbeat: Heartbeat;

    try {
      const bootId = await deadline(timeoutMs, (signal) =>
        input.track(input.heartbeat(AbortSignal.any([signal, stop]))),
      );

      heartbeat = { kind: "ok", atMs, latencyMs: performance.now() - start - atMs, bootId };
    } catch (error) {
      if (stop.aborted) break;
      const latencyMs = performance.now() - start - atMs;

      heartbeat = {
        kind: "missed",
        atMs,
        latencyMs,
        timedOut: error instanceof DeadlineError,
        failure: failureOutcome(error, input.sanitize),
        lookup: await input.lookup().catch(() => null),
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
    verdict: classifyHeartbeats(heartbeats, offsets.length),
  };
}

export type WindowResult = Awaited<ReturnType<typeof heartbeatWindow>>;

/** The failure a dead or unresponsive member's row records: the first miss's evidence, renamed. */
export function survivalFailure(result: WindowResult, stage: string): FailureOutcome | null {
  const { verdict } = result;

  if (verdict.kind !== "died" && verdict.kind !== "unresponsive") return null;
  const miss = result.heartbeats.find((h) => h.kind === "missed");
  const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

  const note =
    verdict.kind === "died"
      ? `Died at ${seconds(verdict.atMs)} (${verdict.reason})`
      : `Unresponsive: ${verdict.missed} of ${result.expected} heartbeats missed, first at ${seconds(verdict.firstMissAtMs)}${verdict.recovered ? ", recovered" : ""}`;

  if (!miss || miss.kind !== "missed") return { kind: "failure", note, stage };

  return { ...miss.failure, note: `${note}: ${miss.failure.note}`, stage };
}

/** Compact heartbeat record for a sample's details: times rounded to milliseconds. */
export function heartbeatDetails(result: WindowResult) {
  return {
    verdict: result.verdict,
    expected: result.expected,
    ok: result.heartbeats.filter((h) => h.kind === "ok").length,
    missed: result.heartbeats.filter((h) => h.kind === "missed").length,
    heartbeats: result.heartbeats.map((h) =>
      h.kind === "ok"
        ? { kind: h.kind, atMs: Math.round(h.atMs), latencyMs: Math.round(h.latencyMs) }
        : {
            kind: h.kind,
            atMs: Math.round(h.atMs),
            latencyMs: Math.round(h.latencyMs),
            timedOut: h.timedOut,
            note: h.failure.note.slice(0, 300),
            code: h.failure.code,
            lookup: h.lookup,
          },
    ),
  };
}
