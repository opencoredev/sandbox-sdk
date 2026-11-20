/**
 * Each case is a configuration in which the SDK adapter reads a live sandbox (or snapshot) and the
 * harness's own read of the same ID used to answer "not found": a trailing slash the adapter drops,
 * a scope or credential the adapter resolves differently, or a debug flag only the native client
 * reads. A false absence closes spend early and can publish a live member as died.
 */
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { createServer as createH2Server, type ServerHttp2Session } from "node:http2";
import type { AddressInfo } from "node:net";
import { ConnectionConfig, type ConnectionOpts } from "e2b";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { boat } from "@opencoredev/sandbox-sdk/boat";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";
import { e2b } from "@opencoredev/sandbox-sdk/e2b";
import { instabox } from "@opencoredev/sandbox-sdk/instabox";
import { superserve } from "@opencoredev/sandbox-sdk/superserve";
import { tenki } from "@opencoredev/sandbox-sdk/tenki";
import { upstash } from "@opencoredev/sandbox-sdk/upstash";
import { vercel } from "@opencoredev/sandbox-sdk/vercel";
import { BillingHttpError, collectProvider, vercelMeter } from "../src/billing/providers.js";
import { lookupSandbox } from "../src/existence.js";
import { inspectSnapshot, snapshotCleaner } from "../src/snapshots.js";
import { fakeNativeModules } from "./native-fakes.js";

const id = "fixture";

interface Row {
  method: string;
  url: string;
  status: number;
}

const rows: Row[] = [];

/** Every variable a case sets, cleared first so the developer's own environment cannot leak in. */
const providerEnv = [
  "BOAT_API_KEY",
  "BOAT_API_BASE",
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
  "INSTABOX_API_KEY",
  "INSTABOX_API_URL",
  "SUPERSERVE_API_KEY",
  "SUPERSERVE_BASE_URL",
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
  rows.length = 0;
  for (const key of providerEnv) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Answer every fetch from `respond`, recording each request. */
function stubFetch(respond: (url: URL, method: string, headers: Headers) => [number, unknown]) {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request ? request.url : input);
    const method = init?.method ?? request?.method ?? "GET";
    const headers = new Headers(init?.headers ?? request?.headers);
    const [status, body] = respond(url, method, headers);
    rows.push({ method, url: url.href, status });

    return Response.json(body, { status });
  });
}

/** A loopback HTTP server (for clients that do not use fetch, such as Daytona's axios client). */
async function httpServer(respond: (request: IncomingMessage) => [number, unknown]) {
  const server = createHttpServer((request, response) => {
    const [status, body] = respond(request);
    rows.push({ method: request.method ?? "", url: request.url ?? "", status });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    base: `http://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("Boat: a trailing slash on BOAT_API_BASE still reads the live sandbox", async () => {
  vi.stubEnv("BOAT_API_KEY", "fixture");
  vi.stubEnv("BOAT_API_BASE", "https://boat.fixture/api/v1/");
  stubFetch((url) =>
    url.pathname === `/api/v1/sandboxes/${id}`
      ? [200, { sandbox: { id, state: "running" } }]
      : [404, {}],
  );

  const adapter = boat();
  await adapter.api.request("GET", `/sandboxes/${id}`);
  expect((await lookupSandbox(adapter, id, 1500)).result).toBe("present");
  expect(rows.map((row) => row.url)).toEqual([
    `https://boat.fixture/api/v1/sandboxes/${id}`,
    `https://boat.fixture/api/v1/sandboxes/${id}`,
  ]);
});

it("Daytona: a trailing slash on DAYTONA_API_URL still reads the live sandbox and snapshot", async () => {
  await using server = await httpServer((request) => {
    if (request.url === `/api/sandbox/${id}`)
      return [200, { id, state: "started", createdAt: "2026-11-20T00:00:00Z" }];

    if (request.url === `/api/snapshots/${id}`) return [200, { id, sourceSandboxId: "source" }];

    return [404, { statusCode: 404, message: "Not found" }];
  });

  vi.stubEnv("DAYTONA_API_KEY", "fixture");
  vi.stubEnv("DAYTONA_API_URL", `${server.base}/api/`);

  const adapter = daytona();
  expect((await adapter.connect(id)).id).toBe(id);
  expect((await lookupSandbox(adapter, id, 1500)).result).toBe("present");
  expect(await inspectSnapshot("daytona", adapter, "source", id)).toEqual({
    exists: true,
    sourceId: "source",
  });
  expect(rows.map((row) => row.status)).toEqual([200, 200, 200]);
});

/** A Vercel OIDC token for a different team and project than the explicit token's. */
function otherOidcToken() {
  const payload = Buffer.from(
    JSON.stringify({
      owner_id: "team_other",
      project_id: "prj_other",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");

  return `e30.${payload}.fixture`;
}

/** Vercel's API: the sandbox and snapshot exist only under team_live/prj_live with the token. */
function vercelApi() {
  stubFetch((url, _method, headers) => {
    const live =
      url.searchParams.get("teamId") === "team_live" &&
      headers.get("authorization") === "Bearer token-fixture";

    if (url.pathname === `/api/v2/sandboxes/snapshots/${id}`)
      return live
        ? [
            200,
            {
              snapshot: {
                id,
                sourceSessionId: "session_fixture",
                region: "iad1",
                status: "created",
                sizeBytes: 1024,
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ]
        : [404, { error: { code: "not_found", message: "Snapshot not found in this team" } }];

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
            totalActiveCpuDurationMs: 1000,
            totalDurationMs: 2000,
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

    return [404, { error: { code: "not_found", message: "Sandbox not found in this project" } }];
  });
}

it("Vercel: lookups, snapshots and meters use the adapter's explicit token scope, not OIDC", async () => {
  vi.stubEnv("VERCEL_TOKEN", "token-fixture");
  vi.stubEnv("VERCEL_TEAM_ID", "team_live");
  vi.stubEnv("VERCEL_PROJECT_ID", "prj_live");
  vi.stubEnv("VERCEL_OIDC_TOKEN", otherOidcToken());
  vercelApi();

  const adapter = vercel();
  expect((await adapter.connect(id)).state).toBe("running");
  expect((await lookupSandbox(adapter, id, 1500)).result).toBe("present");
  expect(await inspectSnapshot("vercel", adapter, id, id)).toEqual({ exists: true });
  expect((await vercelMeter.read(id)).name).toBe(id);
  expect(rows.every((row) => row.status === 200)).toBe(true);
});

/** A Tenki gRPC server that knows the sandbox only under one bearer token. */
async function tenkiServer(liveToken: string) {
  const field = (number: number, value: string | Buffer) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;

    return Buffer.concat([Buffer.from([(number << 3) | 2, bytes.length]), bytes]);
  };

  const metadata = (key: string, value: string) =>
    field(13, Buffer.concat([field(1, key), field(2, value)]));

  const session = Buffer.concat([
    field(1, id),
    Buffer.from([0x10, 3]),
    metadata("sandbox-sdk", "1"),
    metadata("sandbox-sdk-created-at", "1760000000000"),
  ]);

  // Snapshot: id = 1, session_id = 2 (the source).
  const snapshot = Buffer.concat([field(1, id), field(2, "source")]);
  const sessions = new Set<ServerHttp2Session>();
  const server = createH2Server();

  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  server.on("stream", (stream, headers) => {
    stream.resume();
    const path = String(headers[":path"]);
    const live = headers.authorization === `Bearer ${liveToken}`;
    rows.push({ method: "POST", url: path, status: live ? 0 : 5 });

    if (!live) {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": 5 },
        { endStream: true },
      );

      return;
    }
    const body = field(1, path.endsWith("/GetSnapshot") ? snapshot : session);
    const prefix = Buffer.alloc(5);
    prefix.writeUInt32BE(body.length, 1);
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": 0 }));
    stream.end(Buffer.concat([prefix, body]));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${port}`,
    async [Symbol.asyncDispose]() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("Tenki: lookups use TENKI_AUTH_TOKEN before TENKI_API_KEY, as the adapter does", async () => {
  await using server = await tenkiServer("tk_live_fixture");
  vi.stubEnv("TENKI_API_ENDPOINT", server.endpoint);
  vi.stubEnv("TENKI_AUTH_TOKEN", "tk_live_fixture");
  vi.stubEnv("TENKI_API_KEY", "tk_other_fixture");

  const adapter = tenki();
  expect((await adapter.list({})).map((box) => box.id)).toContain(id);
  expect((await lookupSandbox(adapter, id, 2000)).result).toBe("present");
  expect(await inspectSnapshot("tenki", adapter, "source", id)).toEqual({
    exists: true,
    sourceId: "source",
  });

  // With only the auth token, the adapter works, so the lookup must too.
  vi.stubEnv("TENKI_API_KEY", undefined);
  expect((await lookupSandbox(adapter, id, 2000)).result).toBe("present");
  expect(rows.map((row) => row.status)).toEqual([0, 0, 0, 0]);
});

it("E2B: E2B_DEBUG does not move the lookup to localhost while the adapter uses the domain", async () => {
  vi.stubEnv("E2B_API_KEY", "fixture");
  vi.stubEnv("E2B_DOMAIN", "fixture.invalid");
  vi.stubEnv("E2B_DEBUG", "true");
  stubFetch((url) =>
    url.origin === "https://api.fixture.invalid" && url.pathname === `/sandboxes/${id}`
      ? [200, { sandboxID: id, templateID: "base", state: "running" }]
      : [404, { code: 404, message: "Not found" }],
  );

  // The e2b package sends API calls through its own HTTP/2 agent, which no fetch stub sees. Its
  // real ConnectionConfig resolves where a call with these options would go.
  class NotFound extends Error {}

  fakeNativeModules({
    e2b: {
      Sandbox: {
        async getInfo(sandboxId: string, opts?: ConnectionOpts) {
          const target = new ConnectionConfig(opts).apiUrl;
          rows.push({ method: "GET", url: `${target}/sandboxes/${sandboxId}`, status: 0 });

          if (target !== "https://api.fixture.invalid") throw new NotFound();

          return { sandboxId, state: "running" };
        },
        listSnapshots: vi.fn(),
        deleteSnapshot: vi.fn(),
      },
      SandboxNotFoundError: NotFound,
    },
  });

  const adapter = e2b();
  await adapter.api.request("GET", `/sandboxes/${id}`);
  expect((await lookupSandbox(adapter, id, 1500)).result).toBe("present");
  expect(rows.map((row) => row.url)).toEqual([
    `https://api.fixture.invalid/sandboxes/${id}`,
    `https://api.fixture.invalid/sandboxes/${id}`,
  ]);
});

it("Instabox: snapshot read and delete drop a trailing slash like the adapter", async () => {
  vi.stubEnv("INSTABOX_API_KEY", "fixture");
  vi.stubEnv("INSTABOX_API_URL", "https://instabox.fixture/");
  stubFetch((url, method) =>
    url.pathname === `/v1/snapshots/${id}`
      ? [200, method === "DELETE" ? {} : { id, sourceMachineId: "source" }]
      : [404, {}],
  );

  const adapter = instabox();
  expect(await inspectSnapshot("instabox", adapter, "source", id)).toEqual({
    exists: true,
    sourceId: "source",
  });
  await (
    await snapshotCleaner("instabox", adapter, "source")
  )(id);
  expect(rows.map((row) => row.status)).toEqual([200, 200]);
});

it("Instabox: billing reads the machine through the adapter's base URL", async () => {
  vi.stubEnv("INSTABOX_API_KEY", "fixture");
  vi.stubEnv("INSTABOX_API_URL", "https://instabox.fixture/");

  const seen: string[] = [];

  const billing = await collectProvider(
    "instabox",
    [
      {
        provider: "instabox",
        id,
        startedAt: "2026-11-18T10:00:00.000Z",
        finishedAt: "2026-11-18T10:05:00.000Z",
        confirmedStopAt: null,
        app: null,
        scenarios: new Set(["sandbox-lifetime"]),
      },
    ],
    process.env,
    async (request) => {
      const url = new URL(request);
      seen.push(url.pathname);

      if (url.pathname === `/v1/machines/${id}`) return { id, state: "running" };

      if (url.pathname === `/v1/machines/${id}/usage`)
        return {
          from: "2026-11-17T12:00:00Z",
          to: "2026-11-18T13:47:49Z",
          runningSeconds: 100,
          vcpuSeconds: 400,
          memGiBSeconds: 800,
          diskGiBSeconds: 2000,
          egressBytes: 3605,
        };
      throw new BillingHttpError(404);
    },
  );

  // A live machine's usage is still accruing: it must not be marked complete.
  expect(billing.sandboxes[0]?.cost).toMatchObject({ kind: "metered", complete: false });
  expect(seen).toEqual([`/v1/machines/${id}`, `/v1/machines/${id}/usage`]);
});

it("Upstash: the snapshot listing drops a trailing slash like the adapter", async () => {
  vi.stubEnv("UPSTASH_BOX_API_KEY", "fixture");
  vi.stubEnv("UPSTASH_BOX_BASE_URL", "https://upstash.fixture/");
  stubFetch((url) =>
    url.pathname === "/v2/box/snapshots"
      ? [200, { snapshots: [{ id, box_id: "source" }] }]
      : [404, {}],
  );

  expect(await inspectSnapshot("upstash", upstash(), "source", id)).toEqual({
    exists: true,
    sourceId: "source",
  });
});

it("Superserve: snapshot reads drop a trailing slash like the adapter", async () => {
  vi.stubEnv("SUPERSERVE_API_KEY", "fixture");
  vi.stubEnv("SUPERSERVE_BASE_URL", "https://superserve.fixture/");
  stubFetch((url) =>
    url.pathname === `/snapshots/${id}`
      ? [200, { id, sandbox_id: "source", status: "ready", created_at: "2026-11-20T00:00:00Z" }]
      : [404, { error: { code: "not_found", message: "Not found" } }],
  );

  const adapter = superserve();
  await adapter.api.request("GET", `/snapshots/${id}`);
  expect(await inspectSnapshot("superserve", adapter, "source", id)).toEqual({
    exists: true,
    sourceId: "source",
  });
  expect(rows.map((row) => row.status)).toEqual([200, 200]);
});
