import { describe } from "vitest";
import { vercel } from "../src/providers/vercel/index.js";
import { runConformance } from "../src/testing.js";
const credentials = Boolean(process.env.VERCEL_OIDC_TOKEN || (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID));
describe.skipIf(!credentials)("Vercel live", { timeout: 120000 }, () => {
  runConformance(() => vercel(), { live: true, ports: [3000] });
});
