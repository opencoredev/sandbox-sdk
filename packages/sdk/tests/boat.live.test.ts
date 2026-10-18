import { describe, vi } from "vitest";
import { boat } from "../src/providers/boat/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
// Creates billable VMs only when explicitly given Boat credentials.
describe.skipIf(!process.env.BOAT_API_KEY)("Boat live", () => {
  runConformance(() => boat(), { live: true });
});
