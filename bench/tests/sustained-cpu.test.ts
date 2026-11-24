import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { boat } from "@opencoredev/sandbox-sdk/boat";
import type { Labels } from "@opencoredev/sandbox-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { isMissingFile } from "../src/files.js";
import { providerSetup, providerSetups } from "../src/realistic/setup.js";
import {
  burnScript,
  fingerprintCommand,
  labelsFor,
  lcgChecksum,
  lifetimeMs,
  logLineSchema,
  mergeResults,
  parseCli,
  parseLog,
  providerFileSchema,
  runFileSchema,
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
  type LogLine,
  type OpenSession,
  type Point,
  type ProviderFile,
  type RunFile,
} from "../src/sustained-cpu.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

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
  /** Awaited before each segment answers, to hold a provider mid-burn. */
  readonly beforeSegment?: () => Promise<void>;
  /** Runs on every destroy call, before it succeeds or fails. */
  readonly onDestroy?: () => Promise<void>;
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
      await options.beforeSegment?.();
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
      await options.onDestroy?.();

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

async function exists(path: string) {
  try {
    await readFile(path);

    return true;
  } catch (cause) {
    if (isMissingFile(cause)) return false;
    throw cause;
  }
}

/** A promise and the function that resolves it. */
function latch() {
  let open = () => {};
  const opened = new Promise<void>((done) => (open = done));

  return { open, opened };
}

/** A session whose create response is lost: the sandbox is listed but never returned. */
function lostCreate(leftovers: () => Promise<string[]>): OpenSession {
  return async () => ({
    kind: "ready",
    session: {
      create: async () => {
        throw new Error("create response lost");
      },
      leftovers,
      destroyById: async () => {
        throw new Error("sweep delete refused");
      },
    },
  });
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

    const started = performance.now();

    const { stdout } = await exec("python3", [script, String(seed), "2", "0.2", "50000"], {
      timeout: 30_000,
    });

    const check = verifySegment({
      stdout,
      seed,
      workers: 2,
      targetSeconds: 0.2,
      chunkSteps: 50_000,
      hostExecS: (performance.now() - started) / 1000,
    });

    expect(check.kind).toBe("ok");

    if (check.kind !== "ok") return;
    expect(check.output.workers).toHaveLength(2);
    expect(check.opsPerSec).toBeGreaterThan(0);
  });
});

describe("verifySegment", () => {
  const seed = 1234567;
  const base = { seed, workers: 4, targetSeconds: 30, chunkSteps: 1000, hostExecS: 30.5 };
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

  it("rejects timing the host could not have seen", () => {
    // A near-zero guest wall beside 30 s workers: the shape of a fabricated segment.
    const tiny = { ...honest(), wallS: 0.001 };

    expect(verifySegment({ ...base, stdout: JSON.stringify(tiny) })).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("longer than the guest wall"),
    });

    // The guest claims 40 s of burn inside a 30.5 s exec.
    const long = honestOutput({ seed, workers: 4, steps: 5000, elapsedS: 40 });

    expect(verifySegment({ ...base, stdout: JSON.stringify(long) })).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("exceeds the host"),
    });

    // Inside the guest's own tolerance, but past what the host timed.
    const past = {
      ...honestOutput({ seed, workers: 4, steps: 5000, elapsedS: 32.4 }),
      wallS: 31.4,
    };

    expect(verifySegment({ ...base, stdout: JSON.stringify(past) })).toMatchObject({
      kind: "invalid",
      reason: expect.stringContaining("longer than the host"),
    });

    // Small clock skew either way is fine.
    const skew = {
      ...honestOutput({ seed, workers: 4, steps: 5000, elapsedS: 31.2 }),
      wallS: 31.1,
    };

    expect(verifySegment({ ...base, stdout: JSON.stringify(skew) }).kind).toBe("ok");
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

    const { report, failures, cleanupProblems } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open },
    );

    expect(failures).toEqual([]);
    expect(cleanupProblems).toEqual([]);
    expect(reportSchema.parse(report).providers).toHaveLength(1);
    const [result] = report.providers;

    expect(result).toMatchObject({
      provider: "styne",
      status: "completed",
      segmentsCompleted: 3,
      workers: 4,
    });
    expect(result?.points.map((p) => p.segment)).toEqual([1, 2, 3]);

    // `minute` is host time since the burn began, at the segment's end.
    for (const point of result?.points ?? [])
      expect(point.minute).toBe(Math.round((point.wallOffsetS / 60) * 1000) / 1000);

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

    const open: OpenSession = async (setup, attempt) =>
      session(setup.name === "styne" ? styne.box : daytona.box).open(setup, attempt);

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

describe("cleanup", () => {
  it("waits for every provider before returning when one crashes outside its own handling", async () => {
    const out = await temporary();
    // e2b's summary write will fail: its temporary file's path is a directory.
    await mkdir(`${paths(out).provider("e2b")}.${process.pid}.tmp`, { recursive: true });
    let release = () => {};
    const gate = new Promise<void>((done) => (release = done));
    // Hold Styne mid-burn until well after e2b has thrown.
    setTimeout(() => release(), 200);
    const styne = fakeBox({ id: "styne-box", beforeSegment: () => gate });

    const open: OpenSession = async (setup, attempt) =>
      setup.name === "e2b"
        ? { kind: "skipped", note: "Missing credentials: E2B_API_KEY" }
        : session(styne.box).open(setup, attempt);

    const returned = await runSustained(
      [providerSetup("e2b"), providerSetup("styne")],
      { ...plan(out), concurrency: 2 },
      { ...quiet, open },
    ).then((outcome) => ({ outcome, destroysAtReturn: styne.state.destroys }));

    expect(returned.destroysAtReturn).toBe(1);
    expect(returned.outcome.failures).toEqual([
      { provider: "e2b", error: expect.stringContaining("EISDIR") },
    ]);
    expect(returned.outcome.report.providers.map((p) => [p.provider, p.status])).toEqual([
      ["e2b", "failed"],
      ["styne", "completed"],
    ]);
  });

  it("still sweeps when the destroy record cannot be written", async () => {
    const out = await temporary();

    const { box, state } = fakeBox({
      // The log turns unwritable just as the sandbox is destroyed.
      onDestroy: async () => {
        await rm(paths(out).log("styne"));
        await mkdir(paths(out).log("styne"));
      },
    });

    const { open, swept } = session(box, ["lost-1"]);
    const result = await runProvider(providerSetup("styne"), plan(out), { ...quiet, open });

    expect(state.destroys).toBe(1);
    expect(swept).toEqual(["lost-1"]);
    expect(result.status).toBe("completed");
  });

  it("records a sweep that could not delete the sandbox the destroy left behind", async () => {
    const out = await temporary();
    const { box } = fakeBox({ id: "stuck", destroyFailures: 99 });

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => box,
        leftovers: async () => ["stuck"],
        destroyById: async () => {
          throw new Error("delete refused");
        },
      },
    });

    const { cleanupProblems } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open },
    );

    const sweep = (await readLog(out, "styne")).find((line) => line.kind === "sweep");

    expect(sweep).toMatchObject({
      found: ["stuck"],
      destroyed: [],
      error: expect.stringContaining("delete refused"),
    });
    const summary = JSON.parse(await readFile(paths(out).provider("styne"), "utf8"));

    expect(summary).toMatchObject({ sandboxId: "stuck", destroyed: false });
    expect(cleanupProblems).toEqual([
      { provider: "styne", error: expect.stringContaining("stuck") },
    ]);
  });

  it("records a sweep that could not list after a failed destroy", async () => {
    const out = await temporary();
    const { box } = fakeBox({ id: "stuck", destroyFailures: 99 });

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => box,
        leftovers: async () => {
          throw new Error("list unavailable");
        },
        destroyById: async () => {},
      },
    });

    await runProvider(providerSetup("styne"), plan(out), { ...quiet, open });
    const sweep = (await readLog(out, "styne")).find((line) => line.kind === "sweep");

    expect(sweep).toMatchObject({
      error: expect.stringMatching(/list unavailable.*stuck|stuck.*list unavailable/),
    });
  });

  it("reports a lost create's sandbox the sweep could not delete as not destroyed", async () => {
    const out = await temporary();

    const { cleanupProblems } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: lostCreate(async () => ["unknown-create"]) },
    );

    const sweep = (await readLog(out, "styne")).find((line) => line.kind === "sweep");

    expect(sweep).toMatchObject({
      found: ["unknown-create"],
      destroyed: [],
      error: expect.stringMatching(/unknown-create.*sweep delete refused/),
    });
    const summary = JSON.parse(await readFile(paths(out).provider("styne"), "utf8"));

    expect(summary).toMatchObject({ sandboxId: null, destroyed: false });
    expect(cleanupProblems).toEqual([
      { provider: "styne", error: expect.stringContaining("unknown-create") },
    ]);
  });

  it("reports a lost create whose sweep could not list as not destroyed", async () => {
    const out = await temporary();

    const { cleanupProblems } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      {
        ...quiet,
        open: lostCreate(async () => {
          throw new Error("list unavailable");
        }),
      },
    );

    const summary = JSON.parse(await readFile(paths(out).provider("styne"), "utf8"));

    expect(summary).toMatchObject({ sandboxId: null, destroyed: false });
    expect(cleanupProblems).toEqual([
      { provider: "styne", error: expect.stringContaining("list unavailable") },
    ]);
  });

  it("keeps a cleanup problem when the summary cannot be written either", async () => {
    const out = await temporary();
    // The summary write fails: its temporary file's path is a directory.
    await mkdir(`${paths(out).provider("styne")}.${process.pid}.tmp`, { recursive: true });
    const { box } = fakeBox({ id: "stuck", destroyFailures: 99 });

    const open: OpenSession = async () => ({
      kind: "ready",
      session: {
        create: async () => box,
        leftovers: async () => ["stuck"],
        destroyById: async () => {
          throw new Error("sweep delete refused");
        },
      },
    });

    const { failures, cleanupProblems } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open },
    );

    const sweep = (await readLog(out, "styne")).find((line) => line.kind === "sweep");

    expect(sweep).toMatchObject({ error: expect.stringMatching(/stuck.*sweep delete refused/) });
    expect(failures).toEqual([{ provider: "styne", error: expect.stringContaining("EISDIR") }]);
    expect(cleanupProblems).toEqual([
      { provider: "styne", error: expect.stringContaining("stuck") },
    ]);
  });
});

describe("provider lock", () => {
  it("refuses a second invocation for the same provider and output directory", async () => {
    const out = await temporary();
    const entered = latch();
    const release = latch();

    const first = fakeBox({
      id: "first",
      beforeSegment: async () => {
        entered.open();
        await release.opened;
      },
    });

    const running = runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: session(first.box).open },
    );

    await entered.opened;
    expect(await exists(paths(out).lock("styne"))).toBe(true);
    let secondOpened = 0;

    const second = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      {
        ...quiet,
        open: async (setup, attempt) => {
          secondOpened++;

          return session(fakeBox({ id: "second" }).box).open(setup, attempt);
        },
      },
    );

    expect(secondOpened).toBe(0);
    expect(second.failures).toEqual([
      { provider: "styne", error: expect.stringMatching(/styne\.lock.*another invocation/) },
    ]);

    release.open();
    const done = await running;

    expect(done.failures).toEqual([]);
    expect(done.report.providers[0]).toMatchObject({ status: "completed", segmentsCompleted: 3 });
    const log = await readLog(out, "styne");

    expect(log.filter((line) => line.kind === "start")).toHaveLength(1);
    expect(log.flatMap((line) => (line.kind === "destroy" ? [line.sandboxId] : []))).toEqual([
      "first",
    ]);
    expect(await exists(paths(out).lock("styne"))).toBe(false);

    // Once the first is done, a retry takes the lock.
    const retry = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: session(fakeBox({ id: "retry" }).box).open },
    );

    expect(retry.failures).toEqual([]);
  });

  it("releases the lock when the attempt fails past its own handling", async () => {
    const out = await temporary();
    await mkdir(`${paths(out).provider("styne")}.${process.pid}.tmp`, { recursive: true });

    const { failures } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: session(fakeBox({}).box).open },
    );

    expect(failures).toHaveLength(1);
    expect(await exists(paths(out).lock("styne"))).toBe(false);
  });
});

/** One completed run of each provider into `out`. */
async function completedRun(out: string, names: readonly string[] = ["styne"]) {
  const open: OpenSession = async (setup, attempt) =>
    session(fakeBox({ id: `${setup.name}-box` }).box).open(setup, attempt);

  return runSustained(
    names.map((name) => providerSetup(name)),
    { ...plan(out), concurrency: names.length },
    { ...quiet, open },
  );
}

async function editSummary(
  out: string,
  provider: string,
  edit: (file: ProviderFile) => ProviderFile,
) {
  const path = paths(out).provider(provider);
  const file = providerFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  await writeFile(path, `${JSON.stringify(edit(file))}\n`);
}

async function editRun(out: string, edit: (file: RunFile) => RunFile) {
  const path = paths(out).run;
  const file = runFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  await writeFile(path, `${JSON.stringify(edit(file))}\n`);
}

async function editLog(path: string, edit: (lines: LogLine[]) => LogLine[]) {
  const lines = parseLog(await readFile(path, "utf8"));
  await writeFile(
    path,
    `${edit(lines)
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );
}

describe("merge validation", () => {
  it("refuses a summary or a log from another run", async () => {
    const out = await temporary();
    await completedRun(out);

    await editSummary(out, "styne", (file) => ({ ...file, runId: "other" }));
    await expect(mergeResults(out)).rejects.toThrow(/from run other/);

    await unlink(paths(out).provider("styne"));
    await editLog(paths(out).log("styne"), (lines) =>
      lines.map((line) => (line.kind === "start" ? { ...line, runId: "other" } : line)),
    );
    await expect(mergeResults(out)).rejects.toThrow(/from run other/);
  });

  it("refuses a summary filed under another provider's name", async () => {
    const out = await temporary();
    await completedRun(out);
    await copyFile(paths(out).provider("styne"), paths(out).provider("daytona"));

    await expect(mergeResults(out)).rejects.toThrow(/daytona.*styne/);
  });

  it("refuses duplicate segment numbers in a summary or a log", async () => {
    const out = await temporary();
    await completedRun(out);

    await editSummary(out, "styne", (file) => ({
      ...file,
      result: {
        ...file.result,
        points: file.result.points.map((point) =>
          point.segment === 2 ? { ...point, segment: 1 } : point,
        ),
      },
    }));
    await expect(mergeResults(out)).rejects.toThrow(/segment 1/);

    await unlink(paths(out).provider("styne"));
    await editLog(paths(out).log("styne"), (lines) => {
      const segment = lines.find((line) => line.kind === "segment");

      return segment ? [...lines.slice(0, 4), segment, ...lines.slice(4)] : lines;
    });
    await expect(mergeResults(out)).rejects.toThrow(/segment 1/);
  });

  it("refuses a retry or a provider with a different chunk size", async () => {
    const out = await temporary();
    await completedRun(out);
    const { box } = fakeBox({});

    await expect(
      runSustained(
        [providerSetup("styne")],
        { ...plan(out), chunkSteps: 2000, concurrency: 1 },
        { ...quiet, open: session(box).open },
      ),
    ).rejects.toThrow(/chunkSteps/);

    // A run.json from before chunkSteps was recorded: providers must still agree.
    await editRun(out, (file) => ({ ...file, chunkSteps: undefined }));
    await expect(mergeResults(out)).resolves.toBeDefined();

    await copyFile(paths(out).log("styne"), paths(out).log("daytona"));
    await editLog(paths(out).log("daytona"), (lines) =>
      lines.map((line) =>
        line.kind === "start" ? { ...line, provider: "daytona", chunkSteps: 2000 } : line,
      ),
    );
    await expect(mergeResults(out)).rejects.toThrow(/chunkSteps/);
  });

  it("prefers a newer interrupted retry's log over the summary of an earlier attempt", async () => {
    for (const legacy of [false, true]) {
      const out = await temporary();
      await completedRun(out);
      const earlier = await readFile(paths(out).provider("styne"), "utf8");

      // The retry sets the earlier summary aside as it starts.
      const { box } = fakeBox({ id: "retry" });
      await runProvider(providerSetup("styne"), plan(out), { ...quiet, open: session(box).open });

      const kept = (await readdir(paths(out).providers)).filter((name) =>
        name.endsWith(".prev.json"),
      );

      expect(kept).toHaveLength(1);

      // Then the host dies mid-retry, and the earlier summary is back in place (as before this
      // runner set summaries aside, or a copy by hand).
      await editLog(paths(out).log("styne"), (lines) =>
        lines
          .slice(0, 5)
          .map((line) =>
            legacy && line.kind === "start" ? { ...line, attemptId: undefined } : line,
          ),
      );
      await writeFile(paths(out).provider("styne"), earlier);

      if (legacy) await editSummary(out, "styne", (file) => ({ ...file, attemptId: undefined }));
      const report = await mergeResults(out);

      expect(report.providers).toHaveLength(1);
      expect(report.providers[0]).toMatchObject({
        status: "stopped-early",
        segmentsCompleted: 2,
        stopReason: expect.stringContaining("without a stop record"),
      });
    }
  });

  it("refuses a log with a foreign or misfiled start record before a valid one", async () => {
    for (const [edit, error] of [
      [{ runId: "other-run" }, /other-run/],
      [{ provider: "daytona" }, /daytona/],
    ] as const) {
      const out = await temporary();
      await completedRun(out);
      await unlink(paths(out).provider("styne"));
      await editLog(paths(out).log("styne"), (lines) => {
        const start = lines.find((line) => line.kind === "start");

        return start ? [{ ...start, ...edit }, ...lines] : lines;
      });

      await expect(mergeResults(out)).rejects.toThrow(error);
    }
  });

  it("refuses a summary and a log that disagree on chunkSteps under a legacy run.json", async () => {
    const out = await temporary();
    await completedRun(out);
    await editRun(out, (file) => ({ ...file, chunkSteps: undefined }));
    const start = (await readLog(out, "styne")).find((line) => line.kind === "start");

    if (start?.kind !== "start") throw new Error("No start record");
    // A newer attempt's log, started with another chunk size, beside the earlier summary.
    await writeFile(
      paths(out).log("styne"),
      `${JSON.stringify({ ...start, attemptId: "newer", chunkSteps: 2000 })}\n`,
    );

    await expect(mergeResults(out)).rejects.toThrow(/chunkSteps/);

    // Two attempts in one log that disagree, with no summary.
    await unlink(paths(out).provider("styne"));
    await writeFile(
      paths(out).log("styne"),
      `${JSON.stringify(start)}\n${JSON.stringify({ ...start, attemptId: "newer", chunkSteps: 2000 })}\n`,
    );

    await expect(mergeResults(out)).rejects.toThrow(/chunkSteps/);
  });

  it("keeps a finished attempt's summary when its log matches", async () => {
    const out = await temporary();
    await completedRun(out);
    const summary = JSON.parse(await readFile(paths(out).provider("styne"), "utf8"));
    const start = (await readLog(out, "styne")).find((line) => line.kind === "start");

    expect(summary.attemptId).toEqual(expect.any(String));
    expect(start).toMatchObject({ attemptId: summary.attemptId, chunkSteps: 1000 });
    expect((await mergeResults(out)).providers[0]?.status).toBe("completed");
  });
});

/** A provider account shared by several attempts: sandboxes and their labels, listed by label. */
function sharedAccount() {
  const sandboxes = new Map<string, Labels>();
  let next = 0;

  const matches = (labels: Labels, wanted: Labels) =>
    Object.entries(wanted).every(([key, value]) => labels[key] === value);

  const add = (labels: Labels) => {
    const id = `sbx-${++next}`;
    sandboxes.set(id, labels);

    return id;
  };

  const open: OpenSession = async (setup, attempt) => {
    const labels = labelsFor(setup, attempt);
    // A create whose response was lost: listed under this attempt's labels, never returned.
    add(labels);

    return {
      kind: "ready",
      session: {
        create: async () => {
          const id = add(labels);

          return fakeBox({ id, onDestroy: async () => void sandboxes.delete(id) }).box;
        },
        leftovers: async () =>
          [...sandboxes].flatMap(([id, value]) => (matches(value, labels) ? [id] : [])),
        destroyById: async (id) => void sandboxes.delete(id),
      },
    };
  };

  return { sandboxes, add, open };
}

const patchBody = z.object({ name: z.string() });

/**
 * Boat's control plane for the real adapter, offline: create, rename and list. Every other request
 * is a 404, and any other host throws.
 */
function fakeBoatApi() {
  const names = new Map<string, string>();
  let next = 0;

  const sandbox = (id: string) => ({
    id,
    name: names.get(id) ?? "",
    state: "running",
    createdAt: "2026-11-23T00:00:00Z",
  });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (url.host !== "boat.invalid") throw new Error(`Network forbidden: ${url.host}`);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const one = /^\/sandboxes\/([^/]+)$/.exec(path)?.[1];

    if (request.method === "POST" && path === "/sandboxes") {
      const id = `boat-${++next}`;
      names.set(id, "");

      return Response.json({ sandbox: sandbox(id) });
    }

    if (request.method === "PATCH" && one !== undefined) {
      names.set(one, patchBody.parse(await request.json()).name);

      return Response.json({ sandbox: sandbox(one) });
    }

    if (request.method === "GET" && path === "/sandboxes")
      return Response.json({
        sandboxes: [...names.keys()].map(sandbox),
        pageInfo: { hasMore: false },
      });

    return new Response("not stubbed", { status: 404 });
  };

  return { names, fetch };
}

describe("sweep ownership", () => {
  it("labels every attempt apart, Boat in its one label", () => {
    const first = { runId: "sustained15m-20261123", attemptId: "aaaaaaaaaaaa" };
    const second = { ...first, attemptId: "bbbbbbbbbbbb" };

    for (const name of ["boat", "styne"]) {
      const setup = providerSetup(name);

      expect(labelsFor(setup, first)).not.toEqual(labelsFor(setup, second));
    }

    expect(labelsFor(providerSetup("boat"), first)).toEqual({
      "sandbox-bench-run": "sustained15m-20261123.aaaaaaaaaaaa",
    });
    expect(labelsFor(providerSetup("styne"), first)).toEqual({
      "sandbox-bench-run": "sustained15m-20261123",
      "sc-provider": "styne",
      "sc-attempt": "aaaaaaaaaaaa",
    });
  });

  it("fits any valid run ID into Boat's 120-character name, on the real adapter", async () => {
    const api = fakeBoatApi();
    vi.spyOn(globalThis, "fetch").mockImplementation(api.fetch);
    const provider = boat({ apiKey: "offline-fixture", baseUrl: "https://boat.invalid/api/v1" });
    const setup = providerSetup("boat");
    const attemptId = "4ae573dc190f";

    // The run ID that encoded to 130 characters, a long compressible one, and incompressible ones
    // (SHA-256 in base64url) from 43 to 860 characters.
    const runIds = [
      "0123456789abcdef02345789abcedf018264a0b8e7c3d291f6a5",
      "x".repeat(400),
      ...Array.from({ length: 20 }, (_, index) =>
        Array.from({ length: index + 1 }, (_, part) =>
          createHash("sha256").update(`${index}:${part}`).digest("base64url"),
        ).join(""),
      ),
    ];

    const seen = new Set<string>();
    let shortened = 0;

    for (const runId of runIds) {
      expect(parseCli(["--providers", "boat", `--run=${runId}`]).run).toBe(runId);
      const labels = labelsFor(setup, { runId, attemptId });
      const value = labels["sandbox-bench-run"] ?? "";

      expect(value.endsWith(`.${attemptId}`)).toBe(true);

      if (value !== `${runId}.${attemptId}`) shortened++;
      // Deterministic, and apart from every other run's.
      expect(labelsFor(setup, { runId, attemptId })).toEqual(labels);
      expect(labelsFor(setup, { runId, attemptId: "000000000000" })).not.toEqual(labels);
      expect(seen.has(value)).toBe(false);
      seen.add(value);

      const sandbox = await createSandbox(provider, { labels });
      const name = api.names.get(sandbox.id) ?? "";

      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(120);
      // The sweep finds it again by the same labels.
      expect((await provider.list(labels)).map((info) => info.id)).toEqual([sandbox.id]);
      api.names.clear();
    }

    // Every incompressible ID past the budget, and the 130-character one, took the short form.
    expect(shortened).toBe(21);

    // A run ID that already fits keeps its readable label.
    expect(labelsFor(setup, { runId: "sustained15m-20261123", attemptId })).toEqual({
      "sandbox-bench-run": `sustained15m-20261123.${attemptId}`,
    });
  });

  it("never sweeps another attempt's sandbox under the same run ID", async () => {
    for (const name of ["boat", "styne"]) {
      const account = sharedAccount();
      const setup = providerSetup(name);
      // Attempt A is mid-burn in another invocation with the same --run.
      const other = labelsFor(setup, { runId: "test-run", attemptId: "aaaaaaaaaaaa" });
      const running = account.add(other);

      const result = await runProvider(setup, plan(await temporary()), {
        ...quiet,
        open: account.open,
      });

      expect(result.status).toBe("completed");
      expect([...account.sandboxes.keys()]).toEqual([running]);
    }
  });

  it("refuses a complete or schema-invalid final start record in a log, while dropping an incomplete truncated line", async () => {
    const out = await temporary();
    await completedRun(out);
    const start = (await readLog(out, "styne")).find((line) => line.kind === "start");

    if (start?.kind !== "start") throw new Error("No start record");
    // Newline-terminated schema-invalid start (chunkSteps as string) at EOF must fail, not be dropped.
    const badStart = `${JSON.stringify({ ...start, chunkSteps: "2000" })}\n`;
    await writeFile(
      paths(out).log("styne"),
      `${await readFile(paths(out).log("styne"), "utf8")}${badStart}`,
    );
    await expect(mergeResults(out)).rejects.toThrow(/Log line/);

    // Same schema-invalid start even without trailing newline must still fail.
    expect(() => parseLog(JSON.stringify({ ...start, chunkSteps: "2000" }))).toThrow(/Log line 1/);

    // Truly truncated JSON without a trailing newline at EOF is safely dropped.
    expect(parseLog(`${JSON.stringify(start)}\n{"kind":"segment","at":`)).toHaveLength(1);
    // Invalid JSON with a trailing newline is a complete corrupt line and fails.
    expect(() => parseLog(`${JSON.stringify(start)}\n{"kind":"segment","at":\n`)).toThrow(
      /Log line 2/,
    );
  });

  it("prevents concurrent runs with different run IDs from overwriting run.json on a fresh directory", async () => {
    const out = await temporary();
    const { box: boxA } = fakeBox({ id: "a" });
    const { box: boxB } = fakeBox({ id: "b" });

    const results = await Promise.allSettled([
      runSustained(
        [providerSetup("styne")],
        { ...plan(out), runId: "run-alpha", concurrency: 1 },
        { ...quiet, open: session(boxA).open },
      ),
      runSustained(
        [providerSetup("styne")],
        { ...plan(out), runId: "run-beta", concurrency: 1 },
        { ...quiet, open: session(boxB).open },
      ),
    ]);

    const fulfilled = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    const rejected = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0])).toMatch(/belongs to run/);

    const winnerId = fulfilled[0]?.report.run.id;

    expect(winnerId).toBeDefined();

    const runFile = JSON.parse(await readFile(paths(out).run, "utf8"));

    expect(runFile.run.id).toBe(winnerId);
    const merged = await mergeResults(out);

    expect(merged.run.id).toBe(winnerId);
    expect(merged.providers).toHaveLength(1);
    expect(merged.providers[0]?.status).toBe("completed");
  });
});
