import { describe, vi } from "vitest";
import { tenki } from "../src/providers/tenki/index.js";
import { runConformance } from "../src/testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

function liveProvider(options: Parameters<typeof tenki>[0] = {}) {
  const provider = tenki(options);
  const create = provider.create;
  provider.create = (input) =>
    create({
      ...input,
      labels: {
        ...input.labels,
        "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "tenki-conformance",
      },
    });

  return provider;
}

describe.skipIf(!process.env.TENKI_AUTH_TOKEN && !process.env.TENKI_API_KEY)("Tenki live", () => {
  runConformance(() => liveProvider(), { live: true });
});
