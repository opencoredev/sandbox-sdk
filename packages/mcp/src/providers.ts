import type { Provider } from "@opencoredev/sandbox-sdk/provider";

export type ProviderLoader = () => Provider | Promise<Provider>;

interface CatalogEntry {
  /** Any one of these set in the environment means the provider is configured. Empty: needs none. */
  env: readonly string[];
  load: ProviderLoader;
}

/** Every provider this server can reach. Each adapter loads on first use, so unused ones cost nothing. */
export const catalog: ReadonlyMap<string, CatalogEntry> = new Map(
  Object.entries({
    local: { env: [], load: async () => (await import("@opencoredev/sandbox-sdk/local")).local() },
    e2b: {
      env: ["E2B_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/e2b")).e2b(),
    },
    vercel: {
      env: ["VERCEL_TOKEN", "VERCEL_OIDC_TOKEN"],
      load: async () => (await import("@opencoredev/sandbox-sdk/vercel")).vercel(),
    },
    modal: {
      env: ["MODAL_TOKEN_ID"],
      load: async () => (await import("@opencoredev/sandbox-sdk/modal")).modal(),
    },
    baseten: {
      env: ["BASETEN_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/baseten")).baseten(),
    },
    instabox: {
      env: ["INSTABOX_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/instabox")).instabox(),
    },
    daytona: {
      env: ["DAYTONA_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/daytona")).daytona(),
    },
    upstash: {
      env: ["UPSTASH_BOX_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/upstash")).upstash(),
    },
    railway: {
      env: ["RAILWAY_API_TOKEN"],
      load: async () => (await import("@opencoredev/sandbox-sdk/railway")).railway(),
    },
    sandboxer: {
      env: ["SANDBOXER_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/sandboxer")).sandboxer(),
    },
    boat: {
      env: ["BOAT_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/boat")).boat(),
    },
    // Luxor Agent Cloud was called Tenki; its adapter and environment variables keep that name.
    luxor: {
      env: ["TENKI_API_KEY", "TENKI_AUTH_TOKEN"],
      load: async () => (await import("@opencoredev/sandbox-sdk/tenki")).tenki(),
    },
    superserve: {
      env: ["SUPERSERVE_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/superserve")).superserve(),
    },
    boxd: {
      env: ["BOXD_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/boxd")).boxd(),
    },
    freestyle: {
      env: ["FREESTYLE_API_KEY"],
      load: async () => (await import("@opencoredev/sandbox-sdk/freestyle")).freestyle(),
    },
  }),
);

const aliases = new Map([
  ["tenki", "luxor"],
  ["docker", "local"],
]);

/**
 * The providers to offer, in order. `SANDBOX_PROVIDERS` (comma-separated) names them outright; without
 * it, every provider whose credentials are in the environment is offered, then `local` (Docker).
 */
export function providersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Map<string, ProviderLoader> {
  const requested = env.SANDBOX_PROVIDERS?.split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
    .map((name) => aliases.get(name) ?? name);

  const names =
    requested ??
    [...catalog]
      .flatMap(([name, entry]) => (entry.env.some((variable) => env[variable]) ? [name] : []))
      .concat("local");

  const selected = new Map<string, ProviderLoader>();

  for (const name of names) {
    const entry = catalog.get(name);

    if (!entry)
      throw new Error(
        `Unknown provider "${name}" in SANDBOX_PROVIDERS. Known: ${[...catalog.keys()].join(", ")}`,
      );
    selected.set(name, entry.load);
  }

  return selected;
}
