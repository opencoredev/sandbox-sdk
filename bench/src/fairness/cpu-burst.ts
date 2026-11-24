/**
 * cpu-burst-10: ten same-machine sandboxes created at once on one account (40 vCPU), then all of
 * them burning 4 workers of the native LCG for 2 minutes together. Agents fan out like this; a
 * provider that packs ten sandboxes onto shared cores shows it here and nowhere else.
 *
 * - Solo baseline: sandbox 1 burns alone for 30 s first, so the slowdown compares like with like
 *   (same account, same minute, same binary).
 * - Cohort: every created sandbox's burn is sent at once. Each is checked as cpu-native's are. The
 *   guaranteed overlap is the time every burn must have shared: an interval of length w inside the
 *   host's [start, end] window always covers [end - w, start + w].
 * - A create the provider refuses (a quota, a vCPU cap) is recorded with its message, and the
 *   cohort runs with what was created, if at least two.
 * - Boot IDs and uptimes of the fresh sandboxes are kept: identical boot IDs mean clones of one
 *   booted image.
 */
import { z } from "zod";
import { median } from "../sustained-cpu.js";
import { CheckStop, type Check, type CheckContext, type CreatedBox } from "./framework.js";
import { burn, workers } from "./cpu-native.js";
import { installNative, type Installed } from "./native.js";
import { firstCommand, parseFirst } from "./security-probe.js";

export interface BurstOptions {
  readonly cohortSize: number;
  readonly soloSeconds: number;
  readonly cohortSeconds: number;
}

export const defaultBurstOptions: BurstOptions = {
  cohortSize: 10,
  soloSeconds: 30,
  cohortSeconds: 120,
};

const boxSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string(),
  createS: z.number(),
  uptimeS: z.number().nullable(),
  bootId: z.string().nullable(),
  opsPerSec: z.number().nullable(),
  hostStartS: z.number().nullable(),
  hostEndS: z.number().nullable(),
  guestS: z.number().nullable(),
  error: z.string().nullable(),
});

export type BurstBox = z.infer<typeof boxSchema>;

export const burstResultSchema = z.object({
  requested: z.number().int().positive(),
  created: z.number().int().nonnegative(),
  /** Distinct create errors and how many creates each refused. */
  createErrors: z.array(z.object({ error: z.string(), count: z.number().int().positive() })),
  soloOps: z.number(),
  medianOps: z.number().nullable(),
  /** Median cohort ops/s over the solo baseline: 1 means no slowdown. */
  relativeToSolo: z.number().nullable(),
  /** Fastest over slowest verified sandbox in the cohort. */
  spread: z.number().nullable(),
  verified: z.number().int().nonnegative(),
  guaranteedOverlapS: z.number().nullable(),
  distinctBootIds: z.number().int().nonnegative(),
  boxes: z.array(boxSchema),
});

export type BurstResult = z.infer<typeof burstResultSchema>;

export function groupErrors(errors: readonly string[]) {
  const counts = new Map<string, number>();

  for (const error of errors) counts.set(error, (counts.get(error) ?? 0) + 1);

  return [...counts].map(([error, count]) => ({ error, count }));
}

/** min(start + w) - max(end - w) over the burns: seconds every burn certainly ran together. */
export function guaranteedOverlap(
  windows: readonly { readonly startS: number; readonly endS: number; readonly guestS: number }[],
): number | null {
  if (windows.length === 0) return null;
  const latestStart = Math.max(...windows.map((w) => w.endS - w.guestS));
  const earliestEnd = Math.min(...windows.map((w) => w.startS + w.guestS));

  return round(earliestEnd - latestStart, 3);
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

interface Prepared {
  readonly created: CreatedBox;
  readonly installed: Installed | null;
  readonly uptimeS: number | null;
  readonly bootId: string | null;
  readonly error: string | null;
}

async function prepare(context: CheckContext, created: CreatedBox): Promise<Prepared> {
  try {
    const first = parseFirst((await context.exec(created.box, firstCommand, 60_000)).stdout);
    const installed = await installNative(context, created.box);

    return { created, installed, ...first, error: null };
  } catch (cause) {
    return {
      created,
      installed: null,
      uptimeS: null,
      bootId: null,
      error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
    };
  }
}

export const cpuBurstCheck = (options: BurstOptions = defaultBurstOptions): Check<BurstResult> => ({
  id: "cpu-burst-10",
  boxes: options.cohortSize,
  minBoxes: 2,
  lifetimeMs: 30 * 60_000,
  resultSchema: burstResultSchema,
  async run(context) {
    const prepared = await Promise.all(context.boxes.map((created) => prepare(context, created)));
    await context.note(
      "prepared",
      prepared.map((p) => ({
        id: p.created.box.id,
        uptimeS: p.uptimeS,
        bootId: p.bootId,
        error: p.error,
      })),
    );
    const ready = prepared.filter((p) => p.installed !== null);
    const soloBox = ready[0];

    if (soloBox === undefined || soloBox.installed === null || ready.length < 2)
      throw new CheckStop(
        `Only ${ready.length} sandboxes could run sbx-native: ${prepared.find((p) => p.error)?.error ?? ""}`,
      );

    const solo = await burn({
      context,
      box: soloBox.created.box,
      installed: soloBox.installed,
      workers,
      seconds: options.soloSeconds,
      label: "solo",
    });

    await context.note("solo", {
      opsPerSec: solo.opsPerSec,
      guestS: solo.guestS,
      hostS: solo.hostS,
    });
    context.say(`solo ${(solo.opsPerSec / 1e6).toFixed(0)}M ops/s; cohort of ${ready.length}`);
    const epochMs = performance.now();

    const burns = await Promise.all(
      ready.map(async (p) => {
        try {
          if (p.installed === null) throw new Error("not installed");

          return {
            prepared: p,
            burned: await burn({
              context,
              box: p.created.box,
              installed: p.installed,
              workers,
              seconds: options.cohortSeconds,
              label: `cohort ${p.created.index + 1}`,
            }),
            error: null,
          };
        } catch (cause) {
          return {
            prepared: p,
            burned: null,
            error: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
          };
        }
      }),
    );

    const byId = new Map(burns.map((b) => [b.prepared.created.box.id, b]));

    const boxes: BurstBox[] = prepared.map((p) => {
      const entry = byId.get(p.created.box.id);
      const burned = entry?.burned ?? null;

      return {
        index: p.created.index,
        id: p.created.box.id,
        createS: round(p.created.createS, 3),
        uptimeS: p.uptimeS,
        bootId: p.bootId,
        opsPerSec: burned?.opsPerSec ?? null,
        hostStartS: burned ? round((burned.hostStartMs - epochMs) / 1000, 3) : null,
        hostEndS: burned ? round((burned.hostEndMs - epochMs) / 1000, 3) : null,
        guestS: burned?.guestS ?? null,
        error: entry?.error ?? p.error,
      };
    });

    const verified = burns.flatMap((b) => (b.burned ? [b.burned] : []));
    const ops = verified.map((b) => b.opsPerSec);
    const mid = median(ops);

    const overlap = guaranteedOverlap(
      verified.map((b) => ({
        startS: (b.hostStartMs - epochMs) / 1000,
        endS: (b.hostEndMs - epochMs) / 1000,
        guestS: b.guestS,
      })),
    );

    const bootIds = new Set(prepared.flatMap((p) => (p.bootId ? [p.bootId] : [])));

    if (verified.length < 2)
      throw new CheckStop(
        `Only ${verified.length} cohort burns verified: ${burns.find((b) => b.error)?.error ?? ""}`,
      );

    return {
      requested: options.cohortSize,
      created: context.boxes.length,
      createErrors: groupErrors(context.createFailures),
      soloOps: solo.opsPerSec,
      medianOps: mid === null ? null : Math.round(mid),
      relativeToSolo: mid === null || solo.opsPerSec <= 0 ? null : round(mid / solo.opsPerSec, 4),
      spread:
        ops.length > 0 && Math.min(...ops) > 0
          ? round(Math.max(...ops) / Math.min(...ops), 4)
          : null,
      verified: verified.length,
      guaranteedOverlapS: overlap,
      distinctBootIds: bootIds.size,
      boxes,
    };
  },
});

export const cpuBurst = cpuBurstCheck();
