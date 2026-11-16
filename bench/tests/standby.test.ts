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
  test("a gap from the standby to the resume proves standby", () => {
    const ticks = [...ticking(100, 115), ...ticking(131, 131)];

    expect(standbyGap(output(131, ticks), ticker, 31_200, 5_000)).toEqual({ gapMs: 16_000 });
  });

  test("a stall early in the idle wait, ticking on until the resume, proves nothing", () => {
    const ticks = [...ticking(100, 102), ...ticking(108, 131)];

    expect(standbyGap(output(131, ticks), ticker, 31_200, 5_000)).toMatchObject({
      refused: expect.stringContaining("ended before the resume"),
    });
  });

  test("a guest clock step is refused, whatever the ticks show", () => {
    const ticks = [...ticking(100, 115), ...ticking(160, 160)];

    expect(standbyGap(output(160, ticks), ticker, 31_200, 5_000)).toMatchObject({
      refused: expect.stringContaining("guest clock moved"),
    });
  });

  test("no tick after the resume leaves the gap unproven", () => {
    expect(standbyGap(output(131, ticking(100, 115)), ticker, 31_200, 5_000)).toMatchObject({
      refused: expect.stringContaining("longest pause"),
    });
  });

  test("output without a clock reading is refused", () => {
    expect(standbyGap("", ticker, 31_200, 5_000)).toMatchObject({
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
