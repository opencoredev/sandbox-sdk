/**
 * state-survival: what a sandbox keeps across the adapter's pause and resume, and how fast a killed
 * process comes back.
 *
 * 1. Setup, in a fresh directory of this attempt: a 16 MiB random file (sha256 noted), an HTTP
 *    server that holds a random token and 32 MiB of random bytes in memory, and a shell worker that
 *    bumps a heartbeat counter every second. Both run detached from the exec, as an agent's dev
 *    server would. The baseline must show all three, or the check fails rather than judging.
 * 2. Restart speed: `restarts` times, SIGKILL the server and start it again; the guest times each
 *    from the kill to the new child answering on its port with its own launch nonce.
 * 3. Pause and resume (only where the adapter has both): pause, hold `holdMs`, resume. From resume
 *    returning, time the first command that answers and the server serving again (restarted when it
 *    is confirmed gone). Then compare the file's sha256, the boot id, and each process's pid and start
 *    time with the baseline.
 *
 * Verdicts: `in-ram` when the server (same process, token and memory digest) and the worker (same
 * process, heartbeat moving again) survived and the worker missed most of the hold's heartbeats (it
 * was frozen); `kept-running` when they survived but the worker missed almost none (the pause did not
 * freeze the guest); `cold-restart` when the boot id changed or both processes are confirmed gone
 * with the file intact; `files-lost` when the directory or file is gone or changed; `inconclusive`
 * for anything in between, with the reason. A pause or resume the provider refuses is recorded as
 * `refused` with its error. The SDK has no portable stop and start, so that half is recorded as not run.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { deadline } from "../timing.js";
import { quote } from "../workloads.js";
import { diskTarget } from "./disk-real.js";
import { CheckStop, errorText, type Box, type Check, type CheckContext } from "./framework.js";
import {
  bootIdCommand,
  detached,
  guestScripts,
  identityFunction,
  ownKillFunction,
  parseRuntime,
  parseSeen,
  runtimeCommand,
  runtimes,
  type Seen,
} from "./guest-scripts.js";

export interface StateOptions {
  readonly holdMs: number;
  readonly restarts: number;
  readonly port: number;
  readonly fileMiB: number;
  /** Where the attempt's directory goes; the disk test's directory when null. */
  readonly workdir: string | null;
}

export const defaultStateOptions: StateOptions = {
  holdMs: 60_000,
  restarts: 5,
  port: 18_731,
  fileMiB: 16,
  workdir: null,
};

/** Each pause or resume call may take this long before it counts as refused. */
const suspendCallMs = 5 * 60_000;

/** How long after resume the first command may take to answer. */
const firstCommandMs = 3 * 60_000;

const probeMs = 30_000;

/** After resume, a first quick look for the original server, then a longer wait when it is still alive. */
const quickProbeMs = 2_000;

const resumedProbeMs = 10_000;

const bodySchema = z.object({
  nonce: z.string(),
  token: z.string(),
  pid: z.number().int(),
  digestAtStart: z.string(),
  digestNow: z.string(),
  upMs: z.number(),
});

const probeSchema = z.object({ ok: z.boolean(), ms: z.number(), body: bodySchema.nullable() });

export type Probe = z.infer<typeof probeSchema>;

const workerSchema = z.object({
  /** The same pid and start time before the pause, after resume and 2.5 s later. */
  same: z.boolean(),
  /** No live process of this attempt holds the worker's pid file. */
  gone: z.boolean(),
  /** Heartbeats between the snapshots either side of the pause; null unless \`same\`. */
  beatsDuringHold: z.number().int().nullable(),
  /** Bounded host seconds between those snapshots minus the heartbeats: about the hold when it froze. */
  missedBeats: z.object({ min: z.number(), max: z.number() }).nullable(),
  advancing: z.boolean(),
});

const serverSchema = z.object({
  answered: z.boolean(),
  sameProcess: z.boolean(),
  sameToken: z.boolean(),
  memoryIntact: z.boolean(),
  gone: z.boolean(),
});

export const verdicts = [
  "in-ram",
  "kept-running",
  "cold-restart",
  "files-lost",
  "inconclusive",
] as const;

const suspendSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unsupported"), reason: z.string() }),
  z.object({
    kind: z.literal("refused"),
    stage: z.enum(["pause", "resume", "first-command"]),
    error: z.string(),
    pauseMs: z.number().nullable(),
    resumeMs: z.number().nullable(),
  }),
  z.object({
    kind: z.literal("measured"),
    verdict: z.enum(verdicts),
    /** Why the evidence was not enough for another verdict; null otherwise. */
    reason: z.string().nullable(),
    holdMs: z.number(),
    pauseMs: z.number(),
    resumeMs: z.number(),
    /** From resume returning to the first command answering. */
    firstCommandMs: z.number(),
    /** Observed: from resume returning to the original server answering; null when it did not. */
    servingMs: z.number().nullable(),
    serverRestarted: z.boolean(),
    /**
     * Composed, for a server confirmed gone: the first command plus the guest-timed restart, so it
     * leaves out the harness's own checks. Not an observed elapsed time. Null otherwise.
     */
    coldServeMs: z.number().nullable(),
    filesystem: z.boolean(),
    bootSame: z.boolean().nullable(),
    worker: workerSchema,
    server: serverSchema,
  }),
]);

export const stateResultSchema = z.object({
  runtime: z.enum(runtimes),
  workdir: z.string(),
  fileMiB: z.number().int(),
  setupMs: z.number(),
  restart: z.object({
    samplesMs: z.array(z.number()),
    medianMs: z.number().nullable(),
    failures: z.number().int(),
  }),
  suspend: suspendSchema,
  stopStart: z.object({ kind: z.literal("not-run"), reason: z.string() }),
});

export type StateResult = z.infer<typeof stateResultSchema>;

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length === 0) return null;

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

export function parseProbe(stdout: string): Probe | null {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((text) => text.startsWith("{"));

  if (line === undefined) return null;

  try {
    const parsed = probeSchema.safeParse(JSON.parse(line));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** `key=value` lines into a map (the last value of a key wins). */
export function keyValues(stdout: string) {
  const values = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");

    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  return values;
}

/** The guest at one moment: directory, file, boot id, each process's identity, heartbeat. */
export const snapshotCommand = (dir: string) =>
  [
    identityFunction,
    `echo "boot=$(${bootIdCommand})"`,
    `if [ -d ${quote(dir)} ]; then echo dir=1; else echo dir=0; fi`,
    `f=${quote(`${dir}/data.bin`)}`,
    `if [ -f "$f" ]; then echo file=present; echo "size=$(wc -c < "$f" 2>/dev/null)"; echo "sha=$(sha256sum "$f" 2>/dev/null | cut -d' ' -f1)"; elif [ -d ${quote(dir)} ] || [ ! -e ${quote(dir)} ]; then echo file=absent; else echo file=unknown; fi`,
    `echo "worker=$(identity ${quote(`${dir}/worker.pid`)} ${quote(dir)})"`,
    `echo "server=$(identity ${quote(`${dir}/server.pid`)} ${quote(dir)})"`,
    `echo "beat=$(cat ${quote(`${dir}/worker.beat`)} 2>/dev/null)"`,
    "echo snapshot=done",
  ].join("\n");

export interface GuestSnapshot {
  readonly dirExists: boolean;
  readonly file: "present" | "absent" | "unknown";
  readonly size: number | null;
  readonly sha: string | null;
  readonly boot: string | null;
  readonly worker: Seen;
  readonly server: Seen;
  readonly beat: number | null;
}

/** Null when the output is not a complete snapshot (the command did not run to the end). */
export function parseSnapshot(stdout: string): GuestSnapshot | null {
  const values = keyValues(stdout);
  const dir = values.get("dir");
  const file = values.get("file");

  if (values.get("snapshot") !== "done" || (dir !== "0" && dir !== "1")) return null;

  if (file !== "present" && file !== "absent" && file !== "unknown") return null;

  const text = (key: string) => {
    const value = values.get(key);

    return value === undefined || value === "" || value === "unknown" ? null : value;
  };

  const count = (key: string) => {
    const value = text(key);

    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };

  return {
    dirExists: dir === "1",
    file,
    size: count("size"),
    sha: text("sha"),
    boot: text("boot"),
    worker: parseSeen(values.get("worker")),
    server: parseSeen(values.get("server")),
    beat: count("beat"),
  };
}

const same = (a: Seen, b: Seen) => a.kind === "alive" && b.kind === "alive" && a.id === b.id;

const pidOf = (seen: Seen) => (seen.kind === "alive" ? Number(seen.id.split(":")[0]) : null);

/**
 * Host seconds between the two snapshots' samples, bounded: at least from the first snapshot's
 * reply to the second's request, at most from the first's request to the second's reply.
 */
export interface Window {
  readonly minS: number;
  readonly maxS: number;
}

/** Judges what survived from the snapshots around the pause and the server probe after resume. */
export function judgeSurvival(input: {
  readonly before: GuestSnapshot;
  readonly after: GuestSnapshot;
  readonly later: GuestSnapshot;
  readonly token: string;
  readonly probe: Probe | null;
  readonly window: Window;
  readonly holdMs: number;
  /** The pause and resume calls' own time, when a freeze cannot be told from the hold. */
  readonly callsMs: number;
}) {
  const { before, after, later, token, probe, window, holdMs, callsMs } = input;
  const holdS = holdMs / 1000;

  const fileLost =
    !after.dirExists || after.file === "absent" || (after.sha !== null && after.sha !== before.sha);

  const filesystem = after.dirExists && after.file === "present" && after.sha === before.sha;
  const bootSame = before.boot === null || after.boot === null ? null : before.boot === after.boot;
  const workerSame = same(before.worker, after.worker) && same(before.worker, later.worker);
  const advancing = later.beat !== null && after.beat !== null && later.beat > after.beat;

  const beatsDuringHold =
    workerSame && before.beat !== null && after.beat !== null && after.beat >= before.beat
      ? after.beat - before.beat
      : null;

  const missed =
    beatsDuringHold === null
      ? null
      : {
          min: Math.round((window.minS - beatsDuringHold) * 10) / 10,
          max: Math.round((window.maxS - beatsDuringHold) * 10) / 10,
        };

  const body = probe?.ok ? probe.body : null;

  const sameProcess =
    body !== null && body.pid === pidOf(before.server) && same(before.server, after.server);

  const sameToken = sameProcess && body?.token === token;
  const memoryIntact = sameToken && body !== null && body.digestNow === body.digestAtStart;

  const worker = {
    same: workerSame,
    gone: after.worker.kind === "gone",
    beatsDuringHold,
    missedBeats: missed,
    advancing,
  };

  const server = {
    answered: body !== null,
    sameProcess,
    sameToken,
    memoryIntact,
    gone: body === null && after.server.kind === "gone",
  };

  const shared = { filesystem, bootSame, worker, server };

  const judged = (verdict: (typeof verdicts)[number], reason: string | null = null) => ({
    verdict,
    reason,
    ...shared,
  });

  if (fileLost) return judged("files-lost");

  if (!filesystem) return judged("inconclusive", "the file could not be read");

  if (bootSame === false) return judged("cold-restart");

  if (worker.gone && server.gone) return judged("cold-restart");

  if (!(workerSame && advancing && memoryIntact))
    return judged(
      "inconclusive",
      `worker ${workerSame ? (advancing ? "kept" : "kept but not beating") : after.worker.kind}, server ${memoryIntact ? "kept" : server.gone ? "gone" : server.answered ? "answered with other state" : "not answering"}`,
    );

  if (missed === null) return judged("inconclusive", "no heartbeat count across the hold");

  if (missed.min >= holdS * 0.8 && callsMs / 1000 <= holdS * 0.2) return judged("in-ram");

  if (missed.max <= holdS * 0.2) return judged("kept-running");

  return judged(
    "inconclusive",
    `the worker missed ${missed.min} to ${missed.max} s of heartbeats around a ${holdS} s hold with ${Math.round(callsMs / 100) / 10} s of pause and resume calls`,
  );
}

async function timed<T>(action: () => Promise<T>) {
  const started = performance.now();
  const value = await action();

  return { value, ms: Math.round(performance.now() - started) };
}

/** Retries `echo ok` until it answers or `limitMs` passes, timing from `since`. */
async function firstAnswer(context: CheckContext, box: Box, since: number, limitMs: number) {
  let last = "no answer";

  while (performance.now() - since < limitMs) {
    try {
      const result = await context.exec(box, "echo ok", 30_000);

      if (result.exitCode === 0 && result.stdout.includes("ok"))
        return { ok: true as const, ms: Math.round(performance.now() - since) };

      last = `exit ${result.exitCode}`;
    } catch (cause) {
      last = errorText(cause);
    }

    await sleep(1_000, undefined, { signal: context.signal });
  }

  return { ok: false as const, error: last };
}

/** Rejects when `work` has not settled within `ms`; the call itself keeps running. */
async function withLimit<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not return within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measure(context: CheckContext, options: StateOptions): Promise<StateResult> {
  const box = context.boxes[0]?.box;

  if (!box) throw new CheckStop("No sandbox");
  const found = parseRuntime((await context.exec(box, runtimeCommand, 60_000)).stdout);

  if (!found) throw new CheckStop("The image has neither node nor python3");
  const base = options.workdir ?? (await diskTarget(context, box)).dir;
  const dir = `${base}/.sbx-state-${randomBytes(4).toString("hex")}`;
  const script = guestScripts[found.runtime];
  const state = `${dir}/state.${script.extension}`;
  const run = `${quote(found.path)} ${quote(state)}`;
  const port = String(options.port);
  const pidfile = quote(`${dir}/server.pid`);
  const serverLog = quote(`${dir}/server.log`);

  /** A snapshot with the host times its request left and its reply came back. */
  const snapshot = async () => {
    const askedAt = performance.now();
    const parsed = parseSnapshot((await context.exec(box, snapshotCommand(dir), 60_000)).stdout);
    const answeredAt = performance.now();

    if (parsed === null) throw new CheckStop("A guest snapshot did not complete");

    return { ...parsed, askedAt, answeredAt };
  };

  await context.exec(box, `mkdir -p ${quote(dir)}`, 60_000);
  await box.write(state, new TextEncoder().encode(script.state));

  try {
    const beat = quote(`${dir}/worker.beat`);
    const worker = `echo $$ > ${quote(`${dir}/worker.pid`)}; i=0; while :; do i=$((i+1)); echo $i > ${beat}.tmp && mv ${beat}.tmp ${beat}; sleep 1; done`;
    const nonce = randomBytes(8).toString("hex");

    const setup = await timed(() =>
      context.exec(
        box,
        [
          `cd ${quote(dir)} || exit 1`,
          `head -c ${options.fileMiB * 1_048_576} /dev/urandom > data.bin && sync || exit 3`,
          detached(`exec ${run} serve ${port} ${pidfile} ${nonce}`, `${dir}/server.log`),
          detached(worker, `${dir}/worker.log`),
          `${run} probe ${port} ${probeMs} ${nonce}`,
        ].join("\n"),
        probeMs + 60_000,
      ),
    );

    const first = parseProbe(setup.value.stdout);

    if (!first?.ok || !first.body)
      throw new CheckStop(
        `The server did not answer after setup: exit ${setup.value.exitCode} ${errorText(setup.value.stderr).slice(-200)}`,
      );

    context.say(`${found.runtime} server up in ${first.ms} ms, setup ${setup.ms} ms`);
    const samplesMs: number[] = [];
    let failures = 0;
    let current = first.body.nonce;

    for (let index = 0; index < options.restarts; index++) {
      const restarted = parseProbe(
        (
          await context.exec(
            box,
            `${run} restart ${port} ${pidfile} ${serverLog} ${probeMs}`,
            probeMs + 30_000,
          )
        ).stdout,
      );

      if (restarted?.ok && restarted.body) {
        samplesMs.push(restarted.ms);
        current = restarted.body.nonce;
      } else failures++;
    }

    const restart = { samplesMs, medianMs: median(samplesMs), failures };
    await context.note("restart", restart);
    context.say(`restart median ${restart.medianMs ?? "?"} ms (${failures} failed)`);

    const result = {
      runtime: found.runtime,
      workdir: dir,
      fileMiB: options.fileMiB,
      setupMs: setup.ms,
      restart,
      stopStart: {
        kind: "not-run" as const,
        reason: "The SDK has no portable stop and start call",
      },
    };

    if (box.suspend.kind === "none")
      return { ...result, suspend: { kind: "unsupported", reason: box.suspend.reason } };

    const probeServer = async (timeoutMs: number) =>
      parseProbe(
        (
          await context.exec(
            box,
            `${run} probe ${port} ${timeoutMs} ${current}`,
            timeoutMs + 60_000,
          )
        ).stdout,
      );

    const serving = await probeServer(probeMs);

    if (!serving?.ok || !serving.body)
      throw new CheckStop("The server stopped answering before the pause");
    const before = await snapshot();

    if (
      before.file !== "present" ||
      before.size !== options.fileMiB * 1_048_576 ||
      before.sha === null ||
      before.worker.kind !== "alive" ||
      before.server.kind !== "alive" ||
      before.beat === null
    )
      throw new CheckStop(`The baseline is incomplete: ${JSON.stringify(before)}`);

    const { pause, resume } = box.suspend;
    let pauseMs: number | null = null;
    let resumeMs: number | null = null;

    const refused = (stage: "pause" | "resume" | "first-command", error: string): StateResult => ({
      ...result,
      suspend: { kind: "refused", stage, error, pauseMs, resumeMs },
    });

    try {
      pauseMs = (await timed(() => withLimit(pause(), suspendCallMs, "pause"))).ms;
    } catch (cause) {
      return refused("pause", errorText(cause));
    }

    context.say(`paused in ${pauseMs} ms; holding ${options.holdMs / 1000} s`);
    await sleep(options.holdMs, undefined, { signal: context.signal });

    try {
      resumeMs = (await timed(() => withLimit(resume(), suspendCallMs, "resume"))).ms;
    } catch (cause) {
      return refused("resume", errorText(cause));
    }

    const resumedAt = performance.now();
    const answered = await firstAnswer(context, box, resumedAt, firstCommandMs);

    if (!answered.ok) return refused("first-command", answered.error);
    let probe = await probeServer(quickProbeMs);
    let servingMs = probe?.ok ? Math.round(performance.now() - resumedAt) : null;
    const after = await snapshot();
    let serverRestarted = false;
    let coldServeMs: number | null = null;

    // Still alive but slow to answer: give it longer before judging.
    if (!probe?.ok && after.server.kind === "alive") {
      probe = await probeServer(resumedProbeMs);
      servingMs = probe?.ok ? Math.round(performance.now() - resumedAt) : null;
    }

    // A confirmed-gone server is the cold path an agent would take: start it again. Serving is then
    // the first command plus the guest-timed restart, leaving out the harness's own checks.
    if (!probe?.ok && after.server.kind === "gone") {
      serverRestarted = true;

      const again = parseProbe(
        (
          await context.exec(
            box,
            `${run} restart ${port} ${pidfile} ${serverLog} ${probeMs}`,
            probeMs + 30_000,
          )
        ).stdout,
      );

      coldServeMs = again?.ok ? Math.round(answered.ms + again.ms) : null;
    }

    await sleep(2_500, undefined, { signal: context.signal });
    const later = await snapshot();

    const judged = judgeSurvival({
      before,
      after,
      later,
      token: serving.body.token,
      probe,
      window: {
        minS: (after.askedAt - before.answeredAt) / 1000,
        maxS: (after.answeredAt - before.askedAt) / 1000,
      },
      holdMs: options.holdMs,
      callsMs: pauseMs + resumeMs,
    });

    context.say(
      `resume: ${judged.verdict}${judged.reason ? ` (${judged.reason})` : ""}; first command ${answered.ms} ms, serving ${servingMs ?? coldServeMs ?? "?"} ms`,
    );

    return {
      ...result,
      suspend: {
        kind: "measured",
        holdMs: options.holdMs,
        pauseMs,
        resumeMs,
        firstCommandMs: answered.ms,
        servingMs,
        serverRestarted,
        coldServeMs,
        ...judged,
      },
    };
  } finally {
    await context
      .execCleanup(
        box,
        [
          ownKillFunction,
          `ownkill ${pidfile} ${quote(dir)}`,
          `ownkill ${quote(`${dir}/worker.pid`)} ${quote(dir)}`,
        ].join("\n"),
        30_000,
      )
      .catch(() => undefined);
  }
}

export const stateSurvivalCheck = (
  options: StateOptions = defaultStateOptions,
): Check<StateResult> => {
  const lifetimeMs = 20 * 60_000 + options.holdMs;

  return {
    id: "state-survival",
    boxes: 1,
    minBoxes: 1,
    lifetimeMs,
    resultSchema: stateResultSchema,
    // The check ends a minute before the sandbox's lifetime, so cleanup still finds it.
    run: (context) => deadline(lifetimeMs - 60_000, () => measure(context, options)),
  };
};

export const stateSurvival = stateSurvivalCheck();
