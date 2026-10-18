import { describe, vi } from "vitest";
import { daytona } from "../src/providers/daytona/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
// The whole suite, including Git and HTTP, runs only with explicit credentials.
describe.skipIf(!process.env.DAYTONA_API_KEY)("Daytona live", () => {
  runConformance(() => daytona(), { live: true });
});
