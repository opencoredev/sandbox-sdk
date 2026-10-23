import { describe } from "vitest";
import { freestyle } from "../src/providers/freestyle/index.js";
import { runConformance } from "../src/testing.js";
function liveProvider(options: Parameters<typeof freestyle>[0] = {}) {
  const provider = freestyle(options);
  const create = provider.create;
  provider.create = (input) => create({ ...input, labels: { ...input.labels, "live-run": process.env.SANDBOX_TEST_RUN_ID ?? "freestyle-conformance" } });
  return provider;
}
describe.skipIf(process.env.SANDBOX_FREESTYLE_LIVE !== "1" || !process.env.FREESTYLE_API_KEY)(
  "Freestyle live",
  () => {
    runConformance(() => liveProvider(), { live: true });
  },
);
