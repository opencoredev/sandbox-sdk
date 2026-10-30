/** Round-robin queue: busy providers never block a free provider. A job holds its slot until cleanup. */
export async function schedule<T extends { provider: string }>(
  jobs: readonly T[],
  limits: { global: number; perProvider: number },
  action: (job: T) => Promise<void>,
) {
  const waiting = [...jobs],
    active = new Set<Promise<void>>(),
    counts = new Map<string, number>();

  while (waiting.length || active.size) {
    let index = waiting.findIndex((j) => (counts.get(j.provider) ?? 0) < limits.perProvider);

    while (active.size < limits.global && index >= 0) {
      const job = waiting.splice(index, 1)[0];

      if (!job) break;
      counts.set(job.provider, (counts.get(job.provider) ?? 0) + 1);

      const task = Promise.resolve()
        .then(() => action(job))
        .finally(() => {
          counts.set(job.provider, (counts.get(job.provider) ?? 1) - 1);
          active.delete(task);
        });

      active.add(task);
      index = waiting.findIndex((j) => (counts.get(j.provider) ?? 0) < limits.perProvider);
    }

    if (active.size) await Promise.race(active);
  }
}

export function roundRobin(providers: readonly string[], runs: number) {
  return Array.from({ length: runs }, (_, iteration) =>
    providers.map((provider) => ({ provider, iteration })),
  ).flat();
}
