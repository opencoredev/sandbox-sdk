/**
 * cpu-native: the same compiled LCG on every provider (bench/native/sbx-native.c), so CPU numbers
 * no longer depend on which Python each image ships. Three phases in one fresh sandbox:
 *
 * - single core: 3 segments of 10 s with 1 worker;
 * - all cores: 3 segments of 10 s with 4 workers (the size's vCPUs);
 * - sustained: 30 segments of 30 s with 4 workers, 15 minutes without a pause: one detached
 *   `cpu-stream` burn whose workers report a checkpoint every 30 s, polled by the host, so no
 *   exec round trip between segments rests the CPU.
 *
 * Every segment uses a fresh seed; the host checks every worker's final value with `lcgChecksum`
 * and bounds the guest's clock by its own (`verifySegment`).
 */
import { randomBytes, randomInt } from "node:crypto";
import { z } from "zod";
import {
  lcgChecksum,
  median,
  verifySegment,
  windowSegments,
  workerSeed,
} from "../sustained-cpu.js";
import { sanitize } from "../v2-runner.js";
import { CheckStop, type Box, type Check, type CheckContext } from "./framework.js";
import { clockToleranceS, installNative, type Installed } from "./native.js";

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
    throw new CheckStop(
      `${input.label} exited ${result.exitCode}: ${sanitize(result.stderr).slice(-300)}`,
    );

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

// ---------------------------------------------------------------------------------------------
// Sustained, continuous

const streamWorkerSchema = z.object({
  seed: z.number().int().nonnegative(),
  steps: z.number().int().nonnegative(),
  checksum: z.number().int().nonnegative(),
});

/** One sample of every worker at one instant, `elapsedS` after the common start. */
const checkpointSchema = z.object({
  mode: z.literal("cpu-stream"),
  segment: z.number().int().positive(),
  elapsedS: z.number().positive(),
  /** How long the parent took to read every worker; the window edges are this uncertain. */
  scanS: z.number().nonnegative(),
  workers: z.array(streamWorkerSchema).min(1),
});

const streamDoneSchema = z.object({
  mode: z.literal("cpu-stream"),
  done: z.literal(true),
  wallS: z.number().positive(),
});

/**
 * One continuous burn. `tag` is fresh for every attempt and names its output and pid files, so
 * concurrent attempts on one machine never read, stop or delete each other's.
 */
export interface StreamAttempt {
  readonly path: string;
  readonly seed: number;
  readonly phase: Phase;
  readonly tag: string;
}

/**
 * The attempt's files, and `mine <proc dir>`: true only for a process whose stdout is this
 * attempt's output file and whose /proc/<pid>/comm is `.sbx-native` (so never the shell running
 * this).
 * Workers inherit the parent's stdout, so it matches the whole burn with or without setsid, and
 * never another attempt's burn or a reused PID.
 */
const streamPrelude = (tag: string) => [
  `out=/tmp/.sbx-cpu-stream-${tag}.out; pid=/tmp/.sbx-cpu-stream-${tag}.pid`,
  'mine() { [ "$1/fd/1" -ef "$out" ] && [ "$(cat "$1/comm" 2>/dev/null)" = .sbx-native ]; }',
];

/** Starts the burn detached, so the exec returns at once and the workers keep running. */
export const streamStartCommand = (attempt: StreamAttempt) => {
  const { phase } = attempt;
  const run = `'${attempt.path}' cpu-stream ${attempt.seed} ${phase.workers} ${Math.round(phase.seconds * 1000)} ${phase.segments} ${nativeChunkSteps}`;

  return [
    ...streamPrelude(attempt.tag),
    'rm -f "$out" "$pid"',
    `if command -v setsid >/dev/null 2>&1; then L=setsid; else L=; fi`,
    `$L nohup ${run} > "$out" 2>/dev/null < /dev/null &`,
    'echo $! > "$pid"',
    'sleep 0.2; cat "$pid"',
  ].join("\n");
};

/** Prints the output so far, then `alive=1` while the attempt's recorded PID is still its burn. */
export const streamPollCommand = (tag: string) =>
  [
    ...streamPrelude(tag),
    'cat "$out" 2>/dev/null',
    'p=$(cat "$pid" 2>/dev/null)',
    'if [ -n "$p" ] && mine "/proc/$p"; then echo "alive=1"; else echo "alive=0"; fi',
  ].join("\n");

/**
 * Kills every process of this attempt's burn (`mine`), then confirms none is left. Workers also
 * exit by themselves once their parent is gone. Prints `stopped=1`, and deletes the attempt's
 * files, only when none of its processes remain.
 */
export const streamStopCommand = (tag: string) =>
  [
    ...streamPrelude(tag),
    'for d in /proc/[0-9]*; do mine "$d" && kill -9 "${d#/proc/}" 2>/dev/null; done',
    "sleep 0.5",
    'left=0; for d in /proc/[0-9]*; do mine "$d" && left=1; done',
    'if [ $left = 0 ]; then rm -f "$out" "$pid"; echo stopped=1; else echo stopped=0; fi',
  ].join("\n");

/** The binary's MAX_SCAN_NS: a checkpoint's workers were all read within this many seconds. */
export const maxScanS = 0.002;

export type CheckpointCheck =
  | { readonly kind: "ok"; readonly segments: readonly Segment[]; readonly done: boolean }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Checks every complete checkpoint line so far. The parent samples all workers at once at
 * T0 + k * segment, so a segment's window is the same for every worker: its rate is the steps all
 * workers added over the parent's elapsed time between samples. Each line needs segments 1, 2, 3
 * ..., at least k segments of time and a full segment since the last, every worker with its seed,
 * whole chunks, steps that never shrink and a final value equal to `lcgChecksum`, a plausible
 * rate, and a time the host could have seen (no later than the host's seconds since the start when
 * the line first appeared, within `clockToleranceS`). A reason never quotes a line, as
 * `parseNativeOutput` does not.
 */
export function verifyCheckpoints(input: {
  readonly stdout: string;
  readonly seed: number;
  readonly phase: Phase;
  /** Host seconds since the burn started, when each segment's line was first seen. */
  readonly firstSeenS: ReadonlyMap<number, number>;
}): CheckpointCheck {
  const { phase } = input;
  const end = input.stdout.lastIndexOf("\n");
  const complete = end < 0 ? "" : input.stdout.slice(0, end + 1);
  const lines = complete.split("\n").filter((line) => line.startsWith("{"));
  const segments: Segment[] = [];
  let previousSteps: readonly number[] = Array.from({ length: phase.workers }, () => 0);
  let previousS = 0;
  let done = false;

  for (const line of lines) {
    let value: unknown;

    try {
      value = JSON.parse(line);
    } catch {
      return { kind: "invalid", reason: `Checkpoint is not JSON (${line.length} characters)` };
    }

    if (streamDoneSchema.safeParse(value).success) {
      done = true;
      continue;
    }

    const parsed = checkpointSchema.safeParse(value);

    if (!parsed.success)
      return {
        kind: "invalid",
        reason: `Checkpoint shape: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
      };
    const point = parsed.data;
    const k = segments.length + 1;

    if (done || point.segment !== k)
      return { kind: "invalid", reason: `Checkpoint ${point.segment} where ${k} belongs` };

    if (point.workers.length !== phase.workers)
      return { kind: "invalid", reason: `Checkpoint ${k} has ${point.workers.length} workers` };

    if (point.scanS > maxScanS)
      return { kind: "invalid", reason: `Checkpoint ${k} took ${point.scanS}s to sample` };

    if (point.elapsedS < k * phase.seconds)
      return {
        kind: "invalid",
        reason: `Checkpoint ${k} at ${point.elapsedS}s, before ${k * phase.seconds}s`,
      };
    const windowS = point.elapsedS - previousS;

    // Deadlines are absolute, so a window is never shorter than a segment by more than the sleep's
    // own jitter; a late sample lengthens its window and shortens the next one at most that much.
    if (windowS < phase.seconds * 0.5)
      return { kind: "invalid", reason: `Checkpoint ${k} covers ${round(windowS, 3)}s` };
    const seen = input.firstSeenS.get(k);

    if (seen !== undefined && point.elapsedS > seen + clockToleranceS)
      return {
        kind: "invalid",
        reason: `Checkpoint ${k} claims ${point.elapsedS}s by host second ${round(seen, 3)}`,
      };
    let added = 0;
    const perWorker: number[] = [];

    for (const [index, worker] of point.workers.entries()) {
      const before = previousSteps[index] ?? 0;
      const label = `Checkpoint ${k} worker ${index}`;

      if (worker.seed !== workerSeed(input.seed, index))
        return { kind: "invalid", reason: `${label} seed ${worker.seed}` };

      if (worker.steps % nativeChunkSteps !== 0)
        return { kind: "invalid", reason: `${label} steps not whole chunks` };

      if (worker.steps < before) return { kind: "invalid", reason: `${label} went backwards` };
      const rate = (worker.steps - before) / windowS;

      if (rate > maxNativeOpsPerSec)
        return { kind: "invalid", reason: `${label} claims ${rate} ops/s` };

      if (worker.checksum !== lcgChecksum(worker.seed, worker.steps))
        return { kind: "invalid", reason: `${label} checksum does not match` };
      added += worker.steps - before;
      perWorker.push(Math.round(rate));
    }

    segments.push({
      segment: k,
      minute: round(point.elapsedS / 60, 3),
      opsPerSec: Math.round(added / windowS),
      perWorker,
      guestS: round(windowS, 3),
      hostS: round(seen ?? 0, 3),
    });
    previousSteps = point.workers.map((w) => w.steps);
    previousS = point.elapsedS;
  }

  return { kind: "ok", segments, done };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The sustained phase as one detached burn, polled every `pollMs`. Throws CheckStop with the
 * reason if the burn stops early or any checkpoint fails its checks; always stops the burn.
 */
async function streamPhase(input: {
  readonly context: CheckContext;
  readonly box: Box;
  readonly installed: Installed;
  readonly phase: Phase;
  readonly pollMs: number;
}): Promise<Segment[]> {
  const { context, box, installed, phase } = input;
  const seed = randomInt(0, 0x1_0000_0000);
  const tag = randomBytes(8).toString("hex");
  const firstSeenS = new Map<number, number>();
  const startMs = performance.now();

  const limitMs = (phase.segments * phase.seconds + 180) * 1000;
  let reported = 0;

  // The start sits inside the try: a launch that worked in the guest but timed out on the host
  // must still be stopped.
  try {
    const started = await context.exec(
      box,
      streamStartCommand({ path: installed.path, seed, phase, tag }),
      60_000,
    );

    if (!started.ok || !/^\d+$/m.test(started.stdout))
      throw new CheckStop(
        `The continuous burn did not start: exit ${started.exitCode} ${sanitize(started.stderr).slice(0, 200)}`,
      );

    for (;;) {
      if (context.signal.aborted) throw new CheckStop("Interrupted");
      await sleep(input.pollMs);
      const polled = await context.exec(box, streamPollCommand(tag), 60_000);
      const nowS = (performance.now() - startMs) / 1000;
      const output = polled.stdout.replace(/^alive=\d\n?/m, "");

      const count = output
        .split("\n")
        .filter((l) => l.startsWith('{"mode":"cpu-stream","segment":')).length;

      for (let k = 1; k <= count; k++) if (!firstSeenS.has(k)) firstSeenS.set(k, nowS);
      const check = verifyCheckpoints({ stdout: output, seed, phase, firstSeenS });

      if (check.kind === "invalid") throw new CheckStop(`Sustained: ${check.reason}`);

      for (const segment of check.segments.slice(reported)) {
        await context.note("sustained-segment", segment);
        context.say(
          `sustained ${segment.segment}/${phase.segments}: ${(segment.opsPerSec / 1e6).toFixed(0)}M ops/s`,
        );
      }

      reported = check.segments.length;

      if (check.segments.length === phase.segments && check.done) return [...check.segments];

      if (/^alive=0$/m.test(polled.stdout) && !check.done) {
        // The burn may have printed its last line and exited between the read and the liveness
        // test: read once more before calling it stopped.
        const last = await context.exec(box, streamPollCommand(tag), 60_000);
        const finalOut = last.stdout.replace(/^alive=\d\n?/m, "");

        const finalCount = finalOut
          .split("\n")
          .filter((l) => l.startsWith('{"mode":"cpu-stream","segment":')).length;

        const lastS = (performance.now() - startMs) / 1000;

        for (let k = 1; k <= finalCount; k++) if (!firstSeenS.has(k)) firstSeenS.set(k, lastS);
        const final = verifyCheckpoints({ stdout: finalOut, seed, phase, firstSeenS });

        if (final.kind === "invalid") throw new CheckStop(`Sustained: ${final.reason}`);

        for (const segment of final.segments.slice(reported))
          await context.note("sustained-segment", segment);

        if (final.segments.length === phase.segments && final.done) return [...final.segments];

        throw new CheckStop(
          `The continuous burn stopped after ${final.segments.length} of ${phase.segments} segments`,
        );
      }

      if (performance.now() - startMs > limitMs)
        throw new CheckStop(
          `The continuous burn passed ${Math.round(limitMs / 1000)}s at ${check.segments.length} segments`,
        );
    }
  } finally {
    const stopped = await context
      .execCleanup(box, streamStopCommand(tag), 60_000)
      .catch(() => null);

    if (stopped === null || !/^stopped=1$/m.test(stopped.stdout))
      await context.note("burn-stop-unconfirmed", {
        stdout: stopped ? sanitize(stopped.stdout).slice(0, 200) : null,
      });
  }
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

/** The check with a phase plan and poll interval; tests pass short ones. */
export const cpuNativeCheck = (
  plan: CpuPlan = defaultCpuPlan,
  pollMs = 30_000,
): Check<CpuNativeResult> => ({
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
    const sustained = await streamPhase({ context, box, installed, phase: plan.sustained, pollMs });
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
