export class PhaseClock {
  excludedMs = 0;
  start: number | null = null;
  end: number | null = null;
  startedAt: string | null = null;
  finishedAt: string | null = null;
  begin() {
    this.start = performance.now();
    this.startedAt = new Date().toISOString();
  }
  finish() {
    this.end = performance.now();
    this.finishedAt = new Date().toISOString();
  }
  elapsed() {
    return this.start === null
      ? null
      : (this.end ?? performance.now()) - this.start - this.excludedMs;
  }
}

/** The unit each guest performance metric is reported in. */
interface MetricUnits {
  readonly [metric: string]: string;
}

export const perfMetrics: MetricUnits = {
  "cpu-single": "iterations/s",
  "cpu-all": "iterations/s",
  "memory-mbps": "MB/s",
  "disk-write-mbps": "MB/s",
  "disk-read-mbps": "MB/s",
  "disk-4k-write-iops": "IOPS",
  "disk-4k-read-iops": "IOPS",
  "network-mbps": "MB/s",
  "tcp-ms": "ms",
};

// Prepared once before any scenario timers or provider scheduling begin.
export const filePayloads = new Map(
  [1024, 10 * 1024 * 1024].map((size) => {
    const data = Buffer.allocUnsafe(size);

    for (let i = 0; i < size; i++) data[i] = i % 251;

    return [size, data];
  }),
);

export async function firstByteAttempt(
  preview: { url: string; headers?: Record<string, string> },
  signal: AbortSignal,
  clock: PhaseClock,
  trackCleanup: (work: Promise<void>) => void,
) {
  clock.begin();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  try {
    const response = await fetch(preview.url, { headers: preview.headers, signal });
    reader = response.body?.getReader();
    const first = await reader?.read();
    clock.finish();

    if (!response.ok || !first || first.done || !first.value.byteLength)
      throw new Error(`Preview HTTP ${response.status}, no first byte`);
  } finally {
    if (clock.end === null) clock.finish();

    if (reader) trackCleanup(reader.cancel().catch(() => {}));
  }
}
