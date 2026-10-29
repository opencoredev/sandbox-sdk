import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
vi.mock("@boatdev/sdk", () => ({
  Configuration: class { constructor(config: unknown) { state.configs.push(config); } },
  BoatApi: class {
    async sandboxes() { return { sandboxes: [] }; }
    async create(request: unknown) {
      state.creates.push(request);
      throw { response: new Response(null, { status: 400 }) };
    }
  },
}));
// E2B speaks HTTP directly: record the key each control-plane call sends and answer an empty list.
const fetchE2B = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname !== "api.e2b.app") throw new TypeError("fetch failed: the network is blocked in this test");
  state.configs.push({ apiKey: new Headers(init?.headers).get("x-api-key") });
  return new Response("[]", { headers: { "content-type": "application/json" } });
};
beforeEach(() => { vi.stubGlobal("fetch", fetchE2B); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); state.configs.length = 0; state.creates.length = 0; });

for (const [name, factory, legacy] of [
  ["boxd", boxd, { baseURL: "https://old.test" }],
  ["boat", boat, { apiUrl: "https://old.test" }],
] as const) {
  test(`${name} endpoint alias works and baseUrl wins`, async () => {
    await factory({ apiKey: "offline", ...legacy }).list({});
    await factory({ apiKey: "offline", ...legacy, baseUrl: "https://new.test" }).list({});
    const nativeField = name === "boxd" ? "baseURL" : "basePath";
    expect(state.configs).toMatchObject([{ [nativeField]: "https://old.test" }, { [nativeField]: "https://new.test" }]);
  });
}
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
test("Boat type alias works, machine wins, and per-create size still wins", async () => {
  for (const [options, size] of [
    [{ type: "small" }, undefined],
    [{ machine: "large", type: "small" }, undefined],
    [{ machine: "large", type: "small" }, "medium"],
  ] as const) {
    await expect(boat({ apiKey: "offline", ...options }).create({ labels: {}, size })).rejects.toMatchObject({ code: "invalid_argument" });
  }
  expect(state.creates).toMatchObject([
    { createSandboxRequest: { type: "small" } },
    { createSandboxRequest: { type: "large" } },
    { createSandboxRequest: { type: "default" } },
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
