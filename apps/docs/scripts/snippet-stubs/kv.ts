// Stand-in for your own key-value store (Redis, Upstash, a database table).
const store = new Map<string, string>();

export const kv = {
  async get(key: string): Promise<string | null> {
    return store.get(key) ?? null;
  },
  async set(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async delete(key: string): Promise<void> {
    store.delete(key);
  },
  // A real store would hold a distributed lock (Redis SET NX, a row lock) while action runs.
  async withLock<T>(_key: string, action: () => Promise<T>): Promise<T> {
    return await action();
  },
};
