import { describe, vi } from "vitest";
import { luxor } from "../src/providers/luxor/index.js";
import { runConformance } from "../src/testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function liveProvider(options: Parameters<typeof luxor>[0] = {}) {
  const provider = luxor(options);
  const create = provider.create;
  provider.create = (input) =>
    create({
      ...input,
      labels: {
        ...input.labels,
        "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "luxor-conformance",
      },
    });

  return provider;
}

describe.skipIf(
  !["LUXOR_AUTH_TOKEN", "LUXOR_API_KEY", "TENKI_AUTH_TOKEN", "TENKI_API_KEY"].some(
    (name) => process.env[name],
  ),
)("Luxor live", () => {
  runConformance(() => liveProvider(), { live: true });
});
