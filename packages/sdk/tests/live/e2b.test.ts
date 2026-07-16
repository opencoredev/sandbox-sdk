import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { e2b } from "../../src/providers/e2b";

test.skipIf(!process.env.E2B_API_KEY)(
  "E2B live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({ provider: e2b({ timeout: 120_000 }), timeout: 120_000 });
    try {
      expect((await sandbox.run("printf live-e2b")).stdout).toContain("live-e2b");
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);
