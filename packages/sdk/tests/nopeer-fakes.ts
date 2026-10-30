// The local provider fakes the no-peer consumer smoke drives the installed tarball against. The smoke bundles
// this file with `vitest` aliased to ./vitest-shim.ts, so it runs in a plain Node or Bun app outside the workspace.
// Each fake is the one the adapter's own test suite uses:
// - E2B: tests/e2b-fake.ts (control plane and envd, real processes), behind a fetch router.
// - Daytona: tests/daytona-mock.ts (a local HTTP server, reached through DAYTONA_API_URL).
// - Freestyle: tests/freestyle-mock.ts and Superserve: tests/superserve-fake.ts, behind the same fetch router.
// - Boat and Sandboxer: tests/boat-mock.ts (local HTTP servers).
import { afterAll, runAfterAll } from "./vitest-shim.js";
import { boatMock } from "./boat-mock.js";
import { apiUrl as daytonaApiUrl, cleanupMock } from "./daytona-mock.js";
import { fakeE2B } from "./e2b-fake.js";
import { cleanupFreestyle, freestyleFetch } from "./freestyle-mock.js";
import { installSuperserveFake, resetSuperserveFake } from "./superserve-fake.js";

/** Options for each converted provider's factory that point it at its fake. */
export interface FakeProviders {
  e2b: { apiKey: string };
  daytona: { apiKey: string; apiUrl: string };
  freestyle: { apiKey: string };
  superserve: { apiKey: string };
  boat: { apiKey: string; apiUrl: string };
  sandboxer: { apiKey: string; baseUrl: string };
}

/** Starts every fake and routes `fetch` to them. `close()` stops them and restores `fetch` and `WebSocket`. */
export async function startFakes(): Promise<{ options: FakeProviders; close(): Promise<void> }> {
  const original = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket };
  const e2b = await fakeE2B();
  const boat = await boatMock("boat");
  const sandboxer = await boatMock("sandboxer");
  installSuperserveFake();
  const superserveFetch = globalThis.fetch;
  const e2bFetch = e2b.fetch(original.fetch);
  // E2B's fake claims every api.* and sandbox.* host, so the hosts the others own are matched first.
  globalThis.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.hostname === "superserve.ai" || url.hostname.endsWith(".superserve.ai"))
      return superserveFetch(input, init);
    if (url.origin === "https://api.freestyle.sh") return freestyleFetch(input, init);
    return e2bFetch(input, init);
  };
  afterAll(async () => {
    await cleanupMock();
    await cleanupFreestyle();
    await resetSuperserveFake();
  });
  return {
    options: {
      e2b: { apiKey: "mock" },
      daytona: { apiKey: "offline-test-key", apiUrl: daytonaApiUrl },
      freestyle: { apiKey: "mock-key" },
      superserve: { apiKey: "mock" },
      boat: { apiKey: "test-key", apiUrl: boat.apiUrl },
      sandboxer: { apiKey: "test-key", baseUrl: sandboxer.apiUrl },
    },
    async close() {
      globalThis.fetch = original.fetch;
      globalThis.WebSocket = original.WebSocket;
      await runAfterAll();
      await Promise.all([e2b.close(), boat.dispose(), sandboxer.dispose()]);
    },
  };
}
