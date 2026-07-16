import { expect, test } from "bun:test";
import { createSandboxHarnessProvider } from "../../src/ai/harness";
import { toAISandboxSession } from "../../src/ai";
import { isSandboxError } from "../../src/core/errors";
import type { SandboxProvider } from "../../src/core/provider";
import { createEveSandboxBackend } from "../../src/eve";
import { daytona } from "../../src/providers/daytona";
import { e2b } from "../../src/providers/e2b";
import { local } from "../../src/providers/local";
import { upstash } from "../../src/providers/upstash";
import { vercel } from "../../src/providers/vercel";

const vercelAuthenticated = Boolean(
  process.env.VERCEL_OIDC_TOKEN ||
  (process.env.VERCEL_TOKEN && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID),
);

const providers: Array<{
  name: string;
  enabled: boolean;
  create: () => SandboxProvider<unknown>;
}> = [
  { name: "Local", enabled: true, create: () => local() },
  {
    name: "E2B",
    enabled: Boolean(process.env.E2B_API_KEY),
    create: () => e2b({ timeout: 180_000 }),
  },
  {
    name: "Daytona",
    enabled: Boolean(process.env.DAYTONA_API_KEY),
    create: () => daytona(),
  },
  {
    name: "Vercel",
    enabled: vercelAuthenticated,
    create: vercelProvider,
  },
  {
    name: "Upstash",
    enabled: Boolean(process.env.UPSTASH_BOX_API_KEY),
    create: () => upstash({ runtime: "node", timeout: 180_000 }),
  },
];

for (const live of providers) {
  test.skipIf(!live.enabled)(
    `AI SDK, Harness, and Eve live integrations on ${live.name}`,
    async () => {
      await verifyAISDK(live.create(), live.name);
      await verifyHarness(live.create(), live.name);
      await verifyEve(live.create(), live.name);
    },
    600_000,
  );
}

async function verifyAISDK(provider: SandboxProvider<unknown>, name: string) {
  const session = await provider.managed!.create({
    sessionId: `live-ai-${name.toLowerCase()}-${crypto.randomUUID()}`,
    cwd: "/workspace",
  });
  try {
    const ai = toAISandboxSession(session.sandbox);
    await ai.writeTextFile({ path: "ai-live.txt", content: `${name}-ai` });
    expect(await ai.readTextFile({ path: "ai-live.txt" })).toBe(`${name}-ai`);
    expect((await ai.run({ command: "printf ai-command" })).stdout.trimEnd()).toBe("ai-command");
  } finally {
    await session.destroy();
  }
}

async function verifyHarness(provider: SandboxProvider<unknown>, name: string) {
  const harness = createSandboxHarnessProvider({ provider });
  const sessionId = `live-harness-${name.toLowerCase()}-${crypto.randomUUID()}`;
  const first = await harness.createSession({ sessionId });
  try {
    await first.writeTextFile({ path: "harness-live.txt", content: `${name}-harness` });
    await first.stop();
    const resumed = await harness.resumeSession!({ sessionId });
    expect(await resumed.readTextFile({ path: "harness-live.txt" })).toBe(`${name}-harness`);
    await resumed.destroy?.();
  } catch (error) {
    try {
      await first.destroy?.();
    } catch {}
    throw error;
  }
}

async function verifyEve(provider: SandboxProvider<unknown>, name: string) {
  const backend = createEveSandboxBackend({ provider });
  const templateKey = `live-${name.toLowerCase()}-${crypto.randomUUID()}`;
  const sessionKey = `live-eve-${name.toLowerCase()}-${crypto.randomUUID()}`;
  const templateSessionId = `eve-template-${templateKey}`;
  try {
    expect(
      await backend.prewarm({
        templateKey,
        runtimeContext: { appRoot: "/tmp/app" },
        seedFiles: [{ path: "seed.txt", content: `${name}-seed` }],
        async bootstrap({ use }) {
          await (await use()).writeTextFile({ path: "boot.txt", content: `${name}-boot` });
        },
      }),
    ).toEqual({ reused: false });

    const first = await backend.create({
      templateKey,
      sessionKey,
      runtimeContext: { appRoot: "/tmp/app" },
    });
    expect(await first.session.readTextFile({ path: "seed.txt" })).toBe(`${name}-seed`);
    expect(await first.session.readTextFile({ path: "boot.txt" })).toBe(`${name}-boot`);
    await first.session.writeTextFile({ path: "eve-live.txt", content: `${name}-eve` });
    const state = await first.captureState();
    await first.shutdown();

    const resumed = await backend.create({
      templateKey,
      sessionKey,
      existingMetadata: state.metadata,
      runtimeContext: { appRoot: "/tmp/app" },
    });
    expect(await resumed.session.readTextFile({ path: "eve-live.txt" })).toBe(`${name}-eve`);
    await resumed.shutdown();
  } finally {
    await destroyManaged(provider, sessionKey);
    await destroyManaged(provider, templateSessionId);
  }
}

async function destroyManaged(provider: SandboxProvider<unknown>, sessionId: string) {
  try {
    const session = await provider.managed!.resume({ sessionId });
    await session.destroy();
  } catch (error) {
    if (isSandboxError(error) && error.code === "not_found") return;
    throw error;
  }
}

function vercelProvider(): SandboxProvider<unknown> {
  const options = { persistent: true };
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
