import { describe, vi } from "vitest";
import { upstash } from "../src/providers/upstash/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
describe.skipIf(!process.env.UPSTASH_BOX_API_KEY)("Upstash Box live", () => {
  runConformance(() => upstash(), { live: true });
});
