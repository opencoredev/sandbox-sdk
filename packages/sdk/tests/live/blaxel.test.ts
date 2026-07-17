import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { isSandboxError } from "../../src/core/errors";
import type { SandboxProcess } from "../../src/core/types";
import { blaxel } from "../../src/providers/blaxel";

const hasCredentials = Boolean(process.env.BL_API_KEY && process.env.BL_WORKSPACE);

test.skipIf(!hasCredentials)(
  "Blaxel live normalized surface",
  async () => {
    const sandbox = await createSandbox({
      provider: blaxel({
        image: "blaxel/node:latest",
        region: "us-pdx-1",
        lifecycle: {
          expirationPolicies: [{ type: "ttl-max-age", value: "30m", action: "delete" }],
        },
      }),
      env: { SANDBOX_SDK_LIVE: "blaxel" },
      timeout: 120_000,
    });
    try {
      expect((await sandbox.run("printf live-blaxel")).stdout).toContain("live-blaxel");
      expect((await sandbox.run("printf $SANDBOX_SDK_LIVE")).stdout).toContain("blaxel");

      const streams = await sandbox.run(`sh -c 'printf stdout; printf stderr >&2'`);
      expect(streams).toMatchObject({ stdout: "stdout", stderr: "stderr", success: true });
      expect((await sandbox.run("sh -c 'exit 7'")).exitCode).toBe(7);
      const timeoutError = await sandbox.run("sleep 2", { timeout: 50 }).catch((error) => error);
      expect(isSandboxError(timeoutError) && timeoutError.code === "timeout").toBe(true);

      await sandbox.files.write("binary.bin", new Uint8Array([0, 1, 2, 255]));
      expect(await sandbox.files.read("binary.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(await sandbox.files.exists("binary.bin")).toBe(true);
      expect(await sandbox.files.list()).toContainEqual(
        expect.objectContaining({ name: "binary.bin", type: "file", size: 4 }),
      );

      const server = await sandbox.processes.start(
        `node -e 'require("http").createServer((_,res)=>res.end("preview-ok")).listen(3000,"0.0.0.0",()=>console.log("ready"))'`,
      );
      await expectOutput(server, "ready");
      const preview = await sandbox.ports.expose(3000);
      expect(preview).toMatchObject({ public: false, authenticated: true });
      expect(JSON.stringify(preview)).not.toContain("bl_preview_token");
      expect(await (await preview.request!("/")).text()).toBe("preview-ok");
      const requestError = await preview.request!("https://example.com").catch((error) => error);
      expect(isSandboxError(requestError) && requestError.code === "invalid_input").toBe(true);

      await server.kill();
      expect(await server.wait()).toEqual({ exitCode: 137 });
    } finally {
      await sandbox.stop();
    }
  },
  300_000,
);

test.skipIf(!hasCredentials)(
  "Blaxel live managed private preview URL",
  async () => {
    const provider = blaxel({
      image: "blaxel/node:latest",
      region: "us-pdx-1",
      lifecycle: {
        expirationPolicies: [{ type: "ttl-max-age", value: "30m", action: "delete" }],
      },
    });
    const session = await provider.managed!.create({
      sessionId: `live-managed-${crypto.randomUUID()}`,
      ports: [3001],
    });
    let server: SandboxProcess | undefined;
    try {
      server = await session.sandbox.processes.start(
        `node -e 'require("http").createServer((_,res)=>res.end("managed-preview-ok")).listen(3001,"0.0.0.0",()=>console.log("ready"))'`,
      );
      await expectOutput(server, "ready");
      const url = new URL(await session.getPortUrl({ port: 3001 }));
      expect(url.searchParams.has("bl_preview_token")).toBe(true);
      const response = await fetch(url).catch(() => {
        throw new Error("Managed private preview request failed");
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("managed-preview-ok");
    } finally {
      await server?.kill().catch(() => undefined);
      await session.destroy();
    }
  },
  300_000,
);

async function expectOutput(process: SandboxProcess, expected: string): Promise<void> {
  for await (const event of process.output()) {
    const value =
      typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
    if (value.includes(expected)) return;
  }
  throw new Error(`Process ended before emitting ${expected}`);
}
