/**
 * memory-pressure: what happens when a process allocates up to the advertised memory and past it.
 *
 * 1. Limits as memory-honesty reads them (MemTotal, the cgroup limit, swap, overcommit), a canary
 *    process that writes the time every second, the boot id and the exec shell's cgroup OOM counter.
 * 2. A detached hog allocates 64 MiB at a time of random (incompressible) bytes, up to `overshoot`
 *    times the provider's advertised memory, logging each chunk; its supervisor shell records the
 *    exit status. The host polls every `pollMs` for the boot id, progress, the hog's liveness and its
 *    exit, and records the longest wait for an answer. It keeps polling through a spell of silence
 *    and evaluates the sandbox only after the hog has ended.
 * 3. Afterwards: is the boot id the same, is the canary the same live process with a fresh beat, do a
 *    fresh 256 MiB allocation and a file write succeed.
 *
 * Outcomes are only what the evidence shows. `reached-target`: the hog held every byte it asked for
 * (swap, or no enforcement at the advertised size). `process-killed`: its supervisor shell recorded
 * SIGKILL (status 137); the cgroup's OOM count is kept as corroboration only, since other processes
 * share it. `vanished`: the hog and its supervisor were both confirmed gone with no exit status, so
 * how it died is unknown. `refused`: the runtime's allocation failed (its refusal line, then exit 3).
 * `stalled`: confirmed still
 * running at the deadline (thrashing), then killed; usability is measured only once it is confirmed
 * gone. `sandbox-restarted`: a new boot id. `unresponsive`: no answer for
 * `unresponsiveMs + recoveryMs` while the provider's exact lookup, made at that moment, still lists
 * it. `sandbox-lost`: no answer and that lookup says it is gone. Anything else, an unknown provider
 * state included, fails the check. The
 * scope is `process` only when the canary is the same live process with a fresh beat, `collateral` when it is confirmed gone, and `sandbox` when the
 * whole sandbox was lost, rebooted or stopped answering; unknown otherwise.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { deadline } from "../timing.js";
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
  identityFunction,
  ownKillFunction,
  stampFunction,
  parseRuntime,
  parseSeen,
  bootIdPattern,
  valid,
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
  /** No answer for this long asks the provider whether the sandbox is gone. */
  readonly unresponsiveMs: number;
  /** After that, how much longer to wait for the sandbox to answer again. */
  readonly recoveryMs: number;
  readonly healthAllocMiB: number;
  /** The advertised memory; the provider's same-machine size when null. */
  readonly advertisedMiB: number | null;
  /** Where the attempt's directory goes; the disk test's directory when null. */
  readonly workdir: string | null;
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
  workdir: null,
};

const pollTimeoutMs = 20_000;

/** A canary beat older than this (guest seconds) means the canary is stuck, not alive. */
const freshBeatS = 5;

/** The canary after the hog, judged against the one seen before it started. */
function canaryOf(after: Map<string, string>, beforeId: string) {
  const seen = parseSeen(after.get("canary"));
  const now = after.get("now") ?? "";
  const beat = after.get("canaryBeat") ?? "";
  const beatAgeS = /^\d+$/.test(now) && /^\d+$/.test(beat) ? Number(now) - Number(beat) : null;

  if (seen.kind === "gone") return { kind: "gone" as const, beatAgeS };

  // A beat from the future means the two reads did not come from one moment.
  if (seen.kind !== "alive" || seen.id !== beforeId || (beatAgeS !== null && beatAgeS < 0))
    return { kind: "unknown" as const, beatAgeS };

  return {
    kind: beatAgeS !== null && beatAgeS <= freshBeatS ? ("alive" as const) : ("stale" as const),
    beatAgeS,
  };
}

const progressSchema = z.object({ mib: z.number().int(), ms: z.number().int() });

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reached-target") }),
  z.object({
    kind: z.literal("process-killed"),
    /** 137 (SIGKILL by shell convention), or null when the hog and its supervisor vanished. */
    exitCode: z.number().int().nullable(),
    /**
     * New OOM kills counted by the cgroup of the exec shell that read it, which may not be the
     * hog's; corroboration at most, null when unreadable or the cgroup changed.
     */
    oomKills: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
  /** The hog and its supervisor are gone with no exit status: how it died is unknown. */
  z.object({ kind: z.literal("vanished"), oomKills: z.number().int().nullable() }),
  z.object({ kind: z.literal("stalled") }),
  z.object({ kind: z.literal("sandbox-restarted") }),
  z.object({ kind: z.literal("unresponsive"), detail: z.string() }),
  z.object({ kind: z.literal("sandbox-lost"), detail: z.string() }),
]);

export type PressureOutcome = z.infer<typeof outcomeSchema>;

const healthSchema = z.object({
  answered: z.boolean(),
  /** How long the sandbox was silent before it answered again; null when it never went silent. */
  recoveredAfterMs: z.number().nullable(),
  bootSame: z.boolean().nullable(),
  canaryAlive: z.boolean().nullable(),
  /** What the last read saw: the same process beating, gone, alive but not beating, or unreadable. */
  canary: z.enum(["alive", "gone", "stale", "unknown"]).nullable(),
  canaryBeatAgeS: z.number().nullable(),
  allocOk: z.boolean().nullable(),
  fileOk: z.boolean().nullable(),
});

export const pressureResultSchema = z.object({
  runtime: z.enum(runtimes),
  limits: limitsSchema,
  advertisedMiB: z.number().int(),
  targetMiB: z.number().int(),
  /** The most the hog was seen holding; null when nothing was observed. */
  reachedMiB: z.number().int().nullable(),
  /** `log`: from the hog's whole log; `last-poll`: a lower bound from the last progress seen. */
  reachedEvidence: z.enum(["log", "last-poll", "none"]),
  reachedFraction: z.number().nullable(),
  /** One point per 512 MiB held, for a slowdown chart. */
  progress: z.array(progressSchema),
  outcome: outcomeSchema,
  scope: z.enum(["process", "collateral", "sandbox"]).nullable(),
  /**
   * The sandbox works afterwards: it answers, a fresh allocation and a file write succeed. False
   * when it stopped answering or a test failed; null when the hog could not be confirmed gone, so
   * the tests were not run.
   */
  usableAfter: z.boolean().nullable(),
  health: healthSchema,
  maxPollGapMs: z.number().int(),
});

export type PressureResult = z.infer<typeof pressureResultSchema>;

export function parseHogLog(text: string) {
  const progress: { mib: number; ms: number }[] = [];
  let reached = false;
  let refused: string | null = null;
  let heldMiB = 0;

  for (const line of text.split("\n")) {
    const [word, mib, rest] = line.trim().split(/\s+/);
    const value = Number(mib);

    if (!Number.isInteger(value) || (word !== "held" && word !== "reached" && word !== "refused"))
      continue;

    heldMiB = Math.max(heldMiB, value);

    if (word === "refused") refused = rest ?? "unknown";
    else progress.push({ mib: value, ms: Number(rest) || 0 });

    if (word === "reached") reached = true;
  }

  return { progress, heldMiB, reached, refused };
}

/** One point per `stepMiB`, plus the last. */
export function thinProgress(progress: readonly { mib: number; ms: number }[], stepMiB = 512) {
  const kept = progress.filter((point) => point.mib % stepMiB === 0);
  const last = progress.at(-1);

  return last && kept.at(-1) !== last ? [...kept, last] : kept;
}

export type Ending =
  | { readonly kind: "exited"; readonly exitCode: number }
  | { readonly kind: "vanished" }
  | { readonly kind: "stalled" }
  | { readonly kind: "restarted" }
  | { readonly kind: "unresponsive"; readonly detail: string }
  | { readonly kind: "lost"; readonly detail: string };

/** Judges the hog from how it ended, its log and the OOM counter. */
export function judgePressure(input: {
  readonly ending: Ending;
  readonly log: ReturnType<typeof parseHogLog>;
  readonly oomDelta: number | null;
  readonly bootSame: boolean | null;
}): PressureOutcome {
  const { ending, log, oomDelta, bootSame } = input;

  switch (ending.kind) {
    case "lost":
      return { kind: "sandbox-lost", detail: ending.detail };
    case "unresponsive":
      return { kind: "unresponsive", detail: ending.detail };
    case "restarted":
      return { kind: "sandbox-restarted" };
    case "stalled":
      return bootSame === false ? { kind: "sandbox-restarted" } : { kind: "stalled" };
    case "vanished":
      return bootSame === false
        ? { kind: "sandbox-restarted" }
        : { kind: "vanished", oomKills: oomDelta };
    case "exited":
      if (bootSame === false) return { kind: "sandbox-restarted" };

      // Neither the hog's code nor Node or Python on their own exit 137, so the supervisor shell's
      // 137 is SIGKILL (128 + 9), even after a refusal line.
      if (ending.exitCode === 137)
        return { kind: "process-killed", exitCode: 137, oomKills: oomDelta };

      if (ending.exitCode === 0 && log.reached) return { kind: "reached-target" };

      // The hog prints its refusal and then exits 3; a refusal line with any other status is not one.
      if (ending.exitCode === 3 && log.refused !== null)
        return { kind: "refused", reason: log.refused };

      throw new CheckStop(
        `The hog exited ${ending.exitCode} with no kill evidence (held ${log.heldMiB} MiB)`,
      );
    default: {
      const exhaustive: never = ending;

      return exhaustive;
    }
  }
}

export function scopeOf(outcome: PressureOutcome, canaryAlive: boolean | null) {
  switch (outcome.kind) {
    case "sandbox-lost":
    case "sandbox-restarted":
    case "unresponsive":
      return "sandbox" as const;
    case "process-killed":
    case "refused":
    case "vanished":
    case "reached-target":
    case "stalled":
      return canaryAlive === true
        ? outcome.kind === "process-killed" ||
          outcome.kind === "refused" ||
          outcome.kind === "vanished"
          ? ("process" as const)
          : null
        : canaryAlive === false
          ? ("collateral" as const)
          : null;
    default: {
      const exhaustive: never = outcome;

      return exhaustive;
    }
  }
}

/** Boot id first (no dependency on the directory), then the hog's progress, liveness and exit. */
const statusCommand = (dir: string) =>
  [
    identityFunction,
    `echo "boot=$(${bootIdCommand})"`,
    `if [ -d ${quote(dir)} ]; then echo dir=1; else echo dir=0; fi`,
    `echo "exit=$(cat ${quote(`${dir}/hog.exit`)} 2>/dev/null)"`,
    `echo "last=$(tail -n 1 ${quote(`${dir}/hog.log`)} 2>/dev/null)"`,
    `echo "running=$(identity ${quote(`${dir}/hog.pid`)})"`,
    `echo "supervisor=$(identity ${quote(`${dir}/hog.sup`)})"`,
    "echo status=done",
  ].join("\n");

const healthKeys = ["boot", "canary", "canaryBeat", "now", "health"] as const;

const healthCommand = (dir: string) =>
  [
    identityFunction,
    `echo "boot=$(${bootIdCommand})"`,
    `echo "canary=$(identity ${quote(`${dir}/canary.pid`)})"`,
    `echo "canaryBeat=$(cat ${quote(`${dir}/canary.beat`)} 2>/dev/null)"`,
    `echo "now=$(date +%s)"`,
    "echo health=done",
  ].join("\n");

type Polled = {
  readonly ending: Ending;
  readonly heldMiB: number;
  readonly maxGapMs: number;
  readonly recoveredAfterMs: number | null;
};

/** Polls until the hog has ended, the deadline passes, the guest reboots, or it stays silent. */
async function pollHog(input: {
  readonly context: CheckContext;
  readonly box: Box;
  readonly dir: string;
  readonly boot: string;
  readonly options: PressureOptions;
}): Promise<Polled> {
  const { context, box, dir, boot, options } = input;
  const started = performance.now();
  let lastAnswer = started;
  let maxGapMs = 0;
  let heldMiB = 0;
  let recoveredAfterMs: number | null = null;
  let asked = false;
  let vanishedOnce = false;
  const polled = (ending: Ending): Polled => ({ ending, heldMiB, maxGapMs, recoveredAfterMs });

  for (;;) {
    const askedAt = performance.now();
    let values: Map<string, string> | null = null;

    try {
      const result = await context.exec(box, statusCommand(dir), pollTimeoutMs);

      if (!result.timedOut && result.stdout.includes("status=done"))
        values = keyValues(result.stdout);
    } catch (cause) {
      context.say(`poll: ${errorText(cause).slice(0, 120)}`);
    }

    const now = performance.now();

    if (values !== null) {
      const silence = now - lastAnswer;

      if (silence > options.unresponsiveMs) recoveredAfterMs = Math.round(silence);
      asked = false;
      maxGapMs = Math.max(maxGapMs, silence);
      lastAnswer = now;
      const seenBoot = valid(values.get("boot"), bootIdPattern);

      if (seenBoot !== null && seenBoot !== boot) return polled({ kind: "restarted" });

      if (values.get("dir") !== "1")
        throw new CheckStop("The attempt's directory vanished with the same boot id");
      heldMiB = Math.max(heldMiB, parseHogLog(values.get("last") ?? "").heldMiB);
      // The supervisor records the status and the guest seconds since the hog started.
      const exit = /^(\d+) (\d+)$/.exec(values.get("exit") ?? "");

      if (exit !== null) {
        // An exit after the deadline means the hog was still running at it, whenever it was seen.
        if (Number(exit[2]) * 1000 > options.deadlineMs) return polled({ kind: "stalled" });

        return polled({ kind: "exited", exitCode: Number(exit[1]) });
      }

      const running = parseSeen(values.get("running"));
      const supervisor = parseSeen(values.get("supervisor"));

      // Hog and supervisor both confirmed gone with no exit status, twice in a row: vanished.
      if (running.kind === "gone" && supervisor.kind === "gone") {
        if (vanishedOnce) return polled({ kind: "vanished" });
        vanishedOnce = true;
      } else vanishedOnce = false;

      if (now - started > options.deadlineMs) {
        if (running.kind === "alive") return polled({ kind: "stalled" });

        throw new CheckStop(
          `No evidence how the hog ended by the deadline (hog ${running.kind}, supervisor ${supervisor.kind})`,
        );
      }
    } else {
      const silence = now - lastAnswer;
      maxGapMs = Math.max(maxGapMs, silence);

      if (silence > options.unresponsiveMs && !asked) {
        asked = true;
        const liveness = await lookUpLiveness(box, `no answer for ${Math.round(silence)} ms`);

        if (liveness.kind === "absent") return polled({ kind: "lost", detail: liveness.detail });
      }

      if (silence > options.unresponsiveMs + options.recoveryMs) {
        const liveness = await lookUpLiveness(box, `no answer for ${Math.round(silence)} ms`);

        if (liveness.kind === "absent") return polled({ kind: "lost", detail: liveness.detail });

        // Unresponsive is a claim about the provider, so it needs the provider to list the sandbox.
        if (liveness.kind !== "present")
          throw new CheckStop(`No answer and the provider's state is unknown: ${liveness.detail}`);

        return polled({
          kind: "unresponsive",
          detail: `no answer for ${Math.round(silence)} ms; still listed`,
        });
      }
    }

    await sleep(Math.max(0, options.pollMs - (performance.now() - askedAt)), undefined, {
      signal: context.signal,
    });
  }
}

async function measure(context: CheckContext, options: PressureOptions): Promise<PressureResult> {
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

  const base = options.workdir ?? (await diskTarget(context, box)).dir;
  const dir = `${base}/.sbx-mem-${randomBytes(4).toString("hex")}`;
  const script = guestScripts[found.runtime];
  const hog = `${dir}/hog.${script.extension}`;
  const rt = quote(found.path);
  await context.exec(box, `mkdir -p ${quote(dir)}`, 60_000);
  await box.write(hog, new TextEncoder().encode(script.hog));

  try {
    const canary = `${stampFunction}; stamp $$ > canary.pid; while :; do date +%s > canary.beat.tmp && mv canary.beat.tmp canary.beat; sleep 1; done`;

    const prepared = await context.exec(
      box,
      [
        `cd ${quote(dir)} || exit 1`,
        detached(`cd ${quote(dir)} && ${canary}`, `${dir}/canary.log`),
        "sleep 2",
        healthCommand(dir),
        oomCommand,
      ].join("\n"),
      60_000,
    );

    const before = keyValues(prepared.stdout);
    const boot = valid(before.get("boot"), bootIdPattern);
    const canaryBefore = parseSeen(before.get("canary"));

    if (
      boot === null ||
      !prepared.stdout.includes("health=done") ||
      canaryBefore.kind !== "alive" ||
      canaryOf(before, canaryBefore.id).kind !== "alive"
    )
      throw new CheckStop("The baseline has no boot id or no beating canary");
    const oomBefore = parseOomKills(prepared.stdout);
    const oomFileBefore = oomFileOf(prepared.stdout);

    context.say(
      `${found.runtime}: advertised ${advertisedMiB} MiB, MemTotal ${limits.memTotalGiB ?? "?"} GiB, limit ${limits.memLimitGiB ?? "none"}, target ${targetMiB} MiB`,
    );

    await context.exec(
      box,
      detached(
        `cd ${quote(dir)} && { ${stampFunction}; t0=$(date +%s); stamp $$ > hog.sup; ${rt} ${quote(hog)} ${targetMiB} ${options.chunkMiB} > hog.log 2>&1 & stamp $! > hog.pid; wait $!; c=$?; echo "$c $(( $(date +%s) - t0 ))" > hog.exit; }`,
        `${dir}/hog.wrap`,
      ),
      60_000,
    );

    const polled = await pollHog({ context, box, dir, boot, options });
    const answered = polled.ending.kind !== "lost" && polled.ending.kind !== "unresponsive";
    // Usability is measured only once the hog is confirmed gone (or the guest rebooted).
    let ended = polled.ending.kind !== "stalled";

    if (polled.ending.kind === "stalled") {
      await context.exec(
        box,
        [ownKillFunction, `ownkill ${quote(`${dir}/hog.pid`)}`].join("\n"),
        30_000,
      );

      // Measure usability only once the hog is gone.
      for (let tries = 0; tries < 15; tries++) {
        const status = await context
          .exec(box, statusCommand(dir), pollTimeoutMs)
          .then((result) =>
            result.stdout.includes("status=done") ? keyValues(result.stdout) : null,
          )
          .catch(() => null);

        if (status !== null && parseSeen(status.get("running")).kind === "gone") {
          ended = true;
          break;
        }

        await sleep(2_000, undefined, { signal: context.signal });
      }
    }

    let logText = "";
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
        ].join("\n"),
        60_000,
      );

      const at = read.stdout.indexOf("#end-log");
      logText = at < 0 ? "" : read.stdout.slice(0, at);
      after = keyValues(at < 0 ? read.stdout : read.stdout.slice(at));
      const oomAfter = parseOomKills(read.stdout);
      const sameCgroup = oomFileBefore !== null && oomFileOf(read.stdout) === oomFileBefore;
      oomDelta =
        oomBefore !== null && oomAfter !== null && sameCgroup
          ? Math.max(0, oomAfter - oomBefore)
          : null;

      // A canary the thrashing starved can take a few seconds to beat again once the hog is gone.
      for (
        let tries = 0;
        ended && tries < 4 && canaryOf(after, canaryBefore.id).kind === "stale";
        tries++
      ) {
        await sleep(2_000, undefined, { signal: context.signal });
        const again = await context.exec(box, healthCommand(dir), 60_000).catch(() => null);

        // Only a complete read replaces the last one, so its fields all come from one moment.
        const fresh = again === null || again.timedOut ? null : keyValues(again.stdout);

        if (fresh === null || !healthKeys.every((key) => (fresh.get(key) ?? "") !== "")) break;
        after = new Map([...after, ...fresh]);
      }

      const alloc = !ended
        ? null
        : await context
            .exec(box, `${rt} ${quote(hog)} ${options.healthAllocMiB} ${options.chunkMiB}`, 120_000)
            .catch(() => null);

      // A test whose exec never ran is unobserved, not failed.
      allocOk = alloc === null ? null : alloc.exitCode === 0 && /^reached /m.test(alloc.stdout);

      const file = !ended
        ? null
        : await context
            .exec(
              box,
              `cd ${quote(dir)} && head -c 1048576 /dev/urandom > health.bin && sync && test "$(wc -c < health.bin)" -eq 1048576 && rm -f health.bin && echo fileok`,
              60_000,
            )
            .catch(() => null);

      fileOk = file === null ? null : file.stdout.includes("fileok");
    }

    const bootAfter = valid(after.get("boot"), bootIdPattern);
    const bootSame = !answered || bootAfter === null ? null : bootAfter === boot;

    // Alive needs the same process and a fresh beat; gone needs it confirmed gone; else unknown.
    const canaryAfter = answered ? canaryOf(after, canaryBefore.id) : null;

    const canaryAlive =
      canaryAfter?.kind === "alive" ? true : canaryAfter?.kind === "gone" ? false : null;

    const log = parseHogLog(logText);
    const outcome = judgePressure({ ending: polled.ending, log, oomDelta, bootSame });
    const scope = scopeOf(outcome, canaryAlive);
    const fromLog = log.heldMiB > 0 && log.heldMiB >= polled.heldMiB;
    const reachedMiB = fromLog ? log.heldMiB : polled.heldMiB > 0 ? polled.heldMiB : null;
    context.say(`memory: ${outcome.kind} at ${reachedMiB ?? "?"} MiB, scope ${scope ?? "-"}`);

    return {
      runtime: found.runtime,
      limits,
      advertisedMiB,
      targetMiB,
      reachedMiB,
      reachedEvidence: fromLog ? "log" : reachedMiB !== null ? "last-poll" : "none",
      reachedFraction:
        reachedMiB === null ? null : Math.round((reachedMiB / advertisedMiB) * 1000) / 1000,
      progress: thinProgress(log.progress),
      outcome,
      scope,
      usableAfter: !answered
        ? false
        : allocOk === false || fileOk === false
          ? false
          : allocOk === true && fileOk === true
            ? true
            : null,
      health: {
        answered,
        recoveredAfterMs: polled.recoveredAfterMs,
        bootSame,
        canaryAlive,
        canary: canaryAfter?.kind ?? null,
        canaryBeatAgeS: canaryAfter?.beatAgeS ?? null,
        allocOk,
        fileOk,
      },
      maxPollGapMs: Math.round(polled.maxGapMs),
    };
  } finally {
    await context
      .execCleanup(
        box,
        [
          ownKillFunction,
          `ownkill ${quote(`${dir}/hog.pid`)}`,
          `ownkill ${quote(`${dir}/canary.pid`)}`,
        ].join("\n"),
        30_000,
      )
      .catch(() => undefined);
  }
}

export const memoryPressureCheck = (
  options: PressureOptions = defaultPressureOptions,
): Check<PressureResult> => {
  const lifetimeMs = 25 * 60_000;

  return {
    id: "memory-pressure",
    boxes: 1,
    minBoxes: 1,
    lifetimeMs,
    resultSchema: pressureResultSchema,
    // The check ends a minute before the sandbox's lifetime, so cleanup still finds it.
    run: (context) => deadline(lifetimeMs - 60_000, () => measure(context, options)),
  };
};

export const memoryPressure = memoryPressureCheck();
