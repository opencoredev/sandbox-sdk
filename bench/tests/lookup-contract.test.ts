/**
 * Contract: for every provider with an exact lookup, the lookup reaches the endpoint, with the
 * credential and scope, that the SDK adapter itself uses, across the environments the bench can
 * run with. The lookup answers "not found" from that endpoint, so any difference can read a live
 * sandbox as gone. Each case observes the adapter's own request on the wire and the client the
 * lookup builds, and compares the two.
 */
import { createServer as createH2Server, type ServerHttp2Session } from "node:http2";
import { ConnectionConfig } from "e2b";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { resolveConfig as basetenConfig } from "@opencoredev/sandbox-sdk/baseten";
import { beam } from "@opencoredev/sandbox-sdk/beam";
import { boat } from "@opencoredev/sandbox-sdk/boat";
import { resolveConfig as boxdConfig } from "@opencoredev/sandbox-sdk/boxd";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";
import { freestyle } from "@opencoredev/sandbox-sdk/freestyle";
import { instabox } from "@opencoredev/sandbox-sdk/instabox";
import { superserve } from "@opencoredev/sandbox-sdk/superserve";
import { tenki } from "@opencoredev/sandbox-sdk/tenki";
import { upstash } from "@opencoredev/sandbox-sdk/upstash";
import { vercel } from "@opencoredev/sandbox-sdk/vercel";
import type { Json } from "../src/json.js";
import { lookupSandbox } from "../src/existence.js";
import { bound, fakeNativeModules } from "./native-fakes.js";

const id = "fixture";

/** An upper bound for one lookup, loose enough for a loaded host; a fixture answers at once. */
const budget = 10_000;

/** Where a request went and as whom. `endpoint` is the base URL the resource path was appended to. */
interface Target {
  endpoint: string;
  credential: string;
  scope: Record<string, string>;
}

type Env = Record<string, string>;

/** Every variable the matrix sets, cleared first so the developer's environment cannot leak in. */
const providerEnv = [
  "BASETEN_API_KEY",
  "BEAM_TOKEN",
  "BEAM_WORKSPACE_ID",
  "BOAT_API_KEY",
  "BOAT_API_BASE",
  "BOXD_API_KEY",
  "BOXD_BASE_URL",
  "BOXD_API_URL",
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
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_ENVIRONMENT",
  "SUPERSERVE_API_KEY",
  "SUPERSERVE_BASE_URL",
  "LUXOR_API_ENDPOINT",
  "LUXOR_API_URL",
  "TENKI_API_KEY",
  "TENKI_AUTH_TOKEN",
  "TENKI_API_ENDPOINT",
  "TENKI_API_URL",
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

function setEnv(env: Env) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

/** The credential in a request's headers, without its scheme. */
function credentialOf(headers: Headers) {
  const value =
    headers.get("x-api-key") ?? headers.get("x-box-api-key") ?? headers.get("authorization") ?? "";

  return value.replace(/^Bearer /, "");
}

/**
 * Stub fetch, answer every request from `body`, and record the target of each request whose path
 * ends with one of `resources`: the URL before the resource is the endpoint.
 */
function recordFetch(
  resources: string | string[],
  body: (url: URL) => Json,
  scopeKeys: string[] = [],
) {
  const targets: Target[] = [];

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
    const resource = [resources].flat().find((path) => url.pathname.endsWith(path));

    if (resource !== undefined) {
      const scope: Record<string, string> = {};

      for (const key of scopeKeys) {
        const value = url.searchParams.get(key) ?? headers.get(key);

        if (value !== null) scope[key] = value;
      }

      targets.push({
        endpoint: url.href.slice(0, url.href.lastIndexOf(resource)),
        credential: credentialOf(headers),
        scope,
      });
    }

    return Response.json(body(url));
  });

  return targets;
}

/** A provider with this name whose other members are inert: the lookup only reads `name`. */
const named = (name: string): Provider => bound({ ...memory(), name });

/** The first argument of a fake native constructor's or method's `index`-th call. */
const argument = (mock: { mock: { calls: unknown[][] } }, position = 0) =>
  mock.mock.calls[0]?.[position];

describe("Boat", () => {
  const base = "https://boat.fixture/api/v1";

  it.each<[string, Env]>([
    ["default endpoint", { BOAT_API_KEY: "k1" }],
    ["override", { BOAT_API_KEY: "k1", BOAT_API_BASE: base }],
    ["override with a trailing slash", { BOAT_API_KEY: "k1", BOAT_API_BASE: `${base}/` }],
    ["override with several slashes", { BOAT_API_KEY: "k1", BOAT_API_BASE: `${base}///` }],
  ])("%s", async (_, env) => {
    setEnv(env);

    const adapter = recordFetch(`/sandboxes/${id}`, () => ({
      sandbox: { id, state: "running" },
    }));

    await boat().api.request("GET", `/sandboxes/${id}`);
    const Configuration = vi.fn();

    fakeNativeModules({
      "@boatdev/sdk": {
        Configuration,
        BoatApi: vi.fn(function () {
          return { get: vi.fn().mockResolvedValue({ sandbox: { id, state: "running" } }) };
        }),
      },
    });
    expect((await lookupSandbox(named("boat"), id, budget)).result).toBe("present");

    // @boatdev/sdk appends the path to basePath verbatim.
    const params = z
      .object({ basePath: z.string(), accessToken: z.string() })
      .parse(argument(Configuration));

    expect({ endpoint: params.basePath, credential: params.accessToken, scope: {} }).toEqual(
      adapter[0],
    );
  });
});

describe("Daytona", () => {
  const base = "https://daytona.fixture/api";

  it.each<[string, Env]>([
    ["default endpoint", { DAYTONA_API_KEY: "k1" }],
    ["API URL", { DAYTONA_API_KEY: "k1", DAYTONA_API_URL: base }],
    ["API URL with a trailing slash", { DAYTONA_API_KEY: "k1", DAYTONA_API_URL: `${base}/` }],
    ["API URL with several slashes", { DAYTONA_API_KEY: "k1", DAYTONA_API_URL: `${base}///` }],
    ["server URL alias", { DAYTONA_API_KEY: "k1", DAYTONA_SERVER_URL: `${base}/` }],
    ["region", { DAYTONA_API_KEY: "k1", DAYTONA_TARGET: "eu" }],
    [
      "JWT with organization",
      { DAYTONA_JWT_TOKEN: "jwt1", DAYTONA_ORGANIZATION_ID: "org1", DAYTONA_API_URL: `${base}/` },
    ],
  ])("%s", async (_, env) => {
    setEnv(env);

    const adapter = recordFetch(`/sandbox/${id}`, () => ({ id, state: "started" }), [
      "x-daytona-organization-id",
    ]);

    await daytona().api.request("GET", `/sandbox/${id}`);

    const Daytona = vi.fn(function () {
      return {
        sandboxApi: { getSandbox: vi.fn().mockResolvedValue({ data: { id, state: "started" } }) },
        snapshot: { get: vi.fn(), list: vi.fn(), delete: vi.fn() },
        get: vi.fn(),
      };
    });

    fakeNativeModules({ "@daytonaio/sdk": { Daytona } });
    expect((await lookupSandbox(named("daytona"), id, budget)).result).toBe("present");

    const config = z
      .object({
        apiUrl: z.string(),
        apiKey: z.string().optional(),
        jwtToken: z.string().optional(),
        organizationId: z.string().optional(),
      })
      .parse(argument(Daytona));

    // The generated client appends `/sandbox/<id>` to apiUrl verbatim.
    expect({
      endpoint: config.apiUrl,
      credential: config.apiKey ?? config.jwtToken,
      scope: config.organizationId ? { "x-daytona-organization-id": config.organizationId } : {},
    }).toEqual(adapter[0]);
  });
});

describe("E2B", () => {
  it.each<[string, Env]>([
    ["default domain", { E2B_API_KEY: "k1" }],
    ["self-hosted domain", { E2B_API_KEY: "k1", E2B_DOMAIN: "e2b.fixture" }],
    ["API URL", { E2B_API_KEY: "k1", E2B_API_URL: "https://api.e2b.fixture" }],
    ["API URL with slashes", { E2B_API_KEY: "k1", E2B_API_URL: "https://api.e2b.fixture//" }],
    ["debug flag", { E2B_API_KEY: "k1", E2B_DOMAIN: "e2b.fixture", E2B_DEBUG: "true" }],
    [
      "debug flag with an API URL",
      { E2B_API_KEY: "k1", E2B_DEBUG: "true", E2B_API_URL: "https://api.e2b.fixture/" },
    ],
  ])("%s", async (_, env) => {
    setEnv(env);
    const adapter = recordFetch(`/sandboxes/${id}`, () => ({ sandboxID: id, state: "running" }));
    await e2b().api.request("GET", `/sandboxes/${id}`);
    const getInfo = vi.fn().mockResolvedValue({ sandboxId: id, state: "running" });

    fakeNativeModules({
      e2b: {
        Sandbox: { getInfo, listSnapshots: vi.fn(), deleteSnapshot: vi.fn() },
        SandboxNotFoundError: class extends Error {},
      },
    });
    expect((await lookupSandbox(named("e2b"), id, budget)).result).toBe("present");

    // The e2b package's own resolution of the options the lookup passed.
    const opts = z
      .object({ apiKey: z.string(), domain: z.string(), apiUrl: z.string() })
      .parse(argument(getInfo, 1));

    const config = new ConnectionConfig(opts);
    expect({ endpoint: config.apiUrl, credential: config.apiKey, scope: {} }).toEqual(adapter[0]);
  });
});

describe("Freestyle", () => {
  it("default endpoint", async () => {
    setEnv({ FREESTYLE_API_KEY: "k1" });
    const adapter = recordFetch(`/v5/vms/${id}`, () => ({ id, state: "running" }));
    await freestyle().api.request("GET", `/v5/vms/${id}`);

    const Freestyle = vi.fn(function () {
      return {
        vms: {
          get: vi.fn().mockResolvedValue({ id, state: "running" }),
          snapshots: { get: vi.fn(), delete: vi.fn() },
        },
      };
    });

    fakeNativeModules({ freestyle: { Freestyle } });
    expect((await lookupSandbox(named("freestyle"), id, budget)).result).toBe("present");

    const options = z
      .object({ apiKey: z.string(), baseUrl: z.string() })
      .parse(argument(Freestyle));

    expect({ endpoint: options.baseUrl, credential: options.apiKey, scope: {} }).toEqual(
      adapter[0],
    );
  });
});

/** Cases for a provider whose lookup is a raw GET: both sides are observed on the wire. */
function wireCases(
  provider: string,
  read: () => Promise<void>,
  make: () => Provider,
  resource: string,
  body: Json,
  cases: [string, Env][],
) {
  describe(provider, () => {
    it.each(cases)("%s", async (_, env) => {
      setEnv(env);
      const targets = recordFetch(resource, () => body);
      await read().catch(() => undefined);
      const [own] = targets;
      expect(own).toBeDefined();
      expect((await lookupSandbox(bound(make()), id, budget)).result).toBe("present");
      expect(targets.at(-1)).toEqual(own);
    });
  });
}

const liveKey = (region: string) => `ss_live_${region}_${"a".repeat(32)}`;

wireCases(
  "Superserve",
  async () => {
    await superserve().api.request("GET", `/sandboxes/${id}`);
  },
  () => superserve(),
  `/sandboxes/${id}`,
  { id, status: "active" },
  [
    ["default region", { SUPERSERVE_API_KEY: liveKey("use") }],
    ["US West key", { SUPERSERVE_API_KEY: liveKey("usw") }],
    ["override", { SUPERSERVE_API_KEY: liveKey("usw"), SUPERSERVE_BASE_URL: "https://ss.fixture" }],
    [
      "override with spaces and slashes",
      { SUPERSERVE_API_KEY: "k1", SUPERSERVE_BASE_URL: "  https://ss.fixture// " },
    ],
    ["blank override", { SUPERSERVE_API_KEY: liveKey("usw"), SUPERSERVE_BASE_URL: "  " }],
  ],
);

wireCases(
  "Instabox",
  async () => {
    await instabox()
      .native(id)
      .request({ method: "GET", path: `/v1/machines/${id}` });
  },
  () => instabox(),
  `/v1/machines/${id}`,
  { id, state: "running" },
  [
    ["default endpoint", { INSTABOX_API_KEY: "k1" }],
    ["override", { INSTABOX_API_KEY: "k1", INSTABOX_API_URL: "https://ib.fixture" }],
    ["override with slashes", { INSTABOX_API_KEY: "k1", INSTABOX_API_URL: "https://ib.fixture//" }],
    ["key with surrounding spaces", { INSTABOX_API_KEY: " k1 " }],
  ],
);

wireCases(
  "Beam",
  async () => {
    // The adapter finds a container in the gateway's listing, as the lookup does.
    await beam().connect(id);
  },
  () => beam(),
  "/api/v1/gateway/containers",
  { containers: [{ containerId: id, stubId: "stub", status: "RUNNING" }] },
  [
    ["default gateway", { BEAM_TOKEN: "t1", BEAM_WORKSPACE_ID: "ws1" }],
    ["token with surrounding spaces", { BEAM_TOKEN: " t1 ", BEAM_WORKSPACE_ID: "ws1" }],
  ],
);

describe("Upstash", () => {
  it.each<[string, Env]>([
    ["default endpoint", { UPSTASH_BOX_API_KEY: "k1" }],
    ["override", { UPSTASH_BOX_API_KEY: "k1", UPSTASH_BOX_BASE_URL: "https://up.fixture" }],
    [
      "override with a slash",
      { UPSTASH_BOX_API_KEY: "k1", UPSTASH_BOX_BASE_URL: "https://up.fixture/" },
    ],
    [
      "override with slashes",
      { UPSTASH_BOX_API_KEY: "k1", UPSTASH_BOX_BASE_URL: "https://up.fixture///" },
    ],
  ])("%s", async (_, env) => {
    setEnv(env);

    // The adapter's connect lists boxes; the lookup reads the one box.
    const targets = recordFetch(["/v2/box", `/v2/box/${id}`], (url) =>
      url.pathname.endsWith("/v2/box") ? [{ id, status: "running" }] : { id, status: "running" },
    );

    await upstash()
      .connect(id)
      .catch(() => undefined);
    const [own] = targets;
    expect(own).toBeDefined();
    expect((await lookupSandbox(named("upstash"), id, budget)).result).toBe("present");
    expect(targets.at(-1)).toEqual(own);
  });
});

describe("Vercel", () => {
  const oidc = (team: string, project: string) =>
    `e30.${Buffer.from(
      JSON.stringify({
        owner_id: team,
        project_id: project,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url")}.fixture`;

  const sandbox = {
    sandbox: {
      name: id,
      persistent: true,
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      currentSessionId: "session_fixture",
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
  };

  it.each<[string, Env]>([
    ["OIDC only", { VERCEL_OIDC_TOKEN: oidc("team_a", "prj_a") }],
    [
      "explicit token",
      { VERCEL_TOKEN: "t1", VERCEL_TEAM_ID: "team_b", VERCEL_PROJECT_ID: "prj_b" },
    ],
    [
      "explicit token beside another team's OIDC",
      {
        VERCEL_TOKEN: "t1",
        VERCEL_TEAM_ID: "team_b",
        VERCEL_PROJECT_ID: "prj_b",
        VERCEL_OIDC_TOKEN: oidc("team_a", "prj_a"),
      },
    ],
  ])("%s", async (_, env) => {
    setEnv(env);
    const targets = recordFetch(`/api/v2/sandboxes/${id}`, () => sandbox, ["teamId", "projectId"]);
    const adapter = bound(vercel());
    await adapter.connect(id);
    const [own] = targets;
    expect(own?.scope).toHaveProperty("teamId");
    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    expect(targets.at(-1)).toEqual(own);
  });
});

/** A Tenki gRPC server that records each call's token and answers one running session. */
async function tenkiServer() {
  const calls: string[] = [];

  const field = (number: number, bytes: Buffer) =>
    Buffer.concat([Buffer.from([(number << 3) | 2, bytes.length]), bytes]);

  const text = (number: number, value: string) => field(number, Buffer.from(value));

  const metadata = (key: string, value: string) =>
    field(13, Buffer.concat([text(1, key), text(2, value)]));

  const body = field(
    1,
    Buffer.concat([
      text(1, id),
      Buffer.from([0x10, 3]),
      metadata("sandbox-sdk", "1"),
      metadata("sandbox-sdk-created-at", "1760000000000"),
    ]),
  );

  const prefix = Buffer.alloc(5);
  prefix.writeUInt32BE(body.length, 1);
  const sessions = new Set<ServerHttp2Session>();
  const server = createH2Server();

  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    stream.resume();
    calls.push(String(headers.authorization).replace(/^Bearer /, ""));
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": 0 }));
    stream.end(Buffer.concat([prefix, body]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = z.object({ port: z.number() }).parse(server.address());

  return {
    endpoint: `http://127.0.0.1:${port}`,
    calls,
    async [Symbol.asyncDispose]() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("Tenki", () => {
  it.each<[string, (endpoint: string) => Env]>([
    [
      "API key only",
      (endpoint) => ({ TENKI_API_KEY: "tk_live_key", TENKI_API_ENDPOINT: endpoint }),
    ],
    [
      "auth token only",
      (endpoint) => ({ TENKI_AUTH_TOKEN: "tk_live_token", TENKI_API_ENDPOINT: endpoint }),
    ],
    [
      "auth token beside an API key",
      (endpoint) => ({
        TENKI_AUTH_TOKEN: "tk_live_token",
        TENKI_API_KEY: "tk_live_key",
        TENKI_API_URL: endpoint,
      }),
    ],
    [
      "blank auth token beside an API key",
      (endpoint) => ({
        TENKI_AUTH_TOKEN: "  ",
        TENKI_API_KEY: "tk_live_key",
        TENKI_API_ENDPOINT: endpoint,
      }),
    ],
  ])("%s", async (_, env) => {
    await using server = await tenkiServer();
    setEnv(env(server.endpoint));
    const adapter = bound(tenki());
    await adapter.list({});
    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");
    // Both reached this server (the endpoint), with the same token.
    expect(server.calls).toHaveLength(2);
    expect(new Set(server.calls).size).toBe(1);
  });
});

/*
 * boxd and Baseten speak gRPC over node:http2 and through their own fetch, which no stub here sees.
 * Their adapters build the native client from `resolveConfig`; the lookup must hand its client the
 * same values.
 */
describe("boxd", () => {
  it.each<[string, Env]>([
    ["default endpoint", { BOXD_API_KEY: "k1" }],
    ["base URL", { BOXD_API_KEY: "k1", BOXD_BASE_URL: "https://boxd.fixture/" }],
    ["API URL alias", { BOXD_API_KEY: "k1", BOXD_API_URL: "https://boxd.fixture" }],
  ])("%s", async (_, env) => {
    setEnv(env);

    const Boxd = vi.fn(function () {
      return {
        machines: { get: vi.fn().mockResolvedValue({ id, state: "running" }) },
        snapshots: { get: vi.fn(), delete: vi.fn() },
      };
    });

    fakeNativeModules({ "@boxd-sh/sdk": { Boxd } });
    expect((await lookupSandbox(named("boxd"), id, budget)).result).toBe("present");
    expect(Boxd.mock.calls).toEqual([[boxdConfig()]]);
  });
});

describe("Baseten", () => {
  it("passes the adapter's key and team", async () => {
    setEnv({ BASETEN_API_KEY: "k1" });

    const SandboxClient = vi.fn(function () {
      return { getInfo: vi.fn().mockResolvedValue({ name: id, status: "RUNNING" }) };
    });

    fakeNativeModules({ "@basetenlabs/sandbox": { SandboxClient } });
    expect((await lookupSandbox(named("baseten"), id, budget)).result).toBe("present");
    expect(SandboxClient.mock.calls).toEqual([[basetenConfig()]]);
  });
});

describe("Modal", () => {
  it("passes the bound token, secret and environment, as the adapter does", async () => {
    setEnv({ MODAL_TOKEN_ID: "id1", MODAL_TOKEN_SECRET: "secret1" });

    const ModalClient = vi.fn().mockImplementation(function () {
      return {
        sandboxes: { fromId: vi.fn().mockResolvedValue({ sandboxId: id, poll: async () => null }) },
        close: vi.fn(),
      };
    });

    fakeNativeModules({
      modal: { ModalClient, NotFoundError: class extends Error {} },
      "nice-grpc": {
        ClientError: class extends Error {
          readonly code = 0;
        },
        Status: { NOT_FOUND: 5 },
      },
    });

    const adapter = bound(
      { ...memory(), name: "modal" },
      { tokenId: "id2", tokenSecret: "secret2", environment: "env2" },
    );

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("present");

    // The bound connection plus the cancellation middleware, never the ambient id1/secret1.
    expect(Object.keys(z.object({}).loose().parse(argument(ModalClient))).sort()).toEqual([
      "environment",
      "grpcMiddleware",
      "tokenId",
      "tokenSecret",
    ]);
    expect(argument(ModalClient)).toMatchObject({
      tokenId: "id2",
      tokenSecret: "secret2",
      environment: "env2",
    });
  });
});
