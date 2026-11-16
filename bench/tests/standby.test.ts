import { describe, expect, test } from "vitest";
import { longestGapMs, tickerStarted } from "../src/standby.js";

describe("standby evidence", () => {
  test("the longest gap counts only ticks from the idle start", () => {
    const ticks = ["100", "100", "101", "140", "141", "158", "159", ""].join("\n");

    expect(longestGapMs(ticks, 141)).toBe(17_000);
    expect(longestGapMs(ticks, 100)).toBe(39_000);
  });

  test("fewer than two ticks give no gap", () => {
    expect(longestGapMs("", 0)).toBe(0);
    expect(longestGapMs("5\n", 0)).toBe(0);
  });

  test("the ticker's output gives its PID and start time", () => {
    expect(tickerStarted("4242\n1763337600\n")).toEqual({ pid: 4242, startedAtS: 1763337600 });
    expect(() => tickerStarted("sh: date: not found")).toThrow("did not start");
  });
});
