import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { ascii } from "../../src/providers/ascii";

test.skipIf(!process.env.BOX_API_KEY)(
  "Ascii live conformance smoke test",
  async () => {
    const sandbox = await createSandbox({
      provider: ascii({ ttlSeconds: 600 }),
      timeout: 300_000,
    });
    try {
      expect((await sandbox.run("printf live-ascii")).stdout).toBe("live-ascii");
      expect(await sandbox.run("printf out; printf err >&2; exit 7")).toMatchObject({
        stdout: "out",
        stderr: "err",
        exitCode: 7,
        success: false,
      });
      await expect(sandbox.run("sleep 2", { timeout: 20 })).rejects.toMatchObject({
        code: "timeout",
        provider: "ascii",
      });

      await sandbox.files.mkdir("nested");
      await sandbox.files.write("nested/file.txt", "ascii");
      expect(await sandbox.files.text("nested/file.txt")).toBe("ascii");
      expect(await sandbox.files.exists("nested/file.txt")).toBe(true);

      const process = await sandbox.processes.start("printf started; printf warning >&2");
      const events = [];
      for await (const event of process.output()) events.push(event);
      const output = { stdout: "", stderr: "" };
      for (const event of events)
        output[event.stream] +=
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      expect(output.stdout).toContain("started");
      expect(output.stderr).toContain("warning");
      expect(await process.wait()).toEqual({ exitCode: 0 });

      const sleeping = await sandbox.processes.start("sleep 30");
      await sleeping.kill();
      expect(await sleeping.wait()).toEqual({ exitCode: 143 });

      const port = 43_123;
      const server = await sandbox.processes.start(
        `node -e "require('http').createServer((_,res)=>res.end('ascii-port')).listen(${port},'0.0.0.0')"`,
      );
      try {
        const preview = await sandbox.ports.expose(port);
        expect(preview.authenticated).toBe(true);
        expect(preview.url).not.toContain("_token");
        expect(await (await preview.request!("/")).text()).toBe("ascii-port");
      } finally {
        await server.kill();
      }

      const snapshot = await sandbox.snapshots.create({ name: "live-ascii" });
      expect(snapshot.mode).toBe("filesystem");
      expect(await sandbox.files.text("nested/file.txt")).toBe("ascii");
    } finally {
      await sandbox.stop();
    }
  },
  360_000,
);
