import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseCli } from "../../src/fairness/cli.js";
import {
  CheckStop,
  loadResults,
  mergeResults,
  parseLog,
  paths,
  runCheck,
  runProvider,
  type Box,
  type Check,
  type OpenSession,
  type Session,
} from "../../src/fairness/framework.js";
import { labelsFor } from "../../src/sustained-cpu.js";
import { providerSetup } from "../../src/realistic/setup.js";

const e2b = providerSetup("e2b");
const daytona = providerSetup("daytona");
const noSignal = new AbortController().signal;

function fakeBox(id: string, behavior: { destroyFails?: boolean } = {}) {
  const state = { destroyed: false, destroyCalls: 0 };

  const box: Box = {
    id,
    run: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "", timedOut: false }),
    write: async () => {},
    destroy: async () => {
      state.destroyCalls++;

      if (behavior.destroyFails) throw new Error("destroy refused");
      state.destroyed = true;
    },
  };

  return { box, state };
}

function fakeSession(input: {
  readonly creates: readonly (() => Promise<Box>)[];
  readonly leftovers?: () => Promise<string[]>;
  readonly destroyById?: (id: string) => Promise<void>;
}) {
  let next = 0;
  const swept: string[] = [];

  const session: Session = {
    create: () => {
      const create = input.creates[next++];

      return create ? create() : Promise.reject(new Error("no more creates"));
    },
    leftovers: input.leftovers ?? (async () => []),
    destroyById: async (id) => {
      swept.push(id);
      await input.destroyById?.(id);
    },
  };

  const open: OpenSession = async () => ({ kind: "ready", session });

  return { open, swept };
}

const resultSchema = z.object({ boxes: z.number() });

const check = (
  overrides: Partial<Check<z.infer<typeof resultSchema>>> = {},
): Check<z.infer<typeof resultSchema>> => ({
  id: "security-probe",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 60_000,
  resultSchema,
  run: async (context) => ({ boxes: context.boxes.length }),
  ...overrides,
});

const dependencies = (open: OpenSession) => ({
  open,
  signal: noSignal,
  progress: () => {},
  retryDelayMs: 0,
  lateSweepDelayMs: 0,
});

async function outDir() {
  return mkdtemp(join(tmpdir(), "fairness-framework-"));
}

describe("runCheck", () => {
  it("runs, destroys, sweeps and merges", async () => {
    const out = await outDir();
    const one = fakeBox("sb-1");
    const { open } = fakeSession({ creates: [async () => one.box] });

    const outcome = await runCheck(
      check(),
      [e2b],
      { runId: "r1", out, concurrency: 2 },
      dependencies(open),
    );

    expect(outcome.failures).toEqual([]);
    expect(outcome.cleanupProblems).toEqual([]);
    expect(outcome.report.providers).toHaveLength(1);
    expect(outcome.report.providers[0]).toMatchObject({
      provider: "e2b",
      status: "completed",
      destroyed: true,
      sandboxes: [{ id: "sb-1" }],
      result: { boxes: 1 },
    });
    expect(one.state.destroyed).toBe(true);
    const log = parseLog(await readFile(paths(out, "security-probe").log("e2b"), "utf8"));
    expect(log.map((l) => l.kind)).toEqual(["start", "sandbox", "destroy", "sweep", "stop"]);
  });

  it("records refused creates, stops under the minimum, and still destroys what was made", async () => {
    const out = await outDir();
    const made = fakeBox("sb-ok");

    const { open } = fakeSession({
      creates: [
        async () => made.box,
        async () => {
          throw new Error("quota: 10 vCPU");
        },
        async () => {
          throw new Error("quota: 10 vCPU");
        },
      ],
    });

    const outcome = await runCheck(
      check({ id: "cpu-burst-10", boxes: 3, minBoxes: 2 }),
      [daytona],
      { runId: "r2", out, concurrency: 1 },
      dependencies(open),
    );

    const entry = outcome.report.providers[0];
    expect(entry?.status).toBe("failed");
    expect(entry?.reason).toMatch(
      /Created 1 of 3 sandboxes, fewer than the 2 this check needs: quota: 10 vCPU/,
    );
    expect(entry?.createFailures).toEqual(["quota: 10 vCPU", "quota: 10 vCPU"]);
    expect(made.state.destroyed).toBe(true);
  });

  it("marks a provider without credentials skipped", async () => {
    const out = await outDir();

    const open: OpenSession = async () => ({
      kind: "skipped",
      note: "Missing credentials: E2B_API_KEY",
    });

    const outcome = await runCheck(
      check(),
      [e2b],
      { runId: "r3", out, concurrency: 1 },
      dependencies(open),
    );

    expect(outcome.report.providers[0]).toMatchObject({
      status: "skipped",
      reason: "Skipped: Missing credentials: E2B_API_KEY",
      sandboxes: [],
    });
  });

  it("keeps the check's failure and cleans up after it", async () => {
    const out = await outDir();
    const one = fakeBox("sb-1");
    const { open } = fakeSession({ creates: [async () => one.box] });

    const failing = check({
      run: async () => {
        throw new CheckStop("segment 3 timed out");
      },
    });

    const outcome = await runCheck(
      failing,
      [e2b],
      { runId: "r4", out, concurrency: 1 },
      dependencies(open),
    );

    expect(outcome.report.providers[0]).toMatchObject({
      status: "failed",
      reason: "segment 3 timed out",
      result: null,
    });
    expect(one.state.destroyed).toBe(true);
  });

  it("rejects a result that does not fit the check's schema", async () => {
    const out = await outDir();
    const one = fakeBox("sb-1");
    const { open } = fakeSession({ creates: [async () => one.box] });
    // @ts-expect-error the wrong shape on purpose
    const wrong = check({ run: async () => ({ boxes: "one" }) });

    const outcome = await runCheck(
      wrong,
      [e2b],
      { runId: "r5", out, concurrency: 1 },
      dependencies(open),
    );

    expect(outcome.report.providers[0]?.status).toBe("failed");
  });

  it("sweeps a sandbox whose destroy failed, and reports one it cannot", async () => {
    const out = await outDir();
    const stuck = fakeBox("sb-stuck", { destroyFails: true });

    const swept = fakeSession({
      creates: [async () => stuck.box],
      leftovers: async () => ["sb-stuck"],
    });

    const clean = await runCheck(
      check(),
      [e2b],
      { runId: "r6", out, concurrency: 1 },
      dependencies(swept.open),
    );

    expect(stuck.state.destroyCalls).toBe(3);
    expect(swept.swept).toEqual(["sb-stuck"]);
    expect(clean.cleanupProblems).toEqual([]);
    expect(clean.report.providers[0]?.destroyed).toBe(true);

    const out2 = await outDir();
    const stuck2 = fakeBox("sb-stuck-2", { destroyFails: true });

    const unsweepable = fakeSession({
      creates: [async () => stuck2.box],
      leftovers: async () => ["sb-stuck-2"],
      destroyById: async () => {
        throw new Error("still refused");
      },
    });

    const dirty = await runCheck(
      check(),
      [e2b],
      { runId: "r7", out: out2, concurrency: 1 },
      dependencies(unsweepable.open),
    );

    expect(dirty.cleanupProblems[0]?.error).toMatch(/Could not destroy sb-stuck-2/);
    expect(dirty.report.providers[0]?.destroyed).toBe(false);

    const out3 = await outDir();
    const stuck3 = fakeBox("sb-stuck-3", { destroyFails: true });

    const unlisted = fakeSession({
      creates: [async () => stuck3.box],
      leftovers: async () => {
        throw new Error("list 500");
      },
    });

    const unknown = await runCheck(
      check(),
      [e2b],
      { runId: "r8", out: out3, concurrency: 1 },
      dependencies(unlisted.open),
    );

    expect(unknown.cleanupProblems[0]?.error).toMatch(
      /Listing failed, so sb-stuck-3 may still run/,
    );
  });

  it("refuses a directory that belongs to another run, and a held lock", async () => {
    const out = await outDir();

    const { open } = fakeSession({
      creates: [async () => fakeBox("a").box, async () => fakeBox("b").box],
    });

    await runCheck(check(), [e2b], { runId: "r9", out, concurrency: 1 }, dependencies(open));

    await expect(
      runCheck(check(), [e2b], { runId: "other", out, concurrency: 1 }, dependencies(open)),
    ).rejects.toThrow(/belongs to security-probe run r9/);

    await writeFile(paths(out, "security-probe").lock("e2b"), "pid 1\n");
    await expect(
      runProvider(check(), e2b, { runId: "r9", out }, dependencies(open)),
    ).rejects.toThrow(/held by another invocation \(pid 1\)/);
  });

  it("sets the previous attempt aside on a retry", async () => {
    const out = await outDir();

    const { open } = fakeSession({
      creates: [async () => fakeBox("a").box, async () => fakeBox("b").box],
    });

    await runCheck(check(), [e2b], { runId: "r10", out, concurrency: 1 }, dependencies(open));

    const second = await runCheck(
      check(),
      [e2b],
      { runId: "r10", out, concurrency: 1 },
      dependencies(open),
    );

    expect(second.report.providers[0]?.sandboxes).toEqual([
      { id: "b", createS: expect.any(Number) },
    ]);

    const asideLogs = (await readdir(join(out, "logs"))).filter((name) =>
      name.endsWith(".prev.jsonl"),
    );

    expect(asideLogs).toHaveLength(1);
  });
});

describe("cleanup and machine size", () => {
  it("destroys a sandbox whose create returned after its deadline", async () => {
    const out = await outDir();
    const late = fakeBox("sb-late");

    const { open } = fakeSession({
      creates: [() => new Promise<Box>((done) => setTimeout(() => done(late.box), 80))],
    });

    const outcome = await runCheck(
      check(),
      [e2b],
      { runId: "late", out, concurrency: 1 },
      {
        ...dependencies(open),
        createTimeoutMs: 10,
      },
    );

    const entry = outcome.report.providers[0];
    expect(entry?.status).toBe("failed");
    expect(entry?.reason).toMatch(/Created 0 of 1/);
    expect(late.state.destroyed).toBe(true);
    expect(entry?.destroyed).toBe(true);
    const log = parseLog(await readFile(paths(out, "security-probe").log("e2b"), "utf8"));
    expect(log.filter((l) => l.kind === "sweep")).toHaveLength(2);
  });

  it("records each provider's machine and flags one that is not 4 vCPU / 8 GiB", async () => {
    const out = await outDir();

    const { open } = fakeSession({
      creates: [async () => fakeBox("a").box, async () => fakeBox("b").box],
    });

    const outcome = await runCheck(
      check(),
      [e2b, providerSetup("boxd")],
      { runId: "m", out, concurrency: 1 },
      dependencies(open),
    );

    const byName = new Map(outcome.report.providers.map((p) => [p.provider, p.machine]));
    expect(byName.get("e2b")).toEqual({ cpu: 4, memoryGiB: 8, sameSize: true });
    expect(byName.get("boxd")).toEqual({ cpu: 4, memoryGiB: 16, sameSize: false });
  });

  it("refuses a completed summary whose result no longer fits the check", async () => {
    const out = await outDir();
    const { open } = fakeSession({ creates: [async () => fakeBox("a").box] });
    await runCheck(check(), [e2b], { runId: "s", out, concurrency: 1 }, dependencies(open));
    await expect(
      mergeResults(out, "security-probe", z.object({ other: z.string() })),
    ).rejects.toThrow(/does not fit/);
  });
});

describe("merge", () => {
  it("rebuilds an entry from a log whose attempt died before its summary", async () => {
    const out = await outDir();
    const { open } = fakeSession({ creates: [async () => fakeBox("a").box] });
    await runCheck(check(), [e2b], { runId: "r11", out, concurrency: 1 }, dependencies(open));
    const files = paths(out, "security-probe");
    await mkdir(files.logs, { recursive: true });

    // A newer attempt for daytona that only got as far as creating its sandbox.
    await appendFile(
      files.log("daytona"),
      [
        JSON.stringify({
          kind: "start",
          check: "security-probe",
          provider: "daytona",
          runId: "r11",
          attemptId: "abc",
          at: "2026-11-24T00:00:00Z",
        }),
        JSON.stringify({ kind: "sandbox", id: "dt-1", createS: 2, at: "2026-11-24T00:00:02Z" }),
        '{"kind":"event","name":"fir',
      ].join("\n"),
    );

    const report = await mergeResults(out, "security-probe");
    const daytonaEntry = report.providers.find((p) => p.provider === "daytona");
    expect(daytonaEntry).toMatchObject({
      status: "failed",
      sandboxes: [{ id: "dt-1", createS: 2 }],
      destroyed: false,
      result: null,
    });
  });

  it("prefers the log over a summary from an older attempt", async () => {
    const out = await outDir();
    const { open } = fakeSession({ creates: [async () => fakeBox("a").box] });
    await runCheck(check(), [e2b], { runId: "r12", out, concurrency: 1 }, dependencies(open));
    const files = paths(out, "security-probe");
    await appendFile(
      files.log("e2b"),
      `${JSON.stringify({ kind: "start", check: "security-probe", provider: "e2b", runId: "r12", attemptId: "newer", at: "2026-11-24T00:00:00Z" })}\n`,
    );
    const { providers } = await loadResults(out, "security-probe");
    expect(providers[0]).toMatchObject({ attemptId: "newer", status: "failed" });
  });

  it("refuses misfiled summaries and logs", async () => {
    const out = await outDir();
    const { open } = fakeSession({ creates: [async () => fakeBox("a").box] });
    await runCheck(check(), [e2b], { runId: "r13", out, concurrency: 1 }, dependencies(open));
    const files = paths(out, "security-probe");
    await writeFile(files.provider("daytona"), await readFile(files.provider("e2b"), "utf8"));
    await expect(loadResults(out, "security-probe")).rejects.toThrow(
      /providers\/daytona.json holds e2b/,
    );
    await expect(loadResults(out, "disk-real")).rejects.toThrow(/is a security-probe run/);
  });

  it("fails on a corrupt complete log line", () => {
    expect(() => parseLog('{"kind":"nope"}\n')).toThrow(/Log line 1/);
    expect(() => parseLog("not json\n")).toThrow(/Log line 1/);
    expect(
      parseLog('{"kind":"stop","status":"failed","reason":null,"at":"x"}\n{"kind"'),
    ).toHaveLength(1);
  });
});

describe("labels and CLI", () => {
  it("labels each attempt so its sweep finds only its own sandboxes", () => {
    expect(labelsFor(e2b, { runId: "r", attemptId: "a1" })).toEqual({
      "sandbox-bench-run": "r",
      "sc-provider": "e2b",
      "sc-attempt": "a1",
    });
  });

  it("parses a check and its providers", () => {
    expect(parseCli(["cpu-native", "--providers", "e2b,styne,e2b"])).toMatchObject({
      check: "cpu-native",
      providers: ["e2b", "styne"],
      out: "results/fairness/cpu-native",
      concurrency: 15,
    });
    expect(() => parseCli(["cpu-native", "--providers", "nope"])).toThrow(/Unknown provider nope/);
    expect(() => parseCli(["nonsense"])).toThrow();
    expect(() => parseCli([])).toThrow(/Name one check/);
  });
});
