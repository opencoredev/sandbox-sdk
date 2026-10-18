import { describe, vi } from "vitest";
import { tenki } from "../src/providers/tenki/index.js";
import { runConformance } from "../src/testing.js";
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
describe.skipIf(!process.env.TENKI_AUTH_TOKEN && !process.env.TENKI_API_KEY)("Tenki live", () => {
  runConformance(() => tenki(), { live: true });
});
