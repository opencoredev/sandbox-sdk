/**
 * state-survival and memory-pressure: the judges on their own, the guest programs in each runtime the
 * host has, and both checks end to end on this machine with the host standing in for a sandbox.
 * Every fixture lives in its own temporary directory and only signals processes it started.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { admitWithin, parseCli } from "../../src/fairness/cli.js";
import {
  reportSchema,
  runCheck,
  type Box,
  type Check,
  type OpenSession,
  type Suspend,
} from "../../src/fairness/framework.js";
import {
  guestScripts,
  ownKillFunction,
  runtimes,
  stampFunction,
} from "../../src/fairness/guest-scripts.js";
import {
  defaultPressureOptions,
  judgePressure,
  memoryPressureCheck,
  parseHogLog,
  scopeOf,
  thinProgress,
} from "../../src/fairness/memory-pressure.js";
import {
  defaultStateOptions,
  judgeSurvival,
  parseProbe,
  parseSnapshot,
  stateSurvivalCheck,
  type GuestSnapshot,
  type Probe,
} from "../../src/fairness/state-survival.js";
import { providerSetup } from "../../src/realistic/setup.js";
import { hostBox, hostSession } from "./host-box.js";

const setup = providerSetup("e2b");
const linux = platform() === "linux";
const port = () => 20_000 + Math.floor(Math.random() * 20_000);
const noSignal = new AbortController().signal;
const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0;
const available = runtimes.filter((runtime) => linux && has(runtime));
const scratch = (name: string) => mkdtemp(join(tmpdir(), `${name}-`));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
};

async function runOnHost<R>(check: Check<R>, open: OpenSession) {
  const out = await scratch(`fairness-${check.id}`);

  await runCheck(
    check,
    [setup],
    { runId: "host-test", out, concurrency: 1 },
    { open, signal: noSignal, progress: () => {}, retryDelayMs: 0, lateSweepDelayMs: 0 },
  );

  const report = reportSchema.parse(
    JSON.parse(await readFile(join(out, `${check.id}.json`), "utf8")),
  );

  const entry = report.providers[0];

  if (!entry) throw new Error("no entry");

  return entry;
}

const alive_ = (id: string) => ({ kind: "alive" as const, id });
const gone = { kind: "gone" as const };
const unknown = { kind: "unknown" as const };

const snapshot = (over: Partial<GuestSnapshot> = {}): GuestSnapshot => ({
  dir: "present",
  file: "present",
  size: 1_048_576,
  sha: "abc",
  boot: "boot-1",
  worker: alive_("41:1000"),
  server: alive_("7:2000"),
  beat: 10,
  ...over,
});

const answer = (token: string, over: Partial<NonNullable<Probe["body"]>> = {}): Probe => ({
  ok: true,
  ms: 3,
  body: { nonce: "n", token, pid: 7, digestAtStart: "d", digestNow: "d", upMs: 1, ...over },
});

describe("state-survival judge", () => {
  const base = {
    before: snapshot(),
    token: "t",
    holdMs: 60_000,
    window: { minS: 64, maxS: 66 },
  };

  const kept = { later: snapshot({ beat: 80 }), probe: answer("t") };

  it("calls a frozen hold that kept everything in-ram", () => {
    const judged = judgeSurvival({ ...base, ...kept, after: snapshot({ beat: 12 }) });
    expect(judged.verdict).toBe("in-ram");
    expect(judged.worker).toMatchObject({
      same: true,
      beatsDuringHold: 2,
      missedBeats: { min: 62, max: 64 },
      advancing: true,
    });
    expect(judged.server).toEqual({
      answered: true,
      sameProcess: true,
      sameToken: true,
      memoryIntact: true,
      gone: false,
    });
  });

  it("tells a pause that never froze the guest, and a partial freeze, from a frozen one", () => {
    expect(judgeSurvival({ ...base, ...kept, after: snapshot({ beat: 74 }) }).verdict).toBe(
      "kept-running",
    );
    const partial = judgeSurvival({ ...base, ...kept, after: snapshot({ beat: 40 }) });
    expect(partial.verdict).toBe("inconclusive");
    expect(partial.reason).toMatch(/missed 34 to 36 s/);
  });

  it("does not credit a freeze outside the hold to the hold", () => {
    // Long pause and resume calls: the beats missed during them could account for the shortfall.
    const slowCalls = judgeSurvival({
      ...base,
      ...kept,
      after: snapshot({ beat: 12 }),
      window: { minS: 64, maxS: 80 },
    });

    expect(slowCalls.verdict).toBe("inconclusive");

    // The worker beat through the hold, then froze for a minute after resume.
    const afterResume = judgeSurvival({
      ...base,
      ...kept,
      after: snapshot({ beat: 70 }),
      window: { minS: 120, maxS: 122 },
    });

    expect(afterResume.verdict).toBe("inconclusive");
    // A snapshot answered late widens the window, so the missed range is too wide to call either way.

    const late = judgeSurvival({
      ...base,
      ...kept,
      after: snapshot({ beat: 40 }),
      window: { minS: 31, maxS: 90 },
    });

    expect(late.verdict).toBe("inconclusive");
  });

  it("calls a cold restart only on a new boot or both processes confirmed gone", () => {
    const bothGone = snapshot({ worker: gone, server: gone });
    expect(judgeSurvival({ ...base, after: bothGone, later: bothGone, probe: null }).verdict).toBe(
      "cold-restart",
    );
    // Processes that could not be read are not processes lost.
    const unread = snapshot({ worker: unknown, server: unknown });
    expect(judgeSurvival({ ...base, after: unread, later: unread, probe: null })).toMatchObject({
      verdict: "inconclusive",
      worker: { gone: false },
      server: { gone: false },
    });
    const rebooted = snapshot({ boot: "boot-2", beat: 11 });
    expect(judgeSurvival({ ...base, ...kept, after: rebooted }).verdict).toBe("cold-restart");
    // A server that is alive but not answering, or only one process gone, is not enough.

    const slow = judgeSurvival({
      ...base,
      after: snapshot({ beat: 12 }),
      later: snapshot({ beat: 14 }),
      probe: null,
    });

    expect(slow).toMatchObject({
      verdict: "inconclusive",
      server: { gone: false, answered: false },
    });
    const half = snapshot({ worker: gone });
    expect(judgeSurvival({ ...base, after: half, later: half, probe: answer("t") }).verdict).toBe(
      "inconclusive",
    );
  });

  it("does not credit changed memory or another process on the port", () => {
    const changed = judgeSurvival({
      ...base,
      ...kept,
      after: snapshot({ beat: 12 }),
      probe: answer("t", { digestNow: "x" }),
    });

    expect(changed).toMatchObject({ verdict: "inconclusive", server: { memoryIntact: false } });

    const other = judgeSurvival({
      ...base,
      ...kept,
      after: snapshot({ beat: 12 }),
      probe: answer("t", { pid: 99 }),
    });

    expect(other.server).toMatchObject({ answered: true, sameProcess: false, sameToken: false });
  });

  it("calls a missing directory or file, or a changed file, files-lost", () => {
    for (const after of [
      snapshot({ dir: "absent", file: "unknown", sha: null }),
      snapshot({ file: "absent", sha: null, size: null }),
      snapshot({ sha: "def" }),
    ])
      expect(judgeSurvival({ ...base, ...kept, after }).verdict).toBe("files-lost");
  });

  it("calls a file it could not read inconclusive, not lost", () => {
    for (const after of [
      snapshot({ file: "unknown", sha: null }),
      snapshot({ sha: null }),
      snapshot({ dir: "unknown", file: "unknown", sha: null }),
    ])
      expect(judgeSurvival({ ...base, ...kept, after })).toMatchObject({
        verdict: "inconclusive",
        reason: "the file could not be read",
      });
  });

  it("parses only complete snapshots and probe lines", () => {
    expect(
      parseSnapshot(
        "boot=unknown\ndir=present\nfile=present\nsize=1048576\nsha=aa\nworker=9:5\nserver=gone\nbeat=12\nsnapshot=done\n",
      ),
    ).toEqual({
      dir: "present",
      file: "present",
      size: 1_048_576,
      sha: "aa",
      boot: null,
      worker: alive_("9:5"),
      server: gone,
      beat: 12,
    });
    expect(
      parseSnapshot(
        "boot=b\ndir=unknown\nfile=unknown\nworker=\nserver=unknown\nbeat=\nsnapshot=done\n",
      ),
    ).toMatchObject({ file: "unknown", worker: unknown, server: unknown, beat: null });
    expect(parseSnapshot("boot=b\ndir=present\nfile=present\nsha=aa\n")).toBeNull();
    expect(parseSnapshot("boot=b\ndir=1\nfile=present\nsha=aa\nsnapshot=done\n")).toBeNull();
    expect(parseProbe('noise\n{"ok":false,"ms":30001,"body":null}\n')).toEqual({
      ok: false,
      ms: 30_001,
      body: null,
    });
    expect(parseProbe("not json")).toBeNull();
  });
});

describe("memory-pressure judge", () => {
  const log = (text: string) => parseHogLog(text);
  const held = log("held 64 1\n");
  const base = { oomDelta: 0, bootSame: true, log: held };

  it("reads the hog's progress, keeping the amount it held when refused", () => {
    expect(log("held 64 10\nheld 128 22\nreached 128 23\n")).toMatchObject({
      heldMiB: 128,
      reached: true,
      refused: null,
    });
    expect(log("refused 128 MemoryError\n")).toMatchObject({
      heldMiB: 128,
      refused: "MemoryError",
    });
    expect(
      thinProgress([
        { mib: 512, ms: 1 },
        { mib: 576, ms: 2 },
        { mib: 1024, ms: 3 },
        { mib: 1088, ms: 4 },
      ]),
    ).toEqual([
      { mib: 512, ms: 1 },
      { mib: 1024, ms: 3 },
      { mib: 1088, ms: 4 },
    ]);
  });

  it("judges each ending from its evidence only", () => {
    const exited = (exitCode: number) => ({ kind: "exited" as const, exitCode });
    expect(judgePressure({ ...base, ending: exited(0), log: log("reached 64 1\n") })).toEqual({
      kind: "reached-target",
    });
    expect(judgePressure({ ...base, ending: exited(137) })).toEqual({
      kind: "process-killed",
      exitCode: 137,
      oomKills: 0,
    });
    expect(judgePressure({ ...base, ending: exited(3), log: log("refused 64 ENOMEM\n") })).toEqual({
      kind: "refused",
      reason: "ENOMEM",
    });
    // SIGKILL after a refusal line is still a kill.
    expect(
      judgePressure({ ...base, ending: exited(137), log: log("refused 64 ENOMEM\n") }),
    ).toMatchObject({ kind: "process-killed", exitCode: 137 });
    // Gone with its supervisor and no status is a vanish, whatever the shared OOM counter says.
    expect(judgePressure({ ...base, ending: { kind: "vanished" }, oomDelta: 2 })).toEqual({
      kind: "vanished",
      oomKills: 2,
    });
    expect(judgePressure({ ...base, ending: { kind: "stalled" } })).toEqual({ kind: "stalled" });
    expect(judgePressure({ ...base, ending: { kind: "restarted" } })).toEqual({
      kind: "sandbox-restarted",
    });
    expect(judgePressure({ ...base, ending: exited(137), bootSame: false })).toEqual({
      kind: "sandbox-restarted",
    });
    expect(judgePressure({ ...base, ending: { kind: "lost", detail: "404" } })).toEqual({
      kind: "sandbox-lost",
      detail: "404",
    });
    expect(judgePressure({ ...base, ending: { kind: "unresponsive", detail: "x" } })).toMatchObject(
      { kind: "unresponsive" },
    );
    // A cgroup-wide OOM count does not make an ordinary exit, a runtime abort or a vanish a kill.
    expect(() => judgePressure({ ...base, ending: exited(1), oomDelta: 1 })).toThrow(
      /no kill evidence/,
    );
    expect(() => judgePressure({ ...base, ending: exited(134) })).toThrow(/no kill evidence/);
    // A refusal line is a refusal only with the hog's own exit 3.
    expect(() =>
      judgePressure({ ...base, ending: exited(143), log: log("refused 64 ENOMEM\n") }),
    ).toThrow(/no kill evidence/);
  });

  it("scopes a kill to the process only with a live canary", () => {
    const killed = { kind: "process-killed" as const, exitCode: 137, oomKills: 1 };
    expect(scopeOf(killed, true)).toBe("process");
    expect(scopeOf(killed, false)).toBe("collateral");
    expect(scopeOf(killed, null)).toBeNull();
    expect(scopeOf({ kind: "sandbox-lost", detail: "" }, null)).toBe("sandbox");
    expect(scopeOf({ kind: "reached-target" }, true)).toBeNull();
    expect(scopeOf({ kind: "vanished", oomKills: null }, true)).toBe("process");
    expect(scopeOf({ kind: "vanished", oomKills: null }, null)).toBeNull();
  });
});

describe("fairness CLI spend cap", () => {
  it("parses --max-dollars and leaves it off by default", () => {
    expect(
      parseCli(["state-survival", "--providers", "e2b", "--max-dollars", "2.5"]).maxDollars,
    ).toBe(2.5);
    expect(parseCli(["memory-pressure", "--providers", "e2b"]).maxDollars).toBeNull();
    expect(() => parseCli(["memory-pressure", "--max-dollars", "0"])).toThrow();
  });

  it("admits providers in order until the next reservation would pass the cap", () => {
    const setups = ["e2b", "daytona", "modal"].map((name) => providerSetup(name));
    const all = admitWithin({ setups, boxes: 1, lifetimeMs: 25 * 60_000, maxDollars: null });
    expect(all.refused).toHaveLength(0);
    const first = all.admitted[0]?.usd ?? 0;
    expect(first).toBeGreaterThan(0);
    const capped = admitWithin({ setups, boxes: 1, lifetimeMs: 25 * 60_000, maxDollars: first });
    expect(capped.admitted.map((entry) => entry.setup.name)).toEqual(["e2b"]);
    expect(capped.refused.map((entry) => entry.setup.name)).toEqual(["daytona", "modal"]);
    expect(capped.reservedUSD).toBeCloseTo(first);
  });
});

/** Runs a guest program on the host and returns its stdout. */
function run(argv: readonly string[], options: { readonly shell?: string } = {}) {
  const [bin = "", ...rest] = argv;

  const result =
    options.shell === undefined
      ? spawnSync(bin, rest, { encoding: "utf8" })
      : spawnSync("sh", ["-c", options.shell], { encoding: "utf8" });

  return result.stdout;
}

describe.each(available)("guest programs in %s", (runtime) => {
  const script = guestScripts[runtime];

  async function fixture() {
    const dir = await scratch(`guest-${runtime}`);
    const state = join(dir, `state.${script.extension}`);
    await writeFile(state, script.state);

    return { dir, state, pidfile: join(dir, "server.pid"), log: join(dir, "server.log") };
  }

  /** An unrelated process this test owns, so a wrong signal shows as its death. */
  function bystander() {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });

    return { pid: child.pid ?? -1, stop: () => child.kill("SIGKILL") };
  }

  it("restarts only its own server, and accepts only the child it started", async () => {
    const { state, pidfile, log } = await fixture();
    const at = String(port());
    const other = bystander();

    try {
      // No pid file, a pid of -1, another process's bare pid, and its pid with another start time:
      // each only starts a server, and says it signalled nothing.
      for (const content of [null, "-1", String(other.pid), `${other.pid} 1`]) {
        if (content !== null) await writeFile(pidfile, content);
        const started = parseProbe(run([runtime, state, "restart", at, pidfile, log, "10000"]));
        expect(started?.ok, String(content)).toBe(true);
        expect(started?.killed, String(content)).toBe(false);
        expect(alive(other.pid)).toBe(true);
        expect(Number((await readFile(pidfile, "utf8")).split(" ")[0])).toBe(started?.body?.pid);
        // Stop it between cases so the next one starts clean.
        run([], { shell: `${ownKillFunction}\nownkill '${pidfile}'` });
        await sleep(100);
      }

      const first = parseProbe(run([runtime, state, "restart", at, pidfile, log, "10000"]));
      const second = parseProbe(run([runtime, state, "restart", at, pidfile, log, "10000"]));
      expect(second?.ok).toBe(true);
      expect(second?.killed).toBe(true);
      expect(second?.body?.pid).not.toBe(first?.body?.pid);
      expect(second?.body?.nonce).not.toBe(first?.body?.nonce);
      expect(second?.ms).toBeGreaterThan(0);
      await sleep(100);
      expect(alive(first?.body?.pid ?? -1)).toBe(false);
      // A probe for a nonce nobody launched never counts the listener that is there.
      expect(parseProbe(run([runtime, state, "probe", at, "300", "nobody"]))?.ok).toBe(false);
      expect(
        parseProbe(run([runtime, state, "probe", at, "3000", second?.body?.nonce ?? ""]))?.body
          ?.token,
      ).toBe(second?.body?.token);
    } finally {
      run([], { shell: `${ownKillFunction}\nownkill '${pidfile}'` });
      other.stop();
    }
  }, 60_000);

  it("ownkill signals only the process whose stamp the pid file holds", async () => {
    const { pidfile } = await fixture();
    const other = bystander();
    const kill = () => run([], { shell: `${ownKillFunction}\nownkill '${pidfile}'` });

    try {
      // A bare pid, a negative one, and the right pid with a wrong start time are all left alone.
      for (const content of [String(other.pid), "-1", `${other.pid} 1`]) {
        await writeFile(pidfile, content);
        kill();
      }

      await sleep(100);
      expect(alive(other.pid)).toBe(true);
      // Its own stamp, as the process would have written it, is what lets the signal through.
      run([], { shell: `${stampFunction}\nstamp ${other.pid} > '${pidfile}'` });
      kill();
      await sleep(100);
      expect(alive(other.pid)).toBe(false);
    } finally {
      other.stop();
    }
  });

  it("the hog reaches a small target and reports what it held when refused", async () => {
    const dir = await scratch(`hog-${runtime}`);
    const hog = join(dir, `hog.${script.extension}`);
    await writeFile(hog, script.hog);
    expect(parseHogLog(run([runtime, hog, "128", "64"]))).toMatchObject({
      heldMiB: 128,
      reached: true,
    });

    // Python runs under a 400 MiB address-space cap; Node needs more than that to start at all.
    if (runtime === "python3") {
      const refused = parseHogLog(run([], { shell: `ulimit -v 409600; python3 '${hog}' 1024 64` }));
      expect(refused.refused).toBe("MemoryError");
      expect(refused.heldMiB).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe.runIf(linux && available.length > 0)(
  "state-survival and memory-pressure on this machine",
  () => {
    const plan = async (holdMs: number) => ({
      ...defaultStateOptions,
      holdMs,
      restarts: 2,
      fileMiB: 1,
      port: port(),
      workdir: await scratch("state-work"),
    });

    /** A pause that signals this attempt's server and worker, each only after its stamp checks out. */
    const signalling =
      (workdir: string, signal: string): (() => Promise<void>) =>
      async () => {
        run([], {
          shell: `${ownKillFunction}\nfor f in '${workdir}'/.sbx-state-*/server.pid '${workdir}'/.sbx-state-*/worker.pid; do ownkill "$f" ${signal}; done; true`,
        });
      };

    it("times restarts and reports no pause where there is none", async () => {
      const options = await plan(1_000);
      const check = stateSurvivalCheck(options);
      const entry = await runOnHost(check, hostSession().open);
      expect(entry.status, entry.reason ?? "").toBe("completed");
      const result = check.resultSchema.parse(entry.result);
      expect(result.restart).toMatchObject({ failures: 0, startsOnly: 0 });
      expect(result.restart.samplesMs).toHaveLength(2);
      expect(result.restart.medianMs).toBeGreaterThan(0);
      expect(result.workdir.startsWith(options.workdir ?? "")).toBe(true);
      expect(result.suspend).toEqual({ kind: "unsupported", reason: "The host has no pause" });
    }, 60_000);

    it("calls a real freeze in-ram and a pause that froze nothing kept-running", async () => {
      // Long enough that a 2 s beat-sampling allowance and the calls around it still leave a clear freeze.
      const frozen = await plan(30_000);

      const freeze: Suspend = {
        kind: "pause",
        pause: signalling(frozen.workdir ?? "", "STOP"),
        resume: signalling(frozen.workdir ?? "", "CONT"),
      };

      const check = stateSurvivalCheck(frozen);
      const entry = await runOnHost(check, hostSession({ suspend: freeze }).open);
      expect(entry.status, entry.reason ?? "").toBe("completed");
      expect(check.resultSchema.parse(entry.result).suspend).toMatchObject({
        kind: "measured",
        verdict: "in-ram",
        serverRestarted: false,
      });

      const awake = await plan(6_000);
      const nothing: Suspend = { kind: "pause", pause: async () => {}, resume: async () => {} };
      const keptCheck = stateSurvivalCheck(awake);
      const keptEntry = await runOnHost(keptCheck, hostSession({ suspend: nothing }).open);
      expect(keptCheck.resultSchema.parse(keptEntry.result).suspend).toMatchObject({
        kind: "measured",
        verdict: "kept-running",
      });
    }, 120_000);

    it("calls a pause that killed the processes a cold restart and times serving again", async () => {
      const options = await plan(1_000);

      const kill: Suspend = {
        kind: "pause",
        pause: signalling(options.workdir ?? "", "KILL"),
        resume: async () => {},
      };

      const check = stateSurvivalCheck(options);
      const entry = await runOnHost(check, hostSession({ suspend: kill }).open);
      expect(entry.status, entry.reason ?? "").toBe("completed");
      const result = check.resultSchema.parse(entry.result);
      expect(result.suspend).toMatchObject({
        kind: "measured",
        verdict: "cold-restart",
        serverRestarted: true,
        filesystem: true,
      });

      expect(result.suspend).toMatchObject({ servingMs: null, coldServeMs: expect.any(Number) });

      if (result.suspend.kind === "measured") expect(result.suspend.coldServeMs).toBeGreaterThan(0);
    }, 60_000);

    it("records a failed pause call instead of failing the check", async () => {
      const options = await plan(1_000);

      const refusing: Suspend = {
        kind: "pause",
        pause: () => Promise.reject(new Error("409 busy")),
        resume: async () => {},
      };

      const check = stateSurvivalCheck(options);
      const entry = await runOnHost(check, hostSession({ suspend: refusing }).open);
      expect(check.resultSchema.parse(entry.result).suspend).toMatchObject({
        kind: "failed",
        stage: "pause",
        error: "409 busy",
        pauseMs: null,
      });
    }, 60_000);

    it("memory-pressure reaches a small target and the sandbox stays usable", async () => {
      const workdir = await scratch("mem-work");

      const check = memoryPressureCheck({
        ...defaultPressureOptions,
        advertisedMiB: 128,
        healthAllocMiB: 64,
        pollMs: 200,
        workdir,
      });

      const entry = await runOnHost(check, hostSession().open);
      expect(entry.status, entry.reason ?? "").toBe("completed");
      const result = check.resultSchema.parse(entry.result);
      expect(result).toMatchObject({
        targetMiB: 192,
        reachedMiB: 192,
        reachedEvidence: "log",
        reachedFraction: 1.5,
        usableAfter: true,
        scope: null,
      });
      expect(result.outcome).toEqual({ kind: "reached-target" });
      expect(result.health).toMatchObject({
        answered: true,
        bootSame: true,
        canaryAlive: true,
        canary: "alive",
        allocOk: true,
        fileOk: true,
      });
      expect(result.health.canaryBeatAgeS).toBeLessThanOrEqual(5);
    }, 60_000);

    it("memory-pressure calls a sandbox lost only when the lookup confirms it, keeping the last progress seen", async () => {
      const workdir = await scratch("mem-work");
      const real = hostBox();
      let polls = 0;

      // The first progress poll answers once the hog has held something; every later one fails.
      const dying: Box = {
        ...real,
        run: async (command, options) => {
          if (command.includes("status=done")) {
            if (++polls > 1) throw new Error("connection reset");
            await sleep(1_500);
          }

          return real.run(command, options);
        },
        lookup: async () => ({
          result: "not-found",
          checkedAt: new Date().toISOString(),
          method: "fake",
        }),
      };

      const open: OpenSession = async () => ({
        kind: "ready",
        session: {
          create: async () => dying,
          leftovers: async () => [],
          destroyById: async () => {},
        },
      });

      const check = memoryPressureCheck({
        ...defaultPressureOptions,
        advertisedMiB: 128,
        pollMs: 200,
        unresponsiveMs: 1_000,
        recoveryMs: 1_000,
        workdir,
      });

      const entry = await runOnHost(check, open);
      expect(entry.status, entry.reason ?? "").toBe("completed");
      const result = check.resultSchema.parse(entry.result);
      expect(result.outcome.kind).toBe("sandbox-lost");
      expect(result).toMatchObject({
        scope: "sandbox",
        usableAfter: false,
        reachedEvidence: "last-poll",
      });
      expect(result.reachedMiB).toBeGreaterThan(0);
    }, 60_000);

    it("memory-pressure looks the sandbox up again before calling it unresponsive and still listed", async () => {
      const workdir = await scratch("mem-work");
      const real = hostBox();
      let polls = 0;
      let lookups = 0;

      const silent: Box = {
        ...real,
        run: async (command, options) => {
          if (command.includes("status=done") && ++polls > 1) throw new Error("connection reset");

          return real.run(command, options);
        },
        lookup: async () => {
          lookups++;

          return { result: "present", checkedAt: new Date().toISOString(), method: "fake" };
        },
      };

      const open: OpenSession = async () => ({
        kind: "ready",
        session: {
          create: async () => silent,
          leftovers: async () => [],
          destroyById: async () => {},
        },
      });

      const check = memoryPressureCheck({
        ...defaultPressureOptions,
        advertisedMiB: 128,
        pollMs: 200,
        unresponsiveMs: 1_000,
        recoveryMs: 1_000,
        workdir,
      });

      const entry = await runOnHost(check, open);
      expect(entry.status, entry.reason ?? "").toBe("completed");
      const result = check.resultSchema.parse(entry.result);
      expect(result.outcome).toMatchObject({
        kind: "unresponsive",
        detail: expect.stringMatching(/still listed/),
      });
      expect(lookups).toBeGreaterThanOrEqual(2);
      expect(result.scope).toBe("sandbox");
    }, 60_000);

    it("memory-pressure fails rather than calling a sandbox unresponsive when the lookup cannot answer", async () => {
      const workdir = await scratch("mem-work");
      const real = hostBox();
      let polls = 0;

      const silent: Box = {
        ...real,
        run: async (command, options) => {
          if (command.includes("status=done") && ++polls > 1) throw new Error("connection reset");

          return real.run(command, options);
        },
        lookup: () => Promise.reject(new Error("provider API down")),
      };

      const open: OpenSession = async () => ({
        kind: "ready",
        session: {
          create: async () => silent,
          leftovers: async () => [],
          destroyById: async () => {},
        },
      });

      const check = memoryPressureCheck({
        ...defaultPressureOptions,
        advertisedMiB: 128,
        pollMs: 200,
        unresponsiveMs: 1_000,
        recoveryMs: 1_000,
        workdir,
      });

      const entry = await runOnHost(check, open);
      expect(entry.status).not.toBe("completed");
      expect(entry.reason).toMatch(/provider's state is unknown/);
    }, 60_000);

    it("cleanup reports a sandbox whose destroy failed until an exact lookup finds it gone", async () => {
      const real = hostBox();
      let present = true;

      const stuck: Box = {
        ...real,
        destroy: () => Promise.reject(new Error("409 sandbox is paused")),
        lookup: async () => ({
          result: present ? "present" : "not-found",
          checkedAt: new Date().toISOString(),
          method: "fake",
        }),
      };

      const open: OpenSession = async () => ({
        kind: "ready",
        session: {
          create: async () => stuck,
          leftovers: async () => [],
          destroyById: async () => {},
        },
      });

      const left = await runOnHost(stateSurvivalCheck(await plan(1_000)), open);
      expect(left).toMatchObject({ destroyed: false });
      expect(left.cleanupError).toMatch(/may still exist/);
      present = false;
      const gone = await runOnHost(stateSurvivalCheck(await plan(1_000)), open);
      expect(gone).toMatchObject({ destroyed: true, cleanupError: null });
    }, 60_000);
  },
);
