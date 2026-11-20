/**
 * How the harness keeps each adapter instance's connection: an instance it did not bind is never
 * read through the environment, and a reap rebuilds the run's endpoint, region and scope from the
 * run's journal with credentials from the environment.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { bound, fakeNativeModules } from "./native-fakes.js";

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

/** Every file under `dir`, recursively, with its text. */
async function filesUnder(dir: string): Promise<{ path: string; text: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });

  return Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name);

        return { path, text: await readFile(path, "utf8") };
      }),
  );
}

/**
 * Canaries in every place a connection can carry a secret: the key fields, and an endpoint's
 * userinfo, host, path and query. None of them may reach a journal or report.
 */
const canaryEndpoint =
  "https://u-canary-user:p-canary-pass@canary-host.invalid/p-canary-path/?q=canary-query";

const canaryOptions = {
  apiKey: "k-canary-key",
  apiUrl: canaryEndpoint,
  authToken: "t-canary-auth",
  baseURL: canaryEndpoint,
  baseUrl: canaryEndpoint,
  domain: "canary-domain.invalid",
  jwtToken: "j-canary-jwt",
  organizationId: "o-canary-org",
  projectId: "p-canary-project",
  target: "canary-target",
  teamId: "t-canary-team",
  token: "v-canary-token",
} satisfies FactoryOptions;

const connected = [
  "baseten",
  "boat",
  "boxd",
  "daytona",
  "e2b",
  "freestyle",
  "instabox",
  "superserve",
  "tenki",
  "upstash",
  "vercel",
] as const;

it("a run's journal and reports hold no credential or endpoint text, for every connected provider", async () => {
  // Hermetic: every raw request answers 404 and no native SDK loads, so lookups stay unavailable.
  vi.stubGlobal("fetch", async () => Response.json({}, { status: 404 }));
  fakeNativeModules({});

  const out = await mkdtemp(join(tmpdir(), "bench-journal-canaries-"));

  try {
    const config = parseV2([
      "--providers",
      connected.join(","),
      "--run",
      "journal-run",
      "--runs",
      "1",
      "--scenarios",
      "command",
      "--bursts",
      "",
      "--timeout-ms",
      "2000",
      "--out",
      out,
    ]);

    await runV2(
      connected.map((name) => ({
        kind: "ready" as const,
        name,
        cloud: false,
        region: null,
        provider: bound({ ...memory(), name }, canaryOptions),
      })),
      config,
      (r) => writeV2(r, out),
    );

    const files = await filesUnder(out);

    expect(files.map((file) => file.path)).toContain(join(out, "ownership.json"));
    expect(files.filter((file) => /canary/i.test(file.text)).map((file) => file.path)).toEqual([]);

    // Each connection is journaled as a 16-hex fingerprint under its provider's name, nothing else.
    const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));

    expect(Object.keys(journal.fingerprints).sort()).toEqual([...connected]);
    for (const value of Object.values(journal.fingerprints))
      expect(value).toMatch(/^[0-9a-f]{16}$/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}, 60_000);

describe("bench reap acts only through the connection the run used", () => {
  const argv = process.argv;
  const exitCode = process.exitCode;

  afterEach(() => {
    process.argv = argv;
    process.exitCode = exitCode;
  });

  /** E2B answers getInfo for `live` with the run's key only; any other key reads it as missing. */
  function e2bAccount(live: Set<string>) {
    const calls: string[] = [];

    class SandboxNotFoundError extends Error {}

    fakeNativeModules({
      e2b: {
        Sandbox: {
          getInfo: async (sandboxId: string, options: { apiKey: string }) => {
            calls.push(sandboxId);

            if (options.apiKey === "run-key" && live.has(sandboxId))
              return { sandboxId, state: "running" };
            throw new SandboxNotFoundError("not found");
          },
          listSnapshots: () => ({ hasNext: false, nextItems: async () => [] }),
          deleteSnapshot: vi.fn(),
        },
        SandboxNotFoundError,
      },
    });

    return calls;
  }

  /** A run whose delete failed, so its sandbox stays journaled, under E2B_API_KEY=run-key. */
  async function crashedRun(out: string) {
    vi.stubEnv("E2B_API_KEY", "run-key");
    const backing = memory();
    const provider = bound({
      ...backing,
      name: "e2b",
      destroy: async () => {
        throw new Error("delete refused");
      },
    });

    await runV2(
      [{ kind: "ready", name: "e2b", cloud: false, region: null, provider }],
      parseV2([
        "--providers",
        "e2b",
        "--run",
        "fp-run",
        "--runs",
        "1",
        "--scenarios",
        "command",
        "--bursts",
        "",
        "--timeout-ms",
        "2000",
        "--out",
        out,
      ]),
      (r) => writeV2(r, out),
    );

    const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    const ids: string[] = journal.resources
      .filter(
        (r: { provider: string; kind: string }) => r.provider === "e2b" && r.kind === "sandbox",
      )
      .map((r: { id: string }) => r.id);

    if (ids.length === 0) throw new Error("The run left no journaled sandbox");

    return ids;
  }

  async function reap(out: string) {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    process.argv = [
      "bun",
      "bench",
      "reap",
      "--providers",
      "e2b",
      "--run",
      "fp-run",
      "--timeout-ms",
      "2000",
      "--out",
      out,
    ];
    process.exitCode = 0;

    const { main } = await import("../src/cli.js");
    let failure: unknown = null;

    try {
      // The adapter as `loadProvider` builds it: options from the reap's config, keys from the env.
      await main(async (name, _env, _importer, config) => ({
        kind: "ready",
        name,
        cloud: false,
        region: null,
        provider: bound({ ...memory(), name }, config?.factory ?? {}),
      }));
    } catch (error) {
      failure = error;
    }

    const text = stderr.mock.calls.map((call) => String(call[0])).join("");
    stderr.mockRestore();

    return { stderr: text, exitCode: process.exitCode, failure };
  }

  it("with the same endpoint but another account's key, makes no request and keeps the entry", async () => {
    const out = await mkdtemp(join(tmpdir(), "bench-reap-fingerprint-"));

    try {
      const ids = await crashedRun(out);
      const calls = e2bAccount(new Set(ids));

      vi.stubEnv("E2B_API_KEY", "other-key");
      const result = await reap(out);
      const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));

      expect(result.failure).toBeNull();
      // The sandbox is still running under the run's key: its entry must stay.
      expect(journal.resources.map((r: { id: string }) => r.id)).toEqual(
        expect.arrayContaining(ids),
      );
      expect(calls).toEqual([]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SKIP e2b:");
      expect(result.stderr).toContain("fingerprint");
      expect(result.stderr).not.toMatch(/run-key|other-key/);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("with the run's own environment, reads through it and resolves a sandbox that is gone", async () => {
    const out = await mkdtemp(join(tmpdir(), "bench-reap-fingerprint-"));

    try {
      const ids = await crashedRun(out);
      const calls = e2bAccount(new Set());

      const result = await reap(out);
      const journal = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));

      expect(result.failure).toBeNull();
      expect(result.stderr).not.toContain("SKIP e2b");
      expect(calls).toEqual(expect.arrayContaining(ids));
      expect(journal.resources.filter((r: { kind: string }) => r.kind === "sandbox")).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a journal from before fingerprints, which kept endpoint text", async () => {
    const out = await mkdtemp(join(tmpdir(), "bench-reap-legacy-"));

    try {
      vi.stubEnv("E2B_API_KEY", "run-key");
      const calls = e2bAccount(new Set(["sb-1"]));

      await writeFile(
        join(out, "ownership.json"),
        JSON.stringify({
          runId: "fp-run",
          connections: { e2b: { domain: "e2b.app", apiUrl: "https://api.e2b.app" } },
          resources: [{ provider: "e2b", id: "sb-1", kind: "sandbox", parent: null }],
        }),
      );
      const result = await reap(out);

      expect(calls).toEqual([]);
      expect(String(result.failure)).toContain("endpoint text");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
