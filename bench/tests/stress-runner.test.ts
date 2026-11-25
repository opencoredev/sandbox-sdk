import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runV2 } from "../src/v2-runner.js";
import { parseV2 } from "../src/v2-config.js";
import { boundFake } from "./native-fakes.js";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function out() {
  const dir = await mkdtemp(join(tmpdir(), "bench-stress-"));
  dirs.push(dir);

  return dir;
}

/** A memory provider whose sandboxes answer the survival heartbeat with a boot ID. */
function heartbeatProvider(onHeartbeat: (call: number) => Promise<void> | void = () => {}) {
  let calls = 0;
  const provider = memory();

  provider.register("cat", async ({ args, stdout }) => {
    if (args[0] !== "/proc/sys/kernel/random/boot_id") return 1;
    await onHeartbeat(++calls);
    stdout("4f9c1d1e-8b2a-4c1e-9d3f-0a1b2c3d4e5f\n");

    return 0;
  });

  return provider;
}

// Priced as Boat (a fixed hourly rate), so admission reserves real amounts; every call, including
// the exact lookup after a missed heartbeat, still goes to the offline memory fake.
const survivalArgs = (dir: string) => [
  "--providers",
  "boat",
  "--scenarios",
  "survival",
  "--bursts",
  "3",
  "--burst-cohorts",
  "1",
  "--concurrency",
  "3",
  "--survival-window-ms",
  "2000",
  "--survival-heartbeat-ms",
  "1000",
  "--out",
  dir,
];

it("keeps every survival member alive through its window, then cleans up", async () => {
  const dir = await out();
  const provider = heartbeatProvider();

  const report = await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: boundFake(provider) }],
    parseV2(survivalArgs(dir)),
    async () => {},
  );

  // Only the cohort ran: no normal iterations and no readiness burst.
  expect(new Set(report.samples.map((s) => s.scenario.split("/")[0]))).toEqual(
    new Set(["survival-3"]),
  );
  const windows = report.samples.filter((s) => s.scenario === "survival-3/window");

  expect(windows.map((s) => s.outcome.kind)).toEqual(["sample", "sample", "sample"]);
  expect(windows[0]?.details).toMatchObject({ expected: 3, ok: 3, missed: 0 });

  const cohort = report.samples.find((s) => s.scenario === "survival-3/cohort");

  expect(cohort).toMatchObject({
    unit: "sandboxes",
    outcome: { kind: "sample", value: 3 },
    details: { attempted: 3, survived: 3, died: 0, unresponsive: 0, createFailed: 0 },
  });
  expect(report.cleanup).toEqual([{ provider: "boat", remaining: [], error: null }]);
  expect(await provider.list({})).toEqual([]);
  const journal = JSON.parse(await readFile(join(dir, "ownership.json"), "utf8"));

  expect(journal.resources).toEqual([]);
});

it("records a sandbox that disappears mid-window as dead and still cleans up the rest", async () => {
  const dir = await out();

  const provider = heartbeatProvider(async (call) => {
    // After the first round of heartbeats, one sandbox is deleted behind the harness's back.
    if (call === 4) {
      const [victim] = await provider.list({});

      if (victim) await provider.destroy(victim.id);
    }
  });

  const report = await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: boundFake(provider) }],
    // Cleanup waits this long for the vanished sandbox to show in listings before proving it absent.
    parseV2([...survivalArgs(dir), "--ownership-visibility-ms", "500"]),
    async () => {},
  );

  const windows = report.samples.filter((s) => s.scenario === "survival-3/window");
  const dead = windows.filter((s) => s.outcome.kind === "failure");

  expect(dead).toHaveLength(1);
  expect(dead[0]?.outcome).toMatchObject({
    kind: "failure",
    stage: "survival-3/window",
    note: expect.stringMatching(/^Died at \d+ s \(absent\)/),
  });
  expect(report.samples.find((s) => s.scenario === "survival-3/cohort")).toMatchObject({
    outcome: { kind: "sample", value: 2 },
    details: { survived: 2, died: 1 },
  });
  expect(report.cleanup[0]?.remaining).toEqual([]);
  expect(report.cleanupResolved).toEqual([
    expect.objectContaining({ provider: "boat", resolution: "absent" }),
  ]);
  expect(await provider.list({})).toEqual([]);
}, 20_000);

it("marks a member whose heartbeat hangs past the interval unresponsive", async () => {
  const dir = await out();

  const provider = heartbeatProvider(async (call) => {
    if (call === 5) await new Promise((resolve) => setTimeout(resolve, 1300));
  });

  const report = await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: boundFake(provider) }],
    parseV2(survivalArgs(dir)),
    async () => {},
  );

  const failures = report.samples.filter(
    (s) => s.scenario === "survival-3/window" && s.outcome.kind === "failure",
  );

  expect(failures).toHaveLength(1);
  expect(failures[0]?.outcome).toMatchObject({
    note: expect.stringMatching(/^Unresponsive: 1 of 3/),
  });
  expect(report.samples.find((s) => s.scenario === "survival-3/cohort")?.details).toMatchObject({
    survived: 2,
    unresponsive: 1,
  });
  expect(report.cleanup[0]?.remaining).toEqual([]);
});

it("fails a CPU burst whose members cannot run the probe, without leaving sandboxes", async () => {
  const dir = await out();
  // The memory fake has no python3, so every member's fingerprint fails and blocks its CPU run.
  const provider = memory();

  const report = await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: boundFake(provider) }],
    parseV2([
      "--providers",
      "boat",
      "--scenarios",
      "cpu-burst",
      "--bursts",
      "2",
      "--burst-cohorts",
      "2",
      "--concurrency",
      "2",
      "--out",
      dir,
    ]),
    async () => {},
  );

  const aggregates = report.samples.filter((s) => s.scenario === "cpu-burst-2/all-complete");

  expect(aggregates.map((s) => [s.iteration, s.outcome.kind])).toEqual([
    [0, "failure"],
    [1, "failure"],
  ]);
  expect(aggregates[0]?.outcome).toMatchObject({
    note: "0/2 completed the CPU workload; 2/2 ready; 2 attempted (budgets may prevent admission)",
  });
  // Members of both cohorts keep distinct iterations; each CPU row names what blocked it.
  const cold = report.samples.filter((s) => s.scenario === "cpu-burst-2/cold");

  expect(cold.map((s) => s.iteration).sort()).toEqual([0, 1, 2, 3]);
  expect(
    report.samples
      .filter((s) => /^cpu-burst-2\/cpu(-single|-all)?$/.test(s.scenario))
      .map((s) => s.outcome),
  ).toEqual(
    Array.from({ length: 12 }, () => expect.objectContaining({ blocked_by: "fingerprint" })),
  );
  expect(report.cleanup[0]?.remaining).toEqual([]);
  expect(await provider.list({})).toEqual([]);
});

it("reserves a survival member's whole window against the dollar budget", async () => {
  const dir = await out();
  const provider = heartbeatProvider();

  // boat's fixed rate: a 3-member cohort reserving 4 x 180 s + 300 s each exceeds 1 cent.
  const report = await runV2(
    [{ kind: "ready", name: "boat", cloud: false, region: null, provider: boundFake(provider) }],
    parseV2([
      ...survivalArgs(dir),
      "--max-dollars",
      "0.01",
      "--survival-window-ms",
      "300000",
      "--survival-heartbeat-ms",
      "15000",
    ]),
    async () => {},
  );

  expect(report.admissionStopped?.some((a) => a.reason === "Estimated dollar budget reached")).toBe(
    true,
  );
  expect(await provider.list({})).toEqual([]);
});
