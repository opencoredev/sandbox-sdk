import { describe, expect, test } from "vitest";
import { standbyGap, tickerStarted } from "../src/standby.js";
import { pauseSplit, standbyResume } from "../src/site-data.js";

const ticker = { pid: 7, startedAtS: 100 };

/** `stopTicker` output: the clock read after the resume, then the ticks. */
const output = (afterS: number, ticks: number[]) => [afterS, ...ticks].join("\n");

/** Ticks five times a second, whole seconds as BusyBox `date +%s` prints them. */
const ticking = (fromS: number, toS: number) =>
  Array.from({ length: (toS - fromS) * 5 + 1 }, (_, i) => fromS + Math.floor(i / 5));

describe("standby evidence", () => {
  /**
   * A reading taken 31.2 s after the ticker started. `atRequest` is how many ticks the timed
   * request counted when it ran.
   */
  const reading = (afterS: number, ticks: number[], atRequest: number) => ({
    output: output(afterS, ticks),
    ticker,
    hostElapsedMs: 31_200,
    ticksAtRequest: `${atRequest}\n`,
    minGapMs: 5_000,
  });

  const asleep = ticking(100, 115);

  test("a request that found the ticker frozen proves standby", () => {
    // 76 ticks before the gap, then the overdue tick as the sandbox woke, then the request.
    const ticks = [...asleep, 130, 130, 130, 131, 131];

    expect(standbyGap(reading(131, ticks, asleep.length + 1))).toEqual({ gapMs: 15_000 });
  });

  test("a request that found the ticker running again is refused", () => {
    // The review's cases: ticks resumed at 129 and the request ran at 130.5.
    const ticks = [...asleep, 129, 129, 130, 130, 131];

    expect(standbyGap(reading(131, ticks, asleep.length + 4))).toMatchObject({
      refused: expect.stringContaining("had resumed before the timed request"),
    });
  });

  test("however slow the stop command, the count the request took decides", () => {
    const ticks = [...asleep, ...ticking(129, 133)];

    expect(standbyGap(reading(133, ticks, asleep.length + 6))).toMatchObject({
      refused: expect.stringContaining("had resumed before the timed request"),
    });
    expect(standbyGap(reading(133, ticks, asleep.length + 1))).toEqual({ gapMs: 14_000 });
  });

  test("a stall early in the idle wait, ticking on until the resume, proves nothing", () => {
    const ticks = [...ticking(100, 102), ...ticking(108, 131)];

    expect(standbyGap(reading(131, ticks, ticks.length - 1))).toMatchObject({
      refused: expect.stringContaining("had resumed before the timed request"),
    });
  });

  test("a guest clock step is refused, whatever the ticks show", () => {
    const ticks = [...asleep, 160, 160];

    expect(standbyGap(reading(160, ticks, asleep.length + 1))).toMatchObject({
      refused: expect.stringContaining("guest clock moved"),
    });
  });

  test("no tick after the resume leaves the gap unproven", () => {
    expect(standbyGap(reading(131, asleep, asleep.length))).toMatchObject({
      refused: expect.stringContaining("longest pause"),
    });
  });

  test("a missing count or clock reading is refused", () => {
    const ticks = [...asleep, 130, 131];

    expect(standbyGap({ ...reading(131, ticks, 0), ticksAtRequest: "" })).toMatchObject({
      refused: expect.stringContaining("did not count the ticks"),
    });
    expect(standbyGap({ ...reading(131, ticks, 0), output: "" })).toMatchObject({
      refused: expect.stringContaining("no clock reading"),
    });
  });

  test("the ticker's output gives its PID and start time", () => {
    expect(tickerStarted("4242\n1763337600\n")).toEqual({ pid: 4242, startedAtS: 1763337600 });
    expect(() => tickerStarted("sh: date: not found")).toThrow("did not start");
  });
});

describe("standby in site data", () => {
  const sample = (phases: Record<string, number>) => ({
    provider: "baseten",
    scenario: "pause-resume",
    outcome: { kind: "sample" as const, value: phases.resumeReadyMs ?? 0 },
    phases,
  });

  const samples = [
    sample({ resumeReadyMs: 300, standbyIdleMs: 30_000, standbyGapMs: 16_000 }),
    sample({ resumeReadyMs: 340, standbyIdleMs: 30_000, standbyGapMs: 15_000 }),
  ];

  test("a provider that pauses by idling has no pause split, only its standby resume", () => {
    expect(pauseSplit(samples, "baseten")).toBeNull();
    expect(standbyResume(samples, "baseten")).toMatchObject({ idleS: 30, n: 2 });
  });

  test("a provider with a pause call has no standby resume", () => {
    const called = [sample({ pauseMs: 900, resumeReturnedMs: 400, resumeReadyMs: 500 })];

    expect(standbyResume(called, "baseten")).toBeNull();
    expect(pauseSplit(called, "baseten")).toMatchObject({ pause: 0.9, resume: 0.5, n: 1 });
  });
});
