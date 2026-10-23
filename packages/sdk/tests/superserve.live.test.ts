import { describe } from "vitest";
import { superserve } from "../src/providers/superserve/index.js";
import { runConformance } from "../src/testing.js";
describe.skipIf(process.env.SANDBOX_SUPERSERVE_LIVE !== "1" || !process.env.SUPERSERVE_API_KEY)(
  "superserve live",
  () => {
    runConformance(() => {
      const provider = superserve({ template: process.env.SANDBOX_SUPERSERVE_TEMPLATE });
      const create = provider.create;
      provider.create = input => create({ ...input, labels: { ...input.labels, "sbx57-create-a-live": "1", "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "superserve-conformance" } });
      return provider;
    }, {
      live: true,
    });
  },
);
