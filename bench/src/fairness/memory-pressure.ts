/**
 * memory-pressure: what happens when a process allocates up to the advertised memory and past it.
 *
 * 1. Limits as memory-honesty reads them (MemTotal, the cgroup limit, swap, overcommit), a canary
 *    process that rewrites a heartbeat file every second, the boot id and the cgroup OOM counter.
 * 2. A detached hog allocates 64 MiB at a time of random (incompressible) bytes, up to `overshoot`
 *    times the provider's advertised memory, logging each chunk to a file. The host polls the
 *    sandbox every `pollMs` for its progress and exit code, and records the longest wait for an answer.
 * 3. Afterwards: does the sandbox answer, is the boot id the same, is the canary alive, can a fresh
 *    256 MiB allocation and a file write still succeed.
 *
 * Outcomes are only what the evidence shows. `reached-target`: the hog held every byte it asked for
 * (swap, or no enforcement at the advertised size). `process-killed`: it died by a signal or the
 * cgroup counted a new OOM kill. `refused`: the runtime's allocation failed. `stalled`: still
 * allocating at the deadline (thrashing), then killed. `sandbox-restarted`: a new boot id.
 * `unresponsive`: no answer for `unresponsiveMs` and still listed. `sandbox-lost`: no answer and the provider's
 * exact lookup says it is gone. The scope is `process` when only the hog died, `collateral` when the
 * canary died with it, and `sandbox` when the whole sandbox was lost, rebooted or stopped answering.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { quote } from "../workloads.js";
import { diskTarget } from "./disk-real.js";
import {
  CheckStop,
  errorText,
  machineOf,
  type Box,
  type Check,
  type CheckContext,
} from "./framework.js";
import {
  bootIdCommand,
  detached,
  guestScripts,
  parseRuntime,
  runtimeCommand,
  runtimes,
} from "./guest-scripts.js";
import {
  limitsCommand,
  limitsSchema,
  lookUpLiveness,
  oomCommand,
  oomFileOf,
  parseLimits,
  parseOomKills,
} from "./memory-honesty.js";
import { keyValues } from "./state-survival.js";

export interface PressureOptions {
  /** The hog's target as a multiple of the advertised memory. */
  readonly overshoot: number;
  readonly chunkMiB: number;
  /** Longest the hog may run before it counts as stalled. */
  readonly deadlineMs: number;
  readonly pollMs: number;
  /** No answer for this long ends polling and asks the provider whether the sandbox is gone. */
  readonly unresponsiveMs: number;
  /** After an unresponsive spell, how long to wait for the sandbox to come back. */
  readonly recoveryMs: number;
  readonly healthAllocMiB: number;
  /** The advertised memory; the provider's same-machine size when null. */
  readonly advertisedMiB: number | null;
}

export const defaultPressureOptions: PressureOptions = {
  overshoot: 1.5,
  chunkMiB: 64,
  deadlineMs: 10 * 60_000,
  pollMs: 2_000,
  unresponsiveMs: 120_000,
  recoveryMs: 120_000,
  healthAllocMiB: 256,
  advertisedMiB: null,
};

const pollTimeoutMs = 20_000;

const progressSchema = z.object({ mib: z.number().int(), ms: z.number().int() });

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reached-target") }),
  z.object({
    kind: z.literal("process-killed"),
    exitCode: z.number().int().nullable(),
    oomKills: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
  z.object({ kind: z.literal("stalled") }),
  z.object({ kind: z.literal("sandbox-restarted") }),
  z.object({ kind: z.literal("unresponsive"), detail: z.string() }),
  z.object({ kind: z.literal("sandbox-lost"), detail: z.string() }),
]);

export type PressureOutcome = z.infer<typeof outcomeSchema>;

const healthSchema = z.object({
  answered: z.boolean(),
  /** How long the sandbox took to answer again after an unresponsive spell; null when it never stopped. */
  recoveredAfterMs: z.number().nullable(),
  bootSame: z.boolean().nullable(),
  canaryAlive: z.boolean().nullable(),
  allocOk: z.boolean().nullable(),
  fileOk: z.boolean().nullable(),
});

export const pressureResultSchema = z.object({
  runtime: z.enum(runtimes),
  limits: limitsSchema,
  advertisedMiB: z.number().int(),
  targetMiB: z.number().int(),
  /** The most the hog held before it ended. */
  reachedMiB: z.number().int(),
  reachedFraction: z.number(),
  /** One point per 512 MiB held, for a slowdown chart. */
  progress: z.array(progressSchema),
  outcome: outcomeSchema,
  scope: z.enum(["process", "collateral", "sandbox"]).nullable(),
  /** The sandbox works afterwards: it answers, a fresh allocation and a file write succeed. */
  usableAfter: z.boolean(),
  health: healthSchema,
  maxPollGapMs: z.number().int(),
});

export type PressureResult = z.infer<typeof pressureResultSchema>;

export function parseHogLog(text: string) {
  const progress: { mib: number; ms: number }[] = [];
  let reached = false;
  let refused: string | null = null;

  for (const line of text.split("\n")) {
    const [word, mib, rest] = line.trim().split(/\s+/);
    const value = Number(mib);

    if (!Number.isInteger(value)) continue;

    if (word === "held" || word === "reached") progress.push({ mib: value, ms: Number(rest) || 0 });

    if (word === "reached") reached = true;

    if (word === "refused") refused = rest ?? "unknown";
  }

  const heldMiB = progress.reduce((most, point) => Math.max(most, point.mib), 0);

  return { progress, heldMiB, reached, refused };
}

/** One point per `stepMiB`, plus the last. */
export function thinProgress(progress: readonly { mib: number; ms: number }[], stepMiB = 512) {
  const kept = progress.filter((point) => point.mib % stepMiB === 0);
  const last = progress.at(-1);

  return last && kept.at(-1) !== last ? [...kept, last] : kept;
}

/** Judges the hog from its exit and log, the OOM counter and what the sandbox looked like after. */
export function judgePressure(input: {
  readonly exitCode: number | null;
  readonly log: ReturnType<typeof parseHogLog>;
  readonly oomDelta: number | null;
  readonly stalled: boolean;
  readonly lost: { readonly kind: "absent" | "unresponsive"; readonly detail: string } | null;
  readonly bootSame: boolean | null;
}): PressureOutcome {
  const { exitCode, log, oomDelta, stalled, lost, bootSame } = input;

  if (lost?.kind === "absent") return { kind: "sandbox-lost", detail: lost.detail };

  if (lost?.kind === "unresponsive") return { kind: "unresponsive", detail: lost.detail };

  if (bootSame === false) return { kind: "sandbox-restarted" };

  if (stalled) return { kind: "stalled" };

  if (exitCode === 0 && log.reached) return { kind: "reached-target" };

  if (log.refused !== null || exitCode === 3)
    return { kind: "refused", reason: log.refused ?? "exit 3" };

  if ((exitCode !== null && exitCode > 128) || (oomDelta !== null && oomDelta > 0))
    return { kind: "process-killed", exitCode, oomKills: oomDelta };

  throw new CheckStop(`The hog exited ${exitCode} with no kill evidence (held ${log.heldMiB} MiB)`);
}

export function scopeOf(outcome: PressureOutcome, canaryAlive: boolean | null) {
  switch (outcome.kind) {
    case "sandbox-lost":
    case "sandbox-restarted":
    case "unresponsive":
      return "sandbox" as const;
    case "process-killed":
    case "refused":
      return canaryAlive === false ? ("collateral" as const) : ("process" as const);
    case "reached-target":
    case "stalled":
      return canaryAlive === false ? ("collateral" as const) : null;
    default: {
      const exhaustive: never = outcome;

      return exhaustive;
    }
  }
}

const statusCommand = (dir: string) =>
  [
    `cd ${quote(dir)} || exit 1`,
    `echo "exit=$(cat hog.exit 2>/dev/null)"`,
    `echo "last=$(tail -n 1 hog.log 2>/dev/null)"`,
  ].join("\n");

const healthCommand = (dir: string) =>
  [
    `cd ${quote(dir)} || exit 1`,
    `echo "boot=$(${bootIdCommand})"`,
    `p=$(cat canary.pid 2>/dev/null); if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "canaryStart=$(cut -d' ' -f22 /proc/$p/stat 2>/dev/null)"; else echo canaryStart=; fi`,
  ].join("\n");

/** Polls the sandbox until `check` says done, the deadline passes, or it stops answering. */
async function pollHog(input: {
  readonly context: CheckContext;
  readonly box: Box;
  readonly dir: string;
  readonly options: PressureOptions;
}) {
  const { context, box, dir, options } = input;
  const started = performance.now();
  let lastAnswer = started;
  let maxGapMs = 0;
  let heldMiB = 0;

  for (;;) {
    const askedAt = performance.now();

    try {
      const result = await context.exec(box, statusCommand(dir), pollTimeoutMs);

      if (result.exitCode !== null && !result.timedOut) {
        const answeredAt = performance.now();
        maxGapMs = Math.max(maxGapMs, answeredAt - lastAnswer);
        lastAnswer = answeredAt;
        const values = keyValues(result.stdout);
        const exit = values.get("exit") ?? "";
        heldMiB = Math.max(heldMiB, parseHogLog(values.get("last") ?? "").heldMiB);

        if (/^\d+$/.test(exit))
          return { kind: "exited" as const, exitCode: Number(exit), maxGapMs, heldMiB };
      }
    } catch (cause) {
      context.say(`poll: ${errorText(cause).slice(0, 120)}`);
    }

    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastAnswer);

    if (now - lastAnswer > options.unresponsiveMs)
      return {
        kind: "unresponsive" as const,
        maxGapMs,
        heldMiB,
        silentMs: Math.round(now - lastAnswer),
      };

    if (now - started > options.deadlineMs) return { kind: "stalled" as const, maxGapMs, heldMiB };
    await sleep(Math.max(0, options.pollMs - (now - askedAt)), undefined, {
      signal: context.signal,
    });
  }
}

/** Retries a trivial command until it answers or `limitMs` passes; the wait in ms, or null. */
async function answersWithin(context: CheckContext, box: Box, limitMs: number) {
  const started = performance.now();

  while (performance.now() - started < limitMs) {
    try {
      const result = await context.exec(box, "echo ok", 30_000);

      if (result.exitCode === 0) return Math.round(performance.now() - started);
    } catch {
      // Not answering yet.
    }

    await sleep(2_000, undefined, { signal: context.signal });
  }

  return null;
}

export const memoryPressureCheck = (
  options: PressureOptions = defaultPressureOptions,
): Check<PressureResult> => ({
  id: "memory-pressure",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 25 * 60_000,
  resultSchema: pressureResultSchema,
  async run(context) {
    const box = context.boxes[0]?.box;

    if (!box) throw new CheckStop("No sandbox");
    const found = parseRuntime((await context.exec(box, runtimeCommand, 60_000)).stdout);

    if (!found) throw new CheckStop("The image has neither node nor python3");
    const limits = parseLimits((await context.exec(box, limitsCommand, 60_000)).stdout);
    await context.note("limits", limits);

    const advertisedMiB =
      options.advertisedMiB ?? Math.round(machineOf(context.setup).memoryGiB * 1024);

    const targetMiB =
      Math.ceil((advertisedMiB * options.overshoot) / options.chunkMiB) * options.chunkMiB;

    const target = await diskTarget(context, box);
    const dir = `${target.dir}/.sbx-mem`;
    const script = guestScripts[found.runtime];
    const hog = `${dir}/hog.${script.extension}`;
    const rt = quote(found.path);
    await context.exec(box, `mkdir -p ${quote(dir)} && rm -f ${quote(dir)}/hog.*`, 60_000);
    await box.write(hog, new TextEncoder().encode(script.hog));

    try {
      const canary = `echo $$ > canary.pid; while :; do date +%s > canary.beat; sleep 1; done`;

      const prepared = await context.exec(
        box,
        [
          `cd ${quote(dir)} || exit 1`,
          detached(`cd ${quote(dir)} && ${canary}`, `${dir}/canary.log`),
          "sleep 1",
          healthCommand(dir),
          oomCommand,
        ].join("\n"),
        60_000,
      );

      const before = keyValues(prepared.stdout);
      const oomBefore = parseOomKills(prepared.stdout);
      const oomFileBefore = oomFileOf(prepared.stdout);

      context.say(
        `${found.runtime}: advertised ${advertisedMiB} MiB, MemTotal ${limits.memTotalGiB ?? "?"} GiB, limit ${limits.memLimitGiB ?? "none"}, target ${targetMiB} MiB`,
      );

      await context.exec(
        box,
        detached(
          `cd ${quote(dir)} && { ${rt} ${quote(hog)} ${targetMiB} ${options.chunkMiB} > hog.log 2>&1 & echo $! > hog.pid; wait $!; echo $? > hog.exit; }`,
          `${dir}/hog.wrap`,
        ),
        60_000,
      );

      const polled = await pollHog({ context, box, dir, options });
      let recoveredAfterMs: number | null = null;
      let lost: { kind: "absent" | "unresponsive"; detail: string } | null = null;

      if (polled.kind === "unresponsive") {
        const liveness = await lookUpLiveness(box, `no answer for ${polled.silentMs} ms`);

        if (liveness.kind === "absent") lost = { kind: "absent", detail: liveness.detail };
        else {
          recoveredAfterMs = await answersWithin(context, box, options.recoveryMs);

          if (recoveredAfterMs === null)
            lost = {
              kind: "unresponsive",
              detail: `no answer for ${polled.silentMs + options.recoveryMs} ms; ${liveness.kind === "present" ? "still listed" : liveness.detail}`,
            };
          else recoveredAfterMs += polled.silentMs;
        }
      }

      if (polled.kind === "stalled")
        await context
          .exec(box, `kill -9 "$(cat ${quote(`${dir}/hog.pid`)})" 2>/dev/null; true`, 30_000)
          .catch(() => undefined);

      const answered = lost === null;
      let logText = "";
      let exitCode: number | null = polled.kind === "exited" ? polled.exitCode : null;
      let after = new Map<string, string>();
      let oomDelta: number | null = null;
      let allocOk: boolean | null = null;
      let fileOk: boolean | null = null;

      if (answered) {
        const read = await context.exec(
          box,
          [
            `cat ${quote(`${dir}/hog.log`)} 2>/dev/null`,
            "echo '#end-log'",
            healthCommand(dir),
            oomCommand,
            `echo "exit=$(cat ${quote(`${dir}/hog.exit`)} 2>/dev/null)"`,
          ].join("\n"),
          60_000,
        );

        [logText = ""] = read.stdout.split("#end-log");
        after = keyValues(read.stdout.slice(logText.length));
        const exit = after.get("exit") ?? "";

        if (exitCode === null && /^\d+$/.test(exit)) exitCode = Number(exit);
        const oomAfter = parseOomKills(read.stdout);
        const sameCgroup = oomFileBefore !== null && oomFileOf(read.stdout) === oomFileBefore;

        oomDelta =
          oomBefore !== null && oomAfter !== null && sameCgroup
            ? Math.max(0, oomAfter - oomBefore)
            : null;

        const alloc = await context
          .exec(box, `${rt} ${quote(hog)} ${options.healthAllocMiB} ${options.chunkMiB}`, 120_000)
          .catch(() => null);

        allocOk = alloc !== null && alloc.exitCode === 0 && /^reached /m.test(alloc.stdout);

        const file = await context
          .exec(
            box,
            `cd ${quote(dir)} && head -c 1048576 /dev/urandom > health.bin && sync && test "$(wc -c < health.bin)" -eq 1048576 && rm -f health.bin && echo fileok`,
            60_000,
          )
          .catch(() => null);

        fileOk = file !== null && file.stdout.includes("fileok");
      }

      const bootBefore = before.get("boot") ?? "";
      const bootAfter = after.get("boot") ?? "";

      const bootSame =
        !answered ||
        bootBefore === "" ||
        bootBefore === "unknown" ||
        bootAfter === "" ||
        bootAfter === "unknown"
          ? null
          : bootBefore === bootAfter;

      const canaryBefore = before.get("canaryStart") ?? "";

      const canaryAlive =
        !answered || canaryBefore === "" ? null : after.get("canaryStart") === canaryBefore;

      const log = parseHogLog(logText);
      const reachedMiB = Math.max(log.heldMiB, polled.heldMiB);

      const outcome = judgePressure({
        exitCode,
        log,
        oomDelta,
        stalled: polled.kind === "stalled",
        lost,
        bootSame,
      });

      const scope = scopeOf(outcome, canaryAlive);
      context.say(`memory: ${outcome.kind} at ${reachedMiB} MiB, scope ${scope ?? "-"}`);

      return {
        runtime: found.runtime,
        limits,
        advertisedMiB,
        targetMiB,
        reachedMiB,
        reachedFraction: Math.round((reachedMiB / advertisedMiB) * 1000) / 1000,
        progress: thinProgress(log.progress),
        outcome,
        scope,
        usableAfter: answered && allocOk === true && fileOk === true,
        health: { answered, recoveredAfterMs, bootSame, canaryAlive, allocOk, fileOk },
        maxPollGapMs: Math.round(polled.maxGapMs),
      };
    } finally {
      await context
        .execCleanup(
          box,
          `for f in hog.pid canary.pid; do kill -9 "$(cat ${quote(dir)}/$f 2>/dev/null)" 2>/dev/null; done; true`,
          30_000,
        )
        .catch(() => undefined);
    }
  },
});

export const memoryPressure = memoryPressureCheck();
