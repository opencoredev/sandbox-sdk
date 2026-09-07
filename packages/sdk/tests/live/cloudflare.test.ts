import { expect, test } from "bun:test";

test.skip("Cloudflare live smoke needs a Worker Sandbox binding", () => {
  expect(process.env.SANDBOX_LIVE_CLOUDFLARE).toBeDefined();
});
