// Every built-in adapter's optional methods must agree with its declared capabilities, in both directions.
import { describe, expect, test } from "vitest";
import { createSandbox, SandboxError } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { Provider } from "../src/provider.js";
import { createAgentosProvider, createRegistry } from "../src/providers/agentos/provider.js";
import { createBasetenProvider } from "../src/providers/baseten/provider.js";
import { createBeamProvider } from "../src/providers/beam/provider.js";
import { boat } from "../src/providers/boat/index.js";
import { createBoxdProvider } from "../src/providers/boxd/provider.js";
import { daytona } from "../src/providers/daytona/index.js";
import { e2b } from "../src/providers/e2b/index.js";
import { freestyle } from "../src/providers/freestyle/index.js";
import { instabox } from "../src/providers/instabox/index.js";
import { local } from "../src/providers/local/index.js";
import { createModalProvider } from "../src/providers/modal/provider.js";
import { createRailwayProvider } from "../src/providers/railway/provider.js";
import { sandboxer } from "../src/providers/sandboxer/index.js";
import { superserve } from "../src/providers/superserve/index.js";
import { createTenkiProvider } from "../src/providers/tenki/provider.js";
import { createUpstashProvider } from "../src/providers/upstash/provider.js";
import { createVercelProvider } from "../src/providers/vercel/provider.js";

const key = "offline-check";

/** Stands in for a peer SDK import. An aborted create never reaches it. */
async function unreachable(): Promise<never> {
  throw new Error("The transport must not be reached");
}

function noTransfers(): never {
  throw new Error("File transfers must not be reached");
}

const adapters: [string, () => Provider][] = [
  ["local", () => local({ dockerHost: "unix:///nonexistent/docker.sock" })],
  ["agentos", () => createAgentosProvider({}, unreachable, createRegistry())],
  ["e2b", () => e2b({ apiKey: key })],
  ["vercel", () => createVercelProvider(unreachable, { token: key, teamId: key, projectId: key })],
  [
    "vercel (not persistent)",
    () =>
      createVercelProvider(unreachable, {
        token: key,
        teamId: key,
        projectId: key,
        persistent: false,
      }),
  ],
  ["modal", () => createModalProvider(unreachable)],
  ["baseten", () => createBasetenProvider({ apiKey: key }, unreachable)],
  ["daytona", () => daytona({ apiKey: key })],
  ["upstash", () => createUpstashProvider({ apiKey: key }, unreachable)],
  [
    "upstash (ephemeral)",
    () => createUpstashProvider({ apiKey: key, ephemeral: true }, unreachable),
  ],
  ["railway", () => createRailwayProvider({ token: key, environmentId: key }, unreachable)],
  ["boat", () => boat({ apiKey: key })],
  ["sandboxer", () => sandboxer({ apiKey: key })],
  ["tenki", () => createTenkiProvider({ apiKey: key }, unreachable)],
  ["superserve", () => superserve({ apiKey: key })],
  ["boxd", () => createBoxdProvider({ apiKey: key }, unreachable, noTransfers)],
  ["freestyle", () => freestyle({ apiKey: key })],
  ["instabox", () => instabox({ apiKey: key, baseUrl: "https://offline.invalid" })],
  ["beam", () => createBeamProvider({ token: key, workspaceId: key }, unreachable)],
  ["memory", () => memory()],
];

/** Runs createSandbox's validation without creating anything: an aborted signal stops right after it. */
async function validation(provider: Provider) {
  const signal = AbortSignal.abort();

  try {
    await createSandbox(provider, { signal });
  } catch (error) {
    return error;
  }

  return undefined;
}

describe("adapter capabilities match their methods", () => {
  test.each(adapters)("%s", async (_name, build) => {
    expect(await validation(build())).toMatchObject({ code: "aborted" });
  });
});

describe("createSandbox rejects an adapter whose capabilities and methods disagree", () => {
  test("a method without its capability is a provider error, not a silently missing method", async () => {
    const provider = memory();
    provider.snapshot = async () => ({ id: "snap" });

    const error = await validation(provider);

    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({
      code: "provider",
      message: expect.stringContaining('implements snapshot but does not declare "snapshot"'),
    });
  });

  test("half of a pause pair without the capability is rejected too", async () => {
    const provider = memory();
    provider.resume = async () => {};

    expect(await validation(provider)).toMatchObject({
      code: "provider",
      message: expect.stringContaining('implements resume but does not declare "pause"'),
    });
  });

  test("a declared capability without its method is still rejected", async () => {
    const base = memory();
    const provider: Provider = { ...base, capabilities: new Set(["terminal"]) };

    expect(await validation(provider)).toMatchObject({
      code: "provider",
      message: expect.stringContaining('declares "terminal" but does not implement terminal'),
    });
  });
});
