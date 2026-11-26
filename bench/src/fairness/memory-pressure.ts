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

/** How often a sandbox that fails its status polls is looked up. */
const lookupEveryMs = 15_000;

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

/**
 * Only what the supervisor's recorded status, a new boot id or the provider's exact lookup proves is
 * an outcome. Anything else (no status by the deadline, a hog gone without one, a sandbox that stops
 * answering) is `inconclusive` with its reason, and claims nothing about the provider.
 */
const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("reached-target") }),
  z.object({
    kind: z.literal("process-killed"),
    /** The supervisor shell's status for the hog: 137 is SIGKILL (128 + 9). */
    exitCode: z.literal(137),
    /**
     * New OOM kills counted by the cgroup of the exec shell that read it, which may not be the
     * hog's; corroboration at most, null when unreadable or the cgroup changed.
     */
    oomKills: z.number().int().nullable(),
  }),
  z.object({ kind: z.literal("refused"), reason: z.string() }),
  z.object({ kind: z.literal("sandbox-restarted") }),
  /** The provider's exact lookup says the sandbox is gone, and no poll the host cancelled came first. */
  z.object({ kind: z.literal("sandbox-lost"), detail: z.string() }),
  z.object({ kind: z.literal("inconclusive"), reason: z.string() }),
]);

export type PressureOutcome = z.infer<typeof outcomeSchema>;

const healthSchema = z.object({
  /** The read after the hog answered in full. */
  answered: z.boolean(),
  /** How long the sandbox was silent before it answered again; null when it never went silent. */
  recoveredAfterMs: z.number().nullable(),
  bootSame: z.boolean().nullable(),
  canaryAlive: z.boolean().nullable(),
  /** What the last read saw: the same process beating, gone, alive but not beating, or unreadable. */
  canary: z.enum(["alive", "gone", "stale", "unknown"]).nullable(),
  canaryBeatAgeS: z.number().nullable(),
  /** Null when the test did not run to completion; false only for one that ran and failed. */
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
  /**
   * `log`: from the whole log of a hog whose status was recorded; `last-poll`: a lower bound from the
   * progress seen.
   */
  reachedEvidence: z.enum(["log", "last-poll", "none"]),
  reachedFraction: z.number().nullable(),
  /** One point per 512 MiB held, for a slowdown chart. */
  progress: z.array(progressSchema),
  outcome: outcomeSchema,
  scope: z.enum(["process", "collateral", "sandbox"]).nullable(),
  /**
   * The sandbox works afterwards: a fresh allocation and a file write succeed. Measured only after
   * a recorded hog status on the same boot; false for a lost sandbox or a test that ran and failed,
   * null otherwise.
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
  | { readonly kind: "restarted" }
  | { readonly kind: "lost"; readonly detail: string }
  | { readonly kind: "unsettled"; readonly reason: string };

/** Judges the hog from its recorded status, its log and the boot id. */
export function judgePressure(input: {
  readonly ending: Ending;
  readonly log: ReturnType<typeof parseHogLog>;
  readonly oomDelta: number | null;
  readonly bootSame: boolean | null;
}): PressureOutcome {
  const { ending, log, oomDelta, bootSame } = input;

  if (ending.kind === "restarted" || bootSame === false) return { kind: "sandbox-restarted" };

  if (ending.kind === "lost") return { kind: "sandbox-lost", detail: ending.detail };

  if (ending.kind === "unsettled") return { kind: "inconclusive", reason: ending.reason };

  // Neither the hog's code nor Node or Python on their own exit 137, so the supervisor shell's 137
  // is SIGKILL, even after a refusal line.
  if (ending.exitCode === 137) return { kind: "process-killed", exitCode: 137, oomKills: oomDelta };

  if (ending.exitCode === 0 && log.reached) return { kind: "reached-target" };

  // The hog prints its refusal and then exits 3; a refusal line with any other status is not one.
  if (ending.exitCode === 3 && log.refused !== null)
    return { kind: "refused", reason: log.refused };

  return {
    kind: "inconclusive",
    reason: `the hog exited ${ending.exitCode} with no kill evidence (held ${log.heldMiB} MiB)`,
  };
}

export function scopeOf(outcome: PressureOutcome, canaryAlive: boolean | null) {
  switch (outcome.kind) {
    case "sandbox-restarted":
    case "sandbox-lost":
      return "sandbox" as const;
    case "inconclusive":
      return null;
    case "process-killed":
    case "refused":
    case "reached-target":
      return canaryAlive === false
        ? ("collateral" as const)
        : canaryAlive === true && outcome.kind !== "reached-target"
          ? ("process" as const)
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

const healthCommand = (dir: string) =>
  [
    identityFunction,
    `echo "boot=$(${bootIdCommand})"`,
    `echo "canary=$(identity ${quote(`${dir}/canary.pid`)})"`,
    `echo "canaryBeat=$(cat ${quote(`${dir}/canary.beat`)} 2>/dev/null)"`,
    `echo "now=$(date +%s)"`,
    "echo health=done",
  ].join("\n");

type Exec = Awaited<ReturnType<CheckContext["exec"]>>;

/** A command that ran to the end in the guest: not rejected, not timed out, with an exit status. */
const ranToEnd = (result: Exec | null): result is Exec =>
  result !== null && !result.timedOut && result.exitCode !== null;

/** A health read whose every field came from the one, complete run (an empty beat is unobserved). */
const healthFrame = (result: Exec | null) => {
  if (!ranToEnd(result) || !/^health=done$/m.test(result.stdout)) return null;
  const values = keyValues(result.stdout);

  return values.has("canaryBeat") &&
    ["boot", "canary", "now"].every((key) => (values.get(key) ?? "") !== "")
    ? values
    : null;
};

type Polled = {
  readonly ending: Ending;
  readonly heldMiB: number;
  readonly maxGapMs: number;
  readonly recoveredAfterMs: number | null;
};

/** Polls until the hog's status is recorded, the guest reboots, or it cannot be settled. */
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
  let vanishedOnce = false;
  let cancelledPoll = false;
  let lookedUpAt = Number.NEGATIVE_INFINITY;
  const polled = (ending: Ending): Polled => ({ ending, heldMiB, maxGapMs, recoveredAfterMs });
  const unsettled = (reason: string) => polled({ kind: "unsettled", reason });

  for (;;) {
    const askedAt = performance.now();
    let values: Map<string, string> | null = null;

    try {
      const result = await context.exec(box, statusCommand(dir), pollTimeoutMs);
      // The boot id comes first, so even a reply cut short can prove a restart.
      const seenBoot = valid(keyValues(result.stdout).get("boot"), bootIdPattern);

      if (seenBoot !== null && seenBoot !== boot) return polled({ kind: "restarted" });

      if (result.timedOut) cancelledPoll = true;
      else if (result.stdout.includes("status=done")) values = keyValues(result.stdout);
    } catch (cause) {
      context.say(`poll: ${errorText(cause).slice(0, 120)}`);
    }

    // An interrupted run can have its own cleanup delete the sandbox: never judge what follows.
    context.signal.throwIfAborted();

    const now = performance.now();

    // A poll that ran into its own timeout was cancelled by the host, and an SDK may answer a
    // cancellation it cannot confirm by destroying the sandbox.
    if (values === null && now - askedAt >= pollTimeoutMs) cancelledPoll = true;
    const silence = now - lastAnswer;
    maxGapMs = Math.max(maxGapMs, silence);

    if (values !== null) {
      if (silence > options.unresponsiveMs) recoveredAfterMs = Math.round(silence);
      lastAnswer = now;

      if (values.get("dir") !== "1")
        return unsettled("the attempt's directory vanished with the same boot id");
      heldMiB = Math.max(heldMiB, parseHogLog(values.get("last") ?? "").heldMiB);
      const exit = values.get("exit") ?? "";

      // The status is judged on what it says, whenever it is seen; the deadline only bounds the wait.
      if (/^\d+$/.test(exit)) return polled({ kind: "exited", exitCode: Number(exit) });

      const running = parseSeen(values.get("running"));
      const supervisor = parseSeen(values.get("supervisor"));

      if (running.kind === "gone" && supervisor.kind === "gone") {
        if (vanishedOnce) return unsettled("the hog and its supervisor are gone with no status");
        vanishedOnce = true;
      } else vanishedOnce = false;
    } else {
      // A read-only exact lookup, at most every lookupEveryMs, says whether the sandbox still exists.
      if (now - lookedUpAt >= lookupEveryMs) {
        lookedUpAt = now;
        const liveness = await lookUpLiveness(box, "status poll failed");

        if (liveness.kind === "absent")
          return cancelledPoll
            ? unsettled(
                `the sandbox is gone (${liveness.detail}) after a poll the host cancelled, which the SDK may have answered by destroying it`,
              )
            : polled({ kind: "lost", detail: liveness.detail });
      }

      if (silence > options.unresponsiveMs + options.recoveryMs)
        return unsettled(`no answer for ${Math.round(silence)} ms`);
    }

    if (now - started > options.deadlineMs) return unsettled("no status by the deadline");

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

    const before = healthFrame(prepared);
    const boot = valid(before?.get("boot"), bootIdPattern);
    const canaryBefore = parseSeen(before?.get("canary"));

    if (
      before === null ||
      boot === null ||
      canaryBefore.kind !== "alive" ||
      canaryOf(before, canaryBefore.id).kind !== "alive"
    )
      throw new CheckStop("The baseline has no boot id or no beating canary");
    const oomBefore = parseOomKills(prepared.stdout);
    const oomFileBefore = oomFileOf(prepared.stdout);

    context.say(
      `${found.runtime}: advertised ${advertisedMiB} MiB, MemTotal ${limits.memTotalGiB ?? "?"} GiB, limit ${limits.memLimitGiB ?? "none"}, target ${targetMiB} MiB`,
    );

    const launched = await context.exec(
      box,
      detached(
        `cd ${quote(dir)} && { ${stampFunction}; stamp $$ > hog.sup; ${rt} ${quote(hog)} ${targetMiB} ${options.chunkMiB} > hog.log 2>&1 & stamp $! > hog.pid; wait $!; echo $? > hog.exit; }`,
        `${dir}/hog.wrap`,
      ),
      60_000,
    );

    // An unfinished launch may have been cancelled, and an SDK can answer that by destroying the
    // sandbox, so nothing after it would be a pressure outcome.
    if (!ranToEnd(launched) || launched.exitCode !== 0)
      throw new CheckStop("The hog launch did not run to the end");

    const polled = await pollHog({ context, box, dir, boot, options });
    // Only a recorded status says the hog has ended; then its log is whole and health can be tested.
    const ended = polled.ending.kind === "exited";

    // A valid boot id any exec prints, complete or not, is evidence: a new one is a restart.
    let rebooted = polled.ending.kind === "restarted";

    const sawBoot = (result: Exec | null) => {
      const seen = valid(
        result === null ? undefined : keyValues(result.stdout).get("boot"),
        bootIdPattern,
      );

      if (seen !== null && seen !== boot) rebooted = true;

      return seen;
    };

    const read = await context
      .exec(
        box,
        [
          `if cat ${quote(`${dir}/hog.log`)} 2>/dev/null; then echo '#end-log'; else echo '#partial-log'; fi`,
          healthCommand(dir),
          oomCommand,
        ].join("\n"),
        60_000,
      )
      .catch(() => null);

    sawBoot(read);
    const marker = read?.stdout.match(/^#(end|partial)-log$/m);
    const at = marker?.index ?? -1;
    const logWhole = marker?.[1] === "end";

    let after =
      at < 0 || read === null ? null : healthFrame({ ...read, stdout: read.stdout.slice(at) });

    const answered = after !== null;
    const logText = answered && read !== null ? read.stdout.slice(0, at) : "";
    const oomAfter = answered && read !== null ? parseOomKills(read.stdout) : null;

    const sameCgroup =
      answered &&
      read !== null &&
      oomFileBefore !== null &&
      oomFileOf(read.stdout) === oomFileBefore;

    const oomDelta =
      oomBefore !== null && oomAfter !== null && sameCgroup
        ? Math.max(0, oomAfter - oomBefore)
        : null;

    // A canary the thrashing starved can take a few seconds to beat again once the hog is gone.
    for (
      let tries = 0;
      ended && after !== null && tries < 4 && canaryOf(after, canaryBefore.id).kind === "stale";
      tries++
    ) {
      await sleep(2_000, undefined, { signal: context.signal });

      const again = await context.exec(box, healthCommand(dir), 60_000).catch(() => null);
      sawBoot(again);
      const fresh = healthFrame(again);

      if (fresh === null) break;
      after = fresh;
    }

    const bootAfter = valid(after?.get("boot"), bootIdPattern);
    let allocOk: boolean | null = null;
    let fileOk: boolean | null = null;

    /**
     * Runs one health test only when the guest itself still has the original boot id: a result
     * only when the test started and ran to the end; a new boot id is kept as a restart.
     */
    const probe = async (setup: string, test: string, timeoutMs: number) => {
      const result = await context
        .exec(
          box,
          [
            `b=$(${bootIdCommand}); echo "boot=$b"; [ "$b" = ${quote(boot)} ] || exit 98`,
            `${setup} || exit 97`,
            "echo started",
            test,
          ].join("\n"),
          timeoutMs,
        )
        .catch(() => null);

      const seen = sawBoot(result);

      return ranToEnd(result) && seen === boot && /^started$/m.test(result.stdout) ? result : null;
    };

    // Health is tested only once the hog's status is recorded on the same boot, and never again
    // once any test has seen a new one.
    if (ended && !rebooted && bootAfter === boot) {
      const alloc = await probe(
        `test -f ${quote(hog)}`,
        `${rt} ${quote(hog)} ${options.healthAllocMiB} ${options.chunkMiB}`,
        120_000,
      );

      const file = rebooted
        ? null
        : await probe(
            `cd ${quote(dir)}`,
            'head -c 1048576 /dev/urandom > health.bin && sync && test "$(wc -c < health.bin)" -eq 1048576 && rm -f health.bin && echo fileok',
            60_000,
          );

      // A restart seen by either test means the old boot's results say nothing.
      if (!rebooted) {
        allocOk = alloc === null ? null : alloc.exitCode === 0 && /^reached /m.test(alloc.stdout);
        fileOk = file === null ? null : file.exitCode === 0 && /^fileok$/m.test(file.stdout);
      }
    }

    const bootSame = rebooted ? false : bootAfter === null ? null : bootAfter === boot;

    // Alive needs the same process and a fresh beat; gone needs it confirmed gone; else unknown.
    const canaryAfter = after === null ? null : canaryOf(after, canaryBefore.id);

    const canaryAlive =
      canaryAfter?.kind === "alive" ? true : canaryAfter?.kind === "gone" ? false : null;

    const log = parseHogLog(logText);
    const outcome = judgePressure({ ending: polled.ending, log, oomDelta, bootSame });
    const scope = scopeOf(outcome, canaryAlive);
    const fromLog = ended && logWhole && log.heldMiB > 0 && log.heldMiB >= polled.heldMiB;
    const seenMiB = Math.max(log.heldMiB, polled.heldMiB);
    const reachedMiB = seenMiB > 0 ? seenMiB : null;
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
      usableAfter:
        outcome.kind === "sandbox-lost" || allocOk === false || fileOk === false
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
