import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { agentos } from "../../src/providers/agentos";

test("the deprecated agentos() entry is an alias for Local", async () => {
  const sandbox = await createSandbox({ provider: agentos() });
  try {
    expect(sandbox.provider).toBe("local");
    expect(sandbox.raw.vm).toBeDefined();
    expect((await sandbox.run("printf ready")).stdout).toBe("ready");
  } finally {
    await sandbox.stop();
  }
});
