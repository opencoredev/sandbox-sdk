import { cloudflare } from "../src/providers/cloudflare";
import type { CloudflareSandboxClient } from "../src/providers/cloudflare";

declare const env: { Sandbox: unknown };
declare function getSandbox(namespace: unknown, id: string): CloudflareSandboxClient;

await using sandbox = await cloudflare({
  namespace: env.Sandbox,
  getSandbox,
}).create();
console.log((await sandbox.$`node --version`).stdout);
