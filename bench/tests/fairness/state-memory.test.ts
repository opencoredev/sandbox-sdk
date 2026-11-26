/**
 * state-survival and memory-pressure: the judges on their own, and both checks end to end on this
 * machine with the host standing in for a sandbox (pause and resume faked, small allocations).
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
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
  judgePressure,
  memoryPressureCheck,
  parseHogLog,
  scopeOf,
  thinProgress,
  defaultPressureOptions,
} from "../../src/fairness/memory-pressure.js";
import {
  defaultStateOptions,
  judgeSurvival,
  parseProbe,
  parseSnapshot,
  stateSurvivalCheck,
  type GuestSnapshot,
} from "../../src/fairness/state-survival.js";
import { providerSetup } from "../../src/realistic/setup.js";
import { hostBox, hostSession } from "./host-box.js";

const setup = providerSetup("e2b");
const supported = platform() === "linux";
const port = () => 20_000 + Math.floor(Math.random() * 20_000);

async function runOnHost<R>(check: Check<R>, open: OpenSession) {
  const out = await mkdtemp(join(tmpdir(), `fairness-${check.id}-`));

  await runCheck(
    check,
    [setup],
    { runId: "host-test", out, concurrency: 1 },
    {
      open,
      signal: new AbortController().signal,
      progress: () => {},
      retryDelayMs: 0,
      lateSweepDelayMs: 0,
    },
  );

  const report = reportSchema.parse(
    JSON.parse(await readFile(join(out, `${check.id}.json`), "utf8")),
  );

  const entry = report.providers[0];

  if (!entry) throw new Error("no entry");

  return entry;
}

const snapshot = (over: Partial<GuestSnapshot> = {}): GuestSnapshot => ({
  sha: "abc",
  boot: "boot-1",
  workerPid: "41",
  workerStart: "1000",
  beat: 10,
  ...over,
});

const body = (token: string, digestNow = "d") => ({
  ok: true,
  ms: 3,
  body: { token, pid: 7, digestAtStart: "d", digestNow, upMs: 1 },
});

describe("state-survival judge", () => {
  const base = { before: snapshot(), server: { token: "t" }, holdMs: 60_000 };

  it("calls a frozen pause that kept everything in-ram", () => {
    const judged = judgeSurvival({
      ...base,
      after: snapshot({ beat: 12 }),
      later: snapshot({ beat: 14 }),
      probe: body("t"),
    });

    expect(judged.verdict).toBe("in-ram");
    expect(judged.worker).toMatchObject({
      alive: true,
      sameStart: true,
      beatsDuringHold: 2,
      keptRunning: false,
      advancing: true,
    });
    expect(judged.server).toEqual({ answered: true, sameToken: true, memoryIntact: true });
  });

  it("tells a pause that never froze the guest from one that did", () => {
    const judged = judgeSurvival({
      ...base,
      after: snapshot({ beat: 75 }),
      later: snapshot({ beat: 77 }),
      probe: body("t"),
    });

    expect(judged.verdict).toBe("kept-running");
  });

  it("calls lost processes, a new boot or changed memory a cold restart", () => {
    const gone = judgeSurvival({
      ...base,
      after: snapshot({ workerStart: null, beat: 10 }),
      later: snapshot({ workerStart: null, beat: 10 }),
      probe: null,
    });

    expect(gone.verdict).toBe("cold-restart");
    expect(gone.worker.beatsDuringHold).toBeNull();
    expect(gone.server.answered).toBe(false);

    const rebooted = judgeSurvival({
      ...base,
      after: snapshot({ boot: "boot-2", beat: 11 }),
      later: snapshot({ boot: "boot-2", beat: 13 }),
      probe: body("t"),
    });

    expect(rebooted.bootSame).toBe(false);
    expect(rebooted.verdict).toBe("cold-restart");

    const corrupted = judgeSurvival({
      ...base,
      after: snapshot({ beat: 11 }),
      later: snapshot({ beat: 13 }),
      probe: body("t", "other"),
    });

    expect(corrupted.server.memoryIntact).toBe(false);
    expect(corrupted.verdict).toBe("cold-restart");

    const restarted = judgeSurvival({
      ...base,
      after: snapshot({ beat: 11 }),
      later: snapshot({ beat: 13 }),
      probe: body("new"),
    });

    expect(restarted.server).toMatchObject({ answered: true, sameToken: false });
    expect(restarted.verdict).toBe("cold-restart");
  });

  it("calls a changed or missing file files-lost", () => {
    for (const sha of [null, "def"])
      expect(
        judgeSurvival({ ...base, after: snapshot({ sha }), later: snapshot(), probe: body("t") })
          .verdict,
      ).toBe("files-lost");
  });

  it("parses the guest's snapshot and probe lines", () => {
    expect(parseSnapshot("sha=aa\nboot=unknown\nworkerPid=9\nworkerStart=\nbeat=12\n")).toEqual({
      sha: "aa",
      boot: null,
      workerPid: "9",
      workerStart: null,
      beat: 12,
    });
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
  const base = { oomDelta: 0, stalled: false, lost: null, bootSame: true };

  it("reads the hog's progress", () => {
    const parsed = log("held 64 10\nheld 128 22\nreached 128 23\n");
    expect(parsed).toMatchObject({ heldMiB: 128, reached: true, refused: null });
    expect(log("held 64 10\nrefused 64 ENOMEM\n")).toMatchObject({
      heldMiB: 64,
      refused: "ENOMEM",
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
    const held = log("held 64 1\n");
    expect(judgePressure({ ...base, exitCode: 0, log: log("reached 64 1\n") })).toEqual({
      kind: "reached-target",
    });
    expect(judgePressure({ ...base, exitCode: 137, log: held })).toEqual({
      kind: "process-killed",
      exitCode: 137,
      oomKills: 0,
    });
    expect(judgePressure({ ...base, exitCode: 1, oomDelta: 1, log: held })).toMatchObject({
      kind: "process-killed",
      oomKills: 1,
    });
    expect(judgePressure({ ...base, exitCode: 3, log: log("refused 64 ENOMEM\n") })).toEqual({
      kind: "refused",
      reason: "ENOMEM",
    });
    expect(judgePressure({ ...base, exitCode: null, stalled: true, log: held })).toEqual({
      kind: "stalled",
    });
    expect(judgePressure({ ...base, exitCode: 137, bootSame: false, log: held })).toEqual({
      kind: "sandbox-restarted",
    });
    expect(
      judgePressure({
        ...base,
        exitCode: null,
        lost: { kind: "absent", detail: "404" },
        log: held,
      }),
    ).toEqual({ kind: "sandbox-lost", detail: "404" });
    expect(
      judgePressure({
        ...base,
        exitCode: null,
        lost: { kind: "unresponsive", detail: "x" },
        log: held,
      }),
    ).toMatchObject({ kind: "unresponsive" });
    // An exit with no kill evidence is not a finding.
    expect(() => judgePressure({ ...base, exitCode: 1, log: held })).toThrow(/no kill evidence/);
  });

  it("scopes a kill to the process, the canary or the sandbox", () => {
    expect(scopeOf({ kind: "process-killed", exitCode: 137, oomKills: 1 }, true)).toBe("process");
    expect(scopeOf({ kind: "process-killed", exitCode: 137, oomKills: 1 }, false)).toBe(
      "collateral",
    );
    expect(scopeOf({ kind: "sandbox-lost", detail: "" }, null)).toBe("sandbox");
    expect(scopeOf({ kind: "reached-target" }, true)).toBeNull();
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

describe.runIf(supported)("state-survival and memory-pressure on this machine", () => {
  const hold = { ...defaultStateOptions, holdMs: 3_000, restarts: 2, fileMiB: 1 };

  it("times restarts and reports no pause where there is none", async () => {
    const home = await mkdtemp(join(tmpdir(), "state-home-"));
    const check = stateSurvivalCheck({ ...hold, port: port() });
    const entry = await runOnHost(check, hostSession({ env: { HOME: home } }).open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result.restart.samplesMs).toHaveLength(2);
    expect(result.restart.failures).toBe(0);
    expect(result.restart.medianMs).toBeGreaterThan(0);
    expect(result.suspend).toEqual({ kind: "unsupported", reason: "The host has no pause" });
    expect(result.stopStart.kind).toBe("not-run");
  }, 60_000);

  it("calls a pause that froze nothing kept-running", async () => {
    const home = await mkdtemp(join(tmpdir(), "state-home-"));
    const suspend: Suspend = { kind: "pause", pause: async () => {}, resume: async () => {} };
    const check = stateSurvivalCheck({ ...hold, port: port() });
    const entry = await runOnHost(check, hostSession({ env: { HOME: home }, suspend }).open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result.suspend).toMatchObject({
      kind: "measured",
      verdict: "kept-running",
      serverRestarted: false,
      filesystem: true,
      bootSame: true,
    });
  }, 60_000);

  it("calls a pause that killed the processes a cold restart and times serving again", async () => {
    const home = await mkdtemp(join(tmpdir(), "state-home-"));
    const at = port();
    const killer = hostBox({ env: { HOME: home } });

    const suspend: Suspend = {
      kind: "pause",
      pause: async () => {
        await killer.run(
          `for f in "$HOME"/.sbx-state/server.pid "$HOME"/.sbx-state/worker.pid /tmp/.sbx-state/server.pid /tmp/.sbx-state/worker.pid; do [ -f "$f" ] && kill -9 "$(cat "$f")" 2>/dev/null; done; true`,
          { timeoutMs: 10_000, signal: new AbortController().signal },
        );
      },
      resume: async () => {},
    };

    const check = stateSurvivalCheck({ ...hold, port: at });
    const entry = await runOnHost(check, hostSession({ env: { HOME: home }, suspend }).open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result.suspend).toMatchObject({
      kind: "measured",
      verdict: "cold-restart",
      serverRestarted: true,
      filesystem: true,
    });

    if (result.suspend.kind === "measured") {
      expect(result.suspend.servingMs).toBeGreaterThan(0);
      expect(result.suspend.worker.alive).toBe(false);
    }
  }, 60_000);

  it("records a refused pause instead of failing", async () => {
    const home = await mkdtemp(join(tmpdir(), "state-home-"));

    const suspend: Suspend = {
      kind: "pause",
      pause: async () => {
        throw new Error("409 busy");
      },
      resume: async () => {},
    };

    const check = stateSurvivalCheck({ ...hold, port: port() });
    const entry = await runOnHost(check, hostSession({ env: { HOME: home }, suspend }).open);
    const result = check.resultSchema.parse(entry.result);
    expect(result.suspend).toMatchObject({
      kind: "refused",
      stage: "pause",
      error: "409 busy",
      pauseMs: null,
    });
  }, 60_000);

  it("memory-pressure reaches a small target and the sandbox stays usable", async () => {
    const home = await mkdtemp(join(tmpdir(), "mem-home-"));

    const check = memoryPressureCheck({
      ...defaultPressureOptions,
      advertisedMiB: 128,
      healthAllocMiB: 64,
      pollMs: 200,
    });

    const entry = await runOnHost(check, hostSession({ env: { HOME: home } }).open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result).toMatchObject({
      advertisedMiB: 128,
      targetMiB: 192,
      reachedMiB: 192,
      reachedFraction: 1.5,
      usableAfter: true,
      scope: null,
    });
    expect(result.outcome).toEqual({ kind: "reached-target" });
    expect(result.health).toMatchObject({
      answered: true,
      bootSame: true,
      canaryAlive: true,
      allocOk: true,
      fileOk: true,
    });
  }, 60_000);

  it("memory-pressure calls a sandbox lost only when the lookup confirms it", async () => {
    const home = await mkdtemp(join(tmpdir(), "mem-home-"));
    const real = hostBox({ env: { HOME: home } });

    const dying: Box = {
      ...real,
      run: async (command, options) => {
        // Every progress poll fails, as if the guest agent died with the hog.
        if (command.includes("hog.exit") && command.includes("tail -n 1"))
          throw new Error("connection reset");

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
    });

    const entry = await runOnHost(check, open);
    expect(entry.status, entry.reason ?? "").toBe("completed");
    const result = check.resultSchema.parse(entry.result);
    expect(result.outcome.kind).toBe("sandbox-lost");
    expect(result.scope).toBe("sandbox");
    expect(result.usableAfter).toBe(false);
  }, 60_000);
});
