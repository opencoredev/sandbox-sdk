// Regression tests for the review of the stress suites (cpu-sustained, cpu-burst, survival).
// Each test reproduces one counterexample the review found; the finding number is in its name.
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import {
  cpuOverlap,
  cpuResult,
  lcgChecksum,
  runStagedCpuProbe,
  segmentConsistency,
  stageCpuProbe,
} from "../src/cpu.js";
import type { LookupEvidence } from "../src/existence.js";
import type { Fingerprint } from "../src/fingerprint.js";
import { lifetimeOptions } from "../src/lifetime.js";
import { classifyFailure, mergeSources, readSource, type MergeSource } from "../src/merge.js";
import { projectCosts } from "../src/projection.js";
import { cohortBoundMs, cohortOnly, selectedCohorts, survivalEndBy } from "../src/scenarios.js";
import { siteData } from "../src/site-data.js";
import {
  deathReason,
  heartbeatWindow,
  survivalFailure,
  type WindowInput,
} from "../src/survival.js";
import { parseV2 } from "../src/v2-config.js";
import type { Sample } from "../src/v2-model.js";
import { writeV2 } from "../src/v2-report.js";
import { runV2 } from "../src/v2-runner.js";
import { boundFake } from "./native-fakes.js";

const bootId = "4f9c1d1e-8b2a-4c1e-9d3f-0a1b2c3d4e5f";

const running: LookupEvidence = {
  result: "present",
  nativeState: "running",
  method: "exact-get",
  checkedAt: "2026-11-19T00:00:00.000Z",
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function windowInput(overrides: Partial<WindowInput> = {}): WindowInput {
  const plan = overrides.plan ?? { windowMs: 100, intervalMs: 20 };

  return {
    plan,
    heartbeat: async () => bootId,
    lookup: async () => running,
    heartbeatTimeoutMs: 40,
    endBy: performance.now() + cohortBoundMs("survival", 40, plan),
    stop: new AbortController().signal,
    sanitize: (text) => text,
    track: (work) => work,
    ...overrides,
  };
}

describe("finding 6: the CPU probe checks timing and a fresh challenge", () => {
  const work = { segments: 4, steps: 10_000_000 };

  function probe(seed: number, run: { rates: number[]; seconds: number }) {
    const at = 1_800_000_000;
    const timed = { ...run, checksum: lcgChecksum(seed, work.segments * work.steps) };

    return JSON.stringify({
      ...work,
      seed,
      single: { ...timed, startedAt: at, endedAt: at + run.seconds },
      all: {
        workers: [{ ...timed, startedAt: at + run.seconds, endedAt: at + 2 * run.seconds }],
        wallSeconds: run.seconds,
        startedAt: at + run.seconds,
        endedAt: at + 2 * run.seconds,
      },
      cpus: { visible: 1, affinity: 1, quota: null },
      python: "fixture",
    });
  }

  it("computes the LCG checksum by jump-ahead, equal to stepping", () => {
    let x = 99;

    for (let i = 0; i < 1000; i++) x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    expect(lcgChecksum(99, 1000)).toBe(x);
    expect(lcgChecksum(99, 0)).toBe(99);
  });

  it("rejects impossible timing next to a correct checksum", () => {
    // 10 steps/s per segment, yet the whole phase claims a microsecond: no guest did this.
    const output = probe(7, { rates: [10, 10, 10, 10], seconds: 0.000001 });

    expect(() => cpuResult(output, { work, seed: 7, workers: 1 }, 1)).toThrow(/timing/i);
  });

  it("rejects a rate no CPython process reaches", () => {
    const seconds = 0.000004;
    const output = probe(7, { rates: [1e13, 1e13, 1e13, 1e13], seconds });

    expect(() => cpuResult(output, { work, seed: 7, workers: 1 }, 1)).toThrow(/rate/i);
  });

  it("rejects guest phases longer than the host saw", () => {
    const output = probe(7, { rates: [1e7, 1e7, 1e7, 1e7], seconds: 4 });

    // 8 s of guest work cannot fit in a 2 s exec.
    expect(() => cpuResult(output, { work, seed: 7, workers: 1 }, 2)).toThrow(/host/i);
  });

  it("rejects a replay of an earlier run's reply", () => {
    const output = probe(7, { rates: [1e7, 1e7, 1e7, 1e7], seconds: 4 });

    expect(cpuResult(output, { work, seed: 7, workers: 1 }, 9).singleOpsPerSecond).toBeCloseTo(1e7);
    expect(() => cpuResult(output, { work, seed: 8, workers: 1 }, 9)).toThrow(/seed|checksum/i);
  });
});

describe("finding 7: CPU burst overlap and segment consistency", () => {
  it("names consistency honestly: one slow segment shows, whatever the endpoints", () => {
    const result = segmentConsistency([100, 1, 1, 100]);

    expect(result.lastOverFirst).toBe(1);
    expect(result.minOverMedian).toBeCloseTo(1 / 50.5);
    expect(segmentConsistency([10, 10, 10, 10]).minOverMedian).toBe(1);
  });

  it("flags a cohort whose members did not run their CPU phases together", () => {
    // Each exec has 50 ms around its two 1 s phases: wherever they fell, they overlapped 94%.
    const together = cpuOverlap([
      { exec: [0, 2050], singleSeconds: 1, allSeconds: 1 },
      { exec: [10, 2060], singleSeconds: 1, allSeconds: 1 },
    ]);

    expect(together.ok).toBe(true);
    expect(together.kind === "bound" && together.dispatchSkewMs).toBe(10);
    expect(together.kind === "bound" && together.single.provenFraction).toBe(0.94);

    // The second member's exec began after the first could have finished its single-core phase.
    const apart = cpuOverlap([
      { exec: [0, 2050], singleSeconds: 1, allSeconds: 1 },
      { exec: [1500, 3550], singleSeconds: 1, allSeconds: 1 },
    ]);

    expect(apart.ok).toBe(false);
    expect(apart.kind === "bound" && apart.single.provenFraction).toBe(0);

    // Phases longer than the exec that ran them contradict themselves.
    expect(cpuOverlap([{ exec: [0, 1500], singleSeconds: 1, allSeconds: 1 }]).kind).toBe(
      "inconsistent",
    );
  });

  it("stages the probe and reads the guest clock before the work starts, and times its return", async () => {
    const provider = memory();
    const events: string[] = [];

    provider.register("python3", async ({ args, stdout, files }) => {
      const [path, mode, ...rest] = args;

      await files.read(path ?? "");
      events.push(mode ?? "");

      if (mode === "clock") {
        stdout(`${Date.now() / 1000}\n`);

        return 0;
      }

      const [segments, steps, , seed] = rest.map(Number);

      const run = async () => {
        const startedAt = Date.now() / 1000;
        await sleep(40);
        const endedAt = Date.now() / 1000;
        const seconds = endedAt - startedAt;

        return {
          checksum: lcgChecksum(seed ?? 0, (segments ?? 0) * (steps ?? 0)),
          seconds,
          rates: Array.from(
            { length: segments ?? 0 },
            () => ((steps ?? 0) * (segments ?? 0)) / seconds,
          ),
          startedAt,
          endedAt,
        };
      };

      const single = await run();
      const worker = await run();
      stdout(
        JSON.stringify({
          segments,
          steps,
          seed,
          single,
          all: {
            workers: [worker],
            wallSeconds: worker.seconds,
            startedAt: worker.startedAt,
            endedAt: worker.endedAt,
          },
          cpus: { visible: 1, affinity: 1, quota: null },
          python: "fake",
        }),
      );

      return 0;
    });

    const box = await createSandbox(provider, {});

    try {
      const challenge = { work: { segments: 2, steps: 1_000_000 }, seed: 12345, workers: 1 };
      const staged = await stageCpuProbe(box, challenge, 5000);

      expect(events).toEqual(["clock"]);

      const before = performance.now();
      const ran = await runStagedCpuProbe(box, staged, 5000);

      // The clock is read again after the run, to measure any drift or step since staging.
      expect(events).toEqual(["clock", "run", "clock"]);
      expect(ran.returnedAt).toBeGreaterThan(before);
      expect(ran.returnedAt).toBeLessThanOrEqual(performance.now());
      expect(ran.exec[1] - ran.exec[0]).toBeGreaterThanOrEqual(80);
      expect(ran.result.singleOpsPerSecond).toBeGreaterThan(0);
    } finally {
      await box.destroy();
    }
  });
});

describe("findings 3 and 4: heartbeat windows", () => {
  it("survives only with a heartbeat at the window's end, for irregular windows too", async () => {
    const result = await heartbeatWindow(windowInput({ plan: { windowMs: 150, intervalMs: 100 } }));

    expect(result.verdict.kind).toBe("survived");
    expect(result.heartbeats.at(-1)?.atMs).toBeGreaterThanOrEqual(150);
  });

  it("keeps slow heartbeats and lookups inside the member's reserve, without replaying slots", async () => {
    const plan = { windowMs: 100, intervalMs: 20 };
    const start = performance.now();

    const result = await heartbeatWindow(
      windowInput({
        plan,
        endBy: survivalEndBy(start - 2 * 40, 40, plan),
        heartbeat: async () => {
          await sleep(100);

          return bootId;
        },
        lookup: async () => {
          await sleep(35);

          return running;
        },
      }),
    );

    expect(result.elapsedMs).toBeLessThanOrEqual(cohortBoundMs("survival", 40, plan) - 2 * 40);

    // Every heartbeat that was sent went out on its slot, not late; the rest are recorded as skipped.
    for (const h of result.heartbeats)
      if (h.kind !== "skipped") expect(h.atMs % plan.intervalMs).toBeLessThan(10);
    expect(result.heartbeats.some((h) => h.kind === "skipped")).toBe(true);
    expect(result.verdict.kind).toBe("unresponsive");
  });
});

describe("finding 5: death and quota evidence", () => {
  it("trusts an exact running lookup over an exec not_found", () => {
    expect(
      deathReason(
        {
          kind: "missed",
          atMs: 10,
          latencyMs: 1,
          timedOut: false,
          failure: { kind: "failure", code: "not_found", note: "exec endpoint not found" },
          lookup: running,
        },
        bootId,
      ),
    ).toBeNull();
  });

  it("does not treat a Daytona invalid template as quota in the new suites", () => {
    const outcome = {
      kind: "failure" as const,
      code: "invalid_argument",
      note: "invalid_argument: template missing",
    };

    expect(classifyFailure({ provider: "daytona", scenario: "survival-2/cold", outcome })).toBe(
      "provider-operation",
    );
    expect(classifyFailure({ provider: "daytona", scenario: "cpu-burst-2/cold", outcome })).toBe(
      "provider-operation",
    );
    // The published readiness-burst rule stays as it was.
    expect(classifyFailure({ provider: "daytona", scenario: "burst-10/cold", outcome })).toBe(
      "provider-account-limit",
    );
  });

  it("lets proof of death win over an earlier rate-limited heartbeat", async () => {
    let call = 0;

    const result = await heartbeatWindow(
      windowInput({
        plan: { windowMs: 40, intervalMs: 20 },
        heartbeat: async () => {
          call++;

          if (call === 1) return bootId;

          if (call === 2) throw Object.assign(new Error("HTTP 429"), { code: "quota" });
          throw Object.assign(new Error("sandbox not found"), { code: "not_found" });
        },
        lookup: async () =>
          call >= 3 ? { ...running, result: "not-found", nativeState: undefined } : running,
      }),
    );

    expect(result.verdict).toMatchObject({ kind: "died", reason: "absent" });
    const outcome = survivalFailure(result, "survival-2/window");

    expect(outcome).not.toBeNull();
    expect(
      classifyFailure({ provider: "boat", scenario: "survival-2/window", outcome: outcome! }),
    ).toBe("provider-operation");
  });

  it("needs a typed quota signal, not wording, in the new suites", () => {
    const failed = (note: string, extra = {}) =>
      classifyFailure({
        provider: "e2b",
        scenario: "survival-10/cold",
        outcome: { kind: "failure", note, ...extra },
      });

    expect(failed("Create failed", { code: "quota" })).toBe("provider-account-limit");
    expect(failed("Create failed", { cause: { httpStatus: 429 } })).toBe("provider-account-limit");
    expect(failed("Template not found; limit exceeded for nothing in particular")).toBe(
      "provider-operation",
    );
  });
});

describe("finding 8: scenario selection and Modal lifetime", () => {
  it("runs an explicit main scenario next to readiness bursts", () => {
    expect(cohortOnly(["cpu-sustained", "burst"])).toBe(false);
    expect(selectedCohorts(["cpu-sustained", "burst"], [2])).toEqual(["burst"]);
    expect(cohortOnly(["burst"])).toBe(true);
    expect(cohortOnly(["survival", "cpu-burst"])).toBe(true);
  });

  it("refuses an explicit Modal lifetime shorter than a survival member needs", () => {
    const config = {
      scenarios: ["survival"],
      "timeout-ms": 180_000,
      "survival-window-ms": 300_000,
      "survival-heartbeat-ms": 15_000,
    };

    expect(() =>
      lifetimeOptions("modal", { ...config, "lifetime-ms": { modal: 400_000 } }),
    ).toThrow(/survival/);
    expect(
      lifetimeOptions("modal", { ...config, "lifetime-ms": { modal: 3_600_000 } }).timeoutMs,
    ).toBe(3_600_000);
  });
});

describe("finding 9: cost projections charge each sandbox", () => {
  it("prices every cohort member at its own minimum, then multiplies", () => {
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

    const row = (scenario: string): Sample => ({
      provider: "vercel",
      iteration: 0,
      scenario,
      unit: "ms",
      startedAt: at,
      finishedAt: at,
      durationMs: 2000,
      sandboxId: "sb",
      outcome: { kind: "sample", value: 2000 },
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
    });

    const [vercel] = projectCosts({
      config: parseV2([
        "--providers",
        "vercel",
        "--burst-cohorts",
        "1",
        "--account-limits",
        "vercel=25",
      ]),
      providers: [{ name: "vercel", kind: "ready", note: "", configuredRegion: null }],
      samples: [row("cpu-burst-2/sandbox-lifetime")],
    });

    // 25 sandboxes, each billed Vercel's one-minute minimum at 1 vCPU / 2 GiB, plus a creation fee.
    expect(vercel?.stress.cpuBurst25).toBeCloseTo(25 * (0.1704 / 60 + 0.6 / 1_000_000), 9);
    expect(vercel?.stress.cpuBurst25).toBeCloseTo(0.071015, 6);
  });
});

type SourceSample = MergeSource["samples"][number];

/** A row's details as a plain object, for fixtures that change one field. */
const detailsObject = z.record(z.string(), z.unknown());

// Real collections over the offline memory fake, priced as Boat, read back as merge reads them.
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function collect(run: string, args: string[]) {
  const dir = await mkdtemp(join(tmpdir(), `bench-review-${run}-`));
  dirs.push(dir);
  const provider = memory();

  provider.register("cat", async ({ stdout }) => {
    stdout(`${bootId}\n`);

    return 0;
  });

  await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: boundFake(provider) }],
    parseV2(["--providers", "boat", "--run", run, "--out", dir, ...args]),
    (report) => writeV2(report, dir),
  );

  return readSource(dir);
}

const survivalArgs = [
  "--scenarios",
  "survival",
  "--bursts",
  "2",
  "--burst-cohorts",
  "1",
  "--concurrency",
  "2",
  "--survival-window-ms",
  "1000",
  "--survival-heartbeat-ms",
  "1000",
];

describe("findings 1, 2 and 4: publication", () => {
  let main: MergeSource;
  let survival: MergeSource;
  let sustained: MergeSource;

  it("collects the fixtures", async () => {
    [main, survival, sustained] = await Promise.all([
      collect("main-run", ["--runs", "1", "--bursts", "", "--scenarios", "command"]),
      collect("survival-run", survivalArgs),
      collect("sustained-run", ["--runs", "1", "--bursts", "", "--scenarios", "cpu-sustained"]),
    ]);
  }, 60_000);

  const legacy = ({ stress: _stress, ...older }: ReturnType<typeof siteData>) => older;

  /** The survival fixture's rows, split by member scenario, deep-copied for mutation. */
  function rows() {
    const all: SourceSample[] = structuredClone(survival.samples);
    const pick = (name: string) => all.filter((s) => s.scenario === `survival-2/${name}`);

    return { all, cold: pick("cold"), windows: pick("window"), aggregate: pick("cohort")[0]! };
  }

  const source = (samples: SourceSample[], runId = "survival-fixture") => ({
    ...survival,
    runId,
    samples,
  });

  const policy = { replacements: [], notRun: [] };

  it("1: a stress report leaves every legacy field as the legacy report alone gives it", () => {
    const before = siteData(mergeSources([main]));
    const after = siteData(mergeSources([main]), "default", mergeSources([sustained, survival]));

    expect(legacy(after)).toEqual(legacy(before));
    expect(after.stress.runs.map((r) => r.id).sort()).toEqual(["survival-run", "sustained-run"]);
  });

  it("1: a legacy report that carries stress rows is refused, not filtered", () => {
    expect(() => siteData(mergeSources([main, sustained]))).toThrow(/stress/);
  });

  it("2: selection keeps a refused create in stress and out of the legacy exclusions", () => {
    const { cold, windows, aggregate } = rows();
    cold[1]!.outcome = { kind: "failure", code: "quota", note: "HTTP 429" };
    const fixture = source([...cold, windows[0]!, aggregate]);
    const merged = mergeSources([main, fixture], [], 45, policy);

    expect(merged.selectionRemoved).toEqual({});

    const site = siteData(
      mergeSources([main], [], 45, policy),
      "default",
      mergeSources([fixture], [], 45, policy),
    );

    const row = site.stress.burstSurvival[0]?.providers[0];

    expect(row).toMatchObject({ attempted: 2, createFailed: { accountLimit: 1 } });
    expect(site.exclusions).toEqual(siteData(mergeSources([main], [], 45, policy)).exclusions);
  });

  it("2: a rate-limited heartbeat keeps its member's verdict", () => {
    const { cold, windows, aggregate } = rows();
    const details = detailsObject.parse(windows[1]!.details);
    const beats = z.array(detailsObject).parse(details.heartbeats);
    windows[1]!.outcome = { kind: "failure", code: "quota", note: "HTTP 429" };

    // The last heartbeat was refused with a typed quota error, so the evidence shows the verdict.
    windows[1]!.details = {
      ...details,
      verdict: { kind: "unresponsive" },
      heartbeats: [
        ...beats.slice(0, -1),
        {
          ...beats.at(-1),
          kind: "missed",
          timedOut: false,
          note: "HTTP 429",
          code: "quota",
          lookup: running,
        },
      ],
    };
    const stress = mergeSources([source([...cold, ...windows, aggregate])], [], 45, policy);

    const row = siteData(mergeSources([main]), "default", stress).stress.burstSurvival[0]
      ?.providers[0];

    expect(row).toMatchObject({ unresponsive: 1, windowFailures: { accountLimit: 1 } });
    // A rate-limited window is the account's, not the provider's: out of the denominator.
    expect(row?.survivalRate).toBe(1);
  });

  it("4: a member interrupted before its window does not count against the provider", () => {
    const { cold, windows, aggregate } = rows();
    aggregate.outcome = { kind: "skipped", note: "interrupted" };
    const stress = mergeSources([source([...cold, windows[0]!, aggregate])]);

    const row = siteData(mergeSources([main]), "default", stress).stress.burstSurvival[0]
      ?.providers[0];

    expect(row).toMatchObject({ interrupted: 1, survivalRate: 1 });
  });

  it("4: a budget-truncated cohort is not K-way evidence", () => {
    const { cold, windows, aggregate } = rows();
    aggregate.outcome = { kind: "skipped", note: "budget stopped admission" };
    const stress = mergeSources([source([cold[0]!, windows[0]!, aggregate])]);

    const row = siteData(mergeSources([main]), "default", stress).stress.burstSurvival[0]
      ?.providers[0];

    expect(row).toMatchObject({ survivalRate: null, incomplete: { cohorts: 1, members: 1 } });
  });

  it("4: different survival plans stay apart", () => {
    const withPlan = (runId: string, plan: { windowMs: number; intervalMs: number }) =>
      source(
        rows().all.map((s) => ({
          ...s,
          details: s.details === null ? null : { ...detailsObject.parse(s.details), plan },
        })),
        runId,
      );

    const stress = mergeSources([
      withPlan("short", { windowMs: 1000, intervalMs: 1000 }),
      withPlan("long", { windowMs: 300_000, intervalMs: 15_000 }),
    ]);

    const entries = siteData(mergeSources([main]), "default", stress).stress.burstSurvival[0]
      ?.providers;

    expect(entries?.map((e) => e.windowS).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 300]);
  });
});

describe("PR 75 review: the diagnostic clock read never discards a verified CPU result", () => {
  /**
   * The memory fake with a probes/cpu.py stand-in: the first clock read answers, the run reports
   * honest work, and every clock read after it does what `after` says.
   */
  function probeBox(after: "fail" | "hang") {
    const provider = memory();
    let clocks = 0;

    provider.register("python3", async ({ args, stdout }) => {
      const [, mode, ...rest] = args;

      if (mode === "clock") {
        if (clocks++ === 0) {
          stdout(`${Date.now() / 1000}\n`);

          return 0;
        }

        if (after === "hang") await sleep(3_000);

        return 1;
      }

      const [segments = 0, steps = 0, , seed = 0] = rest.map(Number);

      const phase = async () => {
        const startedAt = Date.now() / 1000;
        await sleep(40);
        const endedAt = Date.now() / 1000;
        const seconds = endedAt - startedAt;

        return {
          checksum: lcgChecksum(seed, segments * steps),
          seconds,
          rates: Array.from({ length: segments }, () => (steps * segments) / seconds),
          startedAt,
          endedAt,
        };
      };

      const single = await phase();
      const worker = await phase();
      stdout(
        JSON.stringify({
          segments,
          steps,
          seed,
          single,
          all: {
            workers: [worker],
            wallSeconds: worker.seconds,
            startedAt: worker.startedAt,
            endedAt: worker.endedAt,
          },
          cpus: { visible: 1, affinity: 1, quota: null },
          python: "fake",
        }),
      );

      return 0;
    });

    return provider;
  }

  const challenge = { work: { segments: 2, steps: 1_000_000 }, seed: 12345, workers: 1 };

  it("keeps the result and records why when the clock read fails", async () => {
    const box = await createSandbox(probeBox("fail"), {});

    try {
      const ran = await runStagedCpuProbe(box, await stageCpuProbe(box, challenge, 5000), 5000);

      expect(ran.result.singleOpsPerSecond).toBeGreaterThan(0);
      expect(ran).toMatchObject({ clockDriftMs: null, clockDriftUnread: "failed" });
    } finally {
      await box.destroy();
    }
  });

  it("gives up on a clock read that would outlast the step, and keeps the result", async () => {
    const box = await createSandbox(probeBox("hang"), {});

    try {
      const staged = await stageCpuProbe(box, challenge, 5000);
      const endBy = performance.now() + 1000;
      const ran = await runStagedCpuProbe(box, staged, 5000, undefined, endBy);

      // Returned before the step's end, with the run's own measurements intact.
      expect(performance.now()).toBeLessThan(endBy);
      expect(ran.result.allOpsPerSecond).toBeGreaterThan(0);
      expect(ran).toMatchObject({ clockDriftMs: null, clockDriftUnread: "timed-out" });
    } finally {
      await box.destroy();
    }
  });

  it("skips the clock read when the step has no time left", async () => {
    const box = await createSandbox(probeBox("hang"), {});

    try {
      const staged = await stageCpuProbe(box, challenge, 5000);
      const ran = await runStagedCpuProbe(box, staged, 5000, undefined, performance.now());

      expect(ran.result.singleOpsPerSecond).toBeGreaterThan(0);
      expect(ran).toMatchObject({ clockDriftMs: null, clockDriftUnread: "no-time-left" });
    } finally {
      await box.destroy();
    }
  });
});
