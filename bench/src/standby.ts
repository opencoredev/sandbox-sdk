/**
 * Pause and resume for providers with no pause call, whose sandboxes go on standby by themselves
 * once they stop receiving requests and resume on the next one.
 *
 * Baseten (https://docs.baseten.co/sandboxes/lifecycle): a sandbox on standby keeps its memory,
 * files and processes, and still reports DEPLOYED, so standby cannot be read from the API. A
 * background ticker inside the sandbox proves it instead: while the sandbox is suspended the
 * ticker stops, leaving a gap in its timestamps. Measured 2026-11-16: the ticks stop 14-15 s after
 * the last request, and the first command after standby takes 112-131 ms against 83-86 ms warm.
 *
 * "Pause" is then waiting without requests, which takes no call and is not timed. "Resume" is the
 * first command after standby, timed like the other providers' resume-to-first-command.
 */
export interface AutoStandby {
  /** How long the scenario sends no requests: about twice the observed delay before standby. */
  readonly idleMs: number;
  /** The smallest gap in the ticks that counts as proof of standby. */
  readonly minGapMs: number;
}

export const autoStandby: ReadonlyMap<string, AutoStandby> = new Map([
  ["baseten", { idleMs: 30_000, minGapMs: 5_000 }],
]);

const tickFile = "/tmp/.bench-standby-ticks";

/**
 * Starts the ticker and prints its PID, then the guest's clock in seconds. Wall-clock seconds,
 * since a suspended VM's uptime may not advance; BusyBox `date` has no sub-second format.
 */
export const startTicker =
  `rm -f ${tickFile}; nohup sh -c 'while :; do date +%s >> ${tickFile}; sleep 0.2; done' ` +
  `>/dev/null 2>&1 & echo $!; date +%s`;

/**
 * The timed resume request: counts the ticks written so far. It is the first request after the
 * idle wait, so it is what wakes the sandbox, and its own output shows whether the ticker had
 * already resumed before it ran. `wc` on a few hundred short lines costs about what `true` does.
 */
export const countTicks = `wc -l < ${tickFile}`;

/**
 * Lets the resumed ticker write at least one more tick, then prints the guest's clock, stops the
 * ticker and prints its ticks.
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
  /** The guest's clock when it started, in seconds. */
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
  /** `countTicks`'s output: the ticks written when the timed request ran. */
  readonly ticksAtRequest: string;
  /** Host time from sending the timed request to its result. */
  readonly requestMs: number;
  readonly minGapMs: number;
}

/** The ticker's period: consecutive ticks are at least this far apart (`sleep 0.2`). */
const tickMs = 200;

/**
 * The standby gap, in ms, or why the ticks do not prove standby.
 *
 * Proof needs all of: the guest clock advanced as much as the host's (within 2 s), so a clock
 * step cannot pose as a gap; the longest gap since the ticker started is at least `minGapMs`; it
 * ended no earlier than the timed request's count, so it is not a later gap; and the sandbox woke
 * no earlier than the timed request was sent. For the last: the frozen ticker writes again only
 * once the sandbox wakes, then at most one tick per 200 ms, so k ticks after the gap when the
 * request counted them took at least (k - 1) x 200 ms awake. The request woke it only if that fits
 * within the request's own duration; a sandbox woken earlier ticks for longer. Tick counts and the
 * host's request time decide it, not the guest clock's whole seconds or its offset from the host.
 */
export function standbyGap(
  reading: StandbyReading,
): { gapMs: number; ticksAfterGap: number } | { refused: string } {
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

  const counted = reading.ticksAtRequest.trim();
  const atRequest = Number(counted);

  if (counted === "" || !Number.isInteger(atRequest))
    return { refused: "the timed request did not count the ticks" };

  // Every line, in file order, so indexes match the count the request took.
  const times = rest.map(Number);

  if (times.some((t) => !Number.isFinite(t) || t < ticker.startedAtS))
    return { refused: "the ticks are not all readings from this ticker" };

  let gapMs = 0;
  let end = -1;

  for (const [i, time] of times.entries()) {
    const previous = times[i - 1];

    if (previous !== undefined && (time - previous) * 1000 > gapMs) {
      gapMs = (time - previous) * 1000;
      end = i;
    }
  }

  if (gapMs < reading.minGapMs)
    return { refused: `the longest pause in the ticks was ${gapMs} ms` };

  // Ticks after the gap when the request counted them; negative means the gap came later.
  const after = atRequest - end;

  if (after < 0)
    return { refused: `the ${gapMs} ms pause in the ticks began after the timed request` };

  const awakeAtLeastMs = Math.max(0, after - 1) * tickMs;

  if (awakeAtLeastMs > reading.requestMs)
    return {
      refused: `the sandbox woke before the timed request: ${after} ticks after the ${gapMs} ms pause need ${awakeAtLeastMs} ms awake, the request took ${Math.round(reading.requestMs)} ms`,
    };

  if (atRequest > times.length) return { refused: "the ticks were cut short after the request" };

  return { gapMs, ticksAfterGap: after };
}
