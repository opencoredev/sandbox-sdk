import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { providerSetup, providerSetups } from "../src/realistic/setup.js";
import {
  burnScript,
  fingerprintCommand,
  lcgChecksum,
  lifetimeMs,
  logLineSchema,
  mergeResults,
  parseCli,
  parseFingerprint,
  paths,
  reportSchema,
  runProvider,
  runSustained,
  segmentTimeoutMs,
  summarize,
  verifySegment,
  windowSegments,
  workerSeed,
  type BurnBox,
  type CommandResult,
  type OpenSession,
  type Point,
} from "../src/sustained-cpu.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sustained-cpu-test-"));
  directories.push(directory);

  return directory;
}

/** The LCG stepped one at a time, as the guest does. */
function stepLcg(seed: number, steps: number) {
  let x = seed >>> 0;

  for (let i = 0; i < steps; i++) x = (Math.imul(1664525, x) + 1013904223) >>> 0;

  return x;
}

/** What an honest guest prints for a segment, computed on the host. */
function honestOutput(input: { seed: number; workers: number; steps: number; elapsedS: number }) {
  const workers = Array.from({ length: input.workers }, (_, index) => {
    const seed = workerSeed(input.seed, index);

    return {
      seed,
      steps: input.steps,
      checksum: lcgChecksum(seed, input.steps),
      elapsedS: input.elapsedS,
    };
  });

  const totalSteps = input.steps * input.workers;

  return { wallS: input.elapsedS, totalSteps, opsPerSec: totalSteps / input.elapsedS, workers };
}

const ok = (stdout: string): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout,
  stderr: "",
  timedOut: false,
});

const fingerprintOutput = [
  "nproc=4",
  "memkb=8148020",
  "uptime=12.34 ",
  "pythonPath=/usr/bin/python3",
  "python=Python 3.11.2",
  "cmdline=console=ttyS0 reboot=k panic=1",
].join("\n");

/**
 * A guest that answers the runner's commands: the fingerprint, the script write, and honest
 * segments, except where `tamper` rewrites the output of segment N.
 */
function fakeBox(options: {
  readonly id?: string;
  readonly steps?: number;
  readonly tamper?: (segment: number, output: ReturnType<typeof honestOutput>) => string | null;
  readonly destroyFailures?: number;
}) {
  const commands: string[] = [];
  const state = { segments: 0, destroys: 0, commands };
  let failures = options.destroyFailures ?? 0;

  const box: BurnBox = {
    id: options.id ?? "sbx-1",
    async run(command) {
      state.commands.push(command);

      if (command === fingerprintCommand) return ok(fingerprintOutput);

      if (command.startsWith("cat > /tmp/sustained_lcg.py")) return ok("");
      const [, , seed, workers, target, chunk] = command.split(" ");
      state.segments++;

      const output = honestOutput({
        seed: Number(seed),
        workers: Number(workers),
        steps: options.steps ?? Number(chunk) * 3,
        elapsedS: Number(target) + 0.01,
      });

      const tampered = options.tamper?.(state.segments, output);

      return ok(tampered ?? JSON.stringify(output));
    },
    async destroy() {
      state.destroys++;

      if (failures > 0) {
        failures--;
        throw new Error("destroy flaked");
      }
    },
  };

  return { box, state };
}

function session(box: BurnBox, leftovers: string[] = []) {
  const swept: string[] = [];

  const open: OpenSession = async () => ({
    kind: "ready",
    session: {
      create: async () => box,
      leftovers: async () => leftovers,
      destroyById: async (id) => {
        swept.push(id);
      },
    },
  });

  return { open, swept };
}

const quiet = { signal: new AbortController().signal, progress: () => {}, retryDelayMs: 0 };

async function readLog(out: string, provider: string) {
  const text = await readFile(paths(out).log(provider), "utf8");

  return text
    .trim()
    .split("\n")
    .map((line) => logLineSchema.parse(JSON.parse(line)));
}

describe("lcgChecksum", () => {
  it("matches stepping the LCG one step at a time", () => {
    for (const seed of [0, 1, 42, 0xffffffff, 0x9e3779b9, 2_147_483_648])
      for (const steps of [0, 1, 2, 3, 7, 1000, 65_537, 123_457])
        expect(lcgChecksum(seed, steps)).toBe(stepLcg(seed, steps));
  });

  it("matches the Python kernel run on this host", async () => {
    const directory = await temporary();
    const script = join(directory, "sustained_lcg.py");
    await writeFile(script, burnScript);
    const seed = 0xdeadbeef;

    const { stdout } = await exec("python3", [script, String(seed), "2", "0.2", "50000"], {
      timeout: 30_000,
    });

    const check = verifySegment({
      stdout,
      seed,
      workers: 2,
      targetSeconds: 0.2,
      chunkSteps: 50_000,
    });

    expect(check.kind).toBe("ok");

    if (check.kind !== "ok") return;
    expect(check.output.workers).toHaveLength(2);
    expect(check.opsPerSec).toBeGreaterThan(0);
  });
});

describe("verifySegment", () => {
  const seed = 1234567;
  const base = { seed, workers: 4, targetSeconds: 30, chunkSteps: 1000 };
  const honest = () => honestOutput({ seed, workers: 4, steps: 5000, elapsedS: 30.1 });

  it("accepts an honest segment and sums the workers' rates", () => {
    const check = verifySegment({ ...base, stdout: `noise\n${JSON.stringify(honest())}\n` });

    expect(check.kind).toBe("ok");

    if (check.kind === "ok") expect(check.opsPerSec).toBeCloseTo((4 * 5000) / 30.1, 6);
  });

  it("rejects a tampered checksum", () => {
    const output = honest();
    const [first] = output.workers;

    if (first) first.checksum = (first.checksum + 1) >>> 0;
    const check = verifySegment({ ...base, stdout: JSON.stringify(output) });

    expect(check).toMatchObject({ kind: "invalid", reason: expect.stringContaining("checksum") });
  });

  it("rejects inflated steps that keep the old checksum", () => {
    const output = honest();
    const [first] = output.workers;

    if (first) first.steps += 1000;
    output.totalSteps += 1000;

    expect(verifySegment({ ...base, stdout: JSON.stringify(output) }).kind).toBe("invalid");
  });

  it("rejects a seed the host did not issue", () => {
    const output = honestOutput({ seed: seed + 1, workers: 4, steps: 5000, elapsedS: 30.1 });

    expect(verifySegment({ ...base, stdout: JSON.stringify(output) })).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("seed"),
    });
  });

  it("rejects an implausible rate, a short segment, the wrong worker count and non-JSON", () => {
    const fast = honestOutput({ seed, workers: 4, steps: 31_000_000_000, elapsedS: 30.1 });

    expect(verifySegment({ ...base, stdout: JSON.stringify(fast) })).toMatchObject({
      reason: expect.stringContaining("ops/s"),
    });
    const short = honestOutput({ seed, workers: 4, steps: 5000, elapsedS: 29 });

    expect(verifySegment({ ...base, stdout: JSON.stringify(short) })).toMatchObject({
      reason: expect.stringContaining("before"),
    });
    const two = honestOutput({ seed, workers: 2, steps: 5000, elapsedS: 30.1 });

    expect(verifySegment({ ...base, stdout: JSON.stringify(two) })).toMatchObject({
      reason: expect.stringContaining("Expected 4 workers"),
    });

    expect(verifySegment({ ...base, stdout: "Traceback (most recent call last)" }).kind).toBe(
      "invalid",
    );
  });
});

function points(ops: readonly number[], segmentDurationS = 30): Point[] {
  return ops.map((opsPerSec, index) => ({
    segment: index + 1,
    minute: ((index + 1) * segmentDurationS) / 60,
    elapsedS: segmentDurationS + 0.1,
    wallOffsetS: (index + 1) * (segmentDurationS + 1),
    opsPerSec,
  }));
}

const summaryInput = {
  provider: "styne",
  segmentsTarget: 30,
  segmentDurationS: 30,
  fingerprint: parseFingerprint(fingerprintOutput),
  workers: 4,
  stopReason: null,
};

describe("summarize", () => {
  it("uses 6-segment windows for a 15-minute run", () => {
    expect(windowSegments({ segmentsTarget: 30, segmentDurationS: 30 })).toBe(6);
    expect(windowSegments({ segmentsTarget: 60, segmentDurationS: 15 })).toBe(12);
    expect(windowSegments({ segmentsTarget: 2, segmentDurationS: 5 })).toBe(1);
    expect(windowSegments({ segmentsTarget: 10, segmentDurationS: 30 })).toBe(2);
  });

  it("measures a burst-credit cliff at minute 10", () => {
    // Full speed for 20 segments (10 minutes), then a 16% baseline.
    const ops: number[] = Array.from({ length: 30 }, (_, index) =>
      index < 20 ? 100_000_000 : 16_000_000,
    );

    ops[2] = 101_000_000;
    const result = summarize({ ...summaryInput, points: points(ops) });

    expect(result).toMatchObject({
      status: "completed",
      stopReason: null,
      segmentsCompleted: 30,
      first3MinOps: 100_000_000,
      last3MinOps: 16_000_000,
      overallMedianOps: 100_000_000,
      retention: 0.16,
      minOverFirst: 0.16,
      guestVcpus: 4,
      memoryGiB: 7.77,
      python: "Python 3.11.2",
      uptimeAtStartS: 12.34,
      durationS: 903,
    });
  });

  it("rounds retention to four decimals and takes medians of even windows", () => {
    const ops = [10, 20, 30, 40, 50, 60, ...Array.from({ length: 18 }, () => 35), 7, 7, 7, 8, 8, 8];
    const result = summarize({ ...summaryInput, points: points(ops) });

    expect(result.first3MinOps).toBe(35);
    expect(result.last3MinOps).toBe(8);
    expect(result.retention).toBe(0.2143);
    expect(result.minOverFirst).toBe(0.2);
  });

  it("reports a run stopped before the final window as stopped-early with no last window", () => {
    const result = summarize({
      ...summaryInput,
      stopReason: "Segment 25 timed out",
      points: points(Array.from({ length: 24 }, () => 50)),
    });

    expect(result).toMatchObject({
      status: "stopped-early",
      stopReason: "Segment 25 timed out",
      segmentsCompleted: 24,
      first3MinOps: 50,
      last3MinOps: null,
      retention: null,
      minOverFirst: 1,
    });
  });

  it("reports no segments as failed and a partial first window as null", () => {
    expect(summarize({ ...summaryInput, stopReason: "boom", points: [] })).toMatchObject({
      status: "failed",
      first3MinOps: null,
      overallMedianOps: null,
      minOverFirst: null,
      durationS: 0,
    });
    expect(
      summarize({ ...summaryInput, stopReason: "x", points: points([1, 2]) }).first3MinOps,
    ).toBe(null);
  });
});

describe("fingerprint and plan", () => {
  it("parses a fingerprint and tolerates missing fields", () => {
    expect(parseFingerprint(fingerprintOutput)).toEqual({
      guestVcpus: 4,
      memoryGiB: 7.77,
      uptimeAtStartS: 12.34,
      python: "Python 3.11.2",
      pythonPath: "/usr/bin/python3",
      cmdline: "console=ttyS0 reboot=k panic=1",
    });
    expect(parseFingerprint("nproc=\npython=\ncmdline=")).toEqual({
      guestVcpus: null,
      memoryGiB: null,
      uptimeAtStartS: null,
      python: null,
      pythonPath: null,
      cmdline: null,
    });
  });

  it("gives every provider a lifetime past the burn and throttled segments room to finish", () => {
    expect(lifetimeMs({ segmentsTarget: 30, segmentDurationS: 30 })).toBe(1_500_000);
    expect(lifetimeMs({ segmentsTarget: 60, segmentDurationS: 30 })).toBe(2_400_000);
    expect(segmentTimeoutMs(30)).toBe(120_000);
    expect(segmentTimeoutMs(60)).toBe(240_000);
  });
});

describe("parseCli", () => {
  it("defaults to all 15 providers, 30 x 30 s, concurrency 15", () => {
    const cli = parseCli([]);

    expect(cli.providers).toEqual(providerSetups.map((s) => s.name));
    expect(cli.providers).toHaveLength(15);
    expect(cli).toMatchObject({
      segments: 30,
      segmentSeconds: 30,
      concurrency: 15,
      out: "results/sustained-cpu",
      run: null,
      mergeOnly: false,
    });
  });

  it("parses a provider list and the other flags", () => {
    expect(
      parseCli([
        "--providers",
        "styne, upstash-ephemeral,styne",
        "--segments",
        "2",
        "--segment-seconds",
        "5",
        "--run",
        "smoke-styne",
        "--out",
        "/tmp/x",
        "--merge-only",
      ]),
    ).toMatchObject({
      providers: ["styne", "upstash-ephemeral"],
      segments: 2,
      segmentSeconds: 5,
      run: "smoke-styne",
      out: "/tmp/x",
      mergeOnly: true,
    });
  });

  it("refuses unknown providers, bad numbers and unknown flags", () => {
    expect(() => parseCli(["--providers", "styne,nope"])).toThrow(/Unknown provider nope/);
    expect(() => parseCli(["--segments", "0"])).toThrow();
    expect(() => parseCli(["--segments", "2.5"])).toThrow();
    expect(() => parseCli(["--run", "a/b"])).toThrow();
    expect(() => parseCli(["--bogus"])).toThrow();
  });
});

const plan = (out: string) => ({
  runId: "test-run",
  out,
  segmentsTarget: 3,
  segmentDurationS: 0.2,
  chunkSteps: 1000,
});

describe("runProvider", () => {
  it("runs every segment, logs each as it goes, destroys, sweeps and writes its summary", async () => {
    const out = await temporary();
    const { box, state } = fakeBox({});
    const { open, swept } = session(box, ["lost-1"]);

    const report = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open },
    );

    expect(reportSchema.parse(report).providers).toHaveLength(1);
    const [result] = report.providers;

    expect(result).toMatchObject({
      provider: "styne",
      status: "completed",
      segmentsCompleted: 3,
      workers: 4,
    });
    expect(result?.points.map((p) => p.segment)).toEqual([1, 2, 3]);
    expect(result?.points[2]?.minute).toBe(0.01);
    expect(state.destroys).toBe(1);
    expect(swept).toEqual(["lost-1"]);
    const kinds = (await readLog(out, "styne")).map((line) => line.kind);

    expect(kinds).toEqual([
      "start",
      "sandbox",
      "fingerprint",
      "segment",
      "segment",
      "segment",
      "destroy",
      "sweep",
      "stop",
    ]);
    expect(report).toMatchObject({
      schema: "sustained-cpu.v1",
      track: "same-machine",
      segmentsTarget: 3,
      segmentDurationS: 0.2,
      targetDurationS: 0.6,
    });
    expect(report.run.id).toBe("test-run");

    // Each segment gets its own seed.
    const seeds = state.commands
      .filter((c) => c.startsWith("'/usr/bin/python3' "))
      .map((c) => c.split(" ")[2]);

    expect(new Set(seeds).size).toBe(3);
  });

  it("stops early on a tampered segment and still destroys the sandbox", async () => {
    const out = await temporary();

    const { box, state } = fakeBox({
      tamper: (segment, output) => {
        if (segment !== 2) return null;
        const [first] = output.workers;

        if (first) first.checksum = (first.checksum ^ 1) >>> 0;

        return JSON.stringify(output);
      },
    });

    const result = await runProvider(providerSetup("styne"), plan(out), {
      ...quiet,
      open: session(box).open,
    });

    expect(result).toMatchObject({ status: "stopped-early", segmentsCompleted: 1 });
    expect(result.stopReason).toMatch(/Segment 2: Worker 0 checksum/);
    expect(state.destroys).toBe(1);
  });

  it("fails with no segments when the create throws, and retries a flaky destroy", async () => {
    const out = await temporary();

    const failing: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => {
          throw new Error("quota exceeded");
        },
        leftovers: async () => [],
        destroyById: async () => {},
      },
    });

    const failed = await runProvider(providerSetup("e2b"), plan(out), { ...quiet, open: failing });

    expect(failed).toMatchObject({
      status: "failed",
      stopReason: "quota exceeded",
      segmentsCompleted: 0,
    });

    const { box, state } = fakeBox({ destroyFailures: 2 });
    await runProvider(providerSetup("vercel"), plan(out), { ...quiet, open: session(box).open });
    const destroy = (await readLog(out, "vercel")).find((line) => line.kind === "destroy");

    expect(state.destroys).toBe(3);
    expect(destroy).toMatchObject({ ok: true, attempts: 3 });
  });

  it("records a provider without credentials as failed", async () => {
    const out = await temporary();
    const skipped: OpenSession = async () => ({ kind: "skipped", note: "Missing credentials: X" });

    const result = await runProvider(providerSetup("modal"), plan(out), {
      ...quiet,
      open: skipped,
    });

    expect(result).toMatchObject({
      status: "failed",
      stopReason: "Skipped: Missing credentials: X",
    });
  });

  it("stops at once when interrupted, destroying the sandbox", async () => {
    const out = await temporary();
    const controller = new AbortController();

    const { box, state } = fakeBox({
      tamper: (segment) => (segment === 1 ? (controller.abort(), null) : null),
    });

    const result = await runProvider(providerSetup("styne"), plan(out), {
      ...quiet,
      signal: controller.signal,
      open: session(box).open,
    });

    expect(result).toMatchObject({
      status: "stopped-early",
      stopReason: "Interrupted",
      segmentsCompleted: 1,
    });
    expect(state.destroys).toBe(1);
  });
});

describe("merge-only", () => {
  it("rebuilds the report from summaries, and from a log whose summary is missing", async () => {
    const out = await temporary();
    const run = { ...plan(out), concurrency: 2 };
    const styne = fakeBox({ id: "a" });
    const daytona = fakeBox({ id: "b" });

    const open: OpenSession = async (setup) =>
      session(setup.name === "styne" ? styne.box : daytona.box).open(setup, run);

    await runSustained([providerSetup("styne"), providerSetup("daytona")], run, { ...quiet, open });
    const before = reportSchema.parse(JSON.parse(await readFile(paths(out).report, "utf8")));

    // A crash after Daytona's log but before its summary, and a lost combined file.
    await unlink(paths(out).provider("daytona"));
    await unlink(paths(out).report);
    // A cut-off last line from the crash.
    await writeFile(
      paths(out).log("daytona"),
      `${await readFile(paths(out).log("daytona"), "utf8")}{"kind":"seg`,
    );
    const after = await mergeResults(out);

    expect(after.providers.map((p) => p.provider)).toEqual(["daytona", "styne"]);
    expect(after.providers).toEqual(before.providers);
    expect(reportSchema.parse(JSON.parse(await readFile(paths(out).report, "utf8")))).toEqual(
      after,
    );
  });

  it("marks a provider whose log has no stop record as interrupted", async () => {
    const out = await temporary();
    const { box } = fakeBox({});
    await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: session(box).open },
    );
    const lines = (await readFile(paths(out).log("styne"), "utf8")).trim().split("\n");
    // Keep start, sandbox, fingerprint and two segments: the host died mid-run.
    await writeFile(paths(out).log("styne"), `${lines.slice(0, 5).join("\n")}\n`);
    await unlink(paths(out).provider("styne"));
    const report = await mergeResults(out);

    expect(report.providers[0]).toMatchObject({
      status: "stopped-early",
      segmentsCompleted: 2,
      stopReason: expect.stringContaining("without a stop record"),
    });
  });

  it("refuses a directory with no run, or a retry under another run ID", async () => {
    const out = await temporary();

    await expect(mergeResults(out)).rejects.toThrow(/run.json is missing/);
    const { box } = fakeBox({});
    await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: session(box).open },
    );

    await expect(
      runSustained(
        [providerSetup("styne")],
        { ...plan(out), runId: "other", concurrency: 1 },
        { ...quiet, open: session(box).open },
      ),
    ).rejects.toThrow(/belongs to run test-run/);
  });
});
