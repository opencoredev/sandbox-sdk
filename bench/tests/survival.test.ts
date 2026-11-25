import { describe, expect, it, vi } from "vitest";
import {
  SandboxError,
  createSandbox,
  type RunResult,
  type Sandbox,
} from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { LookupEvidence } from "../src/existence.js";
import type { FailureOutcome } from "../src/failure.js";
import {
  classifyHeartbeats,
  heartbeatOffsets,
  heartbeatWindow,
  parseBootId,
  sendHeartbeat,
  survivalFailure,
  type SentHeartbeat,
} from "../src/survival.js";
import { parseV2 } from "../src/v2-config.js";

const ok = (atMs: number, bootId = "boot-a"): SentHeartbeat => ({
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
): SentHeartbeat => {
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

  it("never copies the guest's reply into the error", () => {
    expect(() => parseBootId("TOKEN=sk-guest-secret")).toThrow(
      /^Heartbeat reply is not a boot ID$/,
    );
  });
});

describe("heartbeatOffsets", () => {
  it("sends one heartbeat at the start and one per interval through the window's end", () => {
    const offsets = heartbeatOffsets({ windowMs: 300_000, intervalMs: 15_000 });

    expect(offsets).toHaveLength(21);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(300_000);
    // A window that is not a whole number of intervals still ends with a heartbeat at its end.
    expect(heartbeatOffsets({ windowMs: 1000, intervalMs: 400 })).toEqual([0, 400, 800, 1000]);
  });
});

describe("classifyHeartbeats", () => {
  it("survives only when every expected heartbeat answered", () => {
    expect(classifyHeartbeats([ok(0), ok(15), ok(30)], 3)).toEqual({ kind: "survived" });
  });

  it("calls a missed heartbeat on a sandbox the provider no longer has a death", () => {
    const gone = missed(15, { found: lookup("not-found") });

    // The verdict carries the heartbeat whose lookup proved the death.
    expect(classifyHeartbeats([ok(0), gone], 3)).toEqual({
      kind: "died",
      atMs: 15,
      reason: "absent",
      evidence: gone,
    });
    expect(classifyHeartbeats([ok(0), missed(15, { found: lookup("terminal") })], 3)).toMatchObject(
      {
        kind: "died",
        atMs: 15,
        reason: "absent",
      },
    );
  });

  it("calls a dead native state, an SDK not_found or a new boot ID a death", () => {
    expect(
      classifyHeartbeats([ok(0), missed(15, { found: lookup("present", "exited") })], 3),
    ).toMatchObject({ kind: "died", reason: "dead-state" });
    expect(
      classifyHeartbeats([ok(0), missed(15, { found: null, code: "not_found" })], 3),
    ).toMatchObject({ kind: "died", reason: "not-found" });
    expect(classifyHeartbeats([ok(0), ok(15), ok(30, "boot-b")], 3)).toMatchObject({
      kind: "died",
      atMs: 30,
      reason: "rebooted",
    });
  });

  it("calls a miss on a sandbox that still exists unresponsive, recovered or not", () => {
    expect(classifyHeartbeats([ok(0), missed(15), ok(30)], 3)).toMatchObject({
      kind: "unresponsive",
      missed: 1,
      firstMissAtMs: 15,
      recovered: true,
    });
    // A lookup that itself failed proves nothing either way.
    expect(
      classifyHeartbeats([ok(0), missed(15, { found: lookup("unavailable") }), missed(30)], 3),
    ).toMatchObject({ kind: "unresponsive", missed: 2, firstMissAtMs: 15, recovered: false });
  });

  it("gives an interrupted window no verdict unless it had already failed", () => {
    expect(classifyHeartbeats([ok(0), ok(15)], 3, true)).toEqual({
      kind: "interrupted",
      atMs: 15,
      reason: "stopped",
    });
    // Out of time before the last slot: no verdict either, and never the provider's fault.
    expect(
      classifyHeartbeats([ok(0), ok(15), { kind: "skipped", atMs: 30, reason: "deadline" }], 3),
    ).toEqual({ kind: "interrupted", atMs: 30, reason: "deadline" });
    expect(classifyHeartbeats([ok(0), missed(15)], 3)).toMatchObject({ kind: "unresponsive" });
  });
});

describe("heartbeatWindow", () => {
  const base = {
    plan: { windowMs: 120, intervalMs: 40 },
    heartbeatTimeoutMs: 1000,
    endBy: Number.POSITIVE_INFINITY,
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
    expect(miss?.kind === "missed" && miss.latencyMs).toBeLessThan(100);
    expect(lookups).toBe(1);
  });

  it("ignores a lookup answer that arrives after its budget, however late its timer fires", async () => {
    let calls = 0;

    const result = await heartbeatWindow({
      ...base,
      heartbeat: async () => {
        if (++calls === 2) await new Promise((resolve) => setTimeout(resolve, 200));

        return "boot-a";
      },
      // Blocks the event loop past the 40 ms budget, so the deadline's timer cannot fire first.
      lookup: async () => {
        const until = performance.now() + 60;

        while (performance.now() < until);

        return lookup("not-found");
      },
      stop: new AbortController().signal,
    });

    expect(result.verdict).toMatchObject({ kind: "unresponsive" });
    const miss = result.heartbeats[1];

    expect(miss?.kind === "missed" && miss.lookup).toBeNull();
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

    expect(result.verdict).toMatchObject({ kind: "died", reason: "absent" });
    expect(result.heartbeats).toHaveLength(2);
    // The lookup decided the death; the row names it and carries no heartbeat error code.
    const failure = survivalFailure(result, "survival-3/window");

    expect(failure).toEqual({
      kind: "failure",
      stage: "survival-3/window",
      note: expect.stringMatching(
        /^Died at 0 s \(absent\): exact lookup not-found; heartbeat not_found: Sandbox gone/,
      ),
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

// PR 75 review (PRRT_kwDOTZ9UNs67Hvb9): with a 1001 ms window and 1000 ms heartbeats the slots
// fall at 0, 1000 and 1001 ms, so a 300 ms reply to the 1000 ms heartbeat made the final slot a
// busy skip and the member interrupted. Such plans are refused before any sandbox starts.
describe("survival plans", () => {
  it("refuses a window that is not a whole number of heartbeat intervals", () => {
    const plan = (windowMs: string, heartbeatMs: string) => () =>
      parseV2(["--survival-window-ms", windowMs, "--survival-heartbeat-ms", heartbeatMs]);

    expect(plan("1001", "1000")).toThrow(
      "--survival-window-ms must be a whole multiple of --survival-heartbeat-ms",
    );
    expect(plan("2500", "1000")).toThrow(/whole multiple/);
    expect(plan("2000", "1000")).not.toThrow();
    expect(plan("300000", "15000")).not.toThrow();
    // The defaults are a whole multiple.
    expect(() => parseV2([])).not.toThrow();
  });

  it("keeps every slot an interval apart, so replies on time never collide", async () => {
    const plan = { windowMs: 120, intervalMs: 40 };

    const result = await heartbeatWindow({
      plan,
      heartbeatTimeoutMs: 1000,
      endBy: Number.POSITIVE_INFINITY,
      sanitize: (text) => text,
      track: (work) => work,
      // Each reply takes 30 ms of a 40 ms interval, as the 300 ms reply did of 1000 ms.
      heartbeat: () => new Promise((resolve) => setTimeout(() => resolve("boot-a"), 30)),
      lookup: async () => lookup("present"),
      stop: new AbortController().signal,
    });

    expect(heartbeatOffsets(plan)).toEqual([0, 40, 80, 120]);
    expect(result.verdict).toEqual({ kind: "survived" });
    expect(result.heartbeats.map((h) => h.kind)).toEqual(["ok", "ok", "ok", "ok"]);
  });
});

describe("heartbeats through the guest", () => {
  const guestText = "Traceback: TOKEN=sk-guest-secret in /home/guest/private";

  async function box(run: Partial<RunResult> | Error) {
    const sandbox = await createSandbox(memory());

    const spy = vi.spyOn(sandbox, "run");

    if (run instanceof Error) spy.mockRejectedValue(run);
    else
      spy.mockResolvedValue({
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        output: "",
        durationMs: 1,
        truncated: false,
        timedOut: false,
        cwd: "/workspace",
        command: "",
        ...run,
      });

    return sandbox;
  }

  async function window(sandbox: Sandbox) {
    return heartbeatWindow({
      plan: { windowMs: 40, intervalMs: 40 },
      heartbeatTimeoutMs: 1000,
      endBy: Number.POSITIVE_INFINITY,
      sanitize: (text: string) => text,
      track: <T>(work: Promise<T>) => work,
      heartbeat: (signal) => sendHeartbeat(sandbox, 1000, signal),
      lookup: async () => lookup("present", "running"),
      stop: new AbortController().signal,
    });
  }

  it("records a failed heartbeat by its exit code alone, never the guest's output", async () => {
    const result = await window(
      await box({ ok: false, exitCode: 1, stdout: guestText, stderr: guestText }),
    );

    const miss = result.heartbeats[0];

    expect(miss?.kind === "missed" && miss.failure.note).toBe("Guest exit 1");
    expect(JSON.stringify(result)).not.toContain("sk-guest-secret");
  });

  it("refuses an oversized reply with a fixed message", async () => {
    const result = await window(await box({ stdout: guestText, truncated: true }));
    const miss = result.heartbeats[0];

    expect(miss?.kind === "missed" && miss.failure.note).toBe(
      "Guest probe output exceeded 4096 bytes",
    );
    expect(JSON.stringify(result)).not.toContain("sk-guest-secret");
  });

  it("keeps a typed lifecycle error from the SDK", async () => {
    const gone = new SandboxError("Sandbox gone", { provider: "memory", code: "not_found" });
    const result = await window(await box(gone));
    const miss = result.heartbeats[0];

    expect(miss?.kind === "missed" && miss.failure.code).toBe("not_found");
  });
});
