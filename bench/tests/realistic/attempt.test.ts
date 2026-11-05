import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAttempt, type AttemptPlan } from "../../src/realistic/attempt.js";
import { systemClock } from "../../src/realistic/gaps.js";
import { attemptRecordSchema } from "../../src/realistic/record.js";
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

const plan = (overrides: Partial<AttemptPlan> = {}): AttemptPlan => ({
  runId: "rw-test",
  attemptId: `rw-test-${Math.random().toString(36).slice(2, 8)}`,
  provider: { name: "host", provider: host },
  manifest: fixture.manifest,
  manifestSha256: null,
  profileName: "fix-and-test",
  track: "same-machine",
  variant: "headline",
  batch: 0,
  slot: { index: 0, id: "fix-and-test/same-machine" },
  seed: 7,
  slotStartedAt: Date.now(),
  ...overrides,
});

const environment = (signal = new AbortController().signal) => ({
  clock: systemClock,
  signal,
  blobs: fixture.blobs,
  prepare: { cacheBaseUrl: fixture.cacheBaseUrl },
  attribution: "per-sandbox" as const,
});

describe("fix-and-test attempt on the host provider", () => {
  it("prepares from hash-checked tarballs, installs offline, and completes from the frozen checks", async () => {
    const { record } = await runAttempt(plan(), environment());
    attemptRecordSchema.parse(JSON.parse(JSON.stringify(record)));

    expect(record.completion).toEqual({ kind: "completed" });
    expect(record.deletionConfirmed).toBe(true);
    expect(record.sandboxIds).toHaveLength(1);
    expect(await host.list({ "rw-attempt": record.attemptId })).toEqual([]);
    expect(record.downloads.map((d) => [d.role, d.hashOk])).toEqual([
      ["toolchain", true],
      ["dependency-cache", true],
    ]);
    // Phases: create, prepare (with each download inside it), workload, destroy.
    const names = record.phases.map((p) => p.name);
    expect(names).toEqual(["create", "prepare", "download", "download", "workload", "destroy"]);
    const prepare = record.phases.find((p) => p.name === "prepare");

    for (const download of record.phases.filter((p) => p.name === "download")) {
      expect(download.startedAt).toBeGreaterThanOrEqual(prepare?.startedAt ?? Infinity);
      expect(download.endedAt).toBeLessThanOrEqual(prepare?.endedAt ?? -Infinity);
    }

    const byId = new Map(record.steps.map((s) => [s.id, s]));
    const testA = byId.get("test-a");
    const testB = byId.get("test-b");

    if (testA?.status !== "passed" || testB?.status !== "passed") throw new Error("Expected runs");
    // Patch A leaves a failing test by design: non-zero is data, and it passes its check.
    expect(testA.exitCode).toBe(1);
    expect(testA.invariants.tests).toEqual({ passed: 3, failed: 1 });
    // The excluded timing test failed, ran, was recorded, and did not count.
    expect(testB.exitCode).toBe(1);
    expect(testB.invariants.tests).toEqual({ passed: 4 });
    expect(testB.excluded).toEqual([
      expect.objectContaining({ name: "timing > finishes within 1ms", status: "failed" }),
    ]);
    // Resume steps belong to held-open runs only.
    expect(byId.has("resume-test")).toBe(false);
    expect(record.gaps).toEqual({ count: 0, totalMs: 0, traffic: [] });
  }, 60_000);

  it("rejects a dependency cache whose hash does not match, before extracting it", async () => {
    const path = join(fixture.cacheDir, fixture.cacheSha256);
    const { readFile } = await import("node:fs/promises");
    const original = await readFile(path);
    await writeFile(path, "tampered");

    try {
      const { record } = await runAttempt(plan(), environment());

      expect(record.completion).toMatchObject({ kind: "incomplete", reason: "prepare-failed" });
      expect(
        record.completion.kind === "incomplete" && JSON.parse(record.completion.detail),
      ).toMatchObject({
        kind: "hash-mismatch",
        role: "dependency-cache",
        expected: fixture.cacheSha256,
      });
      expect(record.downloads.at(-1)).toMatchObject({ role: "dependency-cache", hashOk: false });
      expect(record.steps).toEqual([]);
      expect(record.deletionConfirmed).toBe(true);
    } finally {
      await rm(path);
      await writeFile(path, original);
    }
  }, 60_000);

  it("fails the attempt when a frozen count does not match", async () => {
    const profile = fixture.manifest.profiles["fix-and-test"];

    if (!profile) throw new Error("fixture profile");

    const broken = {
      ...fixture.manifest,
      profiles: {
        "fix-and-test": {
          ...profile,
          steps: profile.steps.map((step) =>
            step.id === "test-b"
              ? {
                  ...step,
                  check: { ...step.check, outputInvariants: { tests: { passed: 5 } } },
                }
              : step,
          ),
        },
      },
    };

    const { record } = await runAttempt(plan({ manifest: broken }), environment());

    expect(record.completion).toMatchObject({ kind: "incomplete", reason: "check-failed" });
    expect(record.completion.kind === "incomplete" && record.completion.detail).toContain("test-b");
  }, 60_000);

  it("ends at the slot timeout, still deletes the sandbox, and says so", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { record } = await runAttempt(plan(), environment(controller.signal));

    expect(record.completion).toMatchObject({ kind: "incomplete", reason: "slot-timeout" });
    expect(record.deletionConfirmed).toBe(true);
    expect(await host.list({ "rw-attempt": record.attemptId })).toEqual([]);
  }, 60_000);
});
