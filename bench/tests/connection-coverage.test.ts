/**
 * Every provider the bench builds has a connection fingerprint, so a reap can always tell whether
 * its environment reaches the run's sandboxes. Modal's covers the connection its SDK resolves
 * (environment, then the profile file); boxd's covers the region its SDK routes machine calls to.
 * Hermetic: Modal's SDK is faked, Docker is a fake daemon on a temp unix socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memory } from "@opencoredev/sandbox-sdk/memory";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  connectionProbes,
  fingerprintOf,
  reapConnection,
  type ModalModule,
} from "../src/connections.js";
import { loadProvider, providerNames, type FactoryOptions } from "../src/providers.js";
import { fakeDocker } from "./docker-fake.js";
import { bound } from "./native-fakes.js";

const hex = /^[0-9a-f]{16}$/;

/** Everything a provider's connection reads from the environment, cleared for each test. */
const connectionEnv = [
  "ARCHIL_API_KEY",
  "ARCHIL_REGION",
  "BEAM_TOKEN",
  "BEAM_WORKSPACE_ID",
  "BUDDY_API_URL",
  "BUDDY_PROJECT",
  "BUDDY_REGION",
  "DOCKER_HOST",
  "MARITIME_API_URL",
  "MSB_API_URL",
  "MODAL_PROFILE",
  "MODAL_CONFIG_PATH",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "MODAL_ENVIRONMENT",
  "MODAL_SERVER_URL",
  "STYNE_API_URL",
  "BOXD_API_KEY",
  "BOXD_BASE_URL",
  "BOXD_API_URL",
  "BOXD_REGION",
  "RAILWAY_API_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_ENVIRONMENT_ID",
  "RAILWAY_GRAPHQL_ENDPOINT",
  "RAILWAY_TCP_PROXY_WS_ENDPOINT",
];

beforeEach(() => {
  for (const key of connectionEnv) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * Profiles as a `~/.modal.toml` would hold them. The fake client resolves them as Modal's SDK
 * does: `MODAL_PROFILE`, else the active profile; each environment variable over the profile's
 * value; explicit client params over both. It makes no request.
 */
/** One profile in `~/.modal.toml`, with Modal's key names. */
interface ModalProfileFile {
  readonly server_url: string;
  readonly token_id: string;
  readonly token_secret: string;
  readonly environment: string;
  readonly active?: boolean;
}

const profiles = new Map<string, ModalProfileFile>([
  [
    "work",
    {
      server_url: "https://api.modal.invalid:443",
      token_id: "ak-work",
      token_secret: "as-work",
      environment: "main",
      active: true,
    },
  ],
  [
    "personal",
    {
      server_url: "https://other.modal.invalid:443",
      token_id: "ak-personal",
      token_secret: "as-personal",
      environment: "dev",
    },
  ],
]);

function fakeModal() {
  const constructed: object[] = [];

  class ModalClient {
    readonly profile: Record<string, string | undefined>;

    constructor(params: { tokenId?: string; tokenSecret?: string; environment?: string } = {}) {
      constructed.push(params);
      const env = process.env;

      const name =
        env.MODAL_PROFILE ?? [...profiles].find(([, profile]) => profile.active)?.[0] ?? "";

      const file = profiles.get(name);

      this.profile = {
        serverUrl: env.MODAL_SERVER_URL || file?.server_url || "https://api.modal.com:443",
        tokenId: params.tokenId ?? (env.MODAL_TOKEN_ID || file?.token_id),
        tokenSecret: params.tokenSecret ?? (env.MODAL_TOKEN_SECRET || file?.token_secret),
        environment: params.environment || env.MODAL_ENVIRONMENT || file?.environment,
      };
    }

    close() {}
  }

  const module: ModalModule = { ModalClient };

  return { module, constructed };
}

function withFakeModal() {
  const fake = fakeModal();
  vi.spyOn(connectionProbes, "loadModal").mockResolvedValue(fake.module);

  return fake;
}

/** Modal as `loadProvider` builds it; its factory is faked, so nothing loads or connects. */
async function modalAdapter(factory: FactoryOptions = {}): Promise<Provider> {
  const loaded = await loadProvider(
    "modal",
    { MODAL_TOKEN_ID: "required-by-the-bench", MODAL_TOKEN_SECRET: "required-by-the-bench" },
    async () => ({ modal: () => ({ ...memory(), name: "modal" }) }),
    { template: {}, product: {}, factory },
  );

  if (loaded.kind !== "ready") throw new Error(`modal skipped: ${loaded.note}`);

  return loaded.provider;
}

describe("Modal's fingerprint covers the connection its SDK resolves", () => {
  it("differs when MODAL_PROFILE picks another profile, even with the same tokens in the environment", async () => {
    withFakeModal();
    vi.stubEnv("MODAL_TOKEN_ID", "ak-env");
    vi.stubEnv("MODAL_TOKEN_SECRET", "as-env");
    vi.stubEnv("MODAL_PROFILE", "work");
    const run = await fingerprintOf(await modalAdapter());

    vi.stubEnv("MODAL_PROFILE", "personal");
    const other = await fingerprintOf(await modalAdapter());

    expect(run).toMatch(hex);
    expect(other).toMatch(hex);
    expect(other).not.toBe(run);
  });

  it("differs when the tokens come only from the profile file and the profile changes", async () => {
    withFakeModal();
    vi.stubEnv("MODAL_ENVIRONMENT", "main");
    vi.stubEnv("MODAL_SERVER_URL", "https://api.modal.invalid:443");
    vi.stubEnv("MODAL_PROFILE", "work");
    const run = await fingerprintOf(await modalAdapter());

    vi.stubEnv("MODAL_PROFILE", "personal");

    expect(await fingerprintOf(await modalAdapter())).not.toBe(run);
  });

  it("is the same for one effective connection, reached through the environment or the profile", async () => {
    withFakeModal();
    vi.stubEnv("MODAL_PROFILE", "personal");
    const fromProfile = await fingerprintOf(await modalAdapter());

    // Another profile, overridden field by field with the first one's values.
    vi.stubEnv("MODAL_PROFILE", "work");
    vi.stubEnv("MODAL_SERVER_URL", "https://other.modal.invalid:443");
    vi.stubEnv("MODAL_TOKEN_ID", "ak-personal");
    vi.stubEnv("MODAL_TOKEN_SECRET", "as-personal");
    vi.stubEnv("MODAL_ENVIRONMENT", "dev");

    expect(await fingerprintOf(await modalAdapter())).toBe(fromProfile);
  });

  it("follows the adapter's own token and Environment options, which win over both", async () => {
    const fake = withFakeModal();
    vi.stubEnv("MODAL_PROFILE", "work");
    const run = await fingerprintOf(await modalAdapter());
    const options = { tokenId: "ak-option", tokenSecret: "as-option", environment: "opt" };
    const other = await fingerprintOf(await modalAdapter(options));

    expect(other).not.toBe(run);
    expect(fake.constructed).toContainEqual(options);
  });

  it("reap refuses a Modal connection whose profile changed, and passes the same one", async () => {
    withFakeModal();
    vi.stubEnv("MODAL_PROFILE", "work");
    const journaled = (await fingerprintOf(await modalAdapter())) ?? undefined;

    expect(await reapConnection(await modalAdapter(), journaled)).toEqual({ kind: "same" });

    vi.stubEnv("MODAL_PROFILE", "personal");

    expect(await reapConnection(await modalAdapter(), journaled)).toMatchObject({
      kind: "differs",
    });
  });

  it("has no fingerprint, and reap refuses, when Modal's client cannot resolve a connection", async () => {
    vi.spyOn(connectionProbes, "loadModal").mockResolvedValue({
      ModalClient: class {
        constructor() {
          throw new Error(
            "Modal token credentials and OAuth credentials cannot both be configured.",
          );
        }

        close() {}
      },
    });
    const adapter = await modalAdapter();

    expect(await fingerprintOf(adapter)).toBeNull();
    expect(await reapConnection(adapter, "0123456789abcdef")).toMatchObject({ kind: "differs" });
  });
});

describe("boxd's fingerprint covers the region its SDK routes machine calls to", () => {
  it("differs when only BOXD_REGION does", async () => {
    vi.stubEnv("BOXD_API_KEY", "live-key");
    vi.stubEnv("BOXD_REGION", "nyc");
    const run = await fingerprintOf(bound({ ...memory(), name: "boxd" }));

    vi.stubEnv("BOXD_REGION", "fra");
    const other = await fingerprintOf(bound({ ...memory(), name: "boxd" }));

    vi.stubEnv("BOXD_REGION", undefined);
    const home = await fingerprintOf(bound({ ...memory(), name: "boxd" }));

    expect(run).toMatch(hex);
    expect(other).not.toBe(run);
    expect(home).not.toBe(run);
  });
});

describe("Beam's fingerprint covers its token, workspace and gateway", () => {
  const beam = (factory: FactoryOptions = {}) => bound({ ...memory(), name: "beam" }, factory);

  it("is the same for the options and the environment naming one connection", async () => {
    vi.stubEnv("BEAM_TOKEN", "live-token");
    vi.stubEnv("BEAM_WORKSPACE_ID", "ws-live");
    const fromEnv = await fingerprintOf(beam());

    vi.stubEnv("BEAM_TOKEN", "other-token");
    vi.stubEnv("BEAM_WORKSPACE_ID", "ws-other");

    expect(fromEnv).toMatch(hex);
    expect(await fingerprintOf(beam({ token: "live-token", workspaceId: "ws-live" }))).toBe(
      fromEnv,
    );
  });

  it.each([
    ["token", { token: "other-token" }],
    ["workspace", { workspaceId: "ws-other" }],
    ["gateway", { gatewayUrl: "https://gateway.invalid" }],
  ])("changes with the %s", async (_field, change) => {
    vi.stubEnv("BEAM_TOKEN", "live-token");
    vi.stubEnv("BEAM_WORKSPACE_ID", "ws-live");
    const run = await fingerprintOf(beam());

    expect(await fingerprintOf(beam(change))).not.toBe(run);
  });

  it("has no fingerprint, and reap refuses, without a workspace ID, as the adapter refuses", async () => {
    vi.stubEnv("BEAM_TOKEN", "live-token");

    expect(await fingerprintOf(beam())).toBeNull();
    expect(await reapConnection(beam(), "0123456789abcdef")).toMatchObject({ kind: "differs" });
  });
});

describe("the local adapter's fingerprint covers its socket and the daemon behind it", () => {
  it("resolves the socket as the adapter does: the dockerHost option, then DOCKER_HOST", async () => {
    const a = await fakeDocker("daemon-a");
    const b = await fakeDocker("daemon-b");

    try {
      vi.stubEnv("DOCKER_HOST", a.host);
      const fromEnv = await fingerprintOf(bound({ ...memory(), name: "local" }));

      vi.stubEnv("DOCKER_HOST", b.host);

      const fromOption = await fingerprintOf(
        bound({ ...memory(), name: "local" }, { dockerHost: a.host }),
      );

      const other = await fingerprintOf(bound({ ...memory(), name: "local" }));

      expect(fromEnv).toMatch(hex);
      expect(fromOption).toBe(fromEnv);
      expect(other).not.toBe(fromEnv);
    } finally {
      await a.close();
      await b.close();
    }
  });
});

describe("no provider the bench builds skips the fingerprint check", () => {
  /** A fake daemon for `local`, a fake SDK for Modal, and a key for every cloud provider. */
  async function environment() {
    const docker = await fakeDocker("daemon-registry");
    withFakeModal();
    vi.stubEnv("DOCKER_HOST", docker.host);

    for (const key of [
      "ARCHIL_API_KEY",
      "BASETEN_API_KEY",
      "BEAM_TOKEN",
      "BEAM_WORKSPACE_ID",
      "BOAT_API_KEY",
      "BOXD_API_KEY",
      "BUDDY_TOKEN",
      "BUDDY_WORKSPACE",
      "DAYTONA_API_KEY",
      "E2B_API_KEY",
      "FREESTYLE_API_KEY",
      "INSTABOX_API_KEY",
      "MARITIME_API_KEY",
      "MSB_API_KEY",
      "STYNE_API_KEY",
      "SUPERSERVE_API_KEY",
      "TENKI_API_KEY",
      "UPSTASH_BOX_API_KEY",
      "VERCEL_TOKEN",
      "VERCEL_TEAM_ID",
      "VERCEL_PROJECT_ID",
      "RAILWAY_API_TOKEN",
      "RAILWAY_ENVIRONMENT_ID",
    ])
      vi.stubEnv(key, `registry-${key}`);

    return docker;
  }

  it("lists the providers loadProvider builds", () => {
    expect([...providerNames].sort()).toEqual(
      expect.arrayContaining(["local", "memory", "modal", "railway", "agentos", "e2b"]),
    );
  });

  it.each(providerNames)("%s has a connection fingerprint a reap checks", async (name) => {
    const docker = await environment();

    try {
      const run = bound({ ...memory(), name });
      const fingerprint = await fingerprintOf(run);

      expect(fingerprint).toMatch(hex);

      // A reap through an instance built the same way passes; a foreign fingerprint is refused.
      expect(await reapConnection(bound({ ...memory(), name }), fingerprint ?? undefined)).toEqual({
        kind: "same",
      });
      expect(await reapConnection(bound({ ...memory(), name }), "ffffffffffffffff")).toMatchObject({
        kind: "differs",
      });
    } finally {
      await docker.close();
    }
  });

  it("refuses a reap through a provider it has no connection model for", async () => {
    expect(
      await reapConnection(bound({ ...memory(), name: "not-registered" }), undefined),
    ).toMatchObject({ kind: "differs" });
  });
});
