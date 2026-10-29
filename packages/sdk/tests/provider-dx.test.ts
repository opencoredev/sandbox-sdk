import { afterEach, expect, test, vi } from "vitest";
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
import { boatApi } from "../src/providers/boat-api/index.js";
import type { BoatOptions } from "../src/providers/boat/index.js";
import { boxd as mockBoxd, MockBoxd } from "./cloud-guest-mock.js";
import { daytona as mockDaytona, mockState as daytonaState } from "./daytona-mock.js";
import { tenki as mockTenki, tenkiState, cleanupTenki } from "./tenki-mock.js";
import { e2b as mockE2B, MockSandbox as MockE2BSandbox, listQueries } from "./e2b-sdk-mock.js";

const boxdConfigs: BoxdClientOptions[] = [];

/** Records the options the adapter passes to the boxd client. */
class RecordingBoxd extends MockBoxd {
  constructor(config: BoxdClientOptions) {
    super();
    boxdConfigs.push(config);
  }
}

const boatOrigins: string[] = [];
const boatTypes: string[] = [];
const createBody = z.object({ type: z.string() });

/** The real Boat SDK over a recording transport: lists are empty and creates are rejected. */
async function boatTransport(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  boatOrigins.push(new URL(request.url).origin);

  if (request.method === "GET") return Response.json({ sandboxes: [] });

  boatTypes.push(createBody.parse(await request.json()).type);

  return new Response(null, { status: 400 });
}

function recordingBoat(options: BoatOptions) {
  return boatApi(options, {
    name: "boat",
    label: "Boat",
    keyEnv: "BOAT_API_KEY",
    baseEnv: "BOAT_API_BASE",
    baseUrl: "https://boat.dev/api/v1",
    fetch: boatTransport,
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  boxdConfigs.length = 0;
  boatOrigins.length = 0;
  boatTypes.length = 0;
  daytonaState.configs.length = 0;
  listQueries.length = 0;
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
  await mockDaytona({ apiKey: "offline", apiUrl: "https://old.test" }).list({});
  await mockDaytona({
    apiKey: "offline",
    apiUrl: "https://old.test",
    baseUrl: "https://new.test",
  }).list({});
  expect(daytonaState.configs).toMatchObject([
    { apiUrl: "https://old.test" },
    { apiUrl: "https://new.test" },
  ]);
});

test("boat endpoint alias works and baseUrl wins", async () => {
  await recordingBoat({ apiKey: "offline", apiUrl: "https://old.test" }).list({});
  await recordingBoat({
    apiKey: "offline",
    apiUrl: "https://old.test",
    baseUrl: "https://new.test",
  }).list({});
  expect(boatOrigins).toEqual(["https://old.test", "https://new.test"]);
});

test("Tenki authToken alias works and apiKey wins", async () => {
  await mockTenki({ authToken: "old" }).list({});
  await mockTenki({ apiKey: "new", authToken: "old" }).list({});
  expect(tenkiState.configs).toMatchObject([{ authToken: "old" }, { authToken: "new" }]);
});

test("Boat type alias works, machine wins, and per-create size still wins", async () => {
  for (const [options, size] of [
    [{ type: "small" }, undefined],
    [{ machine: "large", type: "small" }, undefined],
    [{ machine: "large", type: "small" }, "medium"],
  ] as const) {
    await expect(
      recordingBoat({ apiKey: "offline", ...options }).create({ labels: {}, size }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  }

  expect(boatTypes).toEqual(["small", "large", "default"]);
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

    const native = [
      vi.spyOn(MockE2BSandbox, "create"),
      vi.spyOn(MockE2BSandbox, "connect"),
      vi.spyOn(MockE2BSandbox, "list"),
    ];

    const provider = mockE2B();

    const result =
      operation === "create"
        ? provider.create({ labels: {} })
        : operation === "connect"
          ? provider.connect("id")
          : provider.list({});

    await expect(result).rejects.toMatchObject({ code: "auth" });

    for (const call of native) expect(call).not.toHaveBeenCalled();
  },
);

test("E2B reads env after construction and allows retry after missing credentials", async () => {
  vi.stubEnv("E2B_API_KEY", "");
  const provider = mockE2B();
  await expect(provider.list({})).rejects.toMatchObject({ code: "auth" });
  vi.stubEnv("E2B_API_KEY", "late-key");
  expect(await provider.list({})).toEqual([]);
  expect(listQueries).toMatchObject([{ apiKey: "late-key" }]);
});
