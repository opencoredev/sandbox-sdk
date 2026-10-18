import { describe, vi } from "vitest";
import { e2b } from "../src/providers/e2b/index.js";
import { runConformance } from "../src/testing.js";
// No E2B runtime import, API request or sandbox creation without credentials.
if (process.env.E2B_API_KEY) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
describe.skipIf(!process.env.E2B_API_KEY)("E2B live (billable)", () => {
  runConformance(() => e2b(), { live: true });
});
