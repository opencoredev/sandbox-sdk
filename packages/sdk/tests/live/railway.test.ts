import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { railway } from "../../src/providers/railway";

test.skipIf(!process.env.RAILWAY_API_TOKEN || !process.env.RAILWAY_ENVIRONMENT_ID)(
  "Railway live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: railway({ idleTimeoutMinutes: 5 }),
      timeout: 180_000,
    });
    try {
      expect((await sandbox.run("printf live-railway")).stdout).toContain("live-railway");
      await sandbox.files.write("live.txt", "railway-live-file");
      expect(await sandbox.files.text("live.txt")).toBe("railway-live-file");
    } finally {
      await sandbox.stop();
    }
  },
  210_000,
);
