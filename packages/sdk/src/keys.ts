import type { Provider } from "./provider.js";

// Keys this realm created or found. Provider list indexes can lag a fresh create, and setup
// no longer spends enough time to hide that lag from an immediate same-key lookup.
// Entries leave on destroy, and the oldest go first past the cap, so a long-lived process stays bounded.
const limit = 256;
const known = new WeakMap<Provider, Map<string, string>>();

export const knownKey = (provider: Provider, key: string) => known.get(provider)?.get(key);

export function rememberKey(provider: Provider, key: string, id: string) {
  let keys = known.get(provider);
  if (!keys) { keys = new Map(); known.set(provider, keys); }
  keys.delete(key); keys.set(key, id);
  if (keys.size > limit) { const oldest = keys.keys().next().value; if (oldest !== undefined) keys.delete(oldest); }
}

export function forgetKey(provider: Provider, key: string) { known.get(provider)?.delete(key); }

export function forgetSandbox(provider: Provider, id: string) {
  const keys = known.get(provider); if (!keys) return;
  for (const [key, value] of keys) if (value === id) keys.delete(key);
}
