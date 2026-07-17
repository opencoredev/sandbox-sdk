import { expect, test } from "bun:test";
import type { SandboxProvider } from "../../src/core/provider";
import { createMastraWorkspace } from "../../src/mastra";
import { blaxel } from "../../src/providers/blaxel";
import { daytona } from "../../src/providers/daytona";
import { e2b } from "../../src/providers/e2b";
import { local } from "../../src/providers/local";
import { upstash } from "../../src/providers/upstash";
import { vercel } from "../../src/providers/vercel";

const port = 31_337;
const vercelAuthenticated = Boolean(
  process.env.VERCEL_OIDC_TOKEN ||
  (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
);

interface LiveMastraCase {
  name: string;
  enabled: boolean;
  provider: () => SandboxProvider<unknown>;
}

const cases: LiveMastraCase[] = [
  {
    name: "Local",
    enabled: true,
    provider: () => local(),
  },
  {
    name: "E2B",
    enabled: Boolean(process.env.E2B_API_KEY),
    provider: () => e2b({ timeout: 180_000 }),
  },
  {
    name: "Daytona",
    enabled: Boolean(process.env.DAYTONA_API_KEY),
    provider: () => daytona(),
  },
  {
    name: "Vercel",
    enabled: vercelAuthenticated,
    provider: vercelProvider,
  },
  {
    name: "Upstash",
    enabled: Boolean(process.env.UPSTASH_BOX_API_KEY),
    provider: () => upstash({ runtime: "node", timeout: 180_000 }),
  },
  {
    name: "Blaxel",
    enabled: Boolean(process.env.BL_API_KEY && process.env.BL_WORKSPACE),
    provider: () =>
      blaxel({
        image: "blaxel/node:latest",
        region: "us-pdx-1",
        ports: [{ target: port, protocol: "HTTP" }],
      }),
  },
];

for (const live of cases) {
  test.skipIf(!live.enabled)(
    `Mastra live workspace on ${live.name}`,
    async () => {
      const workspace = createMastraWorkspace({
        provider: live.provider(),
        id: `live-mastra-${live.name.toLowerCase()}-${crypto.randomUUID()}`,
        env: { MASTRA_BASE_ENV: "base" },
        ports: [port],
        workspace: { id: `live-mastra-${live.name.toLowerCase()}` },
      });

      try {
        await workspace.init();
        expect(workspace.sandbox.status).toBe("running");

        const marker = `${live.name.toLowerCase()}-${crypto.randomUUID()}`;
        await workspace.filesystem.writeFile("live/input.txt", marker, {
          recursive: true,
        });
        await workspace.filesystem.appendFile("live/input.txt", "-filesystem");

        const streamed: string[] = [];
        const unsafeArgument = "$HOME;echo-not-executed";
        const command = await workspace.sandbox.executeCommand!(
          "node",
          [
            "-e",
            "const fs=require('fs');process.stdout.write(`${fs.readFileSync('live/input.txt','utf8')}:${process.env.MASTRA_BASE_ENV}:${process.env.MASTRA_LIVE_ENV}:${process.argv[1]}`)",
            unsafeArgument,
          ],
          {
            cwd: "/workspace",
            env: { MASTRA_LIVE_ENV: live.name.toLowerCase() },
            onStdout: (data) => streamed.push(data),
          },
        );
        const expected = `${marker}-filesystem:base:${live.name.toLowerCase()}:${unsafeArgument}`;
        expect(command).toMatchObject({ success: true, exitCode: 0 });
        expect(command.stdout.trimEnd()).toBe(expected);
        expect(streamed.join("").trimEnd()).toBe(expected);

        const background = await workspace.sandbox.processes.spawn(
          "node -e \"process.stdout.write('background-ok')\"",
        );
        const backgroundResult = await background.wait();
        expect(backgroundResult).toMatchObject({ success: true, exitCode: 0 });
        expect(backgroundResult.stdout.trimEnd()).toBe("background-ok");
        expect(await workspace.sandbox.processes.list()).toContainEqual(
          expect.objectContaining({ pid: background.pid, running: false, exitCode: 0 }),
        );

        const capabilities = workspace.sandbox.sandboxSdk.capabilities;
        if (capabilities["process.stdin"] !== false) {
          const stdin = await workspace.sandbox.processes.spawn(
            "node -e \"process.stdin.once('data',d=>{process.stdout.write(d);process.exit(0)})\"",
          );
          await stdin.sendStdin("stdin-ok");
          const stdinResult = await stdin.wait();
          expect(stdinResult).toMatchObject({ success: true, exitCode: 0 });
          expect(stdinResult.stdout.trimEnd()).toBe("stdin-ok");
        }

        if (capabilities["process.cancel"] !== false) {
          const cancellable = await workspace.sandbox.processes.spawn(
            'node -e "setInterval(()=>{},1000)"',
          );
          expect(await cancellable.kill()).toBe(true);
          expect(await cancellable.wait()).toMatchObject({ killed: true });
        }

        const listing = await workspace.filesystem.readdir("/live", { recursive: true });
        expect(listing).toContainEqual(
          expect.objectContaining({ name: "input.txt", type: "file" }),
        );
        expect(await workspace.filesystem.stat("/live/input.txt")).toMatchObject({
          name: "input.txt",
          type: "file",
          size: Buffer.byteLength(`${marker}-filesystem`),
        });

        const portUrl = new URL(await workspace.sandbox.getPortUrl(port));
        expect(["http:", "https:"]).toContain(portUrl.protocol);

        await workspace.sandbox._stop();
        expect(workspace.sandbox.status).toBe("stopped");
        await workspace.sandbox._start();
        expect(await workspace.filesystem.readFile("/live/input.txt", { encoding: "utf8" })).toBe(
          `${marker}-filesystem`,
        );
      } finally {
        await workspace.destroy();
      }
    },
    360_000,
  );
}

function vercelProvider(): SandboxProvider<unknown> {
  const options = { persistent: true, ports: [port] };
  if (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID) {
    return vercel({
      ...options,
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    });
  }
  return vercel(options);
}
