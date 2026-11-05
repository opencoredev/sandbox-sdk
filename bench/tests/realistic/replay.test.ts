import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import { ProviderTrace, systemClock, traceProvider } from "../../src/realistic/gaps.js";
import { profileSchema } from "../../src/realistic/manifest.js";
import { layout } from "../../src/realistic/prepare.js";
import { memoryBlobs, sha256Hex, StepRunner } from "../../src/realistic/steps.js";
import { hostProvider, type HostProvider } from "./host-provider.js";

let host: HostProvider;

beforeAll(async () => {
  host = await hostProvider();
});

afterAll(() => host.dispose());

const edit = new TextEncoder().encode("export const answer = 42;\n");

/** A recorded-session-shaped profile: think gaps, a deliberate failure, built-in file ops, a watcher. */
const session = profileSchema.parse({
  kind: "session",
  status: "draft",
  toolchain: { node: "none" },
  minFreeDiskGiB: 0.01,
  slotTimeoutMs: 60_000,
  steps: [
    { id: "s0", phase: "workload", op: { kind: "shell", script: "mkdir -p src && echo start" } },
    {
      id: "s1",
      phase: "workload",
      gapAfterPrereqMs: 300,
      op: { kind: "shell", script: "grep -c answer src/a.ts" },
      check: { exit: 2 },
    },
    {
      id: "s2",
      phase: "workload",
      gapAfterPrereqMs: 200,
      op: { kind: "write", path: "src/a.ts", blob: sha256Hex(edit) },
      check: { postconditions: { files: { "src/a.ts": sha256Hex(edit) } } },
    },
    {
      id: "s3",
      phase: "workload",
      op: {
        kind: "shell",
        script: "echo booting; sleep 0.3; echo 'watcher ready'; while :; do sleep 1; done",
      },
      background: {
        id: "watcher",
        readiness: { kind: "line", pattern: "^watcher ready" },
        readinessTimeoutMs: 10_000,
        shutdown: { kind: "step", step: "s6" },
      },
    },
    // s4 and s5 both follow s3, so they overlap, as two parallel tool calls did in the recording.
    {
      id: "s4",
      phase: "workload",
      dependsOn: ["s3"],
      gapAfterPrereqMs: 250,
      needs: ["watcher"],
      op: { kind: "read", path: "src/a.ts" },
    },
    {
      id: "s5",
      phase: "workload",
      dependsOn: ["s3"],
      gapAfterPrereqMs: 250,
      op: {
        kind: "shell",
        script: "printf ' Tests  1 failed | 2 passed (3)\\n'; exit 1",
      },
      check: { exit: 1, outputInvariants: { tests: { failed: 1, passed: 2 } } },
    },
    {
      id: "s6",
      phase: "workload",
      dependsOn: ["s4", "s5"],
      gapAfterPrereqMs: 150,
      op: { kind: "shell", script: "true" },
    },
  ],
});

async function replay(gapScale = 1) {
  const trace = new ProviderTrace(systemClock);
  const box: Sandbox = await createSandbox(traceProvider(host, trace), { labels: { t: "replay" } });
  const workdir = "/workspace/session";

  const steps = session.steps.map((step) => ({
    ...step,
    gapAfterPrereqMs: step.gapAfterPrereqMs * gapScale,
  }));

  const profile = { steps };

  const runner = new StepRunner({
    box,
    clock: systemClock,
    trace,
    signal: new AbortController().signal,
    workdir,
    placeholders: layout(workdir, 4),
    commands: {},
    env: {},
    path: [],
    blobs: memoryBlobs([edit]),
    defaultTimeoutMs: 20_000,
  });

  await box.run(`mkdir -p ${workdir}`);
  const results = await runner.run(profile, steps, "continue");
  await runner.stopAll();
  await box.destroy();

  return { results, trace, runner };
}

describe("session replay by cause", () => {
  it("runs gaps on the harness side with no provider call inside any gap", async () => {
    const { results, trace } = await replay();

    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["s0", "passed"],
      ["s1", "passed"],
      ["s2", "passed"],
      ["s3", "passed"],
      ["s4", "passed"],
      ["s5", "passed"],
      ["s6", "passed"],
    ]);
    expect(trace.gaps.map((g) => g.before).sort()).toEqual(["s1", "s2", "s4", "s5", "s6"]);
    // The requirement: nothing (exec, files, list, keepalive) reached the provider during a gap.
    expect(trace.gapTraffic()).toEqual([]);
    expect(trace.calls.some((c) => c.member === "exec")).toBe(true);
  }, 30_000);

  it("measures each gap from its prerequisite's completion, not from the session start", async () => {
    const { results } = await replay();
    const byId = new Map(results.map((r) => [r.id, r]));
    const s0 = byId.get("s0");
    const s1 = byId.get("s1");

    if (s0?.status === "blocked" || s1?.status === "blocked" || !s0 || !s1) throw new Error("ran");
    expect(s1.gap?.requestedMs).toBe(300);
    expect(s1.startedAt - s0.endedAt).toBeGreaterThanOrEqual(295);
    // s1 exits 2 (grep found no file) and that was the recorded, expected status.
    expect(s1.exitCode).toBe(2);
  }, 30_000);

  it("waits for readiness, overlaps independent steps, and stops the watcher at its recorded step", async () => {
    const { results, runner } = await replay();
    const byId = new Map(results.map((r) => [r.id, r]));
    const s4 = byId.get("s4");
    const s5 = byId.get("s5");

    if (s4?.status !== "passed" || s5?.status !== "passed") throw new Error("ran");
    const [watcher] = runner.events;

    expect(watcher?.readyAt).not.toBeNull();
    expect(s4.startedAt).toBeGreaterThanOrEqual(watcher?.readyAt ?? Infinity);
    // Both followed s3 after the same gap, so they ran at the same time.
    expect(Math.abs(s4.startedAt - s5.startedAt)).toBeLessThan(400);
    expect(watcher?.shutdown).toBe("harness");
    const s6 = byId.get("s6");

    expect(s6?.status === "passed" && watcher?.stoppedAt).toBeGreaterThanOrEqual(
      s6?.status === "passed" ? s6.endedAt : Infinity,
    );
  }, 30_000);

  it("runs the dense variant with the same steps and no gaps", async () => {
    const { results, trace } = await replay(0);

    expect(results.every((r) => r.status === "passed")).toBe(true);
    expect(trace.gaps).toEqual([]);
  }, 30_000);

  it("blocks dependents of a failed step under the stop policy", async () => {
    const trace = new ProviderTrace(systemClock);
    const box = await createSandbox(traceProvider(host, trace), { labels: { t: "stop" } });

    const steps = profileSchema.parse({
      kind: "build",
      status: "draft",
      toolchain: { node: "none" },
      minFreeDiskGiB: 0.01,
      slotTimeoutMs: 60_000,
      steps: [
        { id: "build", phase: "workload", op: { kind: "shell", script: "exit 3" } },
        {
          id: "verify",
          phase: "workload",
          op: { kind: "shell", script: "true" },
          check: { postconditions: { exists: ["dist/out.js"] } },
        },
      ],
    }).steps;

    const runner = new StepRunner({
      box,
      clock: systemClock,
      trace,
      signal: new AbortController().signal,
      workdir: "/workspace",
      placeholders: layout("/workspace", 4),
      commands: {},
      env: {},
      path: [],
      blobs: memoryBlobs([]),
      defaultTimeoutMs: 20_000,
    });

    const results = await runner.run({ steps }, steps, "stop");
    await box.destroy();

    expect(results.map((r) => r.status)).toEqual(["failed", "blocked"]);
    expect(results[0]?.status === "failed" && results[0].failures).toEqual([
      { kind: "exit", expected: 0, actual: 3 },
    ]);
  }, 30_000);
});
