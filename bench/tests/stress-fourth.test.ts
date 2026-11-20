// Regression tests for the third re-check of the stress-suite fixes. Each test ports one
// counterexample from its evidence; the item it reproduces is in its describe block.
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandbox, SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { cpuPhaseEvidence, lcgChecksum, runStagedCpuProbe, stageCpuProbe } from "../src/cpu.js";
import type { LookupEvidence } from "../src/existence.js";
import type { FailureOutcome } from "../src/failure.js";
import { classifyFailure, mergeSources, readSource, type MergeSource } from "../src/merge.js";
import { estimateCost } from "../src/pricing.js";
import { stressData } from "../src/stress-site.js";
import { heartbeatWindow, missKind } from "../src/survival.js";
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
  const dir = await mkdtemp(join(tmpdir(), `bench-fourth-${name}-`));
  dirs.push(dir);

  return dir;
}

/** The memory fake answering heartbeats. */
function heartbeating() {
  const provider = memory();

  provider.register("cat", async ({ stdout }) => {
    stdout(`${bootId}\n`);

    return 0;
  });

  return provider;
}

/** What one Boat sandbox costs for `ms`, at the fixed rate the harness prices it at. */
const boatCost = (ms: number) => estimateCost("boat", ms, null, null) ?? Infinity;

/** One survival cohort of K=1 with a 1 s window, as the re-check ran it. */
const survivalArgs = (run: string, out: string, providers: string) => [
  "--providers",
  providers,
  "--run",
  run,
  "--out",
  out,
  "--scenarios",
  "survival",
  "--bursts",
  "1",
  "--burst-cohorts",
  "1",
  "--timeout-ms",
  "3500",
  "--survival-window-ms",
  "1000",
  "--survival-heartbeat-ms",
  "1000",
];

describe("P1.1: a sandbox is priced until it is observed gone, not until its delete returns", () => {
  it("prices a delete that returns at once but takes 2.85 s to take effect", async () => {
    const boat = heartbeating();
    const create = boat.create.bind(boat);
    const destroy = boat.destroy.bind(boat);
    let createdAt = 0;
    let goneAt = 0;
    let settle: Promise<void> | undefined;

    boat.create = async (...args) => {
      const info = await create(...args);
      createdAt = performance.now();

      return info;
    };

    // The delete is acknowledged at once; the sandbox runs on until the provider gets to it.
    boat.destroy = async (id) => {
      settle ??= sleep(2850).then(async () => {
        await destroy(id);
        goneAt = performance.now();
      });
    };

    const out = await tempDir("async-delete");

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "boat",
            region: null,
            cloud: false,
            provider: boat,
          },
        ],
        parseV2(survivalArgs("fourth-async-delete", out, "boat")),
        (r) => writeV2(r, out),
      );

      await settle;
      const budget = report.budgets.boat;

      expect(goneAt).toBeGreaterThan(createdAt);
      // The re-check reported $0.00003 for $0.00004 of runtime.
      expect(budget?.estimatedUSD ?? 0).toBeGreaterThanOrEqual(boatCost(goneAt - createdAt));
    } finally {
      await settle;

      for (const s of await boat.list({})) await destroy(s.id);
    }
  }, 30_000);
});

describe("P1.2: every budget is priced to one cutoff after every provider's sweep", () => {
  it("prices a sandbox left live to the return, not to its own provider's sweep", async () => {
    const boat = heartbeating();
    const destroy = boat.destroy.bind(boat);
    let createdAt = 0;
    let pricedBy = 0;
    const create = boat.create.bind(boat);

    boat.create = async (...args) => {
      const info = await create(...args);
      createdAt = performance.now();

      return info;
    };

    boat.destroy = async () => {
      throw new Error("fixture: deletion failed");
    };

    // The second provider's final sweep lists slowly, after Boat's sweep has ended.
    const local = heartbeating();
    const localList = local.list.bind(local);

    local.list = async (labels) => {
      if (Object.keys(labels ?? {}).join(",") === "sandbox-bench-run") await sleep(1250);

      return localList(labels);
    };

    const out = await tempDir("two-provider");

    try {
      const report = await runV2(
        [
          {
            kind: "ready",
            name: "boat",
            region: null,
            cloud: false,
            provider: boat,
          },
          {
            kind: "ready",
            name: "local",
            region: null,
            cloud: false,
            provider: local,
          },
        ],
        parseV2(survivalArgs("fourth-two-provider", out, "boat,local")),
        async (r) => {
          await writeV2(r, out);
          pricedBy = performance.now();
        },
      );

      const budget = report.budgets.boat;
      const liveMs = budget?.openLiabilities?.[0]?.liveMs ?? 0;

      expect((await boat.list({})).length).toBe(1);
      // The re-check priced the sandbox 2.5 s short of the return.
      expect(pricedBy - createdAt - liveMs).toBeLessThan(500);
      expect(budget?.estimatedUSD ?? 0).toBeGreaterThanOrEqual(boatCost(pricedBy - createdAt - 50));
    } finally {
      for (const s of await boat.list({})) await destroy(s.id);
    }
  }, 30_000);
});

/** A collected survival run (two members, both surviving) and its merge. */
async function survivalSource() {
  const out = await tempDir("survival");

  await runV2(
    [
      {
        kind: "ready",
        name: "boat",
        cloud: false,
        region: null,
        provider: heartbeating(),
      },
    ],
    parseV2([
      "--providers",
      "boat",
      "--run",
      "fourth-survival",
      "--out",
      out,
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
    (report) => writeV2(report, out),
  );

  return readSource(out);
}

describe("P2.3: CPU overlap is proven from the host clock, never from guest wall clocks", () => {
  const work = { segments: 4, steps: 10_000_000 };
  const phaseMs = 1420;

  /**
   * One member's probe on the memory fake. Its guest clock steps by `jump` while it runs, and its
   * phases start `delay` after the exec arrives and are reported `tail` after they end.
   */
  async function member(input: { delay: number; jump: number; tail: number }) {
    const provider = memory();
    let offset = 0;

    provider.register("python3", async ({ args, stdout }) => {
      const [, mode, , , , seedArg] = args;

      if (mode === "clock") {
        stdout(`${(Date.now() + offset) / 1000}\n`);

        return 0;
      }

      const seed = Number(seedArg);
      await sleep(input.delay);
      offset = input.jump;
      const stamp = Date.now();

      const phase = (start: number) => ({
        checksum: lcgChecksum(seed, work.segments * work.steps),
        seconds: phaseMs / 1000,
        rates: Array<number>(work.segments).fill((work.segments * work.steps * 1000) / phaseMs),
        startedAt: (start + offset) / 1000,
        endedAt: (start + phaseMs + offset) / 1000,
      });

      const single = phase(stamp);
      const all = phase(stamp + phaseMs + 25);
      await sleep(2 * phaseMs + 25 + input.tail);
      stdout(
        JSON.stringify({
          ...work,
          seed,
          single,
          all: {
            workers: [all],
            wallSeconds: all.seconds,
            startedAt: all.startedAt,
            endedAt: all.endedAt,
          },
          cpus: { visible: 1, affinity: 1, quota: null },
          python: "fixture",
        }),
      );
      // The clock steps back once the run is over, so the two clock reads agree.
      offset = 0;

      return 0;
    });

    const box = await createSandbox(provider, {});
    const staged = await stageCpuProbe(box, { work, seed: 5, workers: 1 }, 10_000);

    return { box, staged };
  }

  /** Run a cohort of members together and publish it. */
  async function cohort(
    base: Row,
    specs: readonly { delay: number; jump: number; tail: number }[],
  ) {
    const members = await Promise.all(specs.map(member));

    try {
      const runs = await Promise.all(
        members.map(({ box, staged }) => runStagedCpuProbe(box, staged, 10_000)),
      );

      const rows = runs.flatMap((ran, iteration) => {
        const phaseRow = (phase: "single" | "all"): Row => ({
          ...structuredClone(base),
          scenario: `cpu-burst-2/cpu-${phase}`,
          iteration,
          outcome: {
            kind: "sample",
            value: phase === "single" ? ran.result.singleOpsPerSecond : ran.result.allOpsPerSecond,
          },
          // What v2-runner's cpuScenario records for a phase.
          details: {
            work,
            seed: 5,
            workers: 1,
            consistency: ran.result[phase],
            guestVcpus: 1,
            cpus: { visible: 1, affinity: 1, quota: null },
            python: "fixture",
            ...cpuPhaseEvidence(ran, phase),
          },
        });

        const plain = (scenario: string, value: number): Row => ({
          ...structuredClone(base),
          scenario,
          iteration,
          outcome: { kind: "sample", value },
          details: null,
        });

        return [
          plain("cpu-burst-2/cold", 100),
          plain("cpu-burst-2/cpu", 2900),
          phaseRow("single"),
          phaseRow("all"),
        ];
      });

      const aggregate: Row = {
        ...structuredClone(base),
        scenario: "cpu-burst-2/all-complete",
        iteration: 0,
        outcome: { kind: "sample", value: 3000 },
        details: {
          k: 2,
          cohort: 0,
          attempted: 2,
          work,
          ready: 2,
          completed: 2,
        },
      };

      const published = stressData(
        mergeSources([{ ...survival, runId: "cpu-run", samples: [...rows, aggregate] }]),
        "default",
      ).cpuBurst[0]?.providers[0];

      return { published, drift: runs.map((r) => r.clockDriftMs) };
    } finally {
      await Promise.all(members.map(({ box }) => box.destroy()));
    }
  }

  let survival: MergeSource;
  let base: Row;

  it("collects the fixture", async () => {
    survival = await survivalSource();
    const cold = survival.samples.find((s) => s.scenario === "survival-2/cold");

    if (!cold) throw new Error("fixture has no cold row");
    base = cold;
  }, 60_000);

  it("publishes a cohort whose members ran together", async () => {
    const { published } = await cohort(base, [
      { delay: 0, jump: 0, tail: 0 },
      { delay: 0, jump: 0, tail: 0 },
    ]);

    expect(published?.perSandbox.cohorts).toBe(1);
  }, 30_000);

  it("excludes two opposite 350 ms clock steps that hide a 75% overlap", async () => {
    const { published, drift } = await cohort(base, [
      { delay: 350, jump: 0, tail: 0 },
      { delay: 0, jump: 350, tail: 450 },
    ]);

    // The guest clocks agree before and after, so drift alone cannot see the steps.
    for (const d of drift) expect(Math.abs(d)).toBeLessThan(20);
    expect(published?.perSandbox.cohorts).toBe(0);
    expect(published?.excluded).toMatchObject({ lowOverlap: 1 });
  }, 30_000);

  it("excludes two opposite 1650 ms clock steps that hide no overlap at all", async () => {
    const { published } = await cohort(base, [
      { delay: 1650, jump: 0, tail: 0 },
      { delay: 0, jump: 1650, tail: 1750 },
    ]);

    expect(published?.perSandbox.cohorts).toBe(0);
    expect(published?.excluded).toMatchObject({ lowOverlap: 1 });
  }, 30_000);
});

describe("P2.4: heartbeat evidence precedence", () => {
  it("counts a quota rejection that arrives after the deadline as a timeout", async () => {
    const timer = globalThis.setTimeout;
    let sent = 0;
    let delayed = false;

    // The second heartbeat's 30 ms deadline timer fires 90 ms late; its 429 arrives at 75 ms.
    const late = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((callback, delay, ...args) => {
        if (sent === 1 && delay === 30 && !delayed) {
          delayed = true;

          return timer(callback, (delay ?? 0) + 90, ...args);
        }

        return timer(callback, delay, ...args);
      });

    try {
      const result = await heartbeatWindow({
        plan: { windowMs: 100, intervalMs: 100 },
        heartbeatTimeoutMs: 30,
        endBy: performance.now() + 300,
        stop: new AbortController().signal,
        sanitize: (t) => t,
        track: (task) => task,
        lookup: async () => running,
        heartbeat: async () => {
          if (++sent === 2) {
            await sleep(75);
            throw new SandboxError("fixture delayed 429", {
              code: "quota",
              provider: "boat",
            });
          }

          return bootId;
        },
      });

      const miss = result.heartbeats[1];

      expect(delayed).toBe(true);
      expect(miss).toMatchObject({ kind: "missed", timedOut: true });

      if (result.verdict.kind !== "unresponsive") throw new Error("expected unresponsive");
      expect(missKind(result.verdict.evidence.failure)).not.toBe("quota");
    } finally {
      late.mockRestore();
    }
  });

  it("lets an HTTP status decide over the SDK code", () => {
    const outcome = (code: string, httpStatus?: number) => {
      const failure: FailureOutcome = { kind: "failure", note: "fixture", code };

      if (httpStatus !== undefined) failure.cause = { httpStatus };

      return failure;
    };

    expect(missKind(outcome("quota", 507))).toBe("provider");
    expect(missKind(outcome("quota", 404))).toBe("unknown");
    expect(missKind(outcome("provider", 429))).toBe("quota");
    expect(missKind(outcome("quota"))).toBe("quota");

    expect(
      classifyFailure({
        provider: "boat",
        scenario: "survival-2/cold",
        outcome: outcome("quota", 507),
      }),
    ).toBe("provider-operation");
    expect(
      classifyFailure({
        provider: "boat",
        scenario: "survival-2/window",
        outcome: outcome("quota", 503),
      }),
    ).toBe("provider-operation");
  });
});

describe("P2.4 and P2.5: publication recomputes classes from raw evidence", () => {
  let merged: ReturnType<typeof mergeSources>;

  it("collects the fixture", async () => {
    merged = mergeSources([await survivalSource()]);
  }, 60_000);

  const published = (input: ReturnType<typeof mergeSources>) =>
    stressData(input, "default").burstSurvival.find((g) => g.k === 2)?.providers[0];

  const heartbeats = z
    .object({ heartbeats: z.array(z.record(z.string(), z.unknown())) })
    .catchall(z.unknown());

  /** The export after `edit` rewrites the first member's window row as unresponsive at its end. */
  function lastMiss(miss: {
    latencyMs: number;
    timedOut: boolean;
    note: string;
    httpStatus?: number;
    code?: string;
  }) {
    const changed = structuredClone(merged);
    const window = changed.samples.find((s) => s.scenario === "survival-2/window");

    if (!window) throw new Error("fixture has no window row");
    const details = heartbeats.parse(window.details);
    const slot = details.heartbeats.at(-1);
    details.heartbeats[details.heartbeats.length - 1] = {
      kind: "missed",
      atMs: slot?.atMs,
      lookup: null,
      ...miss,
    };
    details.verdict = { kind: "unresponsive" };
    window.details = details;

    return published(changed);
  }

  it("counts an HTTP 507 the SDK mapped to quota as the provider's", () => {
    const statusOnly = lastMiss({
      latencyMs: 20,
      timedOut: false,
      note: "HTTP 507",
      httpStatus: 507,
    });

    const mapped = lastMiss({
      latencyMs: 20,
      timedOut: false,
      note: "HTTP 507",
      httpStatus: 507,
      code: "quota",
    });

    expect(statusOnly).toMatchObject({
      windowFailures: { provider: 1 },
      survivalRate: 0.5,
    });
    expect(mapped).toMatchObject({
      windowFailures: { provider: 1, accountLimit: 0 },
      survivalRate: 0.5,
    });
  });

  it("counts a quota refusal recorded after the heartbeat deadline as the provider's", () => {
    const late = lastMiss({
      latencyMs: 1500,
      timedOut: false,
      note: "late 429",
      code: "quota",
    });

    expect(late).toMatchObject({
      windowFailures: { provider: 1, accountLimit: 0 },
      survivalRate: 0.5,
    });
  });

  it("never reads a create failure's stored class", () => {
    const failCreate = (outcome: Row["outcome"], failureClass: string) => {
      const changed = structuredClone(merged);
      const cold = changed.samples.find((s) => s.scenario === "survival-2/cold");

      if (!cold) throw new Error("fixture has no cold row");
      cold.outcome = outcome;
      cold.failureClass = z
        .enum(["provider-operation", "provider-account-limit", "client-third-party"])
        .parse(failureClass);

      return published(changed);
    };

    const raw = {
      kind: "failure" as const,
      note: "fixture raw provider failure",
      code: "provider",
    };

    const asProvider = failCreate(raw, "provider-operation");
    const asQuota = failCreate(raw, "provider-account-limit");

    expect(asProvider?.survivalRate).toBe(0.5);
    expect(asQuota?.survivalRate).toBe(0.5);
    expect(asQuota?.createFailed).toMatchObject({
      provider: 1,
      accountLimit: 0,
    });

    // A typed quota refusal is an account limit, whatever the stored class says.
    const quota = failCreate({ ...raw, code: "quota" }, "provider-operation");

    expect(quota?.createFailed).toMatchObject({ provider: 0, accountLimit: 1 });
    expect(quota?.survivalRate).toBe(1);

    const status507 = failCreate(
      { ...raw, code: "quota", cause: { httpStatus: 507 } },
      "provider-account-limit",
    );

    expect(status507?.createFailed).toMatchObject({
      provider: 1,
      accountLimit: 0,
    });
  });
});
