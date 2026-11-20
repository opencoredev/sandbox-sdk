// Regression tests for the second re-check of the stress-suite fixes. Each test ports one
// counterexample from its evidence; the item it reproduces is in its describe block.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { lcgChecksum, runStagedCpuProbe, stageCpuProbe } from "../src/cpu.js";
import type { LookupEvidence } from "../src/existence.js";
import { mergeSources, readSource, type MergeSource } from "../src/merge.js";
import { estimateCost } from "../src/pricing.js";
import { cohortBoundMs } from "../src/scenarios.js";
import { siteData, siteDataCommand } from "../src/site-data.js";
import { heartbeatWindow } from "../src/survival.js";
import { parseV2 } from "../src/v2-config.js";
import { writeV2 } from "../src/v2-report.js";
import { runV2 } from "../src/v2-runner.js";

type Row = MergeSource["samples"][number];

const bootId = "4f9c1d1e-8b2a-4c1e-9d3f-0a1b2c3d4e5f";

const running: LookupEvidence = {
  result: "present",
  nativeState: "running",
  method: "exact-get",
  checkedAt: "2026-11-19T00:00:00.000Z",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `bench-third-${name}-`));
  dirs.push(dir);

  return dir;
}

/** The memory fake answering heartbeats, run as Boat so it is priced. */
function memoryBoat() {
  const provider = memory();

  provider.register("cat", async ({ stdout }) => {
    stdout(`${bootId}\n`);

    return 0;
  });

  return provider;
}

async function collect(run: string, args: string[]) {
  const dir = await tempDir(run);

  await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: memoryBoat() }],
    parseV2(["--providers", "boat", "--run", run, "--out", dir, ...args]),
    (report) => writeV2(report, dir),
  );

  return readSource(dir);
}

/** What one Boat sandbox costs for `ms`, at the fixed rate the harness prices it at. */
const boatCost = (ms: number) => estimateCost("boat", ms, null, null) ?? Infinity;

describe("P1.1: reported spend covers every sandbox until it is confirmed gone", () => {
  /**
   * One cohort member priced as Boat with a dollar cap of exactly its reserve. Creates return
   * `createDelayMs` after the sandbox exists; once `slowAfter()` holds, ownership listings and
   * deletes take `slowMs` each, and the first `failures` deletes fail.
   */
  async function overrun(input: {
    kind: "survival" | "cpu-burst";
    timeout: number;
    createDelayMs: number;
    slowMs: number;
    failures: number;
  }) {
    const plan = { windowMs: 1000, intervalMs: 1000 };
    const bound = cohortBoundMs(input.kind, input.timeout, plan);
    const max = boatCost(bound);
    const provider = memoryBoat();
    const create = provider.create.bind(provider);
    const destroy = provider.destroy.bind(provider);
    const list = provider.list.bind(provider);
    let heartbeats = 0;
    let deletes = 0;
    let allocatedAt = 0;
    let deletedAt: number | null = null;
    let pricedBy = 0;
    // When each delete attempt's ownership check listed (after allocation), and when the run's
    // final sweep first listed by label, both relative to the allocation.
    const ownershipChecks: number[] = [];
    let sweepAt: number | null = null;

    provider.register("cat", async ({ stdout }) => {
      if (++heartbeats === 2) await sleep(75);
      stdout(`${bootId}\n`);

      return 0;
    });

    provider.create = async (...args) => {
      const created = await create(...args);
      allocatedAt = performance.now();
      await sleep(input.createDelayMs);

      return created;
    };

    const slow = () => (input.kind === "survival" ? heartbeats > 1 : allocatedAt > 0);

    provider.list = async (...args) => {
      const keys = Object.keys(args[0] ?? {})
        .sort()
        .join(",");

      if (allocatedAt > 0 && keys === "sandbox-bench-run")
        sweepAt ??= performance.now() - allocatedAt;

      if (allocatedAt > 0 && sweepAt === null && keys !== "sandbox-bench-run")
        ownershipChecks.push(performance.now() - allocatedAt);

      if (slow()) await sleep(input.slowMs);

      return list(...args);
    };

    provider.destroy = async (...args) => {
      const attempt = ++deletes;
      await sleep(input.slowMs);

      if (attempt <= input.failures) throw new Error("fixture delete failure");
      await destroy(...args);
      deletedAt = performance.now();
    };

    const out = await tempDir("overrun");

    const args = [
      "--run",
      `overrun-${input.kind}`,
      "--providers",
      "boat",
      "--scenarios",
      input.kind,
      "--bursts",
      "1",
      "--burst-cohorts",
      "1",
      "--survival-window-ms",
      "1000",
      "--survival-heartbeat-ms",
      "1000",
      "--timeout-ms",
      String(input.timeout),
      "--max-dollars",
      String(max),
      "--out",
      out,
    ];

    try {
      const report = await runV2(
        [{ kind: "ready", name: "boat", region: null, cloud: false, provider }],
        parseV2(args),
        async () => {
          pricedBy = performance.now();
        },
      );

      const live = (await list({})).map((s) => s.id);

      return {
        report,
        live,
        deletes,
        allocatedAt,
        deletedAt,
        pricedBy,
        max,
        bound,
        ownershipChecks,
      };
    } finally {
      for (const s of await list({})) await destroy(s.id);
    }
  }

  // Slack for the few milliseconds between the harness pricing at return and the save callback.
  const slack = boatCost(50);

  it("prices the re-check's slow checks and two transient delete failures to the confirmed delete", async () => {
    const run = await overrun({
      kind: "survival",
      timeout: 166,
      createDelayMs: 145,
      slowMs: 155,
      failures: 2,
    });

    const budget = run.report.budgets.boat;
    const end = run.deletedAt ?? run.pricedBy;

    expect(budget?.estimatedUSD ?? 0).toBeGreaterThanOrEqual(
      boatCost(end - run.allocatedAt) - slack,
    );

    // A sandbox still live at return is an open liability, never silently left out.
    for (const id of run.live) expect(budget?.openLiabilities?.map((l) => l.id)).toContain(id);

    // An overrun of the cap is stated, not hidden.
    if ((budget?.estimatedUSD ?? 0) > run.max) expect(budget?.stop).toMatch(/over the .*cap/i);
  }, 30_000);

  it("reports a sandbox that never deletes as an open liability priced to the return", async () => {
    const run = await overrun({
      kind: "survival",
      timeout: 166,
      createDelayMs: 145,
      slowMs: 155,
      failures: Infinity,
    });

    const budget = run.report.budgets.boat;

    expect(run.live).toHaveLength(1);
    expect(budget?.openLiabilities?.map((l) => l.id)).toEqual(run.live);
    expect(budget?.estimatedUSD ?? 0).toBeGreaterThanOrEqual(
      boatCost(run.pricedBy - run.allocatedAt) - slack,
    );
    expect(budget?.stop).toMatch(/over the .*cap/i);
  }, 30_000);

  it("ends a late create's own cleanup by its reserve and prices the sweep past it", async () => {
    // The re-check's case: the create returns after its 250 ms deadline, checks and deletes take
    // 236 ms, and the first two deletes fail.
    const timeout = 250;

    const run = await overrun({
      kind: "cpu-burst",
      timeout,
      createDelayMs: 310,
      slowMs: 236,
      failures: 2,
    });

    // The first check is the create's own; every delete attempt in the iteration starts while a
    // whole attempt (check and delete) still fits in the reserve.
    expect(run.ownershipChecks.length).toBeGreaterThan(1);

    for (const at of run.ownershipChecks) expect(at).toBeLessThanOrEqual(run.bound - 2 * timeout);

    const budget = run.report.budgets.boat;
    const end = run.deletedAt ?? run.pricedBy;

    expect(budget?.estimatedUSD ?? 0).toBeGreaterThanOrEqual(
      boatCost(end - run.allocatedAt) - slack,
    );

    for (const id of run.live) expect(budget?.openLiabilities?.map((l) => l.id)).toContain(id);
  }, 30_000);

  it("lists a late create whose ownership cannot be checked as an open liability", async () => {
    // Listings take longer than the step timeout, so ownership is never verified and no delete
    // is attempted: the sandbox may be live at return, and is reported so.
    const run = await overrun({
      kind: "cpu-burst",
      timeout: 280,
      createDelayMs: 340,
      slowMs: 300,
      failures: 2,
    });

    const budget = run.report.budgets.boat;

    for (const id of run.live) expect(budget?.openLiabilities?.map((l) => l.id)).toContain(id);
    expect(budget?.estimatedUSD ?? 0).toBeGreaterThanOrEqual(
      boatCost(run.pricedBy - run.allocatedAt) - slack,
    );
  }, 30_000);
});

describe("P1.2: a guest clock step is a diagnostic, never a placement", () => {
  it("records a +300 ms step between staging and run as drift, and times the exec on the host", async () => {
    let stepMs = 0;
    const provider = memory();

    provider.register("python3", async ({ args, stdout }) => {
      const [, mode, ...rest] = args;

      if (mode === "clock") {
        stdout(`${(Date.now() + stepMs) / 1000}\n`);

        return 0;
      }

      // The guest reports its phases on its own clock as it was at staging: self-consistent
      // timestamps, inside the exec, that hide the step.
      const [segments = 0, steps = 0, , runSeed = 0] = rest.map(Number);
      const phase = 0.1;
      const startedAt = Date.now() / 1000;
      await sleep(260);

      const run = (at: number) => ({
        checksum: lcgChecksum(runSeed, segments * steps),
        seconds: phase,
        rates: Array<number>(segments).fill((steps * segments) / phase),
        startedAt: at,
        endedAt: at + phase,
      });

      stdout(
        JSON.stringify({
          segments,
          steps,
          seed: runSeed,
          single: run(startedAt),
          all: {
            workers: [run(startedAt + phase + 0.04)],
            wallSeconds: phase,
            startedAt: startedAt + phase + 0.04,
            endedAt: startedAt + 2 * phase + 0.04,
          },
          cpus: { visible: 1, affinity: 1, quota: null },
          python: "fixture",
        }),
      );

      // The clock steps forward once the run is over, before the second read.
      stepMs = 300;

      return 0;
    });

    const box = await createSandbox(provider, {});

    try {
      const challenge = { work: { segments: 4, steps: 1_000_000 }, seed: 5, workers: 1 };
      const staged = await stageCpuProbe(box, challenge, 5000);
      const ran = await runStagedCpuProbe(box, staged, 5000);

      expect(ran.clockDriftMs).toBeGreaterThan(250);
      expect(ran.exec[1] - ran.exec[0]).toBeGreaterThanOrEqual(255);
    } finally {
      await box.destroy();
    }
  });
});

/**
 * Build a two-member cpu-burst cohort's rows from a real source's cold row. A member with a
 * drift records its exec on the host clock; `"legacy"` is a row from before exec was recorded.
 */
function cpuCohort(base: Row, drifts: readonly (number | "legacy")[]) {
  const at = 1_795_146_433_000;
  const rate = 28_000_000;
  const work = { segments: 4, steps: 10_000_000 };

  const row = (
    scenario: string,
    iteration: number,
    value: number,
    details: Row["details"],
  ): Row => ({
    ...structuredClone(base),
    scenario,
    iteration,
    outcome: { kind: "sample", value },
    details,
  });

  const member = (iteration: number, drift: number | "legacy") => {
    const shared = {
      work,
      seed: 1,
      consistency: { minOverMedian: 1, lastOverFirst: 1 },
      guestVcpus: 2,
      cpus: { visible: 2, affinity: 2, quota: null },
      python: "3.12",
    };

    // Two phases of 1.4 s and 1.5 s inside a 2.95 s exec: at least 96% overlap, proven. A
    // legacy row placed its phase by the guest clock instead.
    const where = (guest: [number, number]) =>
      drift === "legacy"
        ? { guest, clockUncertaintyMs: 5 }
        : { exec: [at, at + 2950], clockDriftMs: drift };

    return [
      row("cpu-burst-2/cold", iteration, 100, null),
      row("cpu-burst-2/cpu", iteration, 2900, null),
      row("cpu-burst-2/cpu-single", iteration, rate, {
        ...shared,
        ...where([at, at + 1400]),
        workers: 1,
        seconds: 1.4,
      }),
      row("cpu-burst-2/cpu-all", iteration, rate * 2, {
        ...shared,
        ...where([at + 1400, at + 2900]),
        workers: 2,
        seconds: 1.5,
      }),
    ];
  };

  return [
    ...drifts.flatMap((drift, i) => member(i, drift)),
    row("cpu-burst-2/all-complete", 0, 2950, {
      k: 2,
      cohort: 0,
      attempted: 2,
      work,
      ready: 2,
      completed: 2,
      allCompleteMs: 2950,
      overlap: {
        ok: true,
        single: { startSkewMs: 0, worstCaseFraction: 1, allRunningFraction: 1 },
        all: { startSkewMs: 0, worstCaseFraction: 1, allRunningFraction: 1 },
        clockUncertaintyMs: 5,
        threshold: 0.8,
      },
      single: { maxOverMin: 1 },
      all: { maxOverMin: 1 },
    }),
  ];
}

describe("P1.2 and P1.3: publication recomputes from raw evidence", () => {
  let main: MergeSource;
  let survival: MergeSource;

  it("collects the fixtures", async () => {
    [main, survival] = await Promise.all([
      collect("main-run", ["--runs", "1", "--bursts", "", "--scenarios", "command"]),
      collect("survival-run", [
        "--scenarios",
        "survival",
        "--bursts",
        "2",
        "--burst-cohorts",
        "1",
        "--concurrency",
        "2",
        "--survival-window-ms",
        "2000",
        "--survival-heartbeat-ms",
        "1000",
      ]),
    ]);
  }, 60_000);

  const cpuRow = (drifts: readonly (number | "legacy")[]) => {
    const base = survival.samples.find((s) => s.scenario === "survival-2/cold");

    if (!base) throw new Error("fixture has no cold row");
    const source = { ...survival, runId: "cpu-run", samples: cpuCohort(base, drifts) };

    return siteData(mergeSources([main]), "default", mergeSources([source])).stress.cpuBurst[0]
      ?.providers[0];
  };

  it("publishes a cohort whose guest clocks held steady", () => {
    expect(cpuRow([0, 3])?.perSandbox.cohorts).toBe(1);
  });

  it("publishes a cohort whose guest clock stepped: drift is a diagnostic", () => {
    expect(cpuRow([0, 300])?.perSandbox.cohorts).toBe(1);
  });

  it("excludes a cohort whose members recorded no exec window, as invalid evidence", () => {
    const row = cpuRow(["legacy", "legacy"]);

    expect(row?.perSandbox.cohorts).toBe(0);
    expect(row?.excluded).toMatchObject({ invalidEvidence: 1 });
  });

  /** A window row's stored details, loosely parsed so a test can rewrite any field. */
  const windowDetails = z
    .object({ heartbeats: z.array(z.record(z.string(), z.unknown())) })
    .catchall(z.unknown());

  /** The survival export after `edit` rewrites the first member's window row. */
  function survivalRow(edit: (details: z.infer<typeof windowDetails>, window: Row) => void) {
    const samples = structuredClone(survival.samples);
    const window = samples.find((s) => s.scenario === "survival-2/window" && s.iteration === 0);

    if (!window) throw new Error("fixture has no window row");
    const details = windowDetails.parse(window.details);
    edit(details, window);
    window.details = details;

    return siteData(mergeSources([main]), "default", mergeSources([{ ...survival, samples }]))
      .stress.burstSurvival[0]?.providers[0];
  }

  it("leaves an untouched fixture fully surviving", () => {
    expect(survivalRow(() => {})).toMatchObject({
      survived: 2,
      survivalRate: 1,
      invalidEvidence: 0,
    });
  });

  it("decides a later 500 over a stored 429 classification", () => {
    const row = survivalRow((d, window) => {
      const miss = { kind: "missed", latencyMs: 30, timedOut: false, lookup: running };
      d.heartbeats[0] = { ...miss, atMs: 0, note: "throttled", httpStatus: 429 };
      d.heartbeats[1] = { ...miss, atMs: 1000, note: "server failure", httpStatus: 500 };
      d.verdict = {
        kind: "unresponsive",
        evidence: d.heartbeats[0],
        missed: 2,
        firstMissAtMs: 0,
        recovered: true,
      };
      window.outcome = {
        kind: "failure",
        note: "Unresponsive: throttled",
        cause: { httpStatus: 429 },
      };
    });

    expect(row).toMatchObject({
      survived: 1,
      unresponsive: 1,
      invalidEvidence: 0,
      windowFailures: { accountLimit: 0, provider: 1 },
      survivalRate: 0.5,
    });
  });

  it("refuses a member whose plan differs from its cohort's", () => {
    const row = survivalRow((d) => {
      d.plan = { windowMs: 1000, intervalMs: 1000 };
      d.heartbeats = d.heartbeats.slice(0, 2);
      d.expected = 2;
    });

    expect(row).toMatchObject({ survived: 1, invalidEvidence: 1, survivalRate: 1 });
    expect(row?.invalidReasons).toMatchObject({ "plan-mismatch": 1 });
  });

  it("refuses a reply recorded as answered after its deadline", () => {
    const row = survivalRow((d) => {
      d.heartbeatTimeoutMs = 150;
      d.heartbeats[1] = { ...d.heartbeats[1], latencyMs: 176 };
    });

    expect(row).toMatchObject({ survived: 1, invalidEvidence: 1 });
    expect(row?.invalidReasons).toMatchObject({ "late-reply": 1 });
  });

  it("refuses a window that does not record its heartbeat deadline", () => {
    const row = survivalRow((d) => {
      delete d.heartbeatTimeoutMs;
    });

    expect(row).toMatchObject({ survived: 1, invalidEvidence: 1 });
  });

  it("refuses empty boot IDs", () => {
    const row = survivalRow((d) => {
      for (const h of d.heartbeats) if (h.kind === "ok") h.bootId = "";
    });

    expect(row).toMatchObject({ survived: 1, invalidEvidence: 1 });
    expect(row?.invalidReasons).toMatchObject({ "bad-boot-id": 1 });
  });

  it("P3.5: refuses an empty --stress-report path", async () => {
    const dir = await tempDir("empty-path");
    const report = join(dir, "report");
    await mkdir(report, { recursive: true });
    await writeFile(join(report, "results.json"), JSON.stringify(mergeSources([main])));

    await expect(
      siteDataCommand(["--report", report, "--stress-report=", "--out", join(dir, "out.json")]),
    ).rejects.toThrow(/--stress-report/);
  });
});

describe("P1.3: a heartbeat reply after its deadline is a miss", () => {
  it("counts a late reply as missed even when the deadline's own timer fires late", async () => {
    const timer = globalThis.setTimeout;
    let sent = 0;
    let delayed = false;

    // The heartbeat deadline's timer (30 ms) for the second slot fires 90 ms late.
    const late = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (sent === 1 && delay === 30 && !delayed) {
          delayed = true;

          return timer(callback, delay + 90, ...args);
        }

        return timer(callback, delay, ...args);
      });

    try {
      const start = performance.now();

      const window = await heartbeatWindow({
        plan: { windowMs: 100, intervalMs: 100 },
        heartbeat: async () => {
          if (++sent === 2) await sleep(75);

          return bootId;
        },
        lookup: async () => running,
        heartbeatTimeoutMs: 30,
        endBy: start + 150,
        stop: new AbortController().signal,
        sanitize: (text) => text,
        track: (work) => work,
      });

      expect(delayed).toBe(true);
      expect(window.verdict.kind).not.toBe("survived");

      for (const h of window.heartbeats)
        if (h.kind === "ok") expect(h.latencyMs).toBeLessThanOrEqual(30);
    } finally {
      late.mockRestore();
    }
  });
});

describe("P2.4: documented site-data commands", () => {
  it("passes --stress-report or --no-stress in every README site-data command", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const commands = readme.split("\n").filter((line) => /^bun bench site-data\b/.test(line));

    expect(commands.length).toBeGreaterThan(0);

    for (const line of commands) expect(line).toMatch(/--stress-report \S+|--no-stress\b/);
  });
});
