import type { Labels, SandboxInfo } from "@opencoredev/sandbox-sdk";
import { describe, expect, it } from "vitest";
import {
  cleanupFailure,
  runAll,
  runInSandbox,
  runLabel,
  type RunOutcome,
} from "../scripts/climb-check-expanded.js";

const runId = "run-1";

/** A provider whose listing answers with `listed`, recording the labels it was asked for. */
function fakeProvider(listed: () => Promise<SandboxInfo[]>) {
  const asked: Labels[] = [];

  return {
    asked,
    list(labels: Labels) {
      asked.push(labels);

      return listed();
    },
  };
}

function sandbox(id: string): SandboxInfo {
  return { id, labels: { [runLabel]: runId }, state: "running", createdAt: 0 };
}

describe("climb check cleanup", () => {
  it("passes when the run's own label lists no sandboxes", async () => {
    const provider = fakeProvider(async () => []);

    expect(await cleanupFailure(provider, runId)).toBeNull();
    expect(provider.asked).toEqual([{ [runLabel]: runId }]);
  });

  it("fails when the listing fails, instead of reading it as zero leaks", async () => {
    const provider = fakeProvider(async () => {
      throw new Error("connect ENOENT /run/user/1000/podman/podman.sock");
    });

    expect(await cleanupFailure(provider, runId)).toMatch(/could not list.*ENOENT/);
  });

  it("fails and names every sandbox the run left behind", async () => {
    const provider = fakeProvider(async () => [sandbox("a1"), sandbox("b2")]);

    expect(await cleanupFailure(provider, runId)).toBe("leaked 2 sandbox(es): a1, b2");
  });
});

const passed = (proof: string): RunOutcome => ({
  ok: true,
  sample: {
    scenarioId: proof,
    provider: "local",
    seed: 1,
    value: 1,
    unit: "s",
    better: "lower",
    proof,
    wallMs: 1,
    details: {},
  },
});

/** A sandbox whose destroy resolves, or rejects with `destroyError`, and counts its calls. */
function fakeBox(destroyError?: string) {
  const box = {
    destroyed: 0,
    async destroy() {
      box.destroyed++;

      if (destroyError !== undefined) throw new Error(destroyError);
    },
  };

  return box;
}

describe("climb check runs", () => {
  it("a rejected create is that scenario's failure, not a throw", async () => {
    const outcome = await runInSandbox({
      create: async () => {
        throw new Error("image pull failed");
      },
      work: async () => passed("never"),
    });

    expect(outcome).toEqual({ ok: false, reason: "create failed: image pull failed" });
  });

  it("a rejected destroy fails a scenario that passed, and still runs after a failed one", async () => {
    const box = fakeBox("daemon gone");

    expect(await runInSandbox({ create: async () => box, work: async () => passed("p") })).toEqual({
      ok: false,
      reason: "destroy failed: daemon gone",
    });

    const failing = fakeBox("daemon gone");

    const outcome = await runInSandbox({
      create: async () => failing,
      work: async () => {
        throw new Error("guest exploded");
      },
    });

    expect(outcome).toEqual({ ok: false, reason: "guest exploded; destroy failed: daemon gone" });
    expect([box.destroyed, failing.destroyed]).toEqual([1, 1]);
  });

  it("a passing scenario in a sandbox that destroys cleanly passes", async () => {
    const box = fakeBox();

    expect(await runInSandbox({ create: async () => box, work: async () => passed("p") })).toEqual(
      passed("p"),
    );
    expect(box.destroyed).toBe(1);
  });

  it("runs every scenario and resolves even when some runs throw", async () => {
    const scenarios = ["a", "b", "c", "d", "e", "f"].map((id) => ({ id }));
    const started: string[] = [];

    const outcomes = await runAll({
      scenarios,
      concurrency: 2,
      async runOne(scenario) {
        started.push(scenario.id);

        if (scenario.id === "a" || scenario.id === "b") throw new Error(`${scenario.id} broke`);

        return passed(scenario.id);
      },
    });

    expect([...started].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(
      Object.fromEntries(outcomes.map(({ scenario, outcome }) => [scenario.id, outcome.ok])),
    ).toEqual({
      a: false,
      b: false,
      c: true,
      d: true,
      e: true,
      f: true,
    });
    expect(outcomes.find(({ scenario }) => scenario.id === "a")?.outcome).toEqual({
      ok: false,
      reason: "a broke",
    });
  });
});
