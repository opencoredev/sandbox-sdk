// Existing users' native clients and requests reach what they reached before `resolveConfig`.
// Ported from a review's repros: E2B_DEBUG must keep pointing the `e2b` package's client at
// localhost, and an Upstash base URL that ends in `//` must keep its working `//v2/box` route.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { e2b } from "../src/providers/e2b/index.js";
import { upstash } from "../src/providers/upstash/index.js";

const variables = [
  "E2B_API_KEY",
  "E2B_API_URL",
  "E2B_DEBUG",
  "E2B_DOMAIN",
  "UPSTASH_BOX_API_KEY",
  "UPSTASH_BOX_BASE_URL",
];

beforeEach(() => {
  for (const key of variables) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function listen(handler: (path: string) => { status: number; body: unknown }) {
  const paths: string[] = [];

  const server: Server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    paths.push(path);
    const { status, body } = handler(path);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!isTcp(address)) throw new Error("No TCP address");

  return { origin: `http://127.0.0.1:${address.port}`, paths, close: () => server.close() };
}

function isTcp(address: string | AddressInfo | null): address is AddressInfo {
  return address !== null && typeof address !== "string";
}

describe("native clients and requests are unchanged", () => {
  test("with E2B_DEBUG, the e2b package's client from api.sdk() resolves its API to localhost", async () => {
    vi.stubEnv("E2B_API_KEY", "e2b_fixture");
    vi.stubEnv("E2B_DEBUG", "true");
    vi.stubEnv("E2B_DOMAIN", "remote.invalid");
    const module = await import("e2b");
    const inits: ConstructorParameters<typeof module.E2B>[0][] = [];

    // The real client, recording the options the adapter builds it with. No request is made.
    class E2B extends module.E2B {
      constructor(init: ConstructorParameters<typeof module.E2B>[0]) {
        inits.push(init);
        super(init);
      }
    }

    await e2b().api.sdk(async () => ({ E2B }));

    expect(inits).toHaveLength(1);
    expect(new module.ConnectionConfig(inits[0]).apiUrl).toBe("http://localhost:3000");
  });

  test("Upstash keeps a base URL's inner slashes: /tenant// lists at /tenant//v2/box", async () => {
    const server = await listen((path) =>
      path === "/tenant//v2/box"
        ? { status: 200, body: [] }
        : { status: 404, body: { error: "not found" } },
    );

    try {
      const adapter = upstash({ apiKey: "fixture", baseUrl: `${server.origin}/tenant//` });

      await expect(adapter.list({})).resolves.toEqual([]);
      expect(server.paths).toEqual(["/tenant//v2/box"]);
    } finally {
      server.close();
    }
  });
});
