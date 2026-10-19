import { describe } from "vitest";
import { freestyle } from "../src/providers/freestyle/index.js";
import { runConformance } from "../src/testing.js";
describe.skipIf(process.env.SANDBOX_FREESTYLE_LIVE !== "1" || !process.env.FREESTYLE_API_KEY)(
  "Freestyle live",
  () => {
    runConformance(() => freestyle(), { live: true });
  },
);
