import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import { loadProvider, parseProviderName } from "./sandbox-provider";
import type { SessionId } from "./session";

/** The agent is told to serve the app here; the preview route proxies it. */
export const previewPort = 3000;
export const providerName = parseProviderName(process.env.SANDBOX_PROVIDER);

// Survives Next dev reloads. Keys make this a cache, not the source of truth:
// after a server restart, createSandbox finds the same sandbox again by key.
declare global {
  var sandboxSessions: Map<SessionId, Promise<Sandbox>> | undefined;
}
const cache = (globalThis.sandboxSessions ??= new Map());

export function sessionSandbox(session: SessionId): Promise<Sandbox> {
  const cached = cache.get(session);
  if (cached) return cached;
  const box = loadProvider(providerName).then((provider) =>
    createSandbox(provider, {
      key: `ai-app-builder:${session}`,
      ports: [previewPort],
      labels: { example: "ai-app-builder" },
    }),
  );
  cache.set(session, box);
  box.catch(() => cache.delete(session));
  return box;
}

export async function destroySessionSandbox(session: SessionId): Promise<void> {
  const box = await sessionSandbox(session);
  cache.delete(session);
  await box.destroy();
}
