import { mkdir, writeFile } from "node:fs/promises";
import type { ProviderName } from "../src/core/types";
import { providers } from "../src/metadata";

const requestedId = process.argv[2];
const provider = providers.find((item) => item.id === requestedId);
if (!provider) throw new Error(`Unknown hosted live provider: ${requestedId}`);
const id = provider.id;
if (id === "local") throw new Error(`Unknown hosted live provider: ${requestedId}`);

const credentialsAvailable = {
  e2b: Boolean(process.env.E2B_API_KEY),
  daytona: Boolean(process.env.DAYTONA_API_KEY),
  vercel: Boolean(
    process.env.VERCEL_OIDC_TOKEN ||
    (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
  ),
  upstash: Boolean(process.env.UPSTASH_BOX_API_KEY),
  blaxel: Boolean(process.env.BL_API_KEY && process.env.BL_WORKSPACE),
} satisfies Record<Exclude<ProviderName, "local">, boolean>;

const started = new Date();
const missingCredentials = !credentialsAvailable[id];
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
