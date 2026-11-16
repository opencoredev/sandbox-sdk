import { describe, expect, it } from "vitest";
import {
  boxdPeriod,
  boxdWindow,
  e2bWindow,
  executions,
  type BoxdBucket,
  type E2bEvent,
  type E2bHour,
  type E2bReading,
  type RunAttempt,
  type SettledWindow,
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

  it("refuses a metered bucket whose charge hasn't posted, or posted twice", () => {
    const missing = boxdWindow({ attempts, buckets, ledger: ledger.slice(0, 1), readAt });

    const twice = boxdWindow({
      attempts,
      buckets,
      ledger: [
        ...ledger,
        { kind: "usage_charge", amountMicro: -1, createdAt: at("2026-11-16T17:44:00Z") },
      ],
      readAt,
    });

    expect(missing.kind === "not-isolated" ? missing.reasons : []).toEqual([
      "bucket 2026-11-16T17:15:00.000Z was metered but has 0 usage charges, not 1",
    ]);
    expect(twice.kind).toBe("not-isolated");
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

  const team = "team-1";

  // A paused or killed event carries the segment it closes: `ms` of 4 vCPU and 8 GiB.
  const event = (sandboxId: string, type: string, time: string, ms = 0): E2bEvent => ({
    sandboxId,
    teamId: team,
    type: `sandbox.lifecycle.${type}`,
    timestamp: at(time),
    execution:
      type === "paused" || type === "killed"
        ? { startedAt: null, executionMs: ms, vcpu: 4, memoryMb: 8192 }
        : null,
  });

  const events = [
    event("s-a", "created", "2026-11-16T17:05:01Z"),
    event("s-a", "killed", "2026-11-16T17:20:00Z", 899_000),
    event("s-b", "created", "2026-11-16T17:50:01Z"),
    event("s-b", "killed", "2026-11-16T18:10:00Z", 1_199_000),
    event("old", "created", "2026-11-10T19:11:00Z"),
    event("old", "killed", "2026-11-10T19:11:40Z", 40_000),
  ];

  const hour = (start: string, sandboxCount: number, usd: number, ms = 0): E2bHour => ({
    start: at(start),
    sandboxCount,
    cpuHours: (ms / 3_600_000) * 4,
    ramGibHours: (ms / 3_600_000) * 8,
    usd,
  });

  const hours = [
    hour("2026-11-16T17:00:00Z", 1, 0.02, 899_000),
    hour("2026-11-16T18:00:00Z", 1, 0.03, 1_199_000),
  ];

  const reading = (fetched: string, h: readonly E2bHour[] = hours): E2bReading => ({
    projectId: team,
    from: at("2026-11-16T16:00:00Z"),
    to: at(fetched),
    fetchedAt: at(fetched),
    hours: h,
  });

  const base = {
    attempts,
    events,
    eventsComplete: true,
    reading: reading("2026-11-16T20:05:00Z"),
    recheck: reading("2026-11-16T20:40:00Z"),
  };

  const reasonsOf = (w: SettledWindow) => (w.kind === "not-isolated" ? w.reasons : []);

  it("sums the console's hours when only the run's sandboxes executed", () => {
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
      events: [
        ...events,
        event("io4d8", "created", "2026-11-16T17:03:17Z"),
        event("io4d8", "killed", "2026-11-16T17:03:31Z"),
      ],
    });

    expect(reasonsOf(window).some((r) => r.startsWith("sandbox io4d8, not the run's"))).toBe(true);
  });

  it("refuses another sandbox executing across the whole window, with no event inside it", () => {
    const spanning = [
      ...events,
      event("long", "created", "2026-11-16T15:00:00Z"),
      event("long", "killed", "2026-11-16T21:00:00Z"),
    ];

    const open = [...events, event("open", "resumed", "2026-11-15T10:00:00Z")];

    expect(reasonsOf(e2bWindow({ ...base, events: spanning }))).toHaveLength(1);
    expect(reasonsOf(e2bWindow({ ...base, events: open }))).toHaveLength(1);

    // A sandbox paused before the window and never resumed was not executing in it.
    const paused = [
      ...events,
      event("parked", "created", "2026-10-29T20:20:21Z"),
      event("parked", "paused", "2026-10-29T20:20:36Z"),
    ];

    expect(e2bWindow({ ...base, events: paused }).kind).toBe("isolated");
  });

  it("refuses an hour the run ended a segment in that the console leaves out", () => {
    const short = [hours[0] ?? hour("2026-11-16T17:00:00Z", 1, 0.02, 899_000)];

    const window = e2bWindow({
      ...base,
      reading: reading("2026-11-16T20:05:00Z", short),
      recheck: reading("2026-11-16T20:40:00Z", short),
    });

    expect(reasonsOf(window)).toContain(
      "the console counts 0 sandboxes in 2026-11-16T18:00:00.000Z; the run ended segments of 1",
    );
  });

  it("refuses console readings of another team", () => {
    const window = e2bWindow({
      ...base,
      reading: { ...base.reading, projectId: "team-2" },
      recheck: { ...base.recheck, projectId: "team-2" },
    });

    expect(reasonsOf(window).filter((r) => r.includes("team-2"))).toHaveLength(2);
  });

  it("refuses usage on either side in either reading, a moving figure, short coverage, early or close readings, and a partial event list", () => {
    const moved = [
      hour("2026-11-16T17:00:00Z", 1, 0.02, 899_000),
      hour("2026-11-16T18:00:00Z", 1, 0.031, 1_199_000),
    ];

    const sideHour = [...hours, hour("2026-11-16T19:00:00Z", 1, 0.001)];

    const cases = [
      e2bWindow({
        ...base,
        reading: reading("2026-11-16T20:05:00Z", [
          hour("2026-11-16T16:00:00Z", 1, 0.001),
          ...hours,
        ]),
      }),
      e2bWindow({ ...base, recheck: reading("2026-11-16T20:40:00Z", sideHour) }),
      e2bWindow({ ...base, recheck: reading("2026-11-16T20:40:00Z", moved) }),
      e2bWindow({ ...base, reading: { ...base.reading, from: at("2026-11-16T17:00:00Z") } }),
      e2bWindow({
        ...base,
        reading: reading("2026-11-16T19:30:00Z"),
        recheck: reading("2026-11-16T20:10:00Z"),
      }),
      e2bWindow({ ...base, recheck: reading("2026-11-16T20:20:00Z") }),
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
    const paused = [
      ...events.filter((e) => e.sandboxId !== "s-a"),
      event("s-a", "created", "2026-11-16T17:05:01Z"),
      event("s-a", "paused", "2026-11-16T17:10:00Z", 299_000),
      event("s-a", "resumed", "2026-11-16T17:15:00Z"),
      event("s-a", "killed", "2026-11-16T18:05:00Z", 3_000_000),
    ];

    const both = [
      hour("2026-11-16T17:00:00Z", 1, 0.02, 299_000),
      hour("2026-11-16T18:00:00Z", 2, 0.03, 4_199_000),
    ];

    const window = e2bWindow({
      ...base,
      events: paused,
      reading: reading("2026-11-16T20:05:00Z", both),
      recheck: reading("2026-11-16T20:40:00Z", both),
    });

    expect(window.kind).toBe("isolated");
  });

  it("refuses an hour whose console quantities miss a segment the run ended then", () => {
    // Paused and killed in one hour: the console counts the sandbox once either way, so only the
    // quantities show that the second segment's charge hasn't posted.
    const twice = [
      ...events.filter((e) => e.sandboxId !== "s-a"),
      event("s-a", "created", "2026-11-16T17:05:01Z"),
      event("s-a", "paused", "2026-11-16T17:10:00Z", 299_000),
      event("s-a", "resumed", "2026-11-16T17:12:00Z"),
      event("s-a", "killed", "2026-11-16T17:20:00Z", 480_000),
    ];

    const partial = [hour("2026-11-16T17:00:00Z", 1, 0.02, 299_000), ...hours.slice(1)];

    const window = e2bWindow({
      ...base,
      events: twice,
      reading: reading("2026-11-16T20:05:00Z", partial),
      recheck: reading("2026-11-16T20:40:00Z", partial),
    });

    expect(reasonsOf(window).some((r) => r.startsWith("the console has"))).toBe(true);
  });

  it("refuses another sandbox whose history doesn't show when it began", () => {
    const updatedThenKilled = [
      ...events,
      event("late", "updated", "2026-11-16T17:10:00Z"),
      event("late", "killed", "2026-11-16T20:00:00Z", 1000),
    ];

    const updatedOnly = [...events, event("quiet", "updated", "2026-11-14T10:00:00Z")];

    expect(reasonsOf(e2bWindow({ ...base, events: updatedThenKilled }))).toHaveLength(1);
    expect(reasonsOf(e2bWindow({ ...base, events: updatedOnly }))).toHaveLength(1);
  });

  it("splits a sandbox's events into executions", () => {
    expect(
      executions([
        event("x", "paused", "2026-11-16T10:00:00Z"),
        event("x", "resumed", "2026-11-16T11:00:00Z"),
        event("x", "paused", "2026-11-16T12:00:00Z"),
        event("x", "resumed", "2026-11-16T13:00:00Z"),
      ]),
    ).toEqual([
      { start: -Infinity, end: at("2026-11-16T10:00:00Z") },
      { start: at("2026-11-16T11:00:00Z"), end: at("2026-11-16T12:00:00Z") },
      { start: at("2026-11-16T13:00:00Z"), end: Infinity },
    ]);
  });
});
