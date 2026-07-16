import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { upstash } from "../../src/providers/upstash";

test.skipIf(!process.env.UPSTASH_BOX_API_KEY)(
  "Upstash live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: upstash({ runtime: "node", timeout: 180_000 }),
      cwd: "/workspace/home",
      timeout: 180_000,
    });
    try {
      expect((await sandbox.run("printf live-upstash")).stdout).toContain("live-upstash");
      expect(await sandbox.run("printf out; printf err >&2; exit 7")).toMatchObject({
        stdout: "outerr",
        stderr: "",
        exitCode: 7,
        success: false,
      });
      await expect(sandbox.run("sleep 2", { timeout: 100 })).rejects.toMatchObject({
        code: "timeout",
        provider: "upstash",
      });

      const process = await sandbox.processes.start("printf started");
      const output = process.output()[Symbol.asyncIterator]();
      expect((await output.next()).value?.data).toContain("started");
      expect(await process.wait()).toEqual({ exitCode: 0 });
      await expect(process.kill()).rejects.toMatchObject({
        code: "unsupported",
      });
    } finally {
      await sandbox.stop();
    }
  },
  210_000,
);
