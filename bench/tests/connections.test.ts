/**
 * How the harness keeps each adapter instance's connection: an instance it did not bind is never
 * read through the environment, a run journals only each connection's fingerprint, and a reap
 * reads only through an adapter whose connection, rebuilt from its environment, matches it.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { lookupSandbox } from "../src/existence.js";
import { parseV2 } from "../src/v2-config.js";
import { runV2 } from "../src/v2-runner.js";
import { writeV2 } from "../src/v2-report.js";
import { loadProvider, type FactoryOptions } from "../src/providers.js";
import {
  bindConnection,
  connectionProbes,
  fingerprintOf,
  type ModalClientParams,
} from "../src/connections.js";
import { fakeDocker } from "./docker-fake.js";
import { bound, fakeNativeModules } from "./native-fakes.js";

const id = "fixture";
const budget = 10_000;

const providerEnv = [
  "BASETEN_API_KEY",
  "BOAT_API_KEY",
  "BOAT_API_BASE",
  "BOXD_API_KEY",
  "BOXD_BASE_URL",
  "BOXD_API_URL",
  "BOXD_REGION",
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
  "TENKI_API_URL",
  "UPSTASH_BOX_API_KEY",
  "UPSTASH_BOX_BASE_URL",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_OIDC_TOKEN",
  "DOCKER_HOST",
  "MODAL_PROFILE",
  "MODAL_CONFIG_PATH",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_ENVIRONMENT",
  "MODAL_SERVER_URL",
  "RAILWAY_API_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_GRAPHQL_ENDPOINT",
  "RAILWAY_TCP_PROXY_WS_ENDPOINT",
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

describe("a connection fingerprint names the whole connection without holding any of it", () => {
  const options = { apiKey: "live-key", baseUrl: "https://live.invalid/api/", target: "eu" };

  // `loadProvider` skips Daytona without a key in the environment; the options' key still wins.
  beforeEach(() => vi.stubEnv("DAYTONA_API_KEY", "env-key"));

  it("is the same for adapters built from the same options and environment", async () => {
    const run = await load("daytona", options);

    const again = await load("daytona", {
      target: "eu",
      baseUrl: options.baseUrl,
      apiKey: "live-key",
    });

    expect(await fingerprintOf(run)).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprintOf(again)).toBe(await fingerprintOf(run));
  });

  it.each([
    ["key", { apiKey: "other-key" }],
    ["endpoint", { baseUrl: "https://live.invalid/api" }],
    ["region", { target: "us" }],
  ])("changes with the %s", async (_field, change) => {
    const run = await load("daytona", options);
    const other = await load("daytona", { ...options, ...change });

    expect(await fingerprintOf(other)).not.toBe(await fingerprintOf(run));
  });

  it("changes when only the environment does (E2B_API_URL)", async () => {
    vi.stubEnv("E2B_API_KEY", "live-key");
    const run = await load("e2b", {});

    vi.stubEnv("E2B_API_URL", "https://elsewhere.invalid");
    expect(await fingerprintOf(await load("e2b", {}))).not.toBe(await fingerprintOf(run));
  });

  // Where `resolveConfig` leaves a field to the provider's SDK, the SDK reads the environment.
  it.each([
    ["boxd", "BOXD_BASE_URL", { BOXD_API_KEY: "live-key" }, "https://elsewhere.invalid"],
    ["boxd", "BOXD_API_URL", { BOXD_API_KEY: "live-key" }, "https://elsewhere.invalid"],
    ["tenki", "TENKI_API_ENDPOINT", { TENKI_API_KEY: "live-key" }, "https://elsewhere.invalid"],
    ["tenki", "TENKI_API_URL", { TENKI_API_KEY: "live-key" }, "https://elsewhere.invalid"],
    ["vercel", "VERCEL_OIDC_TOKEN", {}, "other-oidc-token"],
  ])("%s changes when %s, which its SDK reads itself, does", async (name, variable, env, value) => {
    for (const [key, set] of Object.entries(env)) vi.stubEnv(key, set);
    vi.stubEnv("VERCEL_OIDC_TOKEN", "run-oidc-token");

    const run = bound({ ...memory(), name });

    vi.stubEnv(variable, value);
    const other = bound({ ...memory(), name });

    expect(await fingerprintOf(run)).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprintOf(other)).not.toBe(await fingerprintOf(run));
  });

  it("is a constant of its name for an in-process adapter, which has no connection to choose", async () => {
    const fingerprint = await fingerprintOf(bound(memory()));

    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(await fingerprintOf(bound(memory()))).toBe(fingerprint);
    expect(await fingerprintOf(bound({ ...memory(), name: "agentos" }))).not.toBe(fingerprint);
  });
});

it("a run reads through each adapter's own connection and journals only its fingerprint", async () => {
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

    expect(JSON.parse(text).connectionFingerprints).toEqual({
      instabox: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(text).not.toMatch(/run-key|live\.invalid/);
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

const journalSchema = z.object({
  connectionFingerprints: z.record(z.string(), z.string()).default({}),
  resources: z.array(z.object({ provider: z.string(), id: z.string(), kind: z.string() })),
});

/** The run journal in `out`. */
async function journalIn(out: string) {
  return journalSchema.parse(JSON.parse(await readFile(join(out, "ownership.json"), "utf8")));
}

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
  tokenId: "ak-canary-modal-id",
  tokenSecret: "as-canary-modal-secret",
  environment: "e-canary-modal-env",
  environmentId: "r-canary-railway-env",
  authType: "a-canary-auth-type",
} satisfies FactoryOptions;

const connected = [
  "baseten",
  "boat",
  "boxd",
  "daytona",
  "e2b",
  "freestyle",
  "instabox",
  "local",
  "modal",
  "railway",
  "superserve",
  "tenki",
  "upstash",
  "vercel",
] as const;

it("a run's journal and reports hold no credential or endpoint text, for every connected provider", async () => {
  // Hermetic: every raw request answers 404 and no native SDK loads, so lookups stay unavailable.
  vi.stubGlobal("fetch", async () => Response.json({}, { status: 404 }));
  fakeNativeModules({});
  // Modal's client echoes the canary tokens and Environment into the profile it resolves.
  vi.spyOn(connectionProbes, "loadModal").mockResolvedValue({
    ModalClient: class {
      readonly profile: ModalClientParams & { serverUrl: string };

      constructor(params: ModalClientParams) {
        this.profile = { serverUrl: "https://canary-modal.invalid:443", ...params };
      }

      close() {}
    },
  });
  // The local adapter's socket and daemon ID carry canaries too.
  const socketDir = await mkdtemp(join(tmpdir(), "bench-socket-canary-"));
  const docker = await fakeDocker("daemon-canary-id", join(socketDir, "canary.sock"));
  const options = { ...canaryOptions, dockerHost: docker.host };

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
        provider: bound({ ...memory(), name }, options),
      })),
      config,
      (r) => writeV2(r, out),
    );

    const files = await filesUnder(out);

    expect(files.map((file) => file.path)).toContain(join(out, "ownership.json"));
    expect(files.filter((file) => /canary/i.test(file.text)).map((file) => file.path)).toEqual([]);

    // Each connection is journaled as a 16-hex fingerprint under its provider's name, nothing else.
    const journal = await journalIn(out);

    expect(Object.keys(journal.connectionFingerprints).sort()).toEqual([...connected]);

    for (const value of Object.values(journal.connectionFingerprints))
      expect(value).toMatch(/^[0-9a-f]{16}$/);
  } finally {
    await rm(out, { recursive: true, force: true });
    await docker.close();
    await rm(socketDir, { recursive: true, force: true });
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
          getInfo: vi
            .fn()
            .mockImplementation(async (sandboxId: string, options: { apiKey: string }) => {
              calls.push(sandboxId);

              if (options.apiKey === "run-key" && live.has(sandboxId))
                return { sandboxId, state: "running" };

              throw new SandboxNotFoundError("not found");
            }),
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

    const provider = bound({
      ...memory(),
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

    const ids = (await journalIn(out)).resources
      .filter((r) => r.provider === "e2b" && r.kind === "sandbox")
      .map((r) => r.id);

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

    try {
      // The adapter as `loadProvider` builds it: options from the reap's config, keys from the env.
      await main(async (name, _env, _importer, config) => ({
        kind: "ready",
        name,
        cloud: false,
        region: null,
        provider: bound({ ...memory(), name }, config?.factory ?? {}),
      }));

      return {
        stderr: stderr.mock.calls.map((call) => String(call[0])).join(""),
        exitCode: process.exitCode,
      };
    } finally {
      stderr.mockRestore();
    }
  }

  it("with the same endpoint but another account's key, makes no request and keeps the entry", async () => {
    const out = await mkdtemp(join(tmpdir(), "bench-reap-fingerprint-"));

    try {
      const ids = await crashedRun(out);
      const calls = e2bAccount(new Set(ids));

      vi.stubEnv("E2B_API_KEY", "other-key");
      const result = await reap(out);
      const journal = await journalIn(out);

      // The sandbox is still running under the run's key: its entry must stay.
      expect(journal.resources.map((r) => r.id)).toEqual(expect.arrayContaining(ids));
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
      const journal = await journalIn(out);

      expect(result.stderr).not.toContain("SKIP e2b");
      expect(calls).toEqual(expect.arrayContaining(ids));
      expect(journal.resources.filter((r) => r.kind === "sandbox")).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("skips a connected provider the journal has no fingerprint for, without a request", async () => {
    const out = await mkdtemp(join(tmpdir(), "bench-reap-unfingerprinted-"));

    try {
      vi.stubEnv("E2B_API_KEY", "run-key");
      const calls = e2bAccount(new Set());

      await writeFile(
        join(out, "ownership.json"),
        JSON.stringify({
          runId: "fp-run",
          resources: [{ provider: "e2b", id: "sb-1", kind: "sandbox", parent: null }],
        }),
      );
      const result = await reap(out);
      const journal = await journalIn(out);

      expect(calls).toEqual([]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("SKIP e2b: the run's journal has no connection fingerprint");
      expect(journal.resources).toHaveLength(1);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

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
      await expect(reap(out)).rejects.toThrow("endpoint text");
      expect(calls).toEqual([]);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
