/**
 * The harness reads a sandbox through the connection of the adapter instance that created it.
 * Each case builds the adapter the way the bench does (`loadProvider` with explicit factory
 * options) while the environment names another endpoint, key and scope. A read that resolved
 * from the environment would ask the wrong place and record a live sandbox as absent. Ported from
 * a review's repro (Daytona, E2B and Vercel), then widened to every provider with a connection.
 */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { ConnectionConfig } from "e2b";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { lookupSandbox } from "../src/existence.js";
import { loadProvider, type FactoryOptions } from "../src/providers.js";
import { inspectSnapshot } from "../src/snapshots.js";
import { fakeNativeModules } from "./native-fakes.js";

const id = "fixture";
const budget = 10_000;

const providerEnv = [
  "BASETEN_API_KEY",
  "BOAT_API_KEY",
  "BOAT_API_BASE",
  "BOXD_API_KEY",
  "BOXD_BASE_URL",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_SERVER_URL",
  "DAYTONA_JWT_TOKEN",
  "DAYTONA_ORGANIZATION_ID",
  "DAYTONA_TARGET",
  "E2B_API_KEY",
  "E2B_API_URL",
  "E2B_DOMAIN",
  "E2B_DEBUG",
  "FREESTYLE_API_KEY",
  "INSTABOX_API_KEY",
  "INSTABOX_API_URL",
  "SUPERSERVE_API_KEY",
  "SUPERSERVE_BASE_URL",
  "TENKI_API_KEY",
  "TENKI_AUTH_TOKEN",
  "TENKI_API_ENDPOINT",
  "UPSTASH_BOX_API_KEY",
  "UPSTASH_BOX_BASE_URL",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_OIDC_TOKEN",
];

beforeEach(() => {
  for (const key of providerEnv) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The adapter as the bench builds it: `loadProvider`, with these explicit factory options. */
async function load(name: string, factory: FactoryOptions): Promise<Provider> {
  const loaded = await loadProvider(name, process.env, undefined, {
    factory,
    template: {},
    product: {},
  });

  if (loaded.kind !== "ready") throw new Error(`${name} skipped: ${loaded.note}`);

  return loaded.provider;
}

/** The environment a conflicting case runs in: another key, endpoint and scope for everything. */
function otherEnvironment() {
  const other = {
    BASETEN_API_KEY: "other-key",
    BOAT_API_KEY: "other-key",
    BOAT_API_BASE: "https://other.invalid/boat",
    BOXD_API_KEY: "other-key",
    BOXD_BASE_URL: "https://other.invalid/boxd",
    DAYTONA_API_KEY: "other-key",
    E2B_API_KEY: "other-key",
    E2B_DOMAIN: "other.invalid",
    FREESTYLE_API_KEY: "other-key",
    INSTABOX_API_KEY: "other-key",
    INSTABOX_API_URL: "https://other.invalid/instabox",
    SUPERSERVE_API_KEY: "other-key",
    SUPERSERVE_BASE_URL: "https://other.invalid/superserve",
    TENKI_API_KEY: "other-key",
    UPSTASH_BOX_API_KEY: "other-key",
    UPSTASH_BOX_BASE_URL: "https://other.invalid/upstash",
    VERCEL_TOKEN: "other-token",
    VERCEL_TEAM_ID: "team_other",
    VERCEL_PROJECT_ID: "prj_other",
  } satisfies Record<string, string>;

  for (const [key, value] of Object.entries(other)) vi.stubEnv(key, value);
}

/** Answer every fetch from `respond`, recording where each went. */
function stubFetch(respond: (url: URL, headers: Headers) => [number, object]) {
  const seen: string[] = [];

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? request?.headers);
    const [status, body] = respond(url, headers);
    seen.push(`${url.origin}${url.pathname} ${status}`);

    return Response.json(body, { status });
  });

  return seen;
}

/** The first argument of a fake native constructor's or method's `position`-th parameter. */
const argument = (mock: { mock: { calls: unknown[][] } }, position = 0) =>
  mock.mock.calls[0]?.[position];

/** The connection options a lookup handed the e2b package. */
const e2bOptions = z.object({ apiKey: z.string(), domain: z.string(), apiUrl: z.string() });

describe("lookups use the explicit options the adapter was built with, not the environment", () => {
  it("Daytona (review repro): explicit endpoint and key", async () => {
    const server = createHttpServer((request: IncomingMessage, response) => {
      const live =
        request.url === `/live/sandbox/${id}` &&
        request.headers.authorization === "Bearer live-daytona";

      const snapshot =
        request.url === `/live/snapshots/${id}` &&
        request.headers.authorization === "Bearer live-daytona";

      response.writeHead(live || snapshot ? 200 : 404, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          live
            ? { id, state: "started", createdAt: "2026-11-20T00:00:00Z" }
            : snapshot
              ? { id, sourceSandboxId: "source" }
              : { statusCode: 404, message: "Not found" },
        ),
      );
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = z.object({ port: z.number() }).parse(server.address());
    const origin = `http://127.0.0.1:${port}`;

    try {
      otherEnvironment();
      vi.stubEnv("DAYTONA_API_URL", `${origin}/other`);
      const adapter = await load("daytona", { apiKey: "live-daytona", baseUrl: `${origin}/live/` });

      expect((await adapter.connect(id)).id).toBe(id);
      expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
      expect(await inspectSnapshot("daytona", adapter, "source", id)).toEqual({
        exists: true,
        sourceId: "source",
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("E2B (review repro): explicit key and domain, with E2B_DEBUG set", async () => {
    otherEnvironment();
    vi.stubEnv("E2B_DEBUG", "true");

    const adapterSeen = stubFetch((url, headers) =>
      url.origin === "https://api.live.invalid" && headers.get("x-api-key") === "live-e2b"
        ? [200, { sandboxID: id, templateID: "base", state: "running", envdVersion: "0.2.0" }]
        : [404, { code: 404, message: "Not found" }],
    );

    // The e2b package sends through its own HTTP/2 agent, which no fetch stub sees; its real
    // ConnectionConfig resolves where a call with the lookup's options goes.
    const getInfo = vi.fn().mockResolvedValue({ sandboxId: id, state: "running" });

    fakeNativeModules({
      e2b: {
        Sandbox: { getInfo, listSnapshots: vi.fn(), deleteSnapshot: vi.fn() },
        SandboxNotFoundError: class extends Error {},
      },
    });

    const adapter = await load("e2b", { apiKey: "live-e2b", domain: "live.invalid" });

    await expect(adapter.connect(id)).resolves.toMatchObject({ id });
    expect(adapterSeen[0]).toMatch(/^https:\/\/api\.live\.invalid\/sandboxes\/fixture\S* 200$/);
    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");

    const config = new ConnectionConfig(e2bOptions.parse(argument(getInfo, 1)));

    expect([config.apiUrl, config.apiKey]).toEqual(["https://api.live.invalid", "live-e2b"]);
  });

  it("Vercel (review repro): explicit token, team and project", async () => {
    otherEnvironment();
    stubFetch((url, headers) => {
      const live =
        url.searchParams.get("teamId") === "team_live" &&
        headers.get("authorization") === "Bearer live-vercel";

      if (
        url.pathname === `/api/v2/sandboxes/${id}` &&
        live &&
        url.searchParams.get("projectId") === "prj_live"
      )
        return [
          200,
          {
            sandbox: {
              name: id,
              persistent: true,
              status: "running",
              createdAt: 1,
              updatedAt: 1,
              currentSessionId: "session_fixture",
              memory: 2048,
              vcpus: 1,
              totalActiveCpuDurationMs: 1,
              totalDurationMs: 2,
              totalIngressBytes: 0,
              totalEgressBytes: 0,
            },
            session: {
              id: "session_fixture",
              memory: 2048,
              vcpus: 1,
              region: "iad1",
              timeout: 1000,
              status: "running",
              requestedAt: 1,
              createdAt: 1,
              updatedAt: 1,
              cwd: "/workspace",
            },
            routes: [],
          },
        ];

      return [404, { error: { code: "not_found", message: "Not found" } }];
    });

    const adapter = await load("vercel", {
      token: "live-vercel",
      teamId: "team_live",
      projectId: "prj_live",
    });

    expect((await adapter.connect(id)).state).toBe("running");
    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
  });

  it("Boat: explicit base URL and key", async () => {
    otherEnvironment();
    const Configuration = vi.fn();

    const BoatApi = vi.fn(function () {
      return { get: vi.fn().mockResolvedValue({ sandbox: { id, state: "running" } }) };
    });

    fakeNativeModules({ "@boatdev/sdk": { Configuration, BoatApi } });

    const adapter = await load("boat", { apiKey: "live-key", baseUrl: "https://live.invalid/v1/" });

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect(
      z.object({ basePath: z.string(), accessToken: z.string() }).parse(argument(Configuration)),
    ).toEqual({ basePath: "https://live.invalid/v1", accessToken: "live-key" });
  });

  it("boxd: explicit endpoint and key, for lookups and snapshot reads", async () => {
    otherEnvironment();

    const Boxd = vi.fn(function () {
      return {
        machines: { get: vi.fn().mockResolvedValue({ id, state: "running" }) },
        snapshots: { get: vi.fn().mockResolvedValue({ id }), delete: vi.fn() },
      };
    });

    fakeNativeModules({ "@boxd-sh/sdk": { Boxd } });

    const adapter = await load("boxd", {
      apiKey: "live-key",
      baseUrl: "https://live.invalid/boxd",
    });

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect((await inspectSnapshot("boxd", adapter, "source", id)).exists).toBe(true);
    expect(Boxd.mock.calls).toEqual([
      [{ apiKey: "live-key", baseURL: "https://live.invalid/boxd" }],
      [{ apiKey: "live-key", baseURL: "https://live.invalid/boxd" }],
    ]);
  });

  it("Baseten: explicit key and team", async () => {
    otherEnvironment();

    const SandboxClient = vi.fn(function () {
      return { getInfo: vi.fn().mockResolvedValue({ name: id, status: "RUNNING" }) };
    });

    fakeNativeModules({ "@basetenlabs/sandbox": { SandboxClient } });

    const adapter = await load("baseten", { apiKey: "live-key", teamId: "team-live" });

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect(SandboxClient.mock.calls).toEqual([[{ apiKey: "live-key", teamId: "team-live" }]]);
  });

  it("Freestyle: explicit base URL and key", async () => {
    otherEnvironment();

    const Freestyle = vi.fn(function () {
      return {
        vms: {
          get: vi.fn().mockResolvedValue({ id, state: "running" }),
          snapshots: {
            get: vi.fn().mockResolvedValue({ id, sourceVmId: "source" }),
            delete: vi.fn(),
          },
        },
      };
    });

    fakeNativeModules({ freestyle: { Freestyle } });

    const adapter = await load("freestyle", {
      apiKey: "live-key",
      baseUrl: "https://live.invalid/fs/",
    });

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect(await inspectSnapshot("freestyle", adapter, "source", id)).toEqual({
      exists: true,
      sourceId: "source",
    });
    expect(Freestyle.mock.calls).toEqual([
      [{ apiKey: "live-key", baseUrl: "https://live.invalid/fs" }],
      [{ apiKey: "live-key", baseUrl: "https://live.invalid/fs" }],
    ]);
  });

  it("Tenki: explicit token and endpoint", async () => {
    otherEnvironment();

    const TenkiSandbox = vi.fn(function () {
      return {
        get: vi.fn().mockResolvedValue({ id, state: "running" }),
        getSnapshot: vi.fn().mockResolvedValue({ id, sessionId: "source" }),
        deleteSnapshot: vi.fn(),
      };
    });

    fakeNativeModules({ "@tenkicloud/sandbox": { TenkiSandbox } });

    const adapter = await load("tenki", { apiKey: "live-token", baseUrl: "https://live.invalid" });

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect(await inspectSnapshot("tenki", adapter, "source", id)).toEqual({
      exists: true,
      sourceId: "source",
    });
    expect(TenkiSandbox.mock.calls).toEqual([
      [{ authToken: "live-token", baseUrl: "https://live.invalid" }],
      [{ authToken: "live-token", baseUrl: "https://live.invalid" }],
    ]);
  });

  it("Upstash: explicit base URL and key, for lookups and snapshot reads", async () => {
    otherEnvironment();
    const box = { id, getStatus: vi.fn().mockResolvedValue({ status: "running" }) };
    const get = vi.fn().mockResolvedValue(box);

    fakeNativeModules({ "@upstash/box": { Box: { get, deleteSnapshots: vi.fn() } } });
    stubFetch((url, headers) =>
      url.href === "https://live.invalid/up/v2/box/snapshots" &&
      headers.get("authorization") === "Bearer live-key"
        ? [200, { snapshots: [{ id, box_id: "source" }] }]
        : [404, {}],
    );

    const adapter = await load("upstash", {
      apiKey: "live-key",
      baseUrl: "https://live.invalid/up/",
    });

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect(get.mock.calls).toEqual([
      [id, { apiKey: "live-key", baseUrl: "https://live.invalid/up/" }],
    ]);
    expect(await inspectSnapshot("upstash", adapter, "source", id)).toEqual({
      exists: true,
      sourceId: "source",
    });
  });

  it("Instabox and Superserve: explicit base URL and key on their raw reads", async () => {
    otherEnvironment();

    const seen = stubFetch((url, headers) => {
      const key = headers.get("x-api-key") === "live-key";

      if (key && url.href === `https://live.invalid/ib/v1/machines/${id}`)
        return [200, { id, state: "running" }];

      if (key && url.href === `https://live.invalid/ib/v1/snapshots/${id}`)
        return [200, { id, sourceMachineId: "source" }];

      if (key && url.href === `https://live.invalid/ss/sandboxes/${id}`)
        return [200, { id, status: "active" }];

      return [404, {}];
    });

    const instabox = await load("instabox", {
      apiKey: "live-key",
      baseUrl: "https://live.invalid/ib/",
    });

    const superserve = await load("superserve", {
      apiKey: "live-key",
      baseUrl: "https://live.invalid/ss/",
    });

    expect((await lookupSandbox(instabox, id, budget)).result).toBe("present");
    expect(await inspectSnapshot("instabox", instabox, "source", id)).toEqual({
      exists: true,
      sourceId: "source",
    });
    expect((await lookupSandbox(superserve, id, budget)).result).toBe("present");
    expect(seen.every((row) => row.endsWith(" 200"))).toBe(true);
  });
});
