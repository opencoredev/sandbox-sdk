// Each adapter's `resolveConfig` is what the adapter itself connects with, and the clients
// `native.sdk()` builds get the same values, so code outside the adapter reaches the same account.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { daytona } from "../src/providers/daytona/index.js";
import { e2b, resolveConfig as e2bConfig } from "../src/providers/e2b/index.js";
import { resolveConfig as tenkiConfig } from "../src/providers/tenki/index.js";
import { resolveConfig as upstashConfig } from "../src/providers/upstash/index.js";
import { resolveConfig as vercelConfig } from "../src/providers/vercel/index.js";
import { resolveConfig as boatConfig } from "../src/providers/boat/index.js";
import { resolveConfig as superserveConfig } from "../src/providers/superserve/index.js";

const variables = [
  "BOAT_API_KEY",
  "BOAT_API_BASE",
  "DAYTONA_API_URL",
  "DAYTONA_SERVER_URL",
  "E2B_API_URL",
  "E2B_DEBUG",
  "E2B_DOMAIN",
  "SUPERSERVE_BASE_URL",
  "TENKI_API_KEY",
  "TENKI_AUTH_TOKEN",
  "UPSTASH_BOX_BASE_URL",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
];

beforeEach(() => {
  for (const key of variables) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("native.sdk() clients connect where the adapter does", () => {
  test("Daytona's client gets the base URL without trailing slashes", async () => {
    class Daytona {
      constructor(readonly config: { apiUrl?: string; apiKey?: string; target?: string }) {}
      async get() {
        return {};
      }
    }

    const client = await daytona({
      apiKey: "k1",
      baseUrl: "https://daytona.fixture/api//",
    }).api.sdk(async () => ({ Daytona }));

    expect(client.config).toEqual({
      apiKey: "k1",
      apiUrl: "https://daytona.fixture/api",
      target: "us",
    });
  });

  test("E2B's client gets the adapter's API URL, so E2B_DEBUG cannot move it to localhost", async () => {
    vi.stubEnv("E2B_DEBUG", "true");

    class E2B {
      constructor(readonly init: { apiUrl?: string; domain?: string }) {}
    }

    const client = await e2b({ apiKey: "k1", domain: "e2b.fixture" }).api.sdk(async () => ({
      E2B,
    }));

    expect(client.init).toMatchObject({ apiUrl: "https://api.e2b.fixture", domain: "e2b.fixture" });
  });
});

describe("resolveConfig", () => {
  test("drops trailing slashes from base URLs", () => {
    vi.stubEnv("BOAT_API_BASE", "https://boat.fixture/api/v1//");
    vi.stubEnv("UPSTASH_BOX_BASE_URL", "https://up.fixture///");
    vi.stubEnv("E2B_API_URL", "https://api.e2b.fixture/");
    vi.stubEnv("SUPERSERVE_BASE_URL", " https://ss.fixture/ ");
    expect(boatConfig({ apiKey: "k1" }).baseUrl).toBe("https://boat.fixture/api/v1");
    expect(upstashConfig({ apiKey: "k1" }).baseUrl).toBe("https://up.fixture");
    expect(e2bConfig({ apiKey: "k1" }).apiUrl).toBe("https://api.e2b.fixture");
    expect(superserveConfig({ apiKey: "k1" }).baseUrl).toBe("https://ss.fixture");
  });

  test("Tenki prefers a non-blank TENKI_AUTH_TOKEN over TENKI_API_KEY", () => {
    vi.stubEnv("TENKI_API_KEY", "tk_key");
    vi.stubEnv("TENKI_AUTH_TOKEN", "tk_token");
    expect(tenkiConfig().authToken).toBe("tk_token");
    vi.stubEnv("TENKI_AUTH_TOKEN", "  ");
    expect(tenkiConfig().authToken).toBe("tk_key");
  });

  test("Vercel names the token's team and project, else leaves OIDC to the SDK", () => {
    expect(vercelConfig()).toEqual({});
    vi.stubEnv("VERCEL_TOKEN", "t1");
    expect(() => vercelConfig()).toThrow(expect.objectContaining({ code: "auth" }));
    vi.stubEnv("VERCEL_TEAM_ID", "team_1");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_1");
    expect(vercelConfig()).toEqual({ token: "t1", teamId: "team_1", projectId: "prj_1" });
  });

  test("a missing key is auth, as in the adapter", () => {
    expect(() => boatConfig({})).toThrow(expect.objectContaining({ code: "auth" }));
  });
});
