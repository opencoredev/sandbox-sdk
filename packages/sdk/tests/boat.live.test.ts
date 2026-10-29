import { describe, vi } from "vitest";
import { boat } from "../src/providers/boat/index.js";
import { runConformance } from "../src/testing.js";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Creates billable VMs only when explicitly given Boat credentials.
describe.skipIf(!process.env.BOAT_API_KEY)("Boat live", () => {
  // Base-plan starts are limited to 12/min, 60/hour and 200/day.
  // Spread conformance creates below the minute limit even on a fast API.
  let nextStart = 0;
  runConformance(
    () => {
      const provider = boat();
      const create = provider.create;
      provider.create = async (input) => {
        const start = Math.max(Date.now(), nextStart);
        nextStart = start + 7_500;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, start - Date.now())));

        return create(input);
      };

      return provider;
    },
    { live: true },
  );
});
