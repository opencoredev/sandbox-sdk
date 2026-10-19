import { describe } from "vitest";
import { boxd } from "../src/providers/boxd/index.js";
import { runConformance } from "../src/testing.js";
describe.skipIf(process.env.SANDBOX_BOXD_LIVE !== "1" || !process.env.BOXD_API_KEY)(
  "boxd live",
  () => {
    runConformance(() => boxd(), { live: true });
  },
);
