/**
 * The `resolveConfig` recipe for native `@upstash/box` calls reaches the path the adapter's own
 * requests use, for every base URL the adapter accepts. Runs the real `@upstash/box` client
 * against a stubbed fetch, so nothing leaves the process.
 */
import { Box } from "@upstash/box";
import { afterEach, expect, test, vi } from "vitest";
import { resolveConfig } from "../src/providers/upstash/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** The URL `Box.get` requests with these options; the stub answers 404 so no box is built. */
async function getUrl(options: { apiKey: string; baseUrl: string }) {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify({ error: "not found" }), { status: 404 }));

  await Box.get("box-1", options).catch(() => {});
  const url = String(fetch.mock.calls[0]?.[0]);
  fetch.mockRestore();

  return url;
}

test.each([
  "https://box.example/tenant",
  "https://box.example/tenant/",
  "https://box.example/tenant//",
])("Box.get with the documented recipe for %s hits the adapter's own path", async (base) => {
  const config = resolveConfig({ apiKey: "key", baseUrl: base });
  // The adapter's own requests join the resolved base URL with the path (removeBox, create).
  const adapterPath = `${config.baseUrl}/v2/box/box-1`;

  expect(await getUrl({ ...config, baseUrl: `${config.baseUrl}/` })).toBe(adapterPath);
});

test("passing resolveConfig() as is drops a second slash: why the recipe adds one back", async () => {
  const config = resolveConfig({ apiKey: "key", baseUrl: "https://box.example/tenant//" });

  expect(await getUrl(config)).toBe("https://box.example/tenant/v2/box/box-1");
  expect(`${config.baseUrl}/v2/box/box-1`).toBe("https://box.example/tenant//v2/box/box-1");
});
