// Regression tests for the re-check of the stress-suite fixes. Each test ports one counterexample
// from the re-check's evidence; the item it reproduces is in its name.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import {
  cpuOverlap,
  cpuResult,
  lcgChecksum,
  runStagedCpuProbe,
  stageCpuProbe,
} from "../src/cpu.js";
import type { LookupEvidence } from "../src/existence.js";
import type { FailureOutcome } from "../src/failure.js";
import type { Fingerprint } from "../src/fingerprint.js";
import { classifyFailure, mergeSources, readSource, type MergeSource } from "../src/merge.js";
import { estimateCost } from "../src/pricing.js";
import { projectCosts } from "../src/projection.js";
import { cohortBoundMs, selectedCohorts, selectsScenario } from "../src/scenarios.js";
import { siteData, siteDataCommand } from "../src/site-data.js";
import {
  classifyHeartbeats,
  heartbeatWindow,
  survivalFailure,
  type Heartbeat,
} from "../src/survival.js";
import { parseV2 } from "../src/v2-config.js";
import type { Sample } from "../src/v2-model.js";
import { writeV2 } from "../src/v2-report.js";
import { runV2 } from "../src/v2-runner.js";

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
  const dir = await mkdtemp(join(tmpdir(), `bench-recheck-${name}-`));
  dirs.push(dir);

  return dir;
}

/** The memory fake answering heartbeats, run as Boat so it is priced and selected as a cloud. */
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
    [
      {
        kind: "ready",
        name: "boat",
        cloud: false,
        region: null,
        provider: memoryBoat(),
      },
    ],
    parseV2(["--providers", "boat", "--run", run, "--out", dir, ...args]),
    (report) => writeV2(report, dir),
  );

  return readSource(dir);
}

const survivalArgs = (bursts: string) => [
  "--scenarios",
  "survival",
  "--bursts",
  bursts,
  "--burst-cohorts",
  "1",
  "--concurrency",
  "2",
  "--survival-window-ms",
  "1000",
  "--survival-heartbeat-ms",
  "1000",
];

const policy = { replacements: [], notRun: [] };

describe("P1: cleanup stays inside the admitted reserve", () => {
  /**
   * A survival member priced as Boat with a dollar cap of exactly its reserve. After the window,
   * ownership checks and deletes take `slowMs` each, and the first `failures` deletes fail.
   */
  async function cappedMember(failures: number, slowMs = 100) {
    const timeout = 166;
    const plan = { windowMs: 1000, intervalMs: 1000 };
    const bound = cohortBoundMs("survival", timeout, plan);
    const max = estimateCost("boat", bound, null, null) ?? 0;
    const provider = memoryBoat();
    const create = provider.create.bind(provider);
    const destroy = provider.destroy.bind(provider);
    const list = provider.list.bind(provider);
    let heartbeats = 0;
    let destroys = 0;
    let allocatedAt = 0;
    let destroyedAt: number | null = null;

    provider.register("cat", async ({ stdout }) => {
      heartbeats++;
      stdout(`${bootId}\n`);

      return 0;
    });

    provider.create = async (...args) => {
      const result = await create(...args);
      allocatedAt = performance.now();
      await sleep(145);

      return result;
    };

    provider.list = async (...args) => {
      if (heartbeats > 1) await sleep(slowMs);

      return list(...args);
    };

    provider.destroy = async (...args) => {
      const attempt = ++destroys;
      await sleep(slowMs);

      if (attempt <= failures) throw new Error("fixture delete failure");
      await destroy(...args);
      destroyedAt = performance.now();
    };

    const out = await tempDir("cleanup");

    const config = parseV2([
      ...survivalArgs("1"),
      "--providers",
      "boat",
      "--out",
      out,
      "--timeout-ms",
      String(timeout),
      "--max-dollars",
      String(max),
    ]);

    const report = await runV2(
      [{ kind: "ready", name: "boat", region: null, cloud: false, provider }],
      config,
      async () => {},
    );

    const left = await list({});

    // The iteration held the sandbox no longer than its bound.
    expect(
      report.samples.find((s) => s.scenario === "survival-1/sandbox-lifetime")?.durationMs,
    ).toBeLessThanOrEqual(bound);

    for (const s of left) await destroy(s.id);

    return {
      report,
      out,
      left: left.map((s) => s.id),
      destroys,
      lifetimeMs: destroyedAt === null ? null : destroyedAt - allocatedAt,
      bound,
      max,
    };
  }

  it("retries transient delete failures inside the reserve", async () => {
    const member = await cappedMember(2);

    expect(member.left).toEqual([]);
    expect(member.destroys).toBe(3);
    expect(member.lifetimeMs).not.toBeNull();
    expect(member.lifetimeMs ?? Infinity).toBeLessThanOrEqual(member.bound);
    // Deleted inside its reserve, the sandbox cost no more than the cap.
    expect(member.report.budgets.boat?.estimatedUSD ?? Infinity).toBeLessThanOrEqual(member.max);
  }, 30_000);

  it("holds the re-check's slow transient failures inside the cap", async () => {
    // The re-check's case: 155 ms checks and deletes, two failures, a $0.00002 cap.
    const member = await cappedMember(2, 155);

    if (member.lifetimeMs === null) {
      expect(member.left).toHaveLength(1);
      expect(member.report.cleanupReview?.map((r) => r.reason).join("\n")).toMatch(/reap/);
    } else expect(member.lifetimeMs).toBeLessThanOrEqual(member.bound);
  }, 30_000);

  it("stops retrying when the reserve runs out and leaves the sandbox for reap", async () => {
    const member = await cappedMember(Infinity);

    // The final sweep's retries fail too: the sandbox stays journaled for reap, and is reported
    // as still live rather than priced as if it were gone.
    expect(member.left).toHaveLength(1);
    expect(member.report.cleanup[0]?.remaining).toEqual(member.left);
    expect(member.report.budgets.boat?.openLiabilities?.map((l) => l.id)).toEqual(member.left);
    expect(await readFile(join(member.out, "ownership.json"), "utf8")).toContain(member.left[0]);
  }, 30_000);

  it("never sends or counts a heartbeat after the deadline", async () => {
    let sent = 0;
    let delayed = false;
    const timer = globalThis.setTimeout;
    const start = performance.now();
    const endBy = start + 150;

    // The timer for the second slot fires 75 ms late, past the deadline.
    const late = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (sent === 1 && !delayed && delay !== undefined && delay > 65 && delay < 110) {
          delayed = true;

          return timer(callback, delay + 75, ...args);
        }

        return timer(callback, delay, ...args);
      });

    try {
      const window = await heartbeatWindow({
        plan: { windowMs: 100, intervalMs: 100 },
        heartbeat: async () => {
          sent++;

          return bootId;
        },
        lookup: async () => running,
        heartbeatTimeoutMs: 30,
        endBy,
        stop: new AbortController().signal,
        sanitize: (text) => text,
        track: (work) => work,
      });

      expect(delayed).toBe(true);
      expect(window.verdict.kind).not.toBe("survived");

      for (const h of window.heartbeats)
        if (h.kind !== "skipped") expect(start + h.atMs).toBeLessThanOrEqual(endBy);
    } finally {
      late.mockRestore();
    }
  });
});

describe("P2.1: stress runs are kept out of the legacy site data", () => {
  let main: MergeSource;
  let sustained: MergeSource;

  it("collects the fixtures", async () => {
    [main, sustained] = await Promise.all([
      collect("main-run", ["--runs", "1", "--bursts", "", "--scenarios", "command"]),
      collect("sustained-run", ["--runs", "1", "--bursts", "", "--scenarios", "cpu-sustained"]),
    ]);
  }, 60_000);

  it("refuses a stress run in the legacy report even when selection removed its stress rows", () => {
    // Remove the probe rows whichever suite labels them: the run itself still gives it away.
    const rule = { provider: "boat", scenario: "cpu-sustained", reason: "fixture" };

    const selection = {
      ...policy,
      notRun: [
        { ...rule, suite: "main" as const },
        { ...rule, suite: "cpu-sustained" as const },
      ],
    };

    const merged = mergeSources([main, sustained], [], 45, selection);

    expect(merged.samples.some((s) => s.scenario === "cpu-sustained")).toBe(false);
    expect(() => siteData(merged)).toThrow(/stress/);
  });

  it("refuses to drop the stress section silently, or to read a legacy report as stress", async () => {
    const dir = await tempDir("site");
    const legacy = join(dir, "legacy");
    const stress = join(dir, "stress");
    const out = join(dir, "site.json");

    await Promise.all([
      writeV2Json(legacy, mergeSources([main])),
      writeV2Json(stress, mergeSources([sustained])),
    ]);

    await siteDataCommand(["--report", legacy, "--stress-report", stress, "--out", out]);
    const before = JSON.parse(await readFile(out, "utf8")).stress.observations;

    expect(before).toBeGreaterThan(0);

    await expect(siteDataCommand(["--report", legacy, "--out", out])).rejects.toThrow(
      /--stress-report|--no-stress/,
    );
    expect(JSON.parse(await readFile(out, "utf8")).stress.observations).toBe(before);

    await expect(
      siteDataCommand(["--report", legacy, "--stress-report", legacy, "--out", out]),
    ).rejects.toThrow(/stress/);

    await siteDataCommand(["--report", legacy, "--no-stress", "--out", out]);
    expect(JSON.parse(await readFile(out, "utf8")).stress.observations).toBe(0);
  });

  it("P2.2: keeps a dedicated cpu-sustained create refusal in stress selection", () => {
    const refused: MergeSource = {
      ...sustained,
      runId: "refused",
      samples: sustained.samples
        .filter((s) => s.iteration === 0)
        .map((s) => ({
          ...s,
          outcome:
            s.scenario === "cold"
              ? { kind: "failure", code: "quota", note: "Boat reported quota" }
              : {
                  kind: "blocked",
                  note: "Blocked by cold",
                  blocked_by: "cold",
                },
        })),
    };

    const stress = mergeSources([refused], [], 45, policy);

    expect(stress.selectionRemoved).toEqual({});

    const attempts = siteData(mergeSources([main]), "default", stress).stress.cpuSustained[0]
      ?.attempts;

    expect(attempts?.failures.accountLimit).toBe(1);
    expect(attempts?.successes).toBe(0);
  });
});

/** Write a merged report where `site-data` reads one. */
async function writeV2Json(dir: string, report: ReturnType<typeof mergeSources>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "results.json"), JSON.stringify(report));
}

describe("P2.3: survival publication", () => {
  let main: MergeSource;
  let survival: MergeSource;
  let repeated: MergeSource;

  it("collects the fixtures", async () => {
    [main, survival, repeated] = await Promise.all([
      collect("main-run", ["--runs", "1", "--bursts", "", "--scenarios", "command"]),
      collect("survival-run", survivalArgs("2")),
      collect("repeated-run", survivalArgs("1,1")),
    ]);
  }, 60_000);

  it("recomputes a stored survived verdict from its heartbeats and the plan", () => {
    const plan = { windowMs: 1500, intervalMs: 1000 };

    // Evidence from the earlier schedule, which had no slot at the window's end.
    const early = {
      verdict: { kind: "survived" },
      expected: 2,
      ok: 2,
      missed: 0,
      skipped: 0,
      heartbeats: [
        { kind: "ok", atMs: 0, latencyMs: 1 },
        { kind: "ok", atMs: 1002, latencyMs: 1 },
      ],
      plan,
    };

    const samples = structuredClone(survival.samples).map((s) =>
      s.scenario === "survival-2/window"
        ? { ...s, details: early }
        : s.scenario === "survival-2/cohort"
          ? { ...s, details: { ...Object(s.details), plan } }
          : s,
    );

    const stress = mergeSources([{ ...survival, samples }]);

    const row = siteData(mergeSources([main]), "default", stress).stress.burstSurvival[0]
      ?.providers[0];

    expect(row?.survived).toBe(0);
    expect(row?.survivalRate).not.toBe(1);
  });

  it("keeps repeated cohorts of the same K apart", () => {
    const stress = mergeSources([repeated]);

    const row = siteData(mergeSources([main]), "default", stress).stress.burstSurvival[0]
      ?.providers[0];

    const aggregates = repeated.samples.filter((s) => s.scenario === "survival-1/cohort");

    expect(new Set(aggregates.map((s) => s.iteration)).size).toBe(2);
    expect(row).toMatchObject({
      cohorts: 2,
      incomplete: { cohorts: 0, members: 0 },
      survived: 2,
      survivalRate: 1,
    });
  });
});

describe("P2.4: stress failure classes", () => {
  const failure = (note: string, extra: Partial<FailureOutcome> = {}): FailureOutcome => ({
    kind: "failure",
    note,
    ...extra,
  });

  const missed = (outcome: FailureOutcome, atMs: number, lookup = running): Heartbeat => ({
    kind: "missed",
    atMs,
    latencyMs: 1,
    timedOut: false,
    lookup,
    failure: outcome,
  });

  const decide = (heartbeats: Heartbeat[]) =>
    survivalFailure(
      {
        elapsedMs: 1,
        expected: heartbeats.length + 1,
        heartbeatTimeoutMs: 1000,
        heartbeats,
        verdict: classifyHeartbeats(heartbeats, heartbeats.length + 1),
      },
      "survival-2/window",
    );

  it("lets an exact death beat Boat's quota wording", () => {
    const outcome = decide([
      missed(failure("Boat reported quota"), 0, {
        ...running,
        result: "not-found",
      }),
    ]);

    expect(outcome?.note).toMatch(/Died/);
    expect(
      classifyFailure({
        provider: "boat",
        scenario: "survival-2/window",
        outcome: outcome!,
      }),
    ).toBe("provider-operation");
    expect(
      classifyFailure({
        provider: "boat",
        scenario: "cpu-burst-2/cold",
        outcome: failure("Boat reported quota in malformed template"),
      }),
    ).toBe("provider-operation");
    // The published Boat rule stays as it was outside the cohort suites.
    expect(
      classifyFailure({
        provider: "boat",
        scenario: "cold",
        outcome: failure("Boat reported quota"),
      }),
    ).toBe("provider-account-limit");
  });

  it("decides on death, then provider failure, then typed quota, then unknown", () => {
    const quota = failure("numeric quota", { cause: { httpStatus: 429 } });

    const broken = failure("provider exec broke", {
      cause: { httpStatus: 500 },
    });

    const unknown = failure("socket hang up");

    // A later HTTP 500 proves a provider failure, whatever the 429 before it.
    const mixed = decide([missed(quota, 0), missed(broken, 100)]);

    expect(mixed?.cause?.httpStatus).toBe(500);
    expect(
      classifyFailure({
        provider: "e2b",
        scenario: "survival-2/window",
        outcome: mixed!,
      }),
    ).toBe("provider-operation");

    // Typed quota outranks an untyped miss.
    const limited = decide([missed(unknown, 0), missed(quota, 100)]);

    expect(limited?.cause?.httpStatus).toBe(429);
    expect(
      classifyFailure({
        provider: "e2b",
        scenario: "survival-2/window",
        outcome: limited!,
      }),
    ).toBe("provider-account-limit");

    // An untyped miss alone stays the provider's.
    expect(
      classifyFailure({
        provider: "e2b",
        scenario: "survival-2/window",
        outcome: decide([missed(unknown, 0)])!,
      }),
    ).toBe("provider-operation");

    // Proven death beats every miss before it.
    const died = decide([
      missed(quota, 0),
      missed(broken, 100),
      missed(unknown, 200, { ...running, result: "not-found" }),
    ]);

    expect(died?.note).toMatch(/Died/);
  });
});

describe("P2.5 and P2.6: CPU probe timing", () => {
  const work = { segments: 4, steps: 10_000_000 };
  const seed = 8128;

  function reply(start: number, seconds: number, worker = { after: 0, allSeconds: seconds }) {
    const run = (at: number) => ({
      rates: Array<number>(work.segments).fill((work.steps * work.segments) / seconds),
      seconds,
      checksum: lcgChecksum(seed, work.segments * work.steps),
      startedAt: at,
      endedAt: at + seconds,
    });

    return JSON.stringify({
      ...work,
      seed,
      single: run(start),
      all: {
        startedAt: start + seconds,
        endedAt: start + seconds + worker.allSeconds,
        wallSeconds: worker.allSeconds,
        workers: [run(start + seconds + worker.after)],
      },
      cpus: { visible: 1, affinity: 1, quota: null },
      python: "fixture",
    });
  }

  it("rejects a worker outside its phase and an all-core rate no worker reaches", () => {
    // The worker starts a second after its 25 ms all-core phase ended; 1.6 G steps/s on one worker.
    const outside = reply(1_800_000_000, 0.041, {
      after: 1,
      allSeconds: 0.025,
    });

    expect(() => cpuResult(outside, { work, seed, workers: 1 }, 2)).toThrow(/outside|rate/);

    // Inside its phase, but the phase claims more than one worker can do.
    const fast = reply(1_800_000_000, 0.041, { after: 0, allSeconds: 0.039 });

    expect(() => cpuResult(fast, { work, seed, workers: 1 }, 2)).toThrow(/rate/);
  });

  it("compares the overlap cutoff on unrounded values", () => {
    // Single-core proven overlap 799.6 ms of a 1000 ms phase: 0.7996, which rounds to 0.8.
    const borderline = cpuOverlap([
      { exec: [0, 2000], singleSeconds: 1, allSeconds: 1 },
      { exec: [200.4, 2200.4], singleSeconds: 1, allSeconds: 1 },
    ]);

    expect(borderline.kind === "bound" && borderline.single.provenFraction).toBe(0.8);
    expect(borderline.ok).toBe(false);
  });

  it("ignores a guest clock stepped back onto another member's run", async () => {
    let stepMs = 0;
    const provider = memory();

    provider.register("python3", async ({ args, stdout }) => {
      const [, mode, ...rest] = args;

      if (mode === "clock") {
        stdout(`${(Date.now() + stepMs) / 1000}\n`);

        return 0;
      }

      const [segments = 0, steps = 0, , runSeed = 0] = rest.map(Number);
      const phase = 0.05;
      const startedAt = (Date.now() + stepMs) / 1000;
      await sleep(110);

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
            workers: [run(startedAt + phase)],
            wallSeconds: phase,
            startedAt: startedAt + phase,
            endedAt: startedAt + 2 * phase,
          },
          cpus: { visible: 1, affinity: 1, quota: null },
          python: "fixture",
        }),
      );

      return 0;
    });

    const box = await createSandbox(provider, {});

    try {
      const challenge = {
        work: { segments: 4, steps: 1_000_000 },
        seed: 5,
        workers: 1,
      };

      const first = await runStagedCpuProbe(box, await stageCpuProbe(box, challenge, 5000), 5000);
      const staged = await stageCpuProbe(box, challenge, 5000);
      await sleep(25);
      // The second member's guest clock is stepped back onto the first's run: they ran apart.
      stepMs = first.exec[0] - (performance.timeOrigin + performance.now());
      const second = await runStagedCpuProbe(box, staged, 5000);

      // The guest's own timestamps now claim the two runs overlapped; the host clock says not.
      expect(stepMs).toBeLessThan(-100);

      const overlap = cpuOverlap(
        [first, second].map((ran) => ({
          exec: ran.exec,
          singleSeconds: ran.result.singleSeconds,
          allSeconds: ran.result.allSeconds,
        })),
      );

      expect(overlap.ok).toBe(false);
    } finally {
      await box.destroy();
    }
  });
});

describe("P2.7: scenario selection", () => {
  it("refuses a named cohort suite with no cohort sizes", () => {
    expect(() => parseV2(["--scenarios", "survival", "--bursts", ""])).toThrow(/--bursts/);
    expect(() => parseV2(["--scenarios", "cpu-burst", "--bursts", ""])).toThrow(/--bursts/);
    // A run without cohort suites still takes an empty list.
    expect(parseV2(["--scenarios", "command", "--bursts", ""]).bursts).toEqual([]);
  });

  it("keeps stress suites in their own runs, never in `all`", () => {
    expect(() => parseV2(["--scenarios", "command,cpu-sustained"])).toThrow(/Stress suites/);
    expect(() => parseV2(["--scenarios", "all,survival"])).toThrow(/Stress suites/);
    expect(() => parseV2(["--scenarios", "burst,cpu-burst"])).toThrow(/Stress suites/);
    expect(parseV2(["--scenarios", "cpu-sustained,cpu-burst,survival"]).scenarios).toHaveLength(3);
    expect(selectsScenario(["all"], "cpu-sustained")).toBe(false);
    expect(selectsScenario(["all"], "command")).toBe(true);
    // A cpu-sustained run collects no readiness bursts, whatever --bursts says.
    expect(selectedCohorts(["cpu-sustained"], [3])).toEqual([]);
  });

  it("labels ordinary rows of a mixed command,burst run as main", async () => {
    const main = await collect("mixed-run", [
      "--runs",
      "1",
      "--bursts",
      "",
      "--scenarios",
      "command",
    ]);

    const mixed = {
      ...main,
      config: { ...main.config, scenarios: ["command", "burst"] },
    };

    const merged = mergeSources([mixed]);

    expect(merged.samples.find((s) => s.scenario === "cold")?.suite).toBe("main");
  }, 30_000);
});

const at = "2026-11-19T00:00:00.000Z";

const host = {
  timestamp: at,
  load: [0, 0, 0],
  cpu: { user: 0, system: 0 },
  cpuTicks: [],
  network: "",
};

const fingerprint: Fingerprint = {
  cpuModel: "",
  flags: [],
  nproc: 1,
  cpuMax: "",
  quotaCpus: null,
  memoryMax: "",
  memTotalBytes: 2 * 1024 ** 3,
  memoryBytes: 2 * 1024 ** 3,
  diskBytes: 0,
  df: "",
  lsblk: "",
  virtualization: "",
  hypervisor: false,
  dmi: "",
  kernel: "",
  distro: "",
  user: "",
  uid: 0,
  sudo: false,
  stealPercent: null,
  egress: null,
  tools: {},
  runtime: "",
};

function sampleRow(scenario: string, durationMs = 2000, provider = "boat"): Sample {
  return {
    provider,
    iteration: 0,
    scenario,
    unit: "ms",
    startedAt: at,
    finishedAt: at,
    durationMs,
    sandboxId: "sb",
    outcome: { kind: "sample", value: durationMs },
    phases: {},
    hostBefore: host,
    hostAfter: host,
    headroom: {
      normalizedLoad: 0,
      hostCpuBusy: 0,
      processCpuMs: 0,
      highLoad: false,
      rxBytesPerSecond: 0,
      txBytesPerSecond: 0,
    },
    fingerprint,
    estimatedCost: null,
    details: null,
  };
}

describe("P2.8 and P3: cost projections price each sandbox", () => {
  const config = parseV2([
    "--providers",
    "vercel",
    "--burst-cohorts",
    "1",
    "--account-limits",
    "vercel=25",
  ]);

  const providers = [
    {
      name: "vercel",
      kind: "ready" as const,
      note: "",
      configuredRegion: null,
    },
  ];

  // One sandbox, billed Vercel's one-minute minimum at 1 vCPU / 2 GiB, plus a creation fee.
  const oneMinute = 0.1704 / 60 + 0.6 / 1_000_000;

  it("prices readiness bursts per sandbox, not on summed runtime", () => {
    const [vercel] = projectCosts({
      config,
      providers,
      samples: [sampleRow("burst-3/sandbox-lifetime", 2000, "vercel")],
    });

    expect(vercel?.burst10).toBeCloseTo(10 * oneMinute, 9);
    expect(vercel?.burst25).toBeCloseTo(25 * oneMinute, 9);
  });

  it("averages per-member prices, not the mean duration", () => {
    const cpuBurst25 = (...lifetimesMs: number[]) =>
      projectCosts({
        config,
        providers,
        samples: lifetimesMs.map((ms) => sampleRow("cpu-burst-2/sandbox-lifetime", ms, "vercel")),
      })[0]?.stress.cpuBurst25;

    const short = z.number().parse(cpuBurst25(2000));
    const long = z.number().parse(cpuBurst25(118_000));

    expect(cpuBurst25(2000, 118_000)).toBeCloseTo((short + long) / 2, 12);
    // The mean duration (60 s) would be priced at the one-minute minimum alone.
    expect(cpuBurst25(60_000)).toBeLessThan((short + long) / 2);
  });
});
