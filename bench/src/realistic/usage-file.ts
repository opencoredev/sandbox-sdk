/**
 * Usage files: the per-sandbox cost a realistic run saves just before deletion, for providers that
 * report usage only while the sandbox exists (Boat) or between stop and delete (Vercel). Once the
 * sandbox is gone the file is the only evidence, so `bun bench realistic billing` reads it back.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  collectProvider,
  decodeVercel,
  vercelMeter,
  vercelMeterSchema,
  type Cost,
  type VercelMeter,
} from "../billing/providers.js";

/** The billing collector's per-sandbox cost, as saved in a usage file. */
const costSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["billed", "metered"]),
    usd: z.number().finite().nonnegative(),
    scope: z.enum(["sandbox-lifetime", "window"]),
    complete: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
    note: z.string(),
  }),
  z.object({ kind: z.literal("unavailable"), confidence: z.literal("none"), note: z.string() }),
]);

export const usageFileSchema = z.object({
  sandboxes: z.array(z.object({ id: z.string(), cost: costSchema })),
  /** Vercel, from 2026-11-16: the raw meter, byte counters included, the cost was priced from. */
  meter: vercelMeterSchema.optional(),
});

export type UsageFile = z.infer<typeof usageFileSchema>;

const noTransfer =
  "saved before the bench kept Vercel's byte counters, so the data transfer Vercel bills is left out and the cost is understated";

/**
 * Each sandbox's cost in a usage file. Vercel's is priced again from the raw meter the file keeps,
 * so the published cost follows the current rates and rounding; a Vercel file without a raw meter
 * predates the byte counters and is never final. Other adapters' costs are taken as saved.
 */
export function savedCosts(adapter: string, file: UsageFile): { id: string; cost: Cost }[] {
  if (adapter !== "vercel") return file.sandboxes;

  const { meter } = file;

  return file.sandboxes.map(({ id, cost }) => {
    if (meter !== undefined) return { id, cost: decodeVercel(meter, id) };

    if (cost.kind === "unavailable") return { id, cost };

    return {
      id,
      cost: { ...cost, complete: false, confidence: "low", note: `${cost.note}; ${noTransfer}` },
    };
  });
}

/**
 * Save one sandbox's usage just before deletion and return the file. Vercel reports usage only
 * between the end of a session and deletion, so its sandbox is stopped and its meter read once:
 * the cost is priced from that same reading (the collector reads the file it was just given), so
 * a second, failing read can never leave a valid meter beside an unavailable cost. If the one read
 * fails, the collector tries a live read and records why the cost is unavailable, as before.
 */
export async function captureUsage(input: {
  readonly adapter: string;
  readonly id: string;
  readonly usageDir: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  const { adapter, id, usageDir, env } = input;
  const file = join(usageDir, `${adapter}-${id}.json`);
  let meter: VercelMeter | null = null;

  await mkdir(usageDir, { recursive: true });

  if (adapter === "vercel") {
    await vercelMeter.stop(id);
    meter = await vercelMeter.read(id).catch(() => null);

    // The collector's saved-meter format; it prices from this file instead of reading again.
    if (meter !== null)
      await writeFile(file, JSON.stringify({ capturedAt: new Date().toISOString(), meter }) + "\n");
  }

  const collected = await collectProvider(
    adapter,
    [
      {
        provider: adapter,
        id,
        scenarios: new Set(["pre-destroy"]),
        startedAt: null,
        finishedAt: null,
        confirmedStopAt: null,
        app: null,
      },
    ],
    env,
    undefined,
    false,
    0,
    meter === null ? {} : { usageDir },
  );

  await writeFile(
    file,
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      ...collected,
      ...(meter && { meter }),
    }) + "\n",
  );

  return file;
}
