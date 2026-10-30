import type { Provider } from "./provider.js";
import type { CreateOptions } from "./types.js";

// Keys this realm created or found. Provider list indexes can lag a fresh create, and setup
// no longer spends enough time to hide that lag from an immediate same-key lookup.
// Entries leave on destroy, and the oldest go first past the cap, so a long-lived process stays bounded.
const limit = 256;
const known = new WeakMap<Provider, Map<string, string>>();

export const knownKey = (provider: Provider, key: string) => known.get(provider)?.get(key);

export function rememberKey(provider: Provider, key: string, id: string) {
  let keys = known.get(provider);

  if (!keys) {
    keys = new Map();
    known.set(provider, keys);
  }

  keys.delete(key);
  keys.set(key, id);

  if (keys.size > limit) {
    const oldest = keys.keys().next().value;

    if (oldest !== undefined) keys.delete(oldest);
  }
}

export function forgetKey(provider: Provider, key: string) {
  known.get(provider)?.delete(key);
}

export function forgetSandbox(provider: Provider, id: string) {
  const keys = known.get(provider);

  if (!keys) return;

  for (const [key, value] of keys) if (value === id) keys.delete(key);
}

// Serializes same-key callers in this JS realm, including locator read/create/write and the
// locator delete on destroy. Cross-host exactness requires the provider's unique native key
// (see provider keyMode) or the locator's lock, taken here exactly when creation needs it.
const queues = new WeakMap<Provider, Map<string, Promise<unknown>>>();

export async function withKeyLock<T>(
  provider: Provider,
  key: string,
  options: Pick<CreateOptions, "keyMode" | "locator">,
  action: () => Promise<T>,
): Promise<T> {
  let queue = queues.get(provider);

  if (!queue) {
    queue = new Map();
    queues.set(provider, queue);
  }

  const previous = queue.get(key) ?? Promise.resolve();
  const locator = options.locator;

  // The previous call's failure belongs to its own caller; this one only waits its turn.
  const task = previous
    .catch(() => {})
    .then(() =>
      options.keyMode === "exact" && provider.keyMode === "best-effort" && locator?.withLock
        ? locator.withLock(key, action)
        : action(),
    );

  queue.set(key, task);

  try {
    return await task;
  } finally {
    if (queue.get(key) === task) queue.delete(key);
  }
}

// Open handles per sandbox. Adapters keep local resources (clients, foreground commands,
// process monitors) by sandbox ID, so only the last handle to close may detach them.
const attached = new WeakMap<Provider, Map<string, number>>();

export function attachHandle(provider: Provider, id: string) {
  let handles = attached.get(provider);

  if (!handles) {
    handles = new Map();
    attached.set(provider, handles);
  }

  handles.set(id, (handles.get(id) ?? 0) + 1);
}

/** Drop one handle's claim. Returns whether it was the last open handle for the sandbox. */
export function detachHandle(provider: Provider, id: string) {
  const handles = attached.get(provider);
  const count = handles?.get(id) ?? 0;

  if (count > 1) {
    handles?.set(id, count - 1);

    return false;
  }

  handles?.delete(id);

  return true;
}
