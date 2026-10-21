import { describe } from "vitest";
import { superserve } from "../src/providers/superserve/index.js";
import { runConformance } from "../src/testing.js";
describe.skipIf(process.env.SANDBOX_SUPERSERVE_LIVE !== "1" || !process.env.SUPERSERVE_API_KEY)(
  "superserve live",
  () => {
    runConformance(() => superserve(), { live: true });
  },
);
