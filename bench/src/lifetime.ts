import type { ConfigV2 } from "./v2-config.js";
import { cohortBoundMs, iterationBoundMs } from "./scenarios.js";

// parseV2's default --timeout-ms, for callers that pass no full config.
const defaultStepTimeoutMs = 180_000;

/**
 * Providers whose sandboxes stop at a hard lifetime the factory sets as `timeoutMs`, with that
 * lifetime's maximum. Modal stops a sandbox after 5 minutes unless told otherwise. Maritime's
 * adapter asks for an hour unless told otherwise (`timeLimitSeconds`, at most 24 hours, counted
 * from the create or the last resume). Styne's adapter asks for an hour unless told otherwise;
 * Styne counts the lifetime in running time. Microsandbox's adapter also asks for an hour unless told
 * otherwise (`max_duration_secs`, after which the sandbox stops and keeps billing its disk until the
 * bench deletes it); 24 hours is the bench's own cap.
 */
const lifetimeLimits: ReadonlyMap<string, number> = new Map([
  ["modal", 24 * 3_600_000],
  ["maritime", 24 * 3_600_000],
  ["microsandbox", 24 * 3_600_000],
  ["microsandbox-shared", 24 * 3_600_000],
  ["styne", 24 * 3_600_000],
]);

/**
 * The factory's hard sandbox lifetime: `--lifetime-ms provider=ms` when given, else long enough
 * for one whole iteration, restores included. Longer harnesses, such as the realistic workloads'
 * build and 60-minute held-open test, pass `--lifetime-ms` themselves.
 */
/** The factory option a lifetime becomes: Modal's, Maritime's, Styne's and Microsandbox's `timeoutMs`, or nothing for other providers. */
export interface LifetimeOptions {
  timeoutMs?: number;
}

export function lifetimeOptions(
  name: string,
  config: Partial<
    Pick<
      ConfigV2,
      "lifetime-ms" | "timeout-ms" | "scenarios" | "survival-window-ms" | "survival-heartbeat-ms"
    >
  >,
): LifetimeOptions {
  const limit = lifetimeLimits.get(name);
  const configured = config["lifetime-ms"]?.[name];

  if (limit === undefined) {
    if (configured !== undefined) throw new Error(`${name} has no factory lifetime option`);

    return {};
  }

  const step = config["timeout-ms"] ?? defaultStepTimeoutMs;
  const scenarios = config.scenarios ?? [];

  // A survival member lives through its whole heartbeat window, which can outlast an iteration.
  const survival = scenarios.includes("survival")
    ? cohortBoundMs("survival", step, {
        windowMs: config["survival-window-ms"] ?? 300_000,
        intervalMs: config["survival-heartbeat-ms"] ?? 15_000,
      })
    : 0;

  const timeoutMs =
    configured ?? Math.min(limit, Math.max(iterationBoundMs(step, scenarios), survival));

  if (!(timeoutMs > 0)) throw new Error(`${name} needs a positive lifetime`);

  if (timeoutMs > limit)
    throw new Error(`${name} caps a sandbox's lifetime at ${limit / 3_600_000} hours`);

  // An explicit lifetime too short for a survival member would end it mid-window as a "death".
  if (configured !== undefined && configured < survival)
    throw new Error(
      `--lifetime-ms ${name}=${configured} is shorter than a survival member needs: ${survival} ms for create, fingerprint, the window and cleanup`,
    );

  return { timeoutMs };
}
