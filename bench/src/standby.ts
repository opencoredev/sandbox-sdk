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
 * The timed resume request: prints the guest's uptime when it ran. It is the first request after
 * the idle wait, so it is what wakes the sandbox, and its reading shows how long the sandbox had
 * been awake when it ran. A shell `read` and `echo` cost about what `true` does.
 */
export const readUptime = "read u r < /proc/uptime; echo $u";

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
  /** `readUptime`'s output: the guest's uptime when the timed request ran. */
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
 * - The gap the request ended is at least `minGapMs` of wall clock. Uptime orders the ticks (it
 *   only moves forward, and one process writes them), so that gap is the longest among those
 *   closed at or before the first tick sampled after the request's uptime reading. A later
 *   standby, before the stop command, is never chosen, and a tick sampled before the suspension
 *   but appended after the wake does not shift anything.
 * - Uptime advanced at most 1 s across it: the VM was suspended, not just slow to schedule.
 * - The sandbox was awake, by uptime, no longer before the request's own reading than the
 *   request took from the host's send to its result.
 *
 * The last check assumes nothing but this scenario sends the sandbox requests during the idle
 * wait, which holds in the bench: something else waking it shortly before the request (up to the
 * request's duration, plus the ticker's lag after a wake) would pass. Each sample keeps the
 * evidence (standbyAwakeBeforeRequestMs and the gap's two clocks) so it can be checked.
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

  const uptimeLine = reading.atRequest.trim();
  const requestUptimeS = Number(uptimeLine);

  if (uptimeLine === "" || !Number.isFinite(requestUptimeS))
    return { refused: "the timed request did not report its uptime" };

  const ticks = rest.map(parseTick);

  if (ticks.some((t) => t === undefined || t.wallS < ticker.startedAtS))
    return { refused: "the ticks are not all readings from this ticker" };

  const times = ticks.filter((t): t is Tick => t !== undefined);

  // The first tick sampled after the request read uptime: the last that can close its gap.
  const firstAfter = times.findIndex((t) => t.uptimeS > requestUptimeS);

  if (firstAfter === -1) return { refused: "no tick was sampled after the timed request" };

  let end = -1;
  let gapMs = 0;

  for (const [i, tick] of times.entries()) {
    const previous = times[i - 1];

    if (i > firstAfter) break;

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

  // A gap closed by a tick sampled after the request: the request ran before any tick after the
  // wake, so it found the sandbox asleep.
  const awakeBeforeRequestMs = Math.max(0, Math.round((requestUptimeS - closing.uptimeS) * 1000));

  if (awakeBeforeRequestMs > reading.requestMs)
    return {
      refused: `the sandbox woke before the timed request: awake ${awakeBeforeRequestMs} ms when it ran, which took ${Math.round(reading.requestMs)} ms`,
    };

  return { gapMs, gapUptimeMs, awakeBeforeRequestMs };
}
