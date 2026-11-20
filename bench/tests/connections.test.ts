/**
 * How the harness keeps each adapter instance's connection: an instance it did not bind is never
 * read through the environment, and a reap rebuilds the run's endpoint, region and scope from the
 * run's journal with credentials from the environment.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daytona } from "@opencoredev/sandbox-sdk/daytona";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { lookupSandbox } from "../src/existence.js";
import { parseV2 } from "../src/v2-config.js";
import { runV2 } from "../src/v2-runner.js";
import { writeV2 } from "../src/v2-report.js";
import { loadProvider, type FactoryOptions } from "../src/providers.js";
import {
  bindConnection,
  differingFields,
  savedConnectionOf,
  savedConnections,
  savedOptions,
} from "../src/connections.js";
import { bound } from "./native-fakes.js";

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

describe("an adapter instance the harness did not build is never read through the environment", () => {
  it("an unbound instance reads as unavailable, not absent", async () => {
    vi.stubEnv("INSTABOX_API_KEY", "env-key");
    const seen = stubFetch(() => [404, {}]);
    const evidence = await lookupSandbox({ ...memory(), name: "instabox" }, id, budget);

    expect(evidence.result).toBe("unavailable");
    expect(seen).toEqual([]);
  });

  it("a connection that fails to resolve reads as unavailable", async () => {
    const adapter = bindConnection({ ...memory(), name: "instabox" }, {});

    expect((await lookupSandbox(adapter, id, budget)).result).toBe("unavailable");
  });
});

describe("a reap rebuilds the run's connection, with credentials from the environment", () => {
  it("the saved connection holds no credential, and its options reach the same endpoint", async () => {
    const options = { apiKey: "live-key", baseUrl: "https://live.invalid/api/", target: "eu" };
    const run = bindConnection(daytona(options), options);
    const saved = savedConnectionOf(run);

    expect(saved).toEqual({
      apiUrl: "https://live.invalid/api/",
      target: "eu",
      organizationId: null,
    });
    expect(JSON.stringify(saved)).not.toContain("live-key");

    const dir = await mkdtemp(join(tmpdir(), "bench-connections-"));

    try {
      await writeFile(
        join(dir, "ownership.json"),
        JSON.stringify({ runId: "r1", connections: { daytona: saved }, resources: [] }),
      );

      const kept = (await savedConnections(dir)).daytona;

      if (!kept) throw new Error("No saved connection");

      // The environment now names another endpoint; the key still comes from it.
      vi.stubEnv("DAYTONA_API_KEY", "live-key");
      vi.stubEnv("DAYTONA_API_URL", "https://other.invalid/api");
      const rebuilt = await load("daytona", savedOptions("daytona", kept));

      expect(differingFields(rebuilt, kept)).toEqual([]);
      expect(savedConnectionOf(rebuilt)).toEqual(saved);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a connection the environment changes (E2B_API_URL) is reported, so reap refuses it", async () => {
    vi.stubEnv("E2B_API_KEY", "live-key");
    const run = await load("e2b", { domain: "live.invalid" });
    const saved = savedConnectionOf(run);

    if (!saved) throw new Error("No saved connection");
    vi.stubEnv("E2B_API_URL", "https://elsewhere.invalid");
    const rebuilt = await load("e2b", savedOptions("e2b", saved));

    expect(differingFields(rebuilt, saved)).toEqual(["apiUrl"]);
  });
});

describe("bench reap loads each adapter with the run's saved connection", () => {
  const argv = process.argv;
  const exitCode = process.exitCode;

  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
  });

  async function reapWith(load: (name: string, factory: FactoryOptions) => Provider) {
    const dir = await mkdtemp(join(tmpdir(), "bench-reap-connections-"));
    const factories: FactoryOptions[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    vi.spyOn(process.stdout, "write").mockReturnValue(true);

    try {
      await writeFile(
        join(dir, "ownership.json"),
        JSON.stringify({
          runId: "r1",
          connections: {
            daytona: { apiUrl: "https://live.invalid/api", target: "eu", organizationId: null },
          },
          resources: [],
        }),
      );
      process.argv = [
        "bun",
        "bench",
        "reap",
        "--providers",
        "daytona",
        "--run",
        "r1",
        "--out",
        dir,
      ];
      process.exitCode = 0;

      const { main } = await import("../src/cli.js");

      await main(async (name, _env, _importer, config) => {
        const factory = config?.factory ?? {};
        factories.push(factory);

        return { kind: "ready", name, cloud: false, region: null, provider: load(name, factory) };
      });

      return {
        factories,
        stderr: stderr.mock.calls.map((call) => String(call[0])).join(""),
        exitCode: process.exitCode,
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("passes the saved endpoint and region as factory options, keys from the environment", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "env-key");
    vi.stubEnv("DAYTONA_API_URL", "https://other.invalid/api");

    const result = await reapWith((name, factory) => bound({ ...memory(), name }, factory));

    expect(result.factories).toEqual([
      { baseUrl: "https://live.invalid/api", target: "eu", organizationId: undefined },
    ]);
    expect(result.stderr).not.toContain("SKIP daytona");
    expect(result.exitCode).toBe(0);
  });

  it("skips a provider whose rebuilt connection differs, rather than read elsewhere", async () => {
    vi.stubEnv("DAYTONA_API_KEY", "env-key");
    vi.stubEnv("DAYTONA_API_URL", "https://other.invalid/api");

    // An adapter that ignores the saved options connects where the environment points.
    const result = await reapWith((name) => bound({ ...memory(), name }));

    expect(result.stderr).toContain(
      "SKIP daytona: Connection differs from the saved run (apiUrl, target)",
    );
  });
});

it("a run saves each adapter's endpoint and scope in its journal, never its key", async () => {
  vi.stubEnv("INSTABOX_API_KEY", "env-key");
  vi.stubEnv("INSTABOX_API_URL", "https://other.invalid/ib");

  // Instabox by name, backed by memory: creates stay local, and every exact lookup is a raw GET.
  const reads: string[] = [];

  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    reads.push(`${url} ${new Headers(init?.headers).get("x-api-key")}`);

    return Response.json({}, { status: 404 });
  });

  const provider = bound(
    { ...memory(), name: "instabox" },
    { apiKey: "run-key", baseUrl: "https://live.invalid/ib/" },
  );

  const out = await mkdtemp(join(tmpdir(), "bench-journal-connections-"));

  try {
    const config = parseV2([
      "--providers",
      "instabox",
      "--run",
      "journal-run",
      "--runs",
      "1",
      "--scenarios",
      "command",
      "--bursts",
      "",
      "--out",
      out,
    ]);

    await runV2(
      [{ kind: "ready", name: "instabox", cloud: false, region: null, provider }],
      config,
      (r) => writeV2(r, out),
    );

    const text = await readFile(join(out, "ownership.json"), "utf8");

    expect(JSON.parse(text).connections).toEqual({
      instabox: { baseUrl: "https://live.invalid/ib" },
    });
    expect(text).not.toContain("run-key");
    // Every exact lookup after a delete went to the run's endpoint with the run's key.
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((read) => read.startsWith("https://live.invalid/ib/v1/machines/"))).toBe(
      true,
    );
    expect(reads.every((read) => read.endsWith(" run-key"))).toBe(true);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
