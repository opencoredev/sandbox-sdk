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
      reject(new Error(`Scenario timed out after ${ms}ms`));
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
