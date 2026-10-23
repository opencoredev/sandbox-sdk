import { describe, expect, vi } from "vitest";
import { e2b } from "../src/providers/e2b/index.js";
import { runConformance } from "../src/testing.js";
// No E2B runtime import, API request or sandbox creation without credentials.
if (process.env.E2B_API_KEY) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
describe.skipIf(!process.env.E2B_API_KEY)("E2B live (billable)", () => {
  runConformance(() => {
    const provider = e2b();
    const create = provider.create;
    const list = provider.list;
    const reapFixtures = new Map<string, string>();
    provider.create = async input => {
      const box = await create({ ...input, labels: { ...input.labels, sbx57: "adapters-c-conformance" } });
      if (input.labels.reap) reapFixtures.set(input.labels.reap, box.id);
      return box;
    };
    provider.list = async labels => {
      const id = reapFixtures.get(labels.reap ?? "");
      if (!id) return list(labels);
      // Reaping needs a discoverable fixture. Poll the native index here so
      // creation and production listing keep their normal eventual consistency.
      let items: Awaited<ReturnType<typeof list>> = [];
      await expect.poll(async () => {
        items = await list(labels);
        return items.some(item => item.id === id && item.createdAt <= Date.now());
      }, { timeout: 15_000, interval: 500 }).toBe(true);
      return items;
    };
    return provider;
  }, { live: true });
});
