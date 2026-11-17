import { describe, expect, test } from "vitest";
import { standbyGap, tickerStarted } from "../src/standby.js";
import { pauseSplit, standbyResume } from "../src/site-data.js";

const ticker = { pid: 7, startedAtS: 100 };

type Tick = [wallS: number, uptimeS: number];

/** `stopTicker` output: the wall clock read after the resume, then the ticks. */
const output = (afterS: number, ticks: Tick[]) =>
  [afterS, ...ticks.map(([w, u]) => `${w} ${u.toFixed(2)}`)].join("\n");

/**
 * Five ticks a second from `fromUptime`, wall clock in whole seconds as BusyBox prints it, with
 * the wall clock `offsetS` ahead of uptime.
 */
const ticking = (fromUptime: number, toUptime: number, offsetS: number): Tick[] =>
  Array.from({ length: Math.round((toUptime - fromUptime) * 5) + 1 }, (_, i) => {
    const uptime = fromUptime + i * 0.2;

    return [Math.floor(uptime + offsetS), uptime];
  });

describe("standby evidence", () => {
  /**
   * A reading taken 31.2 s after the ticker started at wall clock 100 (uptime 10). The request
   * read `uptimeAtRequest` and took `requestMs` as the host saw it. (`_count`, the ticks written
   * when it ran, documents each case; the rule orders ticks by uptime instead.)
   */
  const reading = (
    afterS: number,
    ticks: Tick[],
    _count: number,
    uptimeAtRequest: number,
    requestMs = 220,
  ) => ({
    output: output(afterS, ticks),
    ticker,
    hostElapsedMs: 31_200,
    atRequest: `${uptimeAtRequest.toFixed(2)}\n`,
    requestMs,
    minGapMs: 5_000,
  });

  // Ticking from wall 100 / uptime 10 until suspended at uptime 25 (wall 115). On wake the wall
  // clock is 15 s further ahead (offset 105 instead of 90) and uptime goes on from 25.2.
  const asleep = ticking(10, 25, 90);
  const woken = (to: number) => ticking(25.2, to, 105);

  test("a request that woke a suspended sandbox proves standby", () => {
    const ticks = [...asleep, ...woken(26)];

    // The count ran before the first tick after the wake.
    expect(standbyGap(reading(131, ticks, asleep.length, 25.2))).toEqual({
      gapMs: 15_000,
      gapUptimeMs: 200,
      awakeBeforeRequestMs: 0,
    });
    // Or just after it: awake 40 ms when the 220 ms request ran.
    expect(standbyGap(reading(131, ticks, asleep.length + 1, 25.24))).toMatchObject({
      awakeBeforeRequestMs: 40,
    });
  });

  test("a slow command start after a real wake still proves standby", () => {
    // Woken at 25.2; three ticks before the command ran at 25.65, within its 520 ms.
    const ticks = [...asleep, ...woken(26)];

    expect(standbyGap(reading(131, ticks, asleep.length + 3, 25.65, 520))).toMatchObject({
      awakeBeforeRequestMs: 450,
    });
  });

  test("a sandbox woken before the timed request was sent is refused", () => {
    // The review's case: woken 300 ms before a 220 ms request, two ticks before its count.
    const ticks = [...asleep, ...woken(26)];

    expect(standbyGap(reading(131, ticks, asleep.length + 2, 25.54))).toMatchObject({
      refused: expect.stringContaining("woke before the timed request"),
    });
  });

  test("a later standby before the stop command does not hide the one the request ended", () => {
    // The review's case: the request ends the 115-130 gap, then the sandbox sleeps again and the
    // stop command wakes it 20 s later.
    const ticks = [...asleep, ...woken(40), ...ticking(40.2, 41, 125)];

    expect(
      standbyGap({ ...reading(166, ticks, asleep.length + 1, 25.24), hostElapsedMs: 66_200 }),
    ).toMatchObject({ gapMs: 15_000, awakeBeforeRequestMs: 40 });
  });

  test("a tick sampled before the suspension but appended after the wake changes nothing", () => {
    // The review's case: the ticker reads 115 / 25.20, the VM suspends before the append, and the
    // stale line lands after the wake, next to the fresh 130 / 25.42.
    const stale: Tick = [115, 25.2];
    const ticks = [...asleep, stale, ...ticking(25.4, 26, 105)];

    expect(standbyGap(reading(131, ticks, asleep.length, 25.21))).toMatchObject({
      gapMs: 15_000,
      awakeBeforeRequestMs: 0,
    });
  });

  test("a gap that began after the timed request is refused", () => {
    // A warm count at uptime 20, ticking on to 35, then a stop request wakes it 15 s later.
    const ticks = [...ticking(10, 35, 90), ...ticking(35.2, 36, 105)];

    expect(standbyGap({ ...reading(141, ticks, 51, 20.05), hostElapsedMs: 41_200 })).toMatchObject({
      refused: expect.stringContaining("no pause of 5000 ms ended"),
    });
  });

  test("a stall, where uptime runs on through the gap, is not a suspension", () => {
    const ticks = [...asleep, ...ticking(40, 41, 90)];

    expect(standbyGap(reading(131, ticks, asleep.length, 40.01))).toMatchObject({
      refused: expect.stringContaining("a stall, not a suspension"),
    });
  });

  test("a guest clock step is refused, whatever the ticks show", () => {
    const ticks = [...asleep, ...ticking(25.2, 26, 135)];

    expect(standbyGap(reading(161, ticks, asleep.length, 25.21))).toMatchObject({
      refused: expect.stringContaining("guest clock moved"),
    });
  });

  test("no tick after the resume leaves the gap unproven", () => {
    expect(standbyGap(reading(131, asleep, asleep.length, 25.21))).toMatchObject({
      refused: expect.stringContaining("no tick was sampled after the timed request"),
    });
  });

  test("a missing count or clock reading is refused", () => {
    const ticks = [...asleep, ...woken(26)];

    expect(standbyGap({ ...reading(131, ticks, 0, 0), atRequest: "" })).toMatchObject({
      refused: expect.stringContaining("did not report its uptime"),
    });
    expect(standbyGap({ ...reading(131, ticks, 0, 0), output: "" })).toMatchObject({
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
