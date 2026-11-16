/**
 * Usage files: the per-sandbox cost a realistic run saves just before deletion, for providers that
 * report usage only while the sandbox exists (Boat) or between stop and delete (Vercel). Once the
 * sandbox is gone the file is the only evidence, so `bun bench realistic billing` reads it back.
 */
import { z } from "zod";
import { decodeVercel, vercelMeterSchema, type Cost } from "../billing/providers.js";

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
