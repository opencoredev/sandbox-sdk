import { afterEach, expect, test, vi } from "vitest";
import { e2b } from "../src/providers/e2b/index.js";
import { boxd } from "../src/providers/boxd/index.js";
import { daytona } from "../src/providers/daytona/index.js";
import { boat } from "../src/providers/boat/index.js";
import { tenki } from "../src/providers/tenki/index.js";
import { freestyle } from "../src/providers/freestyle/index.js";
import { superserve } from "../src/providers/superserve/index.js";
import { upstash } from "../src/providers/upstash/index.js";
import { fakeServer } from "./http-fake.js";

const state = vi.hoisted(() => ({ configs: [] as unknown[], creates: [] as unknown[] }));
vi.mock("@boxd-sh/sdk", () => ({ Boxd: class {
  constructor(config: unknown) { state.configs.push(config); }
  machines = { list: async () => [] };
} }));
vi.mock("@tenkicloud/sandbox", () => ({ TenkiSandbox: class {
  constructor(config: unknown) { state.configs.push(config); }
  async list() { return []; }
} }));
vi.mock("e2b", () => ({ Sandbox: class {
  static list(config: unknown) {
    state.configs.push(config);
    return { hasNext: false };
  }
} }));
afterEach(() => { vi.unstubAllEnvs(); state.configs.length = 0; state.creates.length = 0; });

test("boxd endpoint alias works and baseUrl wins", async () => {
  await boxd({ apiKey: "offline", baseURL: "https://old.test" }).list({});
  await boxd({ apiKey: "offline", baseURL: "https://old.test", baseUrl: "https://new.test" }).list({});
  expect(state.configs).toMatchObject([{ baseURL: "https://old.test" }, { baseURL: "https://new.test" }]);
});
test("daytona endpoint alias works and baseUrl wins", async () => {
  const [old, next] = [await fakeServer(), await fakeServer()];
  try {
    for (const server of [old, next]) server.on("GET /api/sandbox", { json: { items: [], nextCursor: null } });
    await daytona({ apiKey: "offline", apiUrl: `${old.url}/api` }).list({});
    await daytona({ apiKey: "offline", apiUrl: `${old.url}/api`, baseUrl: `${next.url}/api` }).list({});
    expect([old.requests.length, next.requests.length]).toEqual([1, 1]);
  } finally { await old.close(); await next.close(); }
});
test("Tenki authToken alias works and apiKey wins", async () => {
  await tenki({ authToken: "old" }).list({});
  await tenki({ apiKey: "new", authToken: "old" }).list({});
  expect(state.configs).toMatchObject([{ authToken: "old" }, { authToken: "new" }]);
});
/** Boat calls its API with fetch: record each request, list nothing, and refuse every create with a 400. */
function stubBoatFetch() {
  const requests: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    requests.push({ url, method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (method === "POST") return Response.json({ ok: false, code: "invalid_request" }, { status: 400 });
    return Response.json({ ok: true, sandboxes: [], pageInfo: { hasMore: false } });
  });
  return requests;
}
afterEach(() => { vi.unstubAllGlobals(); });

test("boat endpoint alias works and baseUrl wins", async () => {
  const requests = stubBoatFetch();
  await boat({ apiKey: "offline", apiUrl: "https://old.test" }).list({});
  await boat({ apiKey: "offline", apiUrl: "https://old.test", baseUrl: "https://new.test" }).list({});
  expect(requests.map(request => new URL(request.url).origin)).toEqual(["https://old.test", "https://new.test"]);
});

test("Boat type alias works, machine wins, and per-create size still wins", async () => {
  const requests = stubBoatFetch();
  for (const [options, size] of [
    [{ type: "small" }, undefined],
    [{ machine: "large", type: "small" }, undefined],
    [{ machine: "large", type: "small" }, "medium"],
  ] as const) {
    await expect(boat({ apiKey: "offline", ...options }).create({ labels: {}, size })).rejects.toMatchObject({ code: "invalid_argument" });
  }
  expect(requests.filter(request => request.method === "POST").map(request => request.body)).toMatchObject([
    { type: "small" },
    { type: "large" },
    { type: "default" },
  ]);
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
    vi.stubEnv(env, ""); vi.stubEnv("TENKI_AUTH_TOKEN", "");
    const provider = factory();
    await expect(provider.list({})).rejects.toMatchObject({ code: "auth", provider: name, message: `${label} API key is missing. Authentication is required. Set ${next} or pass apiKey.` });
  });
}
test.each(["create", "connect", "list"] as const)("E2B %s checks credentials before a native call", async operation => {
  vi.stubEnv("E2B_API_KEY", "");
  const provider = e2b();
  const result = operation === "create" ? provider.create({ labels: {} }) : operation === "connect" ? provider.connect("id") : provider.list({});
  await expect(result).rejects.toMatchObject({ code: "auth" });
  expect(state.configs).toEqual([]);
});
test("E2B reads env after construction and allows retry after missing credentials", async () => {
  vi.stubEnv("E2B_API_KEY", "");
  const provider = e2b();
  await expect(provider.list({})).rejects.toMatchObject({ code: "auth" });
  vi.stubEnv("E2B_API_KEY", "late-key");
  expect(await provider.list({})).toEqual([]);
  expect(state.configs).toMatchObject([{ apiKey: "late-key" }]);
});
