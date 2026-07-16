import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { createSandboxHarnessProvider } from "../../src/ai/harness";
import { toAISandboxSession } from "../../src/ai";
import { isSandboxError } from "../../src/core/errors";
import { createEveSandboxBackend } from "../../src/eve";
import { vercel } from "../../src/providers/vercel";

const authenticated = Boolean(
  process.env.VERCEL_OIDC_TOKEN ||
  (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
);

function provider(options: { persistent?: boolean; ports?: number[] } = {}) {
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

test.skipIf(!authenticated)(
  "Vercel live normalized surface and AI SDK adapter",
  async () => {
    const sandbox = await createSandbox({
      provider: provider({ persistent: true, ports: [3000] }),
      timeout: 180_000,
    });
    let snapshot: Awaited<ReturnType<typeof sandbox.snapshots.create>> | undefined;
    try {
      await sandbox.files.write("text.txt", "hello");
      await sandbox.files.write("binary.bin", new Uint8Array([0, 1, 2, 255]));
      await sandbox.files.mkdir("nested");
      await sandbox.files.write("nested/item.txt", "item");
      expect(await sandbox.files.text("text.txt")).toBe("hello");
      expect(await sandbox.files.read("binary.bin")).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect((await sandbox.files.list("nested")).map((entry) => entry.name)).toContain("item.txt");
      expect(await sandbox.files.exists("nested/item.txt")).toBe(true);
      await sandbox.files.remove("nested");
      expect(await sandbox.files.exists("nested/item.txt")).toBe(false);

      const direct = await sandbox.run({ command: "printf", args: ["direct"] });
      expect(direct).toMatchObject({
        stdout: "direct",
        stderr: "",
        exitCode: 0,
        success: true,
      });
      const environment = await sandbox.run('printf "$LIVE_VALUE:$PWD"', {
        env: { LIVE_VALUE: "env-ok" },
      });
      expect(environment.stdout).toBe("env-ok:/workspace");
      expect(await sandbox.run("printf failure >&2; exit 7")).toMatchObject({
        stderr: "failure",
        exitCode: 7,
        success: false,
      });
      await expect(sandbox.run("sleep 2", { timeout: 100 })).rejects.toMatchObject({
        code: "timeout",
        provider: "vercel",
      });

      const background = await sandbox.processes.start(
        "printf background-out; printf background-err >&2",
      );
      const events = [];
      for await (const event of background.output()) events.push(event);
      expect(await background.wait()).toEqual({ exitCode: 0 });
      expect(
        events.some((event) => event.stream === "stdout" && event.data === "background-out"),
      ).toBe(true);
      expect(
        events.some((event) => event.stream === "stderr" && event.data === "background-err"),
      ).toBe(true);

      const server = await sandbox.processes.start({
        command: "node",
        args: ["-e", "require('http').createServer((_,res)=>res.end('port-ok')).listen(3000)"],
      });
      const drain = Array.fromAsync(server.output());
      try {
        const exposed = await sandbox.ports.expose(3000);
        expect(exposed).toMatchObject({
          port: 3000,
          public: true,
          authenticated: false,
        });
        expect(await fetchUntilReady(exposed.url)).toBe("port-ok");
      } finally {
        await server.kill();
        await Promise.allSettled([server.wait(), drain]);
      }

      const ai = toAISandboxSession(sandbox);
      await ai.writeTextFile({ path: "ai.txt", content: "ai-ok" });
      expect(await ai.readTextFile({ path: "ai.txt" })).toBe("ai-ok");
      expect(await ai.run({ command: "printf ai-command" })).toMatchObject({
        stdout: "ai-command",
        stderr: "",
        exitCode: 0,
      });

      snapshot = await sandbox.snapshots.create({ name: "live-vercel" });
      expect(snapshot.mode).toBe("filesystem");
      await sandbox.snapshots.delete(snapshot);
      snapshot = undefined;
    } finally {
      try {
        if (snapshot) await sandbox.snapshots.delete(snapshot);
      } finally {
        await sandbox.raw.delete();
      }
    }
  },
  300_000,
);

test.skipIf(!authenticated)(
  "Vercel live Harness and Eve managed lifecycle",
  async () => {
    const harnessProvider = provider({ persistent: true });
    const harness = createSandboxHarnessProvider({ provider: harnessProvider });
    const harnessId = `live-harness-${crypto.randomUUID()}`;
    const first = await harness.createSession({ sessionId: harnessId });
    try {
      await first.writeTextFile({ path: "durable.txt", content: "harness-ok" });
      await first.stop();
      const resumed = await harness.resumeSession!({ sessionId: harnessId });
      expect(await resumed.readTextFile({ path: "durable.txt" })).toBe("harness-ok");
      await resumed.destroy?.();
    } catch (error) {
      try {
        await first.destroy?.();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Vercel Harness test and cleanup failed");
      }
      throw error;
    }

    const eveProvider = provider({ persistent: true });
    const backend = createEveSandboxBackend({ provider: eveProvider });
    const templateKey = `live-template-${crypto.randomUUID()}`;
    const sessionKey = `live-eve-${crypto.randomUUID()}`;
    const templateSessionId = `eve-template-${templateKey}`;
    try {
      expect(
        await backend.prewarm({
          templateKey,
          runtimeContext: { appRoot: "/tmp/app" },
          seedFiles: [{ path: "seed.txt", content: "seed-ok" }],
          async bootstrap({ use }) {
            await (await use()).writeTextFile({ path: "boot.txt", content: "boot-ok" });
          },
        }),
      ).toEqual({ reused: false });
      const handle = await backend.create({
        templateKey,
        sessionKey,
        runtimeContext: { appRoot: "/tmp/app" },
      });
      expect(await handle.session.readTextFile({ path: "seed.txt" })).toBe("seed-ok");
      expect(await handle.session.readTextFile({ path: "boot.txt" })).toBe("boot-ok");
      await handle.session.writeTextFile({
        path: "eve.txt",
        content: "eve-ok",
      });
      const state = await handle.captureState();
      await handle.shutdown();
      const resumed = await backend.create({
        templateKey,
        sessionKey,
        existingMetadata: state.metadata,
        runtimeContext: { appRoot: "/tmp/app" },
      });
      expect(await resumed.session.readTextFile({ path: "eve.txt" })).toBe("eve-ok");
      await resumed.shutdown();
    } finally {
      await destroyManaged(eveProvider, sessionKey);
      await destroyManaged(eveProvider, templateSessionId);
    }
  },
  300_000,
);

async function fetchUntilReady(url: string): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.text();
      lastError = new Error(`Port returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(250);
  }
  throw lastError;
}

async function destroyManaged(providerInstance: ReturnType<typeof provider>, sessionId: string) {
  try {
    const session = await providerInstance.managed!.resume({ sessionId });
    await session.destroy();
  } catch (error) {
    if (isSandboxError(error) && error.code === "not_found") return;
    throw error;
  }
}
