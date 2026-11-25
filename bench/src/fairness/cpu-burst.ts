/**
 * cpu-burst-10: ten same-machine sandboxes created at once on one account (40 vCPU), then all of
 * them burning 4 workers of the native LCG for 2 minutes together. Agents fan out like this; a
 * provider that packs ten sandboxes onto shared cores shows it here and nowhere else.
 *
 * - Solo baseline: sandbox 1 burns alone first, for as long as the cohort will (2 minutes), so the
 *   slowdown compares like with like (same account, same minute, same binary, same length).
 * - Cohort: every created sandbox's burn is sent at once and checked as cpu-native's are. Sandbox 1
 *   burns with them, so the load is all ten, but its cohort figure is left out of the median and
 *   the spread: it has already spent 2 minutes of any burst credit, the others none.
 * - Overlap: the seconds every burn provably shared. A burn's duration is at least the shorter of
 *   its guest wall and its host window, and an interval of length w inside the host window
 *   [start, end] always covers [end - w, start + w].
 * - `comparable` needs all ten created, every burn verified and at least 75% of the burn time
 *   provably shared; otherwise the figures are shown with why. A create the provider refuses (a
 *   quota, a vCPU cap) is recorded with its message, and the cohort runs with what was created,
 *   if at least two.
 * - Boot IDs and uptimes of the fresh sandboxes are kept. Identical boot IDs mean one kernel: a
 *   clone of one booted VM, or containers sharing a host kernel.
 */
import { z } from "zod";
import { median } from "../sustained-cpu.js";
import {
  CheckStop,
  errorText,
  type Check,
  type CheckContext,
  type CreatedBox,
} from "./framework.js";
import { burn, workers, type Burned } from "./cpu-native.js";
import { installNative, type Installed } from "./native.js";
import { firstCommand, parseFirst } from "./security-probe.js";

export interface BurstOptions {
  readonly cohortSize: number;
  readonly cohortSeconds: number;
}

export const defaultBurstOptions: BurstOptions = { cohortSize: 10, cohortSeconds: 120 };

/** Share of the burn time every burn must provably share for the cohort to be comparable. */
export const minOverlapShare = 0.75;

const boxSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string(),
  createS: z.number(),
  uptimeS: z.number().nullable(),
  bootId: z.string().nullable(),
  /** The solo baseline's sandbox: it burns in the cohort but is not in its median. */
  solo: z.boolean(),
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
  soloOps: z.number().positive(),
  /** Median of the cohort's verified sandboxes, the solo one left out. */
  medianOps: z.number().positive(),
  /** medianOps over soloOps: 1 means no slowdown. */
  relativeToSolo: z.number().positive(),
  /** Fastest over slowest of the same sandboxes. */
  spread: z.number(),
  verified: z.number().int().nonnegative(),
  guaranteedOverlapS: z.number(),
  comparable: z.boolean(),
  notComparableWhy: z.string().nullable(),
  distinctBootIds: z.number().int().nonnegative(),
  boxes: z.array(boxSchema),
});

export type BurstResult = z.infer<typeof burstResultSchema>;

export function groupErrors(errors: readonly string[]) {
  const counts = new Map<string, number>();

  for (const error of errors) counts.set(error, (counts.get(error) ?? 0) + 1);

  return [...counts].map(([error, count]) => ({ error, count }));
}

export interface BurnWindow {
  readonly startS: number;
  readonly endS: number;
  readonly guestS: number;
}

/** min(start + w) - max(end - w), w = min(guest, host window): seconds every burn surely shared. */
export function guaranteedOverlap(windows: readonly BurnWindow[]): number | null {
  if (windows.length === 0) return null;
  const length = (w: BurnWindow) => Math.min(w.guestS, w.endS - w.startS);
  const latestStart = Math.max(...windows.map((w) => w.endS - length(w)));
  const earliestEnd = Math.min(...windows.map((w) => w.startS + length(w)));

  return round(earliestEnd - latestStart, 3);
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

/** Why a cohort's figures do not compare with a full one, or null when they do. */
export function notComparable(input: {
  readonly requested: number;
  readonly created: number;
  readonly verified: number;
  readonly overlapS: number;
  readonly cohortSeconds: number;
}): string | null {
  const why = [
    input.created < input.requested
      ? `${input.created} of ${input.requested} sandboxes created`
      : null,
    input.verified < input.created ? `${input.verified} of ${input.created} burns verified` : null,
    input.overlapS < input.cohortSeconds * minOverlapShare
      ? `burns provably overlapped ${Math.max(0, round(input.overlapS, 1))} s of ${input.cohortSeconds} s`
      : null,
  ].filter((reason) => reason !== null);

  return why.length === 0 ? null : why.join("; ");
}

interface Prepared {
  readonly created: CreatedBox;
  readonly installed: Installed | null;
  readonly uptimeS: number | null;
  readonly bootId: string | null;
  readonly error: string | null;
}

const message = (cause: unknown) => errorText(cause).slice(0, 300);

async function prepare(context: CheckContext, created: CreatedBox): Promise<Prepared> {
  try {
    const first = parseFirst((await context.exec(created.box, firstCommand, 60_000)).stdout);
    const installed = await installNative(context, created.box);

    return { created, installed, ...first, error: null };
  } catch (cause) {
    return { created, installed: null, uptimeS: null, bootId: null, error: message(cause) };
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

    const ready = prepared.flatMap((p) => (p.installed ? [{ ...p, installed: p.installed }] : []));
    const soloBox = ready[0];

    if (soloBox === undefined || ready.length < 2)
      throw new CheckStop(
        `Only ${ready.length} sandboxes could run sbx-native: ${prepared.find((p) => p.error)?.error ?? ""}`,
      );

    const solo = await burn({
      context,
      box: soloBox.created.box,
      installed: soloBox.installed,
      workers,
      seconds: options.cohortSeconds,
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
          const burned: Burned = await burn({
            context,
            box: p.created.box,
            installed: p.installed,
            workers,
            seconds: options.cohortSeconds,
            label: `cohort ${p.created.index + 1}`,
          });

          return { id: p.created.box.id, burned, error: null };
        } catch (cause) {
          return { id: p.created.box.id, burned: null, error: message(cause) };
        }
      }),
    );

    const byId = new Map(burns.map((b) => [b.id, b]));
    const soloId = soloBox.created.box.id;

    const boxes: BurstBox[] = prepared.map((p) => {
      const entry = byId.get(p.created.box.id);
      const burned = entry?.burned ?? null;

      return {
        index: p.created.index,
        id: p.created.box.id,
        createS: round(p.created.createS, 3),
        uptimeS: p.uptimeS,
        bootId: p.bootId,
        solo: p.created.box.id === soloId,
        opsPerSec: burned?.opsPerSec ?? null,
        hostStartS: burned ? round((burned.hostStartMs - epochMs) / 1000, 3) : null,
        hostEndS: burned ? round((burned.hostEndMs - epochMs) / 1000, 3) : null,
        guestS: burned?.guestS ?? null,
        error: entry?.error ?? p.error,
      };
    });

    const verified = burns.flatMap((b) => (b.burned ? [{ id: b.id, burned: b.burned }] : []));
    const others = verified.filter((b) => b.id !== soloId).map((b) => b.burned.opsPerSec);

    if (others.length === 0)
      throw new CheckStop(
        `No cohort burn besides the solo sandbox verified: ${burns.find((b) => b.error)?.error ?? ""}`,
      );

    const mid = median(others) ?? 0;

    const overlap =
      guaranteedOverlap(
        verified.map(({ burned }) => ({
          startS: (burned.hostStartMs - epochMs) / 1000,
          endS: (burned.hostEndMs - epochMs) / 1000,
          guestS: burned.guestS,
        })),
      ) ?? 0;

    const why = notComparable({
      requested: options.cohortSize,
      created: context.boxes.length,
      verified: verified.length,
      overlapS: overlap,
      cohortSeconds: options.cohortSeconds,
    });

    return {
      requested: options.cohortSize,
      created: context.boxes.length,
      createErrors: groupErrors(context.createFailures),
      soloOps: solo.opsPerSec,
      medianOps: Math.round(mid),
      relativeToSolo: round(mid / solo.opsPerSec, 4),
      spread: Math.min(...others) > 0 ? round(Math.max(...others) / Math.min(...others), 4) : 0,
      verified: verified.length,
      guaranteedOverlapS: overlap,
      comparable: why === null,
      notComparableWhy: why,
      distinctBootIds: new Set(prepared.flatMap((p) => (p.bootId ? [p.bootId] : []))).size,
      boxes,
    };
  },
});

export const cpuBurst = cpuBurstCheck();
