// Each adapter's `resolveConfig` returns what that adapter already uses: the endpoint its own
// requests go to and the credential they carry. It reads options and the environment and changes
// neither. `request-parity.test.ts` proves the adapters themselves did not change.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { beam, resolveConfig as beamConfig } from "../src/providers/beam/index.js";
import { boat, resolveConfig as boatConfig } from "../src/providers/boat/index.js";
import { daytona, resolveConfig as daytonaConfig } from "../src/providers/daytona/index.js";
import { e2b, resolveConfig as e2bConfig } from "../src/providers/e2b/index.js";
import { freestyle, resolveConfig as freestyleConfig } from "../src/providers/freestyle/index.js";
import { instabox, resolveConfig as instaboxConfig } from "../src/providers/instabox/index.js";
import {
  superserve,
  resolveConfig as superserveConfig,
} from "../src/providers/superserve/index.js";
import { resolveConfig as tenkiConfig } from "../src/providers/tenki/index.js";
import { upstash, resolveConfig as upstashConfig } from "../src/providers/upstash/index.js";
import { resolveConfig as vercelConfig } from "../src/providers/vercel/index.js";

const variables = [
  "BEAM_TOKEN",
  "BEAM_WORKSPACE_ID",
  "BOAT_API_KEY",
  "BOAT_API_BASE",
  "DAYTONA_API_KEY",
  "DAYTONA_API_URL",
  "DAYTONA_SERVER_URL",
  "DAYTONA_TARGET",
  "E2B_API_KEY",
  "E2B_API_URL",
  "E2B_DEBUG",
  "E2B_DOMAIN",
  "FREESTYLE_API_KEY",
  "INSTABOX_API_KEY",
  "INSTABOX_API_URL",
  "SUPERSERVE_API_KEY",
  "SUPERSERVE_BASE_URL",
  "TENKI_API_KEY",
  "TENKI_AUTH_TOKEN",
  "UPSTASH_BOX_API_KEY",
  "UPSTASH_BOX_BASE_URL",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
];

interface Sent {
  readonly url: string;
  readonly headers: Headers;
}

/** Every request the adapter sends, each answered 404. */
function capture(): Sent[] {
  const sent: Sent[] = [];

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push({ url, headers: new Headers(init?.headers) });

    return Response.json({ code: 404, message: "Not found" }, { status: 404 });
  });

  return sent;
}

/** `base` joined with `path` as the adapters' HTTP clients join them. */
const joined = (base: string, path: string) => base.replace(/\/+$/, "") + path;

beforeEach(() => {
  for (const key of variables) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("resolveConfig is where and as whom the adapter's own requests go", () => {
  test("Daytona: explicit options win over a conflicting environment", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "env-key");
    vi.stubEnv("DAYTONA_API_URL", "https://env.invalid/api");
    const options = { apiKey: "option-key", baseUrl: "https://option.invalid/api//" };
    const sent = capture();

    await daytona(options)
      .connect("sbx-1")
      .catch(() => {});

    const config = daytonaConfig(options);

    expect(config).toEqual({
      apiKey: "option-key",
      apiUrl: "https://option.invalid/api//",
      target: "us",
    });
    expect(sent[0]?.url).toBe(joined(config.apiUrl, "/sandbox/sbx-1"));
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer option-key");
  });

  test("E2B: the adapter's API URL ignores E2B_DEBUG", async () => {
    vi.stubEnv("E2B_API_KEY", "env-key");
    vi.stubEnv("E2B_DEBUG", "true");
    vi.stubEnv("E2B_DOMAIN", "env.invalid");
    const options = { apiKey: "option-key", domain: "option.invalid" };
    const sent = capture();

    await e2b(options)
      .connect("sbx-1")
      .catch(() => {});

    const config = e2bConfig(options);

    expect(config).toEqual({
      apiKey: "option-key",
      domain: "option.invalid",
      apiUrl: "https://api.option.invalid",
    });
    expect(sent[0]?.url.startsWith(`${config.apiUrl}/sandboxes/sbx-1`)).toBe(true);
    expect(sent[0]?.headers.get("x-api-key")).toBe("option-key");
  });

  test("Beam: explicit options win over the environment, on the adapter's gateway", async () => {
    vi.stubEnv("BEAM_TOKEN", "env-token");
    vi.stubEnv("BEAM_WORKSPACE_ID", "ws-env");

    const options = {
      token: " option-token ",
      workspaceId: "ws-option",
      gatewayUrl: "https://option.invalid/beam//",
    };

    const sent = capture();

    await beam(options)
      .connect("ctr-1")
      .catch(() => {});

    const config = beamConfig(options);

    expect(config).toEqual({
      token: "option-token",
      workspaceId: "ws-option",
      gatewayUrl: "https://option.invalid/beam//",
    });
    expect(sent[0]?.url).toBe(joined(config.gatewayUrl, "/api/v1/gateway/containers"));
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer option-token");
  });

  test("Beam: the environment and the default gateway", async () => {
    vi.stubEnv("BEAM_TOKEN", "env-token");
    vi.stubEnv("BEAM_WORKSPACE_ID", "ws-env");
    const sent = capture();

    await beam()
      .connect("ctr-1")
      .catch(() => {});

    expect(beamConfig()).toEqual({
      token: "env-token",
      workspaceId: "ws-env",
      gatewayUrl: "https://app.beam.cloud",
    });
    expect(sent[0]?.url).toBe("https://app.beam.cloud/api/v1/gateway/containers");
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer env-token");
  });

  test("Boat, Freestyle, Instabox, Superserve and Upstash agree with their requests", async () => {
    vi.stubEnv("BOAT_API_BASE", "https://env.invalid/boat");
    vi.stubEnv("INSTABOX_API_URL", "https://env.invalid/ib");
    vi.stubEnv("SUPERSERVE_BASE_URL", "https://env.invalid/ss");
    vi.stubEnv("UPSTASH_BOX_BASE_URL", "https://env.invalid/up");

    const cases = [
      {
        name: "boat",
        config: boatConfig({ apiKey: "k1", baseUrl: "https://option.invalid/v1//" }),
        run: () => boat({ apiKey: "k1", baseUrl: "https://option.invalid/v1//" }).connect("s1"),
        path: "/sandboxes/s1",
      },
      {
        name: "freestyle",
        config: freestyleConfig({ apiKey: "k1", baseUrl: "https://option.invalid/fs/" }),
        run: () => freestyle({ apiKey: "k1", baseUrl: "https://option.invalid/fs/" }).connect("s1"),
        path: "/v5/vms/s1",
      },
      {
        name: "instabox",
        config: instaboxConfig({ apiKey: "k1", baseUrl: "https://option.invalid/ib//" }),
        run: () => instabox({ apiKey: "k1", baseUrl: "https://option.invalid/ib//" }).connect("s1"),
        path: "/v1/machines/s1",
      },
      {
        name: "superserve",
        config: superserveConfig({ apiKey: "k1", baseUrl: "https://option.invalid/ss/" }),
        run: () =>
          superserve({ apiKey: "k1", baseUrl: "https://option.invalid/ss/" }).destroy("s1"),
        path: "/sandboxes/s1",
      },
      {
        name: "upstash",
        config: upstashConfig({ apiKey: "k1", baseUrl: "https://option.invalid/up//" }),
        run: () => upstash({ apiKey: "k1", baseUrl: "https://option.invalid/up//" }).destroy("s1"),
        path: "/v2/box/s1",
      },
    ];

    for (const entry of cases) {
      const sent = capture();

      await entry.run().catch(() => {});

      // Each adapter's HTTP client joins the configured URL its own way; Upstash drops one slash.
      const expected =
        entry.name === "upstash"
          ? `${entry.config.baseUrl}${entry.path}`
          : joined(entry.config.baseUrl, entry.path);

      expect(entry.config.apiKey, entry.name).toBe("k1");
      expect(
        sent.some((request) => request.url.startsWith(expected)),
        `${entry.name}: ${sent.map((request) => request.url).join(", ")}`,
      ).toBe(true);
    }
  });
});

describe("resolveConfig reads and changes nothing else", () => {
  test("options and the environment are left as they were", () => {
    vi.stubEnv("DAYTONA_API_KEY", "env-key");
    const options = Object.freeze({ baseUrl: "https://option.invalid/api/" });
    const before = { ...process.env };

    expect(daytonaConfig(options)).toEqual(daytonaConfig(options));
    expect({ ...process.env }).toEqual(before);
  });

  test("a URL keeps the trailing slashes the adapter keeps", () => {
    vi.stubEnv("BOAT_API_BASE", "https://boat.invalid/api/v1//");
    vi.stubEnv("UPSTASH_BOX_BASE_URL", "https://up.invalid///");
    vi.stubEnv("E2B_API_URL", "https://api.e2b.invalid/");
    vi.stubEnv("SUPERSERVE_BASE_URL", " https://ss.invalid/ ");
    expect(boatConfig({ apiKey: "k1" }).baseUrl).toBe("https://boat.invalid/api/v1//");
    expect(upstashConfig({ apiKey: "k1" }).baseUrl).toBe("https://up.invalid//");
    expect(e2bConfig({ apiKey: "k1" }).apiUrl).toBe("https://api.e2b.invalid/");
    expect(superserveConfig({ apiKey: "k1" }).baseUrl).toBe("https://ss.invalid/");
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

  test("Beam needs both a token and a workspace ID, as the adapter does", async () => {
    vi.stubEnv("BEAM_WORKSPACE_ID", "ws-env");
    expect(() => beamConfig()).toThrow(expect.objectContaining({ code: "auth" }));
    await expect(beam().list({})).rejects.toMatchObject({ code: "auth" });
    vi.stubEnv("BEAM_TOKEN", "env-token");
    vi.stubEnv("BEAM_WORKSPACE_ID", "  ");
    expect(() => beamConfig()).toThrow(expect.objectContaining({ code: "auth" }));
    await expect(beam().list({})).rejects.toMatchObject({ code: "auth" });
  });
});
