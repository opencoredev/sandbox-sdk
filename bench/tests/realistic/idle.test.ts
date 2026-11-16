import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSandbox } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import { runAttempt, type AttemptPlan } from "../../src/realistic/attempt.js";
import { ProviderTrace, systemClock, traceProvider } from "../../src/realistic/gaps.js";
import { checkStatePreservation, managedIdleCapabilities } from "../../src/realistic/idle.js";
import { buildFixture, type Fixture } from "./fixture.js";
import { hostProvider, type HostProvider } from "./host-provider.js";

let fixture: Fixture;
let host: HostProvider;

beforeAll(async () => {
  fixture = await buildFixture();
  host = await hostProvider();
});

afterAll(async () => {
  await host.dispose();
  await fixture.cleanup();
});

const preserving = {
  verdict: "state-preserving",
  mechanism: "pause",
  filesystem: true,
  process: true,
  memory: true,
  suspendMs: 1,
  restoreMs: 1,
} as const;

const plan = (overrides: Partial<AttemptPlan>): AttemptPlan => ({
  runId: "rw-idle",
  attemptId: `rw-idle-${Math.random().toString(36).slice(2, 8)}`,
  provider: { name: "host", provider: host },
  manifest: fixture.manifest,
  manifestSha256: null,
  profileName: "fix-and-test",
  track: "same-machine",
  variant: "held-open",
  batch: 0,
  slot: { index: 0, id: "held-open" },
  seed: 1,
  slotStartedAt: Date.now(),
  ...overrides,
});

const environment = {
  clock: systemClock,
  signal: new AbortController().signal,
  blobs: { get: (sha: string) => fixture.blobs.get(sha) },
  prepare: { cacheBaseUrl: "" },
  attribution: "per-sandbox" as const,
};

const run = (overrides: Partial<AttemptPlan>) =>
  runAttempt(plan(overrides), {
    ...environment,
    prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
  });

describe("held-open diagnostic", () => {
  it("runs fix-and-test, idles on the harness side for the frozen time, then the resume steps", async () => {
    const { record, trace } = await run({ idle: { policy: "provider-defaults", idleMs: 600 } });

    expect(record.completion).toEqual({ kind: "completed" });
    const idle = record.phases.find((p) => p.name === "idle");
    const resume = record.phases.find((p) => p.name === "resume");
    const workload = record.phases.find((p) => p.name === "workload");

    expect(idle && idle.endedAt - idle.startedAt).toBeGreaterThanOrEqual(600);
    expect(record.phases.filter((p) => p.name === "gap")).toEqual([]);
    expect(idle?.startedAt).toBeGreaterThanOrEqual(workload?.endedAt ?? Infinity);
    expect(resume?.startedAt).toBeGreaterThanOrEqual(idle?.endedAt ?? Infinity);
    expect(record.idle).toMatchObject({
      policy: "provider-defaults",
      requestedMs: 600,
      mechanism: null,
      stateBefore: "running",
      stateAfter: "running",
      trafficDuringIdle: 0,
    });
    expect(record.idle?.wakeLatencyMs).toBeGreaterThan(0);
    expect(record.steps.map((s) => [s.id, s.status]).slice(-2)).toEqual([
      ["resume-status", "passed"],
      ["resume-test", "passed"],
    ]);
    // No call reached the provider while the sandbox sat idle.
    const window = trace.gaps.find((g) => g.before === "idle");

    expect(window && trace.trafficDuring(window)).toEqual([]);
  }, 60_000);

  it("pairs it with a zero-wait twin: same steps, resume straight away", async () => {
    const { record } = await run({
      variant: "zero-wait",
      idle: { policy: "provider-defaults", idleMs: 0 },
    });

    const idle = record.phases.find((p) => p.name === "idle");

    expect(record.completion).toEqual({ kind: "completed" });
    expect(idle && idle.endedAt - idle.startedAt).toBeLessThan(100);
    expect(record.steps.at(-1)).toMatchObject({ id: "resume-test", status: "passed" });
  }, 60_000);

  it("managed idle pauses after the threshold and resumes before the next step", async () => {
    const { record, trace } = await run({
      variant: "managed-idle",
      idle: { policy: "managed", idleMs: 500, thresholdMs: 100 },
      statePreservation: preserving,
    });

    expect(record.completion).toEqual({ kind: "completed" });
    expect(record.idle).toMatchObject({
      policy: "managed",
      mechanism: "pause",
      trafficDuringIdle: 0,
    });
    const members = trace.calls.map((c) => c.member);

    expect(members.indexOf("pause")).toBeGreaterThan(-1);
    expect(members.indexOf("resume")).toBeGreaterThan(members.indexOf("pause"));
    expect(record.idle?.suspendMs).not.toBeNull();
  }, 60_000);

  it("refuses managed idle unless this provider passed the state-preservation check", async () => {
    for (const statePreservation of [
      undefined,
      { ...preserving, verdict: "restore-and-rebuild" as const, process: false, memory: false },
    ]) {
      const overrides: Partial<AttemptPlan> = {
        variant: "managed-idle",
        idle: { policy: "managed", idleMs: 500, thresholdMs: 100 },
      };

      if (statePreservation) overrides.statePreservation = statePreservation;
      const { record } = await run(overrides);

      expect(record.completion).toMatchObject({ kind: "incomplete", reason: "not-available" });
      expect(record.sandboxIds).toEqual([]);
    }
  });

  it("reads not available, without creating anything, where the adapter has no pause", async () => {
    const provider = memory();

    const { record } = await runAttempt(
      plan({ provider: { name: "memory", provider }, idle: { policy: "managed", idleMs: 1000 } }),
      environment,
    );

    expect(record.completion).toMatchObject({ kind: "incomplete", reason: "not-available" });
    expect(record.sandboxIds).toEqual([]);
    expect(await provider.list({})).toEqual([]);
  });
});

describe("state-preservation check", () => {
  it("passes when pause keeps the filesystem, the process and its in-memory marker", async () => {
    const box = await createSandbox(host, { labels: { t: "state" } });

    try {
      const result = await checkStatePreservation({
        box,
        provider: host,
        clock: systemClock,
        workdir: "/workspace",
        holdMs: 300,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        verdict: "state-preserving",
        filesystem: true,
        process: true,
        memory: true,
      });
    } finally {
      await box.destroy();
    }
  }, 30_000);

  it("reports restore-and-rebuild when the suspend loses running processes", async () => {
    host.pauseMode = "lossy";
    const box = await createSandbox(host, { labels: { t: "lossy" } });

    try {
      const result = await checkStatePreservation({
        box,
        provider: host,
        clock: systemClock,
        workdir: "/workspace",
        holdMs: 300,
        signal: new AbortController().signal,
      });

      expect(result).toMatchObject({
        verdict: "restore-and-rebuild",
        filesystem: true,
        process: false,
        memory: false,
      });
    } finally {
      host.pauseMode = "preserve";
      await box.destroy();
    }
  }, 30_000);

  it("is unavailable without an adapter pause, and capability flags say why", async () => {
    const provider = memory();
    const box = await createSandbox(provider, { labels: {} });

    expect(managedIdleCapabilities(provider)).toEqual({
      pause: false,
      snapshot: false,
      stop: false,
    });
    expect(managedIdleCapabilities(host)).toEqual({ pause: true, snapshot: false, stop: false });
    expect(
      await checkStatePreservation({
        box,
        provider,
        clock: systemClock,
        workdir: "/workspace",
        holdMs: 0,
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ verdict: "unavailable" });
  });
});

describe("gap traffic detection", () => {
  it("reports a call that reaches the provider during a gap outside any step", async () => {
    const trace = new ProviderTrace(systemClock);
    const traced = traceProvider(host, trace);
    const waiting = trace.wait("s1", 200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await traced.list({});
    await waiting;

    expect(trace.gapTraffic()).toEqual([expect.objectContaining({ gap: "s1", member: "list" })]);
  });
});
