import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { z } from "zod";
import type { BoxdOptions as BoxdClientOptions } from "@boxd-sh/sdk";
import { e2b } from "../src/providers/e2b/index.js";
import { boxd } from "../src/providers/boxd/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { boat } from "../src/providers/boat/index.js";
import { tenki } from "../src/providers/tenki/index.js";
import { freestyle } from "../src/providers/freestyle/index.js";
import { superserve } from "../src/providers/superserve/index.js";
import { upstash } from "../src/providers/upstash/index.js";
import { boxd as mockBoxd, MockBoxd } from "./cloud-guest-mock.js";
import { tenki as mockTenki, tenkiState, cleanupTenki } from "./tenki-mock.js";
import { fakeServer } from "./http-fake.js";

const boxdConfigs: BoxdClientOptions[] = [];

/** Records the options the adapter passes to the boxd client. */
class RecordingBoxd extends MockBoxd {
  constructor(config: BoxdClientOptions) {
    super();
    boxdConfigs.push(config);
  }
}

const e2bKeys: (string | null)[] = [];
const realFetch = globalThis.fetch;

/** E2B speaks HTTP directly: record the key each control-plane call sends and answer an empty list. */
async function fetchE2B(input: string | URL | Request, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : input);

  // Local fake servers (other providers' tests) pass through; everything else stays offline.
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return realFetch(input, init);

  if (url.hostname !== "api.e2b.app")
    throw new TypeError("fetch failed: the network is blocked in this test");

  e2bKeys.push(new Headers(init?.headers).get("x-api-key"));

  return Response.json([]);
}

const boatRequest = z.object({ type: z.string() });

/** Boat calls its API with fetch: record each request, list nothing, and refuse every create with a 400. */
function stubBoatFetch() {
  const requests: { origin: string; method: string; type?: string }[] = [];

  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const origin = new URL(url).origin;

    if (method !== "POST") {
      requests.push({ origin, method });
      return Response.json({ ok: true, sandboxes: [], pageInfo: { hasMore: false } });
    }

    const body = boatRequest.parse(JSON.parse(z.string().parse(init.body)));
    requests.push({ origin, method, type: body.type });

    return Response.json({ ok: false, code: "invalid_request" }, { status: 400 });
  });

  return requests;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchE2B);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  boxdConfigs.length = 0;
  e2bKeys.length = 0;
  await cleanupTenki();
});

test("boxd endpoint alias works and baseUrl wins", async () => {
  await mockBoxd({ apiKey: "offline", baseURL: "https://old.test" }, RecordingBoxd).list({});
  await mockBoxd(
    { apiKey: "offline", baseURL: "https://old.test", baseUrl: "https://new.test" },
    RecordingBoxd,
  ).list({});
  expect(boxdConfigs).toMatchObject([
    { baseURL: "https://old.test" },
    { baseURL: "https://new.test" },
  ]);
});

test("daytona endpoint alias works and baseUrl wins", async () => {
  const old = await fakeServer();
  const next = await fakeServer();

  try {
    for (const server of [old, next])
      server.on("GET /api/sandbox", { json: { items: [], nextCursor: null } });

    await daytona({ apiKey: "offline", apiUrl: `${old.url}/api` }).list({});
    await daytona({
      apiKey: "offline",
      apiUrl: `${old.url}/api`,
      baseUrl: `${next.url}/api`,
    }).list({});
    expect([old.requests.length, next.requests.length]).toEqual([1, 1]);
  } finally {
    await old.close();
    await next.close();
  }
});

test("boat endpoint alias works and baseUrl wins", async () => {
  const requests = stubBoatFetch();
  await boat({ apiKey: "offline", apiUrl: "https://old.test" }).list({});
  await boat({
    apiKey: "offline",
    apiUrl: "https://old.test",
    baseUrl: "https://new.test",
  }).list({});
  expect(requests.map((request) => request.origin)).toEqual([
    "https://old.test",
    "https://new.test",
  ]);
});

test("Tenki authToken alias works and apiKey wins", async () => {
  await mockTenki({ authToken: "old" }).list({});
  await mockTenki({ apiKey: "new", authToken: "old" }).list({});
  expect(tenkiState.configs).toMatchObject([{ authToken: "old" }, { authToken: "new" }]);
});

test("Boat type alias works, machine wins, and per-create size still wins", async () => {
  const requests = stubBoatFetch();

  for (const [options, size] of [
    [{ type: "small" }, undefined],
    [{ machine: "large", type: "small" }, undefined],
    [{ machine: "large", type: "small" }, "medium"],
  ] as const) {
    await expect(
      boat({ apiKey: "offline", ...options }).create({ labels: {}, size }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }

  expect(
    requests.filter((request) => request.method === "POST").map((request) => request.type),
  ).toEqual(["small", "large", "default"]);
});

for (const [name, factory, env, label, next] of [
  ["e2b", e2b, "E2B_API_KEY", "E2B", "E2B_API_KEY"],
  ["boxd", boxd, "BOXD_API_KEY", "boxd", "BOXD_API_KEY"],
  ["daytona", daytona, "DAYTONA_API_KEY", "Daytona", "DAYTONA_API_KEY"],
  ["boat", boat, "BOAT_API_KEY", "Boat", "BOAT_API_KEY"],
  ["tenki", tenki, "TENKI_API_KEY", "Tenki", "TENKI_API_KEY or TENKI_AUTH_TOKEN"],
  ["freestyle", freestyle, "FREESTYLE_API_KEY", "Freestyle", "FREESTYLE_API_KEY"],
  ["superserve", superserve, "SUPERSERVE_API_KEY", "Superserve", "SUPERSERVE_API_KEY"],
  ["upstash", upstash, "UPSTASH_BOX_API_KEY", "Upstash Box", "UPSTASH_BOX_API_KEY"],
] as const) {
  test(`${name} constructs freely and reports missing credentials on first use`, async () => {
    vi.stubEnv(env, "");
    vi.stubEnv("TENKI_AUTH_TOKEN", "");
    const provider = factory();
    await expect(provider.list({})).rejects.toMatchObject({
      code: "auth",
      provider: name,
      message: `${label} API key is missing. Authentication is required. Set ${next} or pass apiKey.`,
    });
  });
}

test.each(["create", "connect", "list"] as const)(
  "E2B %s checks credentials before a native call",
  async (operation) => {
    vi.stubEnv("E2B_API_KEY", "");

    const provider = e2b();

    const result =
      operation === "create"
        ? provider.create({ labels: {} })
        : operation === "connect"
          ? provider.connect("id")
          : provider.list({});

    await expect(result).rejects.toMatchObject({ code: "auth" });
    expect(e2bKeys).toEqual([]);
  },
);

test("E2B reads env after construction and allows retry after missing credentials", async () => {
  vi.stubEnv("E2B_API_KEY", "");
  const provider = e2b();
  await expect(provider.list({})).rejects.toMatchObject({ code: "auth" });
  vi.stubEnv("E2B_API_KEY", "late-key");
  expect(await provider.list({})).toEqual([]);
  expect(e2bKeys).toEqual(["late-key"]);
});
