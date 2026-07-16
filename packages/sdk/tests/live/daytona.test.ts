import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { daytona } from "../../src/providers/daytona";

test.skipIf(!process.env.DAYTONA_API_KEY)(
  "Daytona live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: daytona(),
      timeout: 180_000,
    });
    try {
      expect(await sandbox.files.exists(sandbox.cwd)).toBe(true);
      expect((await sandbox.run("printf live-daytona")).stdout).toContain("live-daytona");
    } finally {
      await sandbox.stop();
    }
  },
  210_000,
);
