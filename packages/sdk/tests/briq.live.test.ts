import { describe, vi } from "vitest";
import { briq } from "../src/providers/briq/index.js";
import { runConformance } from "../src/testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function liveProvider(options: Parameters<typeof briq>[0] = {}) {
  const provider = briq(options);
  const create = provider.create;
  provider.create = (input) =>
    create({
      ...input,
      labels: {
        ...input.labels,
        "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "briq-conformance",
      },
    });

  return provider;
}

describe.skipIf(!process.env.BRIQ_API_KEY)("Briq live", () => {
  runConformance(() => liveProvider(), { live: true });
});
