export class DeadlineError extends Error {}

/** All scenario races clear their timer. The signal also cancels APIs that support it. */
export async function deadline<T>(
  ms: number,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineError(`Scenario timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([Promise.resolve().then(() => action(controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export async function pool(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (next < count) {
        const index = next++;
        await task(index);
      }
    }),
  );
}

/** Track work separately from its deadline: racing a promise does not cancel it. */
export class PendingWork {
  private readonly pending = new Set<Promise<unknown>>();
  track<T>(task: Promise<T>): Promise<T> {
    this.pending.add(task);
    void task.then(
      () => this.pending.delete(task),
      () => this.pending.delete(task),
    );

    return task;
  }
  async drain(ms: number): Promise<boolean> {
    try {
      await deadline(ms, async () => {
        // Tasks may enqueue other tracked work while settling (e.g. late deletion).
        while (this.pending.size) await Promise.allSettled(this.pending);
      });

      return true;
    } catch {
      return false;
    }
  }
}

/** Retain the native delete promise across deadline races; never submit it twice while pending. */
export class DeletionWork {
  private readonly pending = new Map<string, Promise<void>>();
  start(provider: string, id: string, action: () => Promise<void>) {
    const key = JSON.stringify([provider, id]);
    const existing = this.pending.get(key);

    if (existing) return existing;
    const task = Promise.resolve().then(action);
    this.pending.set(key, task);

    const settled = () => {
      if (this.pending.get(key) === task) this.pending.delete(key);
    };

    void task.then(settled, settled);

    return task;
  }
  async wait(provider: string, id: string, budgetMs: number) {
    const task = this.pending.get(JSON.stringify([provider, id]));

    if (!task) return;

    try {
      await deadline(budgetMs, () => task);
    } catch {
      /* Exact lookup decides whether cleanup resolved. */
    }
  }
}

/** Releases every waiter together once `size` arrivals have been counted. */
export class Barrier {
  private arrived = 0;
  private release = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  /** `performance.now()` when the last arrival released the barrier. */
  releasedAt: number | null = null;
  constructor(private readonly size: number) {}
  arrive(): Promise<void> {
    if (++this.arrived === this.size) {
      this.releasedAt = performance.now();
      this.release();
    }

    return this.gate;
  }
}

/**
 * One cohort member's two waits: `ready` once every member is created (or failed), `done` once
 * every member has finished its work. Each counts this member once however often it is awaited,
 * so a member that fails early can still arrive at both from its cleanup path.
 */
export class CohortGates {
  private readyWait: Promise<void> | null = null;
  private doneWait: Promise<void> | null = null;
  constructor(
    private readonly readyBarrier: Barrier,
    private readonly doneBarrier: Barrier,
  ) {}
  ready() {
    this.readyWait ??= this.readyBarrier.arrive();

    return this.readyWait;
  }
  async done() {
    await this.ready();
    this.doneWait ??= this.doneBarrier.arrive();

    return this.doneWait;
  }
}
