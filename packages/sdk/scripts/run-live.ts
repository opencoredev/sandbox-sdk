import { mkdir, writeFile } from "node:fs/promises";
import { providers } from "../src/metadata";

const id = process.argv[2];
const provider = providers.find((item) => item.id === id);
if (!provider || id === "local" || id === "agentos")
  throw new Error(`Unknown hosted live provider: ${id}`);

const started = new Date();
const missingCredentials = (() => {
  switch (id) {
    case "e2b":
      return !process.env.E2B_API_KEY;
    case "daytona":
      return !process.env.DAYTONA_API_KEY;
    case "upstash":
      return !process.env.UPSTASH_BOX_API_KEY;
    case "box":
      return !process.env.BOX_API_KEY;
    case "railway":
      return !process.env.RAILWAY_API_TOKEN || !process.env.RAILWAY_ENVIRONMENT_ID;
    case "vercel":
      return (
        !process.env.VERCEL_OIDC_TOKEN &&
        !(process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID)
      );
    default:
      return true;
  }
})();
const processResult = missingCredentials
  ? null
  : Bun.spawn(["bun", "test", `tests/live/${id}.test.ts`], {
      cwd: new URL("..", import.meta.url).pathname,
      stdout: "inherit",
      stderr: "inherit",
      env: process.env,
    });
const exitCode = processResult ? await processResult.exited : 0;
const result = {
  provider: id,
  testedAt: started.toISOString(),
  adapterVersion: "0.1.0",
  providerSdkVersion: provider.packageVersion,
  passed: !missingCredentials && exitCode === 0 ? 1 : 0,
  failed: !missingCredentials && exitCode !== 0 ? 1 : 0,
  skipped: missingCredentials ? 1 : 0,
  capabilities: provider.capabilities,
};
await mkdir(new URL("../compatibility/results", import.meta.url), {
  recursive: true,
});
await writeFile(
  new URL(`../compatibility/results/${id}.json`, import.meta.url),
  `${JSON.stringify(result, null, 2)}\n`,
);
process.exitCode = exitCode;
