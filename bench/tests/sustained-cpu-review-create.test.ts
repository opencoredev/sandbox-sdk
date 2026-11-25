import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxError } from "@opencoredev/sandbox-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerSetup } from "../src/realistic/setup.js";
import {
  paths,
  runSustained,
  type BurnBox,
  type BurnSession,
  type CommandResult,
  type OpenSession,
} from "../src/sustained-cpu.js";

const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();

  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "sustained-cpu-review-create-test-"));
  directories.push(directory);

  return directory;
}

const plan = (out: string) => ({
  runId: "test-run",
  out,
  segmentsTarget: 3,
  segmentDurationS: 0.2,
  chunkSteps: 1000,
  concurrency: 1,
});

const quiet = { signal: new AbortController().signal, progress: () => {}, retryDelayMs: 0 };
const createTimeoutMs = 10 * 60_000;

const failing: CommandResult = { ok: false, exitCode: 1, stdout: "", stderr: "", timedOut: false };

async function summary(out: string, provider: string) {
  return JSON.parse(await readFile(paths(out).provider(provider), "utf8"));
}

function opening(session: BurnSession): OpenSession {
  return async () => ({ kind: "ready", session });
}

/** Runs one provider whose create rejects with `cause` and whose sweep lists `leftovers`. */
async function rejectedCreate(input: {
  readonly provider: string;
  readonly cause: unknown;
  readonly leftovers?: readonly string[];
}) {
  const out = await temporary();
  const swept: string[] = [];

  const { cleanupProblems } = await runSustained([providerSetup(input.provider)], plan(out), {
    ...quiet,
    open: opening({
      create: async () => {
        throw input.cause;
      },
      leftovers: async () => [...(input.leftovers ?? [])],
      destroyById: async (id) => {
        swept.push(id);
      },
    }),
  });

  return { cleanupProblems, swept, summary: await summary(out, input.provider) };
}

describe("the create deadline", () => {
  it("stops waiting without aborting the create, so a late sandbox is still destroyed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const out = await temporary();
    const destroyed: string[] = [];
    let answer: (box: BurnBox) => void = () => {};
    let called = () => {};
    const started = new Promise<void>((done) => (called = done));
    const createSignals: AbortSignal[] = [];

    const box: BurnBox = {
      id: "late-1",
      run: async () => failing,
      destroy: async () => {
        destroyed.push("late-1");
      },
    };

    const running = runSustained([providerSetup("styne")], plan(out), {
      ...quiet,
      open: opening({
        create: (signal) => {
          createSignals.push(signal);
          called();

          return new Promise<BurnBox>((done, fail) => {
            answer = done;
            signal.addEventListener("abort", () =>
              fail(new SandboxError("Create aborted", { code: "aborted" })),
            );
          });
        },
        leftovers: async () => [],
        destroyById: async () => {},
      }),
    });

    await started;
    await vi.advanceTimersByTimeAsync(createTimeoutMs);

    expect(createSignals.map((signal) => signal.aborted)).toEqual([false]);
    answer(box);
    const { cleanupProblems } = await running;

    expect(destroyed).toEqual(["late-1"]);
    expect(cleanupProblems).toEqual([]);
    expect(await summary(out, "styne")).toMatchObject({ destroyed: true });
  });
});

describe("a create that rejected", () => {
  it("reports an ambiguous rejection with an empty sweep as not destroyed", async () => {
    for (const cause of [
      new Error("socket hang up"),
      new SandboxError("Create aborted", { code: "aborted" }),
      new SandboxError("Create timed out", { code: "timeout" }),
      new SandboxError("Unknown", { code: "outcome_unknown" }),
      new SandboxError("Bad gateway", { code: "unavailable" }),
      new SandboxError("Over quota", { code: "quota", sandboxId: "named-1" }),
    ]) {
      const { cleanupProblems, summary } = await rejectedCreate({ provider: "styne", cause });

      expect(summary, cause.message).toMatchObject({ sandboxId: null, destroyed: false });
      expect(cleanupProblems).toEqual([
        { provider: "styne", error: expect.stringContaining("create") },
      ]);
    }
  });

  it("counts an ambiguous rejection as cleaned up once the sweep destroyed its sandbox", async () => {
    const { cleanupProblems, swept, summary } = await rejectedCreate({
      provider: "styne",
      cause: new Error("socket hang up"),
      leftovers: ["lost-1"],
    });

    expect(swept).toEqual(["lost-1"]);
    expect(cleanupProblems).toEqual([]);
    expect(summary).toMatchObject({ destroyed: true });
  });

  it("keeps a confirmed refusal with an empty sweep clean, except on Modal", async () => {
    const refusal = () => new SandboxError("Over quota", { code: "quota" });
    const refused = await rejectedCreate({ provider: "styne", cause: refusal() });

    expect(refused.cleanupProblems).toEqual([]);
    expect(refused.summary).toMatchObject({ destroyed: true });

    // Modal allocates before it can refuse, so its refusal proves nothing.
    const modal = await rejectedCreate({ provider: "modal", cause: refusal() });

    expect(modal.summary).toMatchObject({ destroyed: false });
    expect(modal.cleanupProblems).toEqual([
      { provider: "modal", error: expect.stringContaining("create") },
    ]);
  });
});
