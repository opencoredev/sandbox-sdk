/**
 * Pause and resume for providers with no pause call, whose sandboxes go on standby by themselves
 * once they stop receiving requests and resume on the next one.
 *
 * Baseten (https://docs.baseten.co/sandboxes/lifecycle): a sandbox on standby keeps its memory,
 * files and processes, and still reports DEPLOYED, so standby cannot be read from the API. A
 * background ticker inside the sandbox proves it instead. Each tick records two clocks: the wall
 * clock (whole seconds; BusyBox `date` has no sub-second format) and `/proc/uptime` (10 ms). On
 * standby the VM is suspended: the ticker stops, and uptime stops with it, while the wall clock
 * jumps ahead on wake. Measured 2026-11-16: ticks stop 14-15 s after the last request, and across
 * a 15 s wall-clock gap uptime advanced 0.2 s, one tick's worth.
 *
 * "Pause" is then waiting without requests, which takes no call and is not timed. "Resume" is the
 * first request after standby, timed like the other providers' resume-to-first-command.
 */
export interface AutoStandby {
  /** How long the scenario sends no requests: about twice the observed delay before standby. */
  readonly idleMs: number;
  /** The smallest wall-clock gap in the ticks that counts as standby. */
  readonly minGapMs: number;
}

export const autoStandby: ReadonlyMap<string, AutoStandby> = new Map([
  ["baseten", { idleMs: 30_000, minGapMs: 5_000 }],
]);

const tickFile = "/tmp/.bench-standby-ticks";

/** Uptime may advance this much across a standby gap: a tick's sleep and its own work. */
const suspendedUptimeMs = 1_000;

/**
 * Starts the ticker and prints its PID, then the guest's wall clock in seconds. Each tick is a
 * line `<wall-clock seconds> <uptime seconds>`.
 */
export const startTicker =
  `rm -f ${tickFile}; nohup sh -c 'while :; do read u r < /proc/uptime; ` +
  `echo "$(date +%s) $u" >> ${tickFile}; sleep 0.2; done' >/dev/null 2>&1 & echo $!; date +%s`;

/**
 * The timed resume request: prints how many ticks were written and the guest's uptime when it
 * ran. It is the first request after the idle wait, so it is what wakes the sandbox, and its
 * output shows how long the sandbox had been awake when it ran. `wc` and `read` on a few hundred
 * short lines cost about what `true` does.
 */
export const countTicks = `wc -l < ${tickFile}; read u r < /proc/uptime; echo $u`;

/**
 * Lets the resumed ticker write at least one more tick, then prints the guest's wall clock, stops
 * the ticker and prints its ticks.
 */
export const stopTicker = (pid: number) =>
  `sleep 0.5; date +%s; kill ${pid} 2>/dev/null; cat ${tickFile}; rm -f ${tickFile}`;

/** Waits `ms` without touching the sandbox; rejects when `signal` aborts. */
export function idle(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    function stop() {
      clearTimeout(timer);
      reject(signal.reason);
    }

    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The ticker `startTicker` started. */
export interface Ticker {
  readonly pid: number;
  /** The guest's wall clock when it started, in seconds. */
  readonly startedAtS: number;
}

/** Parses `startTicker`'s output. */
export function tickerStarted(output: string): Ticker {
  const [pid, startedAtS] = output.trim().split(/\s+/).map(Number);

  if (pid === undefined || startedAtS === undefined)
    throw new Error("Standby ticker did not start");

  if (!Number.isInteger(pid) || !Number.isFinite(startedAtS))
    throw new Error("Standby ticker did not start");

  return { pid, startedAtS };
}

/** What `standbyGap` checks. */
export interface StandbyReading {
  /** `stopTicker`'s output. */
  readonly output: string;
  readonly ticker: Ticker;
  /** Host time from the ticker's start until `stopTicker` returned. */
  readonly hostElapsedMs: number;
  /** `countTicks`'s output: the ticks written, and the guest's uptime, when the request ran. */
  readonly atRequest: string;
  /** Host time from sending the timed request to its result. */
  readonly requestMs: number;
  readonly minGapMs: number;
}

/** What proved standby, kept on the sample so a later rule can be checked against it. */
export interface StandbyEvidence {
  /** The wall-clock gap the request ended. */
  readonly gapMs: number;
  /** Uptime across that gap: near zero for a suspended VM. */
  readonly gapUptimeMs: number;
  /** Guest uptime from the first tick after the gap to the request's own reading. */
  readonly awakeBeforeRequestMs: number;
}

/** One tick: wall-clock seconds and uptime seconds. */
interface Tick {
  readonly wallS: number;
  readonly uptimeS: number;
}

function parseTick(line: string): Tick | undefined {
  const [wall, uptime, extra] = line.trim().split(/\s+/);
  const wallS = Number(wall);
  const uptimeS = Number(uptime);

  return extra === undefined && Number.isFinite(wallS) && Number.isFinite(uptimeS)
    ? { wallS, uptimeS }
    : undefined;
}

/**
 * The standby the timed request woke, or why the ticks do not prove it.
 *
 * Proof needs all of:
 * - The guest wall clock advanced as much as the host's (within 2 s): no clock step.
 * - The gap the request ended is at least `minGapMs` of wall clock. That gap is the longest
 *   among those that ended by the request's count (the first tick after the count may close it),
 *   so a later standby, before the stop command, is never mistaken for it.
 * - Uptime advanced at most 1 s across it: the VM was suspended, not just slow to schedule.
 * - The sandbox was awake, by uptime, no longer before the request's own reading than the
 *   request took from the host's send to its result. A sandbox woken by anything earlier than
 *   this request was awake longer. Uptime is precise to 10 ms and needs no host offset.
 */
export function standbyGap(reading: StandbyReading): StandbyEvidence | { refused: string } {
  const { ticker } = reading;
  const [first, ...rest] = reading.output.trim().split("\n");
  const afterS = Number(first);

  if (first === undefined || first === "" || !Number.isFinite(afterS))
    return { refused: "the ticker's output has no clock reading" };

  const guestElapsedMs = (afterS - ticker.startedAtS) * 1000;

  if (Math.abs(guestElapsedMs - reading.hostElapsedMs) > 2000)
    return {
      refused: `the guest clock moved ${guestElapsedMs} ms while ${Math.round(reading.hostElapsedMs)} ms passed`,
    };

  const [countLine, uptimeLine, extra] = reading.atRequest.trim().split("\n");
  const count = Number(countLine);
  const requestUptimeS = Number(uptimeLine);

  if (
    extra !== undefined ||
    countLine === undefined ||
    !Number.isInteger(count) ||
    uptimeLine === undefined ||
    !Number.isFinite(requestUptimeS)
  )
    return { refused: "the timed request did not report its count and uptime" };

  const ticks = rest.map(parseTick);

  if (ticks.some((t) => t === undefined || t.wallS < ticker.startedAtS))
    return { refused: "the ticks are not all readings from this ticker" };

  const times = ticks.filter((t): t is Tick => t !== undefined);

  if (count > times.length) return { refused: "the ticks were cut short after the request" };

  // Gaps ending at or before index `count`: the request ran after the ticks before `count`, so
  // the tick at `count` (if any) is the first it could have woken.
  let end = -1;
  let gapMs = 0;

  for (const [i, tick] of times.entries()) {
    const previous = times[i - 1];

    if (i > count) break;

    if (previous !== undefined && (tick.wallS - previous.wallS) * 1000 > gapMs) {
      gapMs = (tick.wallS - previous.wallS) * 1000;
      end = i;
    }
  }

  const closing = times[end];
  const opening = times[end - 1];

  if (gapMs < reading.minGapMs || closing === undefined || opening === undefined)
    return {
      refused: `no pause of ${reading.minGapMs} ms ended at the timed request (longest ${gapMs} ms)`,
    };

  const gapUptimeMs = Math.round((closing.uptimeS - opening.uptimeS) * 1000);

  if (gapUptimeMs > suspendedUptimeMs)
    return {
      refused: `uptime advanced ${gapUptimeMs} ms across the ${gapMs} ms pause: a stall, not a suspension`,
    };

  // No tick after the gap before the count: the request ran before the first one, so it found
  // the sandbox asleep.
  const awakeBeforeRequestMs =
    end === count ? 0 : Math.round((requestUptimeS - closing.uptimeS) * 1000);

  if (awakeBeforeRequestMs < 0)
    return { refused: "the request's uptime is earlier than the tick it followed" };

  if (awakeBeforeRequestMs > reading.requestMs)
    return {
      refused: `the sandbox woke before the timed request: awake ${awakeBeforeRequestMs} ms when it ran, which took ${Math.round(reading.requestMs)} ms`,
    };

  return { gapMs, gapUptimeMs, awakeBeforeRequestMs };
}
