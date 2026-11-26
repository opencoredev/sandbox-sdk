/**
 * state-survival: what a sandbox keeps across the adapter's pause and resume, and how fast a killed
 * process comes back.
 *
 * 1. Setup, in the disk test's directory: a 16 MiB random file (sha256 noted), an HTTP server that
 *    holds a random token and 32 MiB of random bytes in memory, and a shell worker that rewrites a
 *    heartbeat file every second. Both run detached from the exec, as an agent's dev server would.
 * 2. Restart speed: `restarts` times, SIGKILL the server and start it again; the guest times each
 *    from the kill to the new pid answering on its port.
 * 3. Pause and resume (only where the adapter has both): pause, hold `holdMs`, resume, then time the
 *    first command that answers. Check the file's sha256, the boot id, the worker (same pid and
 *    start time, heartbeat moving again) and the server (same token, memory digest unchanged).
 *    A server that is gone is started again and timed, so `servingMs` is resume-to-serving either way.
 *
 * Verdicts: `in-ram` when the server, its memory, the worker and the boot id all survived a frozen
 * hold; `kept-running` when they survived because the worker beat through the hold (the pause did
 * not suspend the guest); `cold-restart`
 * when the files survived but the processes did not; `files-lost` when the file did not. A pause or
 * resume the provider refuses is recorded with its error. The SDK has no portable stop and start, so
 * that half is recorded as not run rather than guessed.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { quote } from "../workloads.js";
import { diskTarget } from "./disk-real.js";
import { CheckStop, errorText, type Box, type Check, type CheckContext } from "./framework.js";
import {
  bootIdCommand,
  detached,
  guestScripts,
  parseRuntime,
  runtimeCommand,
  runtimes,
} from "./guest-scripts.js";

export interface StateOptions {
  readonly holdMs: number;
  readonly restarts: number;
  readonly port: number;
  readonly fileMiB: number;
}

export const defaultStateOptions: StateOptions = {
  holdMs: 60_000,
  restarts: 5,
  port: 18_731,
  fileMiB: 16,
};

/** Each pause or resume call may take this long before it counts as failed. */
const suspendCallMs = 5 * 60_000;
/** How long after resume the first command may take to answer. */

const firstCommandMs = 3 * 60_000;
const probeMs = 30_000;

const probeSchema = z.object({
  ok: z.boolean(),
  ms: z.number(),
  body: z
    .object({
      token: z.string(),
      pid: z.number().int(),
      digestAtStart: z.string(),
      digestNow: z.string(),
      upMs: z.number(),
    })
    .nullable(),
});

type Probe = z.infer<typeof probeSchema>;

const workerSchema = z.object({
  alive: z.boolean(),
  sameStart: z.boolean(),
  /** Heartbeats between the snapshots either side of the pause; null when the worker restarted. */
  beatsDuringHold: z.number().int().nullable(),
  /** The worker beat through at least half the hold, so the pause did not freeze it. */
  keptRunning: z.boolean(),
  advancing: z.boolean(),
});

const serverSchema = z.object({
  answered: z.boolean(),
  sameToken: z.boolean(),
  memoryIntact: z.boolean(),
});

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
    verdict: z.enum(["in-ram", "kept-running", "cold-restart", "files-lost"]),
    holdMs: z.number(),
    pauseMs: z.number(),
    resumeMs: z.number(),
    /** From resume returning to the first command answering. */
    firstCommandMs: z.number(),
    /** From resume returning to the server answering, restarting it when it is gone. */
    servingMs: z.number().nullable(),
    /** The server had to be started again after resume. */
    serverRestarted: z.boolean(),
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

export type Suspended = z.infer<typeof suspendSchema>;

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

/** What the guest looked like at one moment: file digest, boot id, worker pid, start and beat. */
export const snapshotCommand = (dir: string) =>
  [
    `cd ${quote(dir)} || exit 1`,
    `echo "sha=$(sha256sum data.bin 2>/dev/null | cut -d' ' -f1)"`,
    `echo "boot=$(${bootIdCommand})"`,
    `p=$(cat worker.pid 2>/dev/null); echo "workerPid=$p"`,
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then echo "workerStart=$(cut -d' ' -f22 /proc/$p/stat 2>/dev/null)"; else echo workerStart=; fi`,
    `echo "beat=$(cut -d' ' -f1 worker.beat 2>/dev/null)"`,
  ].join("\n");

export interface GuestSnapshot {
  readonly sha: string | null;
  readonly boot: string | null;
  readonly workerPid: string | null;
  readonly workerStart: string | null;
  readonly beat: number | null;
}

export function parseSnapshot(stdout: string): GuestSnapshot {
  const values = keyValues(stdout);

  const text = (key: string) => {
    const value = values.get(key);

    return value === undefined || value === "" || value === "unknown" ? null : value;
  };

  const beat = text("beat");

  return {
    sha: text("sha"),
    boot: text("boot"),
    workerPid: text("workerPid"),
    workerStart: text("workerStart"),
    beat: beat !== null && /^\d+$/.test(beat) ? Number(beat) : null,
  };
}

/** Judges what survived from the snapshots and probe around the pause. */
export function judgeSurvival(input: {
  readonly before: GuestSnapshot;
  readonly after: GuestSnapshot;
  readonly later: GuestSnapshot;
  readonly server: { readonly token: string };
  readonly probe: Probe | null;
  readonly holdMs: number;
}) {
  const { before, after, later, server, probe, holdMs } = input;
  const filesystem = before.sha !== null && after.sha === before.sha;
  const bootSame = before.boot === null || after.boot === null ? null : before.boot === after.boot;
  const alive = after.workerStart !== null && after.workerPid === before.workerPid;
  const sameStart = alive && after.workerStart === before.workerStart;

  const beatsDuringHold =
    sameStart && before.beat !== null && after.beat !== null && after.beat >= before.beat
      ? after.beat - before.beat
      : null;

  // A worker that beat through most of the hold was never frozen: the pause did not suspend it.
  const keptRunning = beatsDuringHold !== null && beatsDuringHold >= holdMs / 2_000;

  const advancing = later.beat !== null && after.beat !== null && later.beat > after.beat;
  const body = probe?.ok ? probe.body : null;
  const answered = body !== null;
  const sameToken = body?.token === server.token;
  const memoryIntact = sameToken && body !== null && body.digestNow === body.digestAtStart;

  const survived = sameToken && memoryIntact && sameStart && advancing && bootSame !== false;

  const verdict = !filesystem
    ? ("files-lost" as const)
    : !survived
      ? ("cold-restart" as const)
      : keptRunning
        ? ("kept-running" as const)
        : ("in-ram" as const);

  return {
    verdict,
    filesystem,
    bootSame,
    worker: { alive, sameStart, beatsDuringHold, keptRunning, advancing },
    server: { answered, sameToken, memoryIntact },
  };
}

async function timed<T>(action: () => Promise<T>) {
  const started = performance.now();
  const value = await action();

  return { value, ms: Math.round(performance.now() - started) };
}

/** Runs `command` until it exits 0, for up to `limitMs`; the time from the first try to success. */
async function firstAnswer(context: CheckContext, box: Box, limitMs: number) {
  const started = performance.now();
  let last = "no answer";

  while (performance.now() - started < limitMs) {
    try {
      const result = await context.exec(box, "echo ok", 30_000);

      if (result.exitCode === 0 && result.stdout.includes("ok"))
        return { ok: true as const, ms: Math.round(performance.now() - started) };
      last = `exit ${result.exitCode}`;
    } catch (cause) {
      last = errorText(cause);
    }

    await sleep(1_000, undefined, { signal: context.signal });
  }

  return { ok: false as const, error: last };
}

export const stateSurvivalCheck = (
  options: StateOptions = defaultStateOptions,
): Check<StateResult> => ({
  id: "state-survival",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 20 * 60_000 + options.holdMs,
  resultSchema: stateResultSchema,
  async run(context) {
    const box = context.boxes[0]?.box;

    if (!box) throw new CheckStop("No sandbox");
    const found = parseRuntime((await context.exec(box, runtimeCommand, 60_000)).stdout);

    if (!found) throw new CheckStop("The image has neither node nor python3");
    const target = await diskTarget(context, box);
    const dir = `${target.dir}/.sbx-state`;
    const script = guestScripts[found.runtime];
    const state = `${dir}/state.${script.extension}`;
    const rt = quote(found.path);
    const port = String(options.port);
    const pidfile = `${dir}/server.pid`;
    const serverLog = `${dir}/server.log`;
    await context.exec(box, `mkdir -p ${quote(dir)}`, 60_000);
    await box.write(state, new TextEncoder().encode(script.state));

    try {
      const worker = `echo $$ > ${quote(`${dir}/worker.pid`)}; i=0; while :; do i=$((i+1)); echo "$i $(date +%s)" > ${quote(`${dir}/worker.beat.tmp`)} && mv ${quote(`${dir}/worker.beat.tmp`)} ${quote(`${dir}/worker.beat`)}; sleep 1; done`;

      const setup = await timed(() =>
        context.exec(
          box,
          [
            `cd ${quote(dir)} || exit 1`,
            `head -c ${options.fileMiB * 1_048_576} /dev/urandom > data.bin && sync`,
            detached(`exec ${rt} ${quote(state)} serve ${port} ${quote(pidfile)}`, serverLog),
            detached(worker, `${dir}/worker.log`),
            `${rt} ${quote(state)} probe ${port} ${probeMs}`,
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

      for (let index = 0; index < options.restarts; index++) {
        const restarted = parseProbe(
          (
            await context.exec(
              box,
              `${rt} ${quote(state)} restart ${port} ${quote(pidfile)} ${quote(serverLog)} ${probeMs}`,
              probeMs + 30_000,
            )
          ).stdout,
        );

        if (restarted?.ok) samplesMs.push(restarted.ms);
        else failures++;
      }

      const restart = { samplesMs, medianMs: median(samplesMs), failures };
      await context.note("restart", restart);
      context.say(`restart median ${restart.medianMs ?? "?"} ms (${failures} failed)`);

      const base = {
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
        return { ...base, suspend: { kind: "unsupported", reason: box.suspend.reason } };

      const current = parseProbe(
        (
          await context.exec(
            box,
            `${rt} ${quote(state)} probe ${port} ${probeMs}`,
            probeMs + 30_000,
          )
        ).stdout,
      );

      if (!current?.ok || !current.body)
        throw new CheckStop("The server stopped answering before the pause");
      const server = { token: current.body.token };
      const before = parseSnapshot((await context.exec(box, snapshotCommand(dir), 60_000)).stdout);
      const { pause, resume } = box.suspend;
      let pauseMs: number | null = null;
      let resumeMs: number | null = null;

      const refused = (stage: "pause" | "resume" | "first-command", error: string) => ({
        ...base,
        suspend: { kind: "refused" as const, stage, error, pauseMs, resumeMs },
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

      const answered = await firstAnswer(context, box, firstCommandMs);

      if (!answered.ok) return refused("first-command", answered.error);
      const servingStart = performance.now();
      const after = parseSnapshot((await context.exec(box, snapshotCommand(dir), 60_000)).stdout);

      const probe = parseProbe(
        (await context.exec(box, `${rt} ${quote(state)} probe ${port} 2000`, 60_000)).stdout,
      );

      let serverRestarted = false;

      let servingMs: number | null = probe?.ok
        ? Math.round(performance.now() - servingStart)
        : null;

      // A gone server is the cold path an agent would take: start it again and time it to serving.
      if (!probe?.ok) {
        serverRestarted = true;

        const again = parseProbe(
          (
            await context.exec(
              box,
              `${rt} ${quote(state)} restart ${port} ${quote(pidfile)} ${quote(serverLog)} ${probeMs}`,
              probeMs + 30_000,
            )
          ).stdout,
        );

        servingMs = again?.ok ? Math.round(performance.now() - servingStart) : null;
      }

      await sleep(2_500, undefined, { signal: context.signal });
      const later = parseSnapshot((await context.exec(box, snapshotCommand(dir), 60_000)).stdout);
      const judged = judgeSurvival({ before, after, later, server, probe, holdMs: options.holdMs });
      context.say(
        `resume: ${judged.verdict} (first command ${answered.ms} ms, serving ${servingMs ?? "?"} ms)`,
      );

      return {
        ...base,
        suspend: {
          kind: "measured",
          holdMs: options.holdMs,
          pauseMs,
          resumeMs,
          firstCommandMs: answered.ms,
          servingMs,
          serverRestarted,
          ...judged,
        },
      };
    } finally {
      await context
        .execCleanup(
          box,
          `for f in server.pid worker.pid; do kill -9 "$(cat ${quote(dir)}/$f 2>/dev/null)" 2>/dev/null; done; true`,
          30_000,
        )
        .catch(() => undefined);
    }
  },
});

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

export const stateSurvival = stateSurvivalCheck();
