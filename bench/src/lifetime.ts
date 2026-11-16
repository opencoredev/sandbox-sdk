import type { ConfigV2 } from "./v2-config.js";
import { iterationBoundMs } from "./scenarios.js";

// parseV2's default --timeout-ms, for callers that pass no full config.
const defaultStepTimeoutMs = 180_000;

/**
 * Providers whose sandboxes stop at a hard lifetime the factory sets as `timeoutMs`, with that
 * lifetime's maximum. Modal stops a sandbox after 5 minutes unless told otherwise.
 */
const lifetimeLimits: ReadonlyMap<string, number> = new Map([["modal", 24 * 3_600_000]]);

/**
 * The factory's hard sandbox lifetime: `--lifetime-ms provider=ms` when given, else long enough
 * for one whole iteration, restores included. Longer harnesses, such as the realistic workloads'
 * build and 60-minute held-open test, pass `--lifetime-ms` themselves.
 */
/** The factory option a lifetime becomes: Modal's `timeoutMs`, or nothing for other providers. */
export interface LifetimeOptions {
  timeoutMs?: number;
}

export function lifetimeOptions(
  name: string,
  config: Partial<Pick<ConfigV2, "lifetime-ms" | "timeout-ms">>,
): LifetimeOptions {
  const limit = lifetimeLimits.get(name);
  const configured = config["lifetime-ms"]?.[name];

  if (limit === undefined) {
    if (configured !== undefined) throw new Error(`${name} has no factory lifetime option`);

    return {};
  }

  const timeoutMs =
    configured ?? Math.min(limit, iterationBoundMs(config["timeout-ms"] ?? defaultStepTimeoutMs));

  if (!(timeoutMs > 0)) throw new Error(`${name} needs a positive lifetime`);

  if (timeoutMs > limit)
    throw new Error(`${name} caps a sandbox's lifetime at ${limit / 3_600_000} hours`);

  return { timeoutMs };
}
