import { describe, vi } from "vitest";
import { railway } from "../src/providers/railway/index.js";
import { runConformance } from "../src/testing.js";
const enabled = Boolean(process.env.RAILWAY_API_TOKEN && process.env.RAILWAY_ENVIRONMENT_ID);
if (enabled) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
describe.skipIf(!enabled)("Railway live (billable)", () => { runConformance(() => railway(), { live: true, ports: [3000] }); });
