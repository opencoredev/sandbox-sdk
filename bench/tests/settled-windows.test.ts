import { describe, expect, it } from "vitest";
import {
  boxdPeriod,
  boxdWindow,
  e2bWindow,
  type BoxdBucket,
  type E2bEvent,
  type E2bHour,
  type RunAttempt,
} from "../src/cost/settled-windows.js";

const at = (s: string) => Date.parse(s);

const attempt = (id: string, sandbox: string | null, start: string, end: string): RunAttempt => ({
  attemptId: id,
  sandboxIds: sandbox === null ? [] : [sandbox],
  startedAt: at(start),
  endedAt: at(end),
  deletionConfirmed: true,
});

describe("boxdWindow", () => {
  // Two machines in 17:00 and 17:15, deleted at 17:20; nothing at 16:45 or 17:30.
  const attempts = [
    attempt("a", "m-a", "2026-11-16T17:01:00Z", "2026-11-16T17:10:00Z"),
    attempt("b", "m-b", "2026-11-16T17:09:00Z", "2026-11-16T17:20:00Z"),
    attempt("skip", null, "2026-11-16T17:00:30Z", "2026-11-16T17:00:30Z"),
  ];

  const bucket = (start: string, machines: BoxdBucket["machines"]): BoxdBucket => ({
    start: at(start),
    complete: true,
    machines,
  });

  const buckets = [
    bucket("2026-11-16T16:45:00Z", []),
    bucket("2026-11-16T17:00:00Z", [
      { machineId: "m-a", micro: 4000 },
      { machineId: "m-b", micro: 1000 },
    ]),
    bucket("2026-11-16T17:15:00Z", [{ machineId: "m-b", micro: 2000 }]),
    bucket("2026-11-16T17:30:00Z", [{ machineId: "deleted-long-ago", micro: 0 }]),
  ];

  const ledger = [
    { kind: "usage_charge", amountMicro: -5010, createdAt: at("2026-11-16T17:27:00Z") },
    { kind: "usage_charge", amountMicro: -2004, createdAt: at("2026-11-16T17:42:00Z") },
  ];

  const readAt = at("2026-11-16T18:10:00Z");

  it("covers the buckets from the first create through the one the last delete lands in", () => {
    expect(boxdPeriod(attempts)).toEqual({
      start: at("2026-11-16T17:00:00Z"),
      end: at("2026-11-16T17:30:00Z"),
    });
    // A delete in a bucket's last minute is still metered in the next one.
    expect(
      boxdPeriod([attempt("x", "m", "2026-11-16T17:01:00Z", "2026-11-16T17:29:30Z")]).end,
    ).toBe(at("2026-11-16T17:45:00Z"));
  });

  it("sums the posted charges when only the run's machines are metered, with empty buckets on both sides", () => {
    const window = boxdWindow({ attempts, buckets, ledger, readAt });

    expect(window).toMatchObject({
      kind: "isolated",
      period: { start: "2026-11-16T17:00:00.000Z", end: "2026-11-16T17:30:00.000Z" },
    });

    if (window.kind === "isolated") expect(window.settledUSD).toBeCloseTo(0.007014, 9);
  });

  it("refuses a window another machine was metered in, as cb2627ec was on 2026-11-16", () => {
    const woken = buckets.map((b, i) =>
      i === 1 ? { ...b, machines: [...b.machines, { machineId: "cb2627ec", micro: 905 }] } : b,
    );

    const window = boxdWindow({ attempts, buckets: woken, ledger, readAt });

    expect(window.kind).toBe("not-isolated");

    if (window.kind === "not-isolated")
      expect(window.reasons).toContain(
        "machine cb2627ec, not the run's, was metered in 2026-11-16T17:00:00.000Z",
      );
  });

  it("refuses usage or a charge in the buckets on either side, an unread or open bucket, and an early read", () => {
    const busyBefore = buckets.map((b, i) =>
      i === 0 ? { ...b, machines: [{ machineId: "m-a", micro: 1 }] } : b,
    );

    const cases = [
      boxdWindow({ attempts, buckets: busyBefore, ledger, readAt }),
      boxdWindow({
        attempts,
        buckets,
        ledger: [
          ...ledger,
          { kind: "usage_charge", amountMicro: -3, createdAt: at("2026-11-16T17:57:00Z") },
        ],
        readAt,
      }),
      boxdWindow({ attempts, buckets: buckets.slice(0, 3), ledger, readAt }),
      boxdWindow({
        attempts,
        buckets: buckets.map((b, i) => (i === 2 ? { ...b, complete: false } : b)),
        ledger,
        readAt,
      }),
      boxdWindow({ attempts, buckets, ledger, readAt: at("2026-11-16T17:59:00Z") }),
      boxdWindow({
        attempts: attempts.map((a) => ({ ...a, deletionConfirmed: a.attemptId !== "b" })),
        buckets,
        ledger,
        readAt,
      }),
    ];

    expect(cases.map((c) => c.kind)).toEqual(Array(cases.length).fill("not-isolated"));
  });

  it("refuses a machine of the run that usage doesn't show", () => {
    const missing = buckets.map((b) => ({
      ...b,
      machines: b.machines.filter((m) => m.machineId !== "m-b"),
    }));

    expect(boxdWindow({ attempts, buckets: missing, ledger, readAt }).kind).toBe("not-isolated");
  });

  it("ignores buckets far from the run but reports any non-usage ledger entry near it", () => {
    const window = boxdWindow({
      attempts,
      buckets: [...buckets, bucket("2026-11-16T19:00:00Z", [{ machineId: "later", micro: 50 }])],
      ledger: [
        ...ledger,
        { kind: "credit_grant", amountMicro: 1_000_000, createdAt: at("2026-11-16T17:30:00Z") },
      ],
      readAt,
    });

    expect(window.kind).toBe("not-isolated");

    if (window.kind === "not-isolated") expect(window.reasons).toHaveLength(1);
  });
});

describe("e2bWindow", () => {
  // Two sandboxes ended in 17:00 and 18:00; hours 16:00 and 19:00 are empty.
  const attempts = [
    attempt("a", "s-a", "2026-11-16T17:05:00Z", "2026-11-16T17:20:00Z"),
    attempt("b", "s-b", "2026-11-16T17:50:00Z", "2026-11-16T18:10:00Z"),
  ];

  const event = (sandboxId: string, type: string, time: string): E2bEvent => ({
    sandboxId,
    type: `sandbox.lifecycle.${type}`,
    timestamp: at(time),
  });

  const events = [
    event("s-a", "created", "2026-11-16T17:05:01Z"),
    event("s-a", "killed", "2026-11-16T17:20:00Z"),
    event("s-b", "created", "2026-11-16T17:50:01Z"),
    event("s-b", "killed", "2026-11-16T18:10:00Z"),
    event("old", "killed", "2026-11-10T19:11:40Z"),
  ];

  const hour = (start: string, sandboxCount: number, usd: number): E2bHour => ({
    start: at(start),
    sandboxCount,
    usd,
  });

  const hours = [hour("2026-11-16T17:00:00Z", 1, 0.02), hour("2026-11-16T18:00:00Z", 1, 0.03)];

  const base = {
    attempts,
    hours,
    hoursRecheck: hours,
    recheckGapMs: 45 * 60_000,
    events,
    eventsComplete: true,
  };

  it("sums the console's hours when the team's events name only the run's sandboxes", () => {
    const window = e2bWindow(base);

    expect(window).toMatchObject({
      kind: "isolated",
      period: { start: "2026-11-16T17:00:00.000Z", end: "2026-11-16T19:00:00.000Z" },
    });

    if (window.kind === "isolated") expect(window.settledUSD).toBeCloseTo(0.05, 12);
  });

  it("refuses a window holding another sandbox, as rw-held1's did at 22:03 on 2026-11-05", () => {
    const window = e2bWindow({
      ...base,
      events: [...events, event("io4d8", "killed", "2026-11-16T17:03:31Z")],
      hours: [
        hour("2026-11-16T17:00:00Z", 2, 0.0213),
        hours[1] ?? hour("2026-11-16T18:00:00Z", 1, 0.03),
      ],
    });

    expect(window.kind).toBe("not-isolated");

    if (window.kind === "not-isolated") {
      expect(window.reasons.some((r) => r.startsWith("sandbox io4d8, not the run's"))).toBe(true);
      expect(window.reasons.some((r) => r.startsWith("the console counts 2 sandboxes"))).toBe(true);
    }
  });

  it("refuses usage in the hour on either side, a moving figure, an early recheck and a partial event list", () => {
    const moved = [hour("2026-11-16T17:00:00Z", 1, 0.02), hour("2026-11-16T18:00:00Z", 1, 0.031)];

    const cases = [
      e2bWindow({ ...base, hours: [hour("2026-11-16T16:00:00Z", 1, 0.001), ...hours] }),
      e2bWindow({ ...base, hours: [...hours, hour("2026-11-16T19:00:00Z", 1, 0.001)] }),
      e2bWindow({ ...base, hoursRecheck: moved }),
      e2bWindow({ ...base, recheckGapMs: 10 * 60_000 }),
      e2bWindow({ ...base, eventsComplete: false }),
      e2bWindow({
        ...base,
        events: events.filter(
          (e) => e.type !== "sandbox.lifecycle.killed" || e.sandboxId !== "s-b",
        ),
      }),
    ];

    expect(cases.map((c) => c.kind)).toEqual(Array(cases.length).fill("not-isolated"));
  });

  it("books a paused segment in the hour it ended", () => {
    const paused = [...events, event("s-a", "paused", "2026-11-16T18:05:00Z")];

    const window = e2bWindow({
      ...base,
      events: paused,
      hours: [hour("2026-11-16T17:00:00Z", 1, 0.02), hour("2026-11-16T18:00:00Z", 2, 0.03)],
      hoursRecheck: [hour("2026-11-16T17:00:00Z", 1, 0.02), hour("2026-11-16T18:00:00Z", 2, 0.03)],
    });

    expect(window.kind).toBe("isolated");
  });
});
