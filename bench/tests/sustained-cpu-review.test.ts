import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerSetup } from "../src/realistic/setup.js";
import {
  fingerprintCommand,
  paths,
  runProvider,
  runSustained,
  verifySegment,
  type BurnBox,
  type CommandResult,
  type OpenSession,
} from "../src/sustained-cpu.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();

  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sustained-cpu-review-test-"));
  directories.push(directory);

  return directory;
}

const plan = (out: string) => ({
  runId: "test-run",
  out,
  segmentsTarget: 3,
  segmentDurationS: 0.2,
  chunkSteps: 1000,
});

const quiet = { signal: new AbortController().signal, progress: () => {}, retryDelayMs: 0 };
const createTimeoutMs = 10 * 60_000;
const lateCreateMs = 60_000;

const result = (input: Partial<CommandResult>): CommandResult => ({
  ok: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  timedOut: false,
  ...input,
});

async function summary(out: string) {
  return JSON.parse(await readFile(paths(out).provider("styne"), "utf8"));
}

async function logText(out: string) {
  return readFile(paths(out).log("styne"), "utf8");
}

/** Yields to real I/O until the runner arms a timer or finishes. */
async function untilTimerArmed(running: Promise<unknown>) {
  let done = false;
  void running.finally(() => (done = true));

  while (!done && vi.getTimerCount() === 0) await new Promise((next) => setImmediate(next));
}

/** A create that ignores its abort signal and answers only when the test says so. */
function slowCreate() {
  let answer: (box: BurnBox) => void = () => {};
  let called = () => {};
  const started = new Promise<void>((done) => (called = done));
  const destroyed: string[] = [];

  const box: BurnBox = {
    id: "late-1",
    run: async () => result({}),
    destroy: async () => {
      destroyed.push("late-1");
    },
  };

  const open: OpenSession = async () => ({
    kind: "ready",
    session: {
      create: () => {
        called();

        return new Promise<BurnBox>((done) => (answer = done));
      },
      leftovers: async () => [],
      destroyById: async () => {},
    },
  });

  return { open, started, destroyed, arrive: () => answer(box) };
}

describe("a create that outlives its deadline", () => {
  it("destroys the sandbox it returns late", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const out = await temporary();
    const create = slowCreate();
    const running = runProvider(providerSetup("styne"), plan(out), { ...quiet, open: create.open });

    await create.started;
    await vi.advanceTimersByTimeAsync(createTimeoutMs);
    await untilTimerArmed(running);
    create.arrive();
    const outcome = await running;

    expect(outcome.status).toBe("failed");
    expect(create.destroyed).toEqual(["late-1"]);
    expect(await logText(out)).toMatch(/"kind":"destroy"[^\n]*"sandboxId":"late-1"[^\n]*"ok":true/);
    expect(await summary(out)).toMatchObject({ destroyed: true });
  });

  it("reports a create still unanswered after the grace as not destroyed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const out = await temporary();
    const create = slowCreate();

    const running = runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open: create.open },
    );

    await create.started;
    await vi.advanceTimersByTimeAsync(createTimeoutMs);
    await untilTimerArmed(running);
    await vi.advanceTimersByTimeAsync(lateCreateMs);
    const { cleanupProblems } = await running;

    expect(create.destroyed).toEqual([]);
    expect(await summary(out)).toMatchObject({ sandboxId: null, destroyed: false });
    expect(cleanupProblems).toEqual([
      { provider: "styne", error: expect.stringContaining("create") },
    ]);
  });
});

describe("a destroy the sweep cannot confirm", () => {
  it("reports a failed destroy as not destroyed when the listing comes back empty", async () => {
    const out = await temporary();

    const box: BurnBox = {
      id: "stuck",
      run: async (command) =>
        command === fingerprintCommand ? result({ ok: false, exitCode: 1 }) : result({}),
      destroy: async () => {
        throw new Error("destroy refused");
      },
    };

    const open: OpenSession = async () => ({
      kind: "ready",
      session: { create: async () => box, leftovers: async () => [], destroyById: async () => {} },
    });

    const { cleanupProblems } = await runSustained(
      [providerSetup("styne")],
      { ...plan(out), concurrency: 1 },
      { ...quiet, open },
    );

    expect(await summary(out)).toMatchObject({ sandboxId: "stuck", destroyed: false });
    expect(cleanupProblems).toEqual([
      { provider: "styne", error: expect.stringContaining("stuck") },
    ]);
  });
});

describe("guest output in a stop reason", () => {
  const secret = "review-marker-9f8e7d6c5b4a3210";

  async function stopWith(run: BurnBox["run"]) {
    vi.stubEnv("SUSTAINED_REVIEW_TOKEN", secret);
    const out = await temporary();
    const lines: string[] = [];
    const box: BurnBox = { id: "sbx-1", run, destroy: async () => {} };

    const open: OpenSession = async () => ({
      kind: "ready",
      session: { create: async () => box, leftovers: async () => [], destroyById: async () => {} },
    });

    const outcome = await runProvider(providerSetup("styne"), plan(out), {
      ...quiet,
      progress: (line) => lines.push(line),
      open,
    });

    return {
      outcome,
      written: [lines.join("\n"), await logText(out), JSON.stringify(await summary(out))],
    };
  }

  it("redacts a secret in the fingerprint's stderr from progress, the log and the summary", async () => {
    const { outcome, written } = await stopWith(async () =>
      result({ ok: false, exitCode: 1, stderr: `boom ${secret} boom` }),
    );

    expect(outcome.stopReason).toMatch(/Fingerprint exited 1: boom \[REDACTED\] boom/);

    for (const text of written) expect(text).not.toContain(secret);
  });

  it("redacts before truncating, so no tail of a secret survives a segment's stderr", async () => {
    const fingerprint = [
      "nproc=1",
      "memkb=1000000",
      "uptime=1",
      "pythonPath=/usr/bin/python3",
      "python=Python 3.11.2",
    ].join("\n");

    const { outcome, written } = await stopWith(async (command) => {
      if (command === fingerprintCommand) return result({ stdout: fingerprint });

      if (command.startsWith("cat > ")) return result({});

      return result({ ok: false, exitCode: 2, stderr: `${secret}${"x".repeat(290)}` });
    });

    expect(outcome.stopReason).toMatch(/Segment 1 exited 2: \[REDACTED\]x+$/);

    for (const text of written) expect(text).not.toContain(secret.slice(-8));
  });

  it("never quotes guest stdout that is not JSON", () => {
    vi.stubEnv("SUSTAINED_REVIEW_TOKEN", secret);

    const check = verifySegment({
      stdout: `${"y".repeat(190)}${secret}`,
      seed: 1,
      workers: 1,
      targetSeconds: 1,
      chunkSteps: 1000,
      hostExecS: 1,
    });

    expect(check).toEqual({
      kind: "invalid",
      reason: `Output is not JSON (${190 + secret.length} characters)`,
    });
  });
});
