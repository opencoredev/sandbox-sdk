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

/** Stops the ticker and prints its ticks. */
export const stopTicker = (pid: number) =>
  `kill ${pid} 2>/dev/null; cat ${tickFile}; rm -f ${tickFile}`;

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

/** The longest gap, in ms, between consecutive ticks at or after `fromS`; 0 with fewer than two. */
export function longestGapMs(ticks: string, fromS: number): number {
  const times = ticks
    .split("\n")
    .map(Number)
    .filter((t) => Number.isFinite(t) && t >= fromS);

  let longest = 0;

  for (const [i, time] of times.entries()) {
    const previous = times[i - 1];

    if (previous !== undefined) longest = Math.max(longest, time - previous);
  }

  return longest * 1000;
}
