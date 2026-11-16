/**
 * Confirmed stops (`stops.jsonl`) in a run's output directory: when a destroy returned after the
 * adapter reported the sandbox stopped (Modal's `onDestroy`). Billing settles a Modal App's charge
 * only after its sandbox's confirmed stop. Destroy rows carry it in their phases; deletions outside
 * a timed row (cleanup, recovery, the realistic harness) journal it here.
 */
import { appendFile, readFile } from "node:fs/promises";
import { z } from "zod";
import { isMissingFile } from "./files.js";
import { destroyTimings } from "./providers.js";

export const stopJournalFile = "stops.jsonl";

const stopSchema = z.object({
  provider: z.string(),
  sandboxId: z.string(),
  /** When destroy returned after Modal reported the stop: an upper bound on the stop. */
  confirmedStopAt: z.iso.datetime(),
  requestMs: z.number().nullable(),
  stoppedMs: z.number(),
});

/** Each sandbox's confirmed stop, keyed `provider/sandboxId`; the latest wins. */
export async function readStops(path: string): Promise<Map<string, string>> {
  const stops = new Map<string, string>();

  for (const line of await lines(path)) {
    const stop = stopSchema.parse(JSON.parse(line));
    stops.set(`${stop.provider}/${stop.sandboxId}`, stop.confirmedStopAt);
  }

  return stops;
}

/**
 * Journal a sandbox's confirmed stop once its destroy has returned, when the adapter reported one
 * (Modal). Called from both the attempt's deletion and the recovery sweep's.
 */
export async function recordStop({
  path,
  provider,
  sandboxId,
  now = Date.now,
}: {
  path: string;
  provider: string;
  sandboxId: string;
  now?: () => number;
}): Promise<void> {
  const timing = destroyTimings.get(`${provider}/${sandboxId}`);
  destroyTimings.delete(`${provider}/${sandboxId}`);

  if (!timing || timing.stoppedMs === null) return;

  const stop: z.infer<typeof stopSchema> = {
    provider,
    sandboxId,
    confirmedStopAt: new Date(now()).toISOString(),
    requestMs: timing.requestMs,
    stoppedMs: timing.stoppedMs,
  };

  await appendFile(path, JSON.stringify(stop) + "\n");
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter((line) => line.trim());
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}
