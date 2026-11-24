/**
 * cpu-native: the same compiled LCG on every provider (bench/native/sbx-native.c), so CPU numbers
 * no longer depend on which Python each image ships. Three phases in one fresh sandbox:
 *
 * - single core: 3 segments of 10 s with 1 worker;
 * - all cores: 3 segments of 10 s with 4 workers (the size's vCPUs);
 * - sustained: 30 segments of 30 s with 4 workers, 15 minutes, as sustained-cpu.
 *
 * Every segment uses a fresh seed; the host checks every worker's final value with `lcgChecksum`
 * and bounds the guest's clock by its own (`verifySegment`).
 */
import { randomInt } from "node:crypto";
import { z } from "zod";
import { median, verifySegment, windowSegments } from "../sustained-cpu.js";
import { CheckStop, type Box, type Check, type CheckContext } from "./framework.js";
import { installNative, type Installed } from "./native.js";

/** 4 Mi steps: about 4 ms at 1 G steps/s, 25 ms at a 16% baseline. */
export const nativeChunkSteps = 4_194_304;

/** One dependent multiply-add chain cannot reach 8 G steps/s on any CPU at any clock. */
export const maxNativeOpsPerSec = 8e9;

export const workers = 4;

export interface Phase {
  readonly segments: number;
  readonly seconds: number;
  readonly workers: number;
}

export const defaultCpuPlan = {
  single: { segments: 3, seconds: 10, workers: 1 },
  allCore: { segments: 3, seconds: 10, workers },
  sustained: { segments: 30, seconds: 30, workers },
} as const satisfies Record<string, Phase>;

export const burnCommand = (input: {
  readonly path: string;
  readonly seed: number;
  readonly workers: number;
  readonly seconds: number;
}) =>
  `'${input.path}' cpu ${input.seed} ${input.workers} ${Math.round(input.seconds * 1000)} ${nativeChunkSteps}`;

const segmentSchema = z.object({
  segment: z.number().int().positive(),
  /** Host minutes from the phase's start to the segment's end. */
  minute: z.number(),
  opsPerSec: z.number().nonnegative(),
  perWorker: z.array(z.number().nonnegative()),
  guestS: z.number(),
  hostS: z.number(),
});

export type Segment = z.infer<typeof segmentSchema>;

export interface Burned {
  readonly opsPerSec: number;
  readonly perWorker: readonly number[];
  readonly guestS: number;
  readonly hostS: number;
  readonly hostStartMs: number;
  readonly hostEndMs: number;
}

/** Runs one verified burn; throws CheckStop with the reason when the output does not check out. */
export async function burn(input: {
  readonly context: CheckContext;
  readonly box: Box;
  readonly installed: Installed;
  readonly workers: number;
  readonly seconds: number;
  readonly label: string;
}): Promise<Burned> {
  const seed = randomInt(0, 0x1_0000_0000);
  const hostStartMs = performance.now();

  const result = await input.context.exec(
    input.box,
    burnCommand({
      path: input.installed.path,
      seed,
      workers: input.workers,
      seconds: input.seconds,
    }),
    Math.max(120_000, input.seconds * 4 * 1000),
  );

  const hostEndMs = performance.now();
  const hostS = (hostEndMs - hostStartMs) / 1000;

  if (result.timedOut) throw new CheckStop(`${input.label} timed out`);

  if (!result.ok)
    throw new CheckStop(`${input.label} exited ${result.exitCode}: ${result.stderr.slice(-300)}`);

  const check = verifySegment({
    stdout: result.stdout,
    seed,
    workers: input.workers,
    targetSeconds: input.seconds,
    chunkSteps: nativeChunkSteps,
    hostExecS: hostS,
    maxRate: maxNativeOpsPerSec,
  });

  if (check.kind === "invalid") throw new CheckStop(`${input.label}: ${check.reason}`);

  // Aggregate rate over the guest's whole wall time (bounded by the host's exec time), not the sum
  // of per-worker rates: a worker scheduled late then lowers the figure instead of hiding.
  return {
    opsPerSec: Math.round(check.output.totalSteps / check.output.wallS),
    perWorker: check.output.workers.map((w) => Math.round(w.steps / w.elapsedS)),
    guestS: round(check.output.wallS, 3),
    hostS: round(hostS, 3),
    hostStartMs,
    hostEndMs,
  };
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

const phaseSchema = z.object({
  workers: z.number().int().positive(),
  seconds: z.number().positive(),
  segments: z.array(segmentSchema),
  medianOps: z.number().nullable(),
});

const sustainedSchema = phaseSchema.extend({
  first3MinOps: z.number().nullable(),
  last3MinOps: z.number().nullable(),
  retention: z.number().nullable(),
  minOverFirst: z.number().nullable(),
});

export const cpuNativeResultSchema = z.object({
  binarySha256Verified: z.boolean().nullable(),
  guestVcpus: z.number().int().positive().nullable(),
  cpuModel: z.string().nullable(),
  single: phaseSchema,
  allCore: phaseSchema,
  /** All-core over 4 x single-core: 1 when four workers each run as fast as one alone. */
  scaling: z.number().nullable(),
  sustained: sustainedSchema,
});

export type CpuNativeResult = z.infer<typeof cpuNativeResultSchema>;

export const fingerprintCommand = [
  `echo "nproc=$(nproc 2>/dev/null)"`,
  `echo "model=$(grep -m1 '^model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2- | sed 's/^ *//')"`,
].join("\n");

export function parseCpuFingerprint(stdout: string) {
  const nproc = Number(/^nproc=(\d+)$/m.exec(stdout)?.[1] ?? Number.NaN);
  const model = /^model=(.*)$/m.exec(stdout)?.[1]?.trim() ?? "";

  return {
    guestVcpus: Number.isInteger(nproc) && nproc > 0 ? nproc : null,
    cpuModel: model === "" ? null : model,
  };
}

async function runPhase(
  context: CheckContext,
  box: Box,
  installed: Installed,
  name: string,
  phase: Phase,
): Promise<Segment[]> {
  const segments: Segment[] = [];
  const startMs = performance.now();

  for (let segment = 1; segment <= phase.segments; segment++) {
    if (context.signal.aborted) throw new CheckStop("Interrupted");

    const burned = await burn({
      context,
      box,
      installed,
      workers: phase.workers,
      seconds: phase.seconds,
      label: `${name} segment ${segment}`,
    });

    const entry: Segment = {
      segment,
      minute: round((burned.hostEndMs - startMs) / 60_000, 3),
      opsPerSec: burned.opsPerSec,
      perWorker: [...burned.perWorker],
      guestS: burned.guestS,
      hostS: burned.hostS,
    };

    segments.push(entry);
    await context.note(`${name}-segment`, entry);
    context.say(
      `${name} ${segment}/${phase.segments}: ${(entry.opsPerSec / 1e6).toFixed(0)}M ops/s`,
    );
  }

  return segments;
}

/** The sustained phase's first and last 3-minute medians, as sustained-cpu publishes them. */
export function summarizeSustained(segments: readonly Segment[], phase: Phase) {
  const window = windowSegments({
    segmentsTarget: phase.segments,
    segmentDurationS: phase.seconds,
  });

  const ops = segments.map((s) => s.opsPerSec);
  const first = ops.length >= window ? median(ops.slice(0, window)) : null;
  const last = ops.length >= phase.segments ? median(ops.slice(-window)) : null;

  return {
    first3MinOps: first === null ? null : Math.round(first),
    last3MinOps: last === null ? null : Math.round(last),
    retention: first !== null && last !== null && first > 0 ? round(last / first, 4) : null,
    minOverFirst:
      first !== null && first > 0 && ops.length > 0 ? round(Math.min(...ops) / first, 4) : null,
  };
}

const medianOf = (segments: readonly Segment[]) => {
  const value = median(segments.map((s) => s.opsPerSec));

  return value === null ? null : Math.round(value);
};

export interface CpuPlan {
  readonly single: Phase;
  readonly allCore: Phase;
  readonly sustained: Phase;
}

/** The check with a phase plan; tests pass short ones. */
export const cpuNativeCheck = (plan: CpuPlan = defaultCpuPlan): Check<CpuNativeResult> => ({
  id: "cpu-native",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 40 * 60_000,
  resultSchema: cpuNativeResultSchema,
  async run(context) {
    const box = context.boxes[0]?.box;

    if (!box) throw new CheckStop("No sandbox");
    const installed = await installNative(context, box);
    await context.note("installed", installed);
    const probe = await context.exec(box, fingerprintCommand, 60_000);
    const fingerprint = parseCpuFingerprint(probe.stdout);
    await context.note("fingerprint", fingerprint);

    const single = await runPhase(context, box, installed, "single", plan.single);
    const allCore = await runPhase(context, box, installed, "all-core", plan.allCore);
    const sustained = await runPhase(context, box, installed, "sustained", plan.sustained);
    const singleOps = medianOf(single);
    const allOps = medianOf(allCore);

    return {
      binarySha256Verified: installed.shaVerified,
      guestVcpus: fingerprint.guestVcpus,
      cpuModel: fingerprint.cpuModel,
      single: { ...plan.single, segments: single, medianOps: singleOps },
      allCore: { ...plan.allCore, segments: allCore, medianOps: allOps },
      scaling:
        singleOps !== null && allOps !== null && singleOps > 0
          ? round(allOps / (workers * singleOps), 4)
          : null,
      sustained: {
        ...plan.sustained,
        segments: sustained,
        medianOps: medianOf(sustained),
        ...summarizeSustained(sustained, plan.sustained),
      },
    };
  },
});

export const cpuNative = cpuNativeCheck();
