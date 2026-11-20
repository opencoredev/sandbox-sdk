import { describe, expect, it } from "vitest";
import type { LookupEvidence } from "../src/existence.js";
import type { FailureOutcome } from "../src/failure.js";
import {
  classifyHeartbeats,
  heartbeatOffsets,
  heartbeatWindow,
  parseBootId,
  survivalFailure,
  type Heartbeat,
} from "../src/survival.js";

const ok = (atMs: number, bootId = "boot-a"): Heartbeat => ({
  kind: "ok",
  atMs,
  latencyMs: 5,
  bootId,
});

const lookup = (result: LookupEvidence["result"], nativeState?: string): LookupEvidence => {
  const evidence: LookupEvidence = {
    result,
    checkedAt: "2026-11-19T00:00:00.000Z",
    method: "test:native-exact-get",
  };

  if (nativeState) evidence.nativeState = nativeState;

  return evidence;
};

const missed = (
  atMs: number,
  { found = lookup("present"), code }: { found?: LookupEvidence | null; code?: string } = {},
): Heartbeat => {
  const failure: FailureOutcome = { kind: "failure", note: "heartbeat failed" };

  if (code) failure.code = code;

  return { kind: "missed", atMs, latencyMs: 15_000, timedOut: !code, failure, lookup: found };
};

describe("parseBootId", () => {
  it("accepts the kernel's boot ID and refuses an empty or garbled reply", () => {
    expect(parseBootId("4F9C1D1E-8B2A-4C1E-9D3F-0A1B2C3D4E5F\n")).toBe(
      "4f9c1d1e-8b2a-4c1e-9d3f-0a1b2c3d4e5f",
    );
    expect(() => parseBootId("")).toThrow("not a boot ID");
    expect(() => parseBootId("cat: /proc/sys/kernel/random/boot_id: No such file")).toThrow(
      "not a boot ID",
    );
  });
});

describe("heartbeatOffsets", () => {
  it("sends one heartbeat at the start and one per interval through the window's end", () => {
    const offsets = heartbeatOffsets({ windowMs: 300_000, intervalMs: 15_000 });

    expect(offsets).toHaveLength(21);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(300_000);
    expect(heartbeatOffsets({ windowMs: 1000, intervalMs: 400 })).toEqual([0, 400, 800]);
  });
});

describe("classifyHeartbeats", () => {
  it("survives only when every expected heartbeat answered", () => {
    expect(classifyHeartbeats([ok(0), ok(15), ok(30)], 3)).toEqual({ kind: "survived" });
  });

  it("calls a missed heartbeat on a sandbox the provider no longer has a death", () => {
    expect(classifyHeartbeats([ok(0), missed(15, { found: lookup("not-found") })], 3)).toEqual({
      kind: "died",
      atMs: 15,
      reason: "absent",
    });
    expect(classifyHeartbeats([ok(0), missed(15, { found: lookup("terminal") })], 3)).toEqual({
      kind: "died",
      atMs: 15,
      reason: "absent",
    });
  });

  it("calls a dead native state, an SDK not_found or a new boot ID a death", () => {
    expect(
      classifyHeartbeats([ok(0), missed(15, { found: lookup("present", "exited") })], 3),
    ).toMatchObject({ kind: "died", reason: "dead-state" });
    expect(
      classifyHeartbeats([ok(0), missed(15, { found: null, code: "not_found" })], 3),
    ).toMatchObject({ kind: "died", reason: "not-found" });
    expect(classifyHeartbeats([ok(0), ok(15), ok(30, "boot-b")], 3)).toEqual({
      kind: "died",
      atMs: 30,
      reason: "rebooted",
    });
  });

  it("calls a miss on a sandbox that still exists unresponsive, recovered or not", () => {
    expect(classifyHeartbeats([ok(0), missed(15), ok(30)], 3)).toEqual({
      kind: "unresponsive",
      missed: 1,
      firstMissAtMs: 15,
      recovered: true,
    });
    // A lookup that itself failed proves nothing either way.
    expect(
      classifyHeartbeats([ok(0), missed(15, { found: lookup("unavailable") }), missed(30)], 3),
    ).toEqual({ kind: "unresponsive", missed: 2, firstMissAtMs: 15, recovered: false });
  });

  it("gives an interrupted window no verdict unless it had already failed", () => {
    expect(classifyHeartbeats([ok(0), ok(15)], 3)).toEqual({ kind: "interrupted", atMs: 15 });
    expect(classifyHeartbeats([ok(0), missed(15)], 3)).toMatchObject({ kind: "unresponsive" });
  });
});

describe("heartbeatWindow", () => {
  const base = {
    plan: { windowMs: 120, intervalMs: 40 },
    heartbeatTimeoutMs: 1000,
    sanitize: (text: string) => text,
    track: <T>(work: Promise<T>) => work,
  };

  it("sends every heartbeat on schedule and survives", async () => {
    const result = await heartbeatWindow({
      ...base,
      heartbeat: async () => "boot-a",
      lookup: async () => lookup("present"),
      stop: new AbortController().signal,
    });

    expect(result.verdict).toEqual({ kind: "survived" });
    expect(result.expected).toBe(4);
    expect(result.heartbeats.map((h) => h.kind)).toEqual(["ok", "ok", "ok", "ok"]);
    // The last heartbeat is due at the window's end, not before it.
    expect(result.heartbeats.at(-1)?.atMs).toBeGreaterThanOrEqual(120);
  });

  it("times a hung heartbeat out at the interval and looks the sandbox up", async () => {
    let calls = 0;
    let lookups = 0;

    const result = await heartbeatWindow({
      ...base,
      heartbeat: async () => {
        calls++;

        if (calls === 2) await new Promise((resolve) => setTimeout(resolve, 200));

        return "boot-a";
      },
      lookup: async () => {
        lookups++;

        return lookup("present", "running");
      },
      stop: new AbortController().signal,
    });

    expect(result.verdict).toMatchObject({ kind: "unresponsive", missed: 1, recovered: true });
    const miss = result.heartbeats[1];

    expect(miss?.kind === "missed" && miss.timedOut).toBe(true);
    expect(miss?.latencyMs).toBeLessThan(100);
    expect(lookups).toBe(1);
  });

  it("stops at the first proof of death and records the provider's error", async () => {
    let calls = 0;

    const result = await heartbeatWindow({
      ...base,
      heartbeat: async () => {
        if (++calls === 2) throw Object.assign(new Error("Sandbox gone"), { code: "not_found" });

        return "boot-a";
      },
      lookup: async () => lookup("not-found"),
      stop: new AbortController().signal,
    });

    expect(result.verdict).toEqual({ kind: "died", atMs: expect.any(Number), reason: "absent" });
    expect(result.heartbeats).toHaveLength(2);
    expect(survivalFailure(result, "survival-3/window")).toMatchObject({
      kind: "failure",
      code: "not_found",
      stage: "survival-3/window",
      note: expect.stringMatching(/^Died at 0 s \(absent\): Sandbox gone/),
    });
  });

  it("ends early with an interrupted verdict when the run stops", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 60);

    const result = await heartbeatWindow({
      ...base,
      heartbeat: async () => "boot-a",
      lookup: async () => lookup("present"),
      stop: stop.signal,
    });

    expect(result.verdict.kind).toBe("interrupted");
    expect(result.heartbeats.length).toBeLessThan(4);
    expect(result.elapsedMs).toBeLessThan(120);
    expect(survivalFailure(result, "survival-3/window")).toBeNull();
  });
});
