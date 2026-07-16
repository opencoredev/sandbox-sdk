import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { agent37 } from "../../src/providers/agent37";

test.skipIf(!process.env.AGENT37_API_KEY)(
  "Agent37 live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: agent37({ template: "agent37-hermes-small" }),
      timeout: 240_000,
    });
    try {
      expect((await sandbox.run("printf live-agent37")).stdout).toContain("live-agent37");
      expect(await sandbox.run("printf out; printf err >&2; exit 7")).toMatchObject({
        stdout: "out",
        stderr: "err",
        exitCode: 7,
        success: false,
      });
      await expect(sandbox.run("sleep 2", { timeout: 100 })).rejects.toMatchObject({
        code: "timeout",
        provider: "agent37",
      });

      await sandbox.files.write("live.txt", "live-file");
      expect(await sandbox.files.text("live.txt")).toBe("live-file");

      const process = await sandbox.processes.start("printf started");
      expect(await process.wait()).toEqual({ exitCode: 0 });
      let output = "";
      for await (const event of process.output()) {
        output +=
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      }
      expect(output).toContain("started");
    } finally {
      await sandbox.stop();
    }
  },
  300_000,
);
