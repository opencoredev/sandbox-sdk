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
 * Lets the resumed ticker write at least one tick, then prints the guest's clock, stops the
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

/**
 * The standby gap, in ms, from `stopTicker`'s output, or why the ticks do not prove standby.
 *
 * Proof needs all of: the guest clock advanced as much as the host's (within 2 s), so a clock
 * step cannot pose as a gap; the longest gap since the ticker started is at least `minGapMs`; and
 * it ends at the resume (within 2 s of the clock read just after it), so a stall early in the idle
 * wait, with ticks continuing until the timed request, does not count. Ticks are whole seconds.
 */
export function standbyGap(
  output: string,
  ticker: Ticker,
  hostElapsedMs: number,
  minGapMs: number,
): { gapMs: number } | { refused: string } {
  const [first, ...rest] = output.trim().split("\n");
  const afterS = Number(first);

  if (first === undefined || first === "" || !Number.isFinite(afterS))
    return { refused: "the ticker's output has no clock reading" };

  const guestElapsedMs = (afterS - ticker.startedAtS) * 1000;

  if (Math.abs(guestElapsedMs - hostElapsedMs) > 2000)
    return {
      refused: `the guest clock moved ${guestElapsedMs} ms while ${Math.round(hostElapsedMs)} ms passed`,
    };

  const times = rest.map(Number).filter((t) => Number.isFinite(t) && t >= ticker.startedAtS);

  let gapMs = 0;
  let endS = Number.NaN;

  for (const [i, time] of times.entries()) {
    const previous = times[i - 1];

    if (previous !== undefined && (time - previous) * 1000 > gapMs) {
      gapMs = (time - previous) * 1000;
      endS = time;
    }
  }

  if (gapMs < minGapMs) return { refused: `the longest pause in the ticks was ${gapMs} ms` };

  if (afterS - endS > 2)
    return { refused: `the ${gapMs} ms pause in the ticks ended before the resume` };

  return { gapMs };
}
