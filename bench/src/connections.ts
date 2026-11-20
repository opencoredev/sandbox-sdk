import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import type { FactoryOptions } from "./providers.js";
import {
  resolveConfig as basetenConfig,
  type BasetenConfig,
} from "@opencoredev/sandbox-sdk/baseten";
import { resolveConfig as boatConfig, type BoatConfig } from "@opencoredev/sandbox-sdk/boat";
import { resolveConfig as boxdConfig, type BoxdConfig } from "@opencoredev/sandbox-sdk/boxd";
import {
  resolveConfig as daytonaConfig,
  type DaytonaConfig,
} from "@opencoredev/sandbox-sdk/daytona";
import { resolveConfig as e2bConfig, type E2BConfig } from "@opencoredev/sandbox-sdk/e2b";
import {
  resolveConfig as freestyleConfig,
  type FreestyleConfig,
} from "@opencoredev/sandbox-sdk/freestyle";
import {
  resolveConfig as instaboxConfig,
  type InstaboxConfig,
} from "@opencoredev/sandbox-sdk/instabox";
import {
  resolveConfig as superserveConfig,
  type SuperserveConfig,
} from "@opencoredev/sandbox-sdk/superserve";
import { resolveConfig as tenkiConfig, type TenkiConfig } from "@opencoredev/sandbox-sdk/tenki";
import {
  resolveConfig as upstashConfig,
  type UpstashConfig,
} from "@opencoredev/sandbox-sdk/upstash";
import { resolveConfig as vercelConfig, type VercelConfig } from "@opencoredev/sandbox-sdk/vercel";

/**
 * Where each adapter connects and as whom: the endpoint, credentials and scope its own requests
 * use, from the SDK's `resolveConfig`. The harness reads, snapshots and cleans up through the
 * connection of the exact adapter instance that created the sandboxes. A read sent to another
 * endpoint, account, team or project answers 404 for a sandbox that is running, which would be
 * recorded as absence. Modal, local and memory resolve their own connection inside the adapter.
 */
export interface Connections {
  baseten: BasetenConfig;
  boat: BoatConfig;
  boxd: BoxdConfig;
  daytona: DaytonaConfig;
  e2b: E2BConfig;
  freestyle: FreestyleConfig;
  instabox: InstaboxConfig;
  superserve: SuperserveConfig;
  tenki: TenkiConfig;
  upstash: UpstashConfig;
  vercel: VercelConfig;
}

type Connected = keyof Connections;

/** One adapter instance's connection. It holds credentials: never log or store it. */
export type Connection = {
  [N in Connected]: { readonly name: N; readonly config: Connections[N] };
}[Connected];

/** The factory options that choose an adapter's endpoint, credentials and scope. */
const connectionOptions = z.object({
  apiKey: z.string().optional(),
  apiUrl: z.string().optional(),
  authToken: z.string().optional(),
  baseURL: z.string().optional(),
  baseUrl: z.string().optional(),
  domain: z.string().optional(),
  jwtToken: z.string().optional(),
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  target: z.string().optional(),
  teamId: z.string().optional(),
  token: z.string().optional(),
});

export type ConnectionOptions = z.infer<typeof connectionOptions>;

/** What `resolveConfig` returns for `name` with these factory options; null when the adapter resolves its own. */
function resolve(name: string, options: ConnectionOptions): Connection | null {
  switch (name) {
    case "baseten":
      return { name, config: basetenConfig(options) };
    case "boat":
      return { name, config: boatConfig(options) };
    case "boxd":
      return { name, config: boxdConfig(options) };
    case "daytona":
      return { name, config: daytonaConfig(options) };
    case "e2b":
      return { name, config: e2bConfig(options) };
    case "freestyle":
      return { name, config: freestyleConfig(options) };
    case "instabox":
      return { name, config: instaboxConfig(options) };
    case "superserve":
      return { name, config: superserveConfig(options) };
    case "tenki":
      return { name, config: tenkiConfig(options) };
    case "upstash":
      return { name, config: upstashConfig(options) };
    case "vercel":
      return { name, config: vercelConfig(options) };
    default:
      return null;
  }
}

/** A connection keyed by its provider, for typed reads by name. */
function byName(connection: Connection): Partial<Connections> {
  switch (connection.name) {
    case "baseten":
      return { baseten: connection.config };
    case "boat":
      return { boat: connection.config };
    case "boxd":
      return { boxd: connection.config };
    case "daytona":
      return { daytona: connection.config };
    case "e2b":
      return { e2b: connection.config };
    case "freestyle":
      return { freestyle: connection.config };
    case "instabox":
      return { instabox: connection.config };
    case "superserve":
      return { superserve: connection.config };
    case "tenki":
      return { tenki: connection.config };
    case "upstash":
      return { upstash: connection.config };
    case "vercel":
      return { vercel: connection.config };
    default: {
      const exhaustive: never = connection;

      return exhaustive;
    }
  }
}

type Binding =
  | {
      readonly kind: "resolved";
      readonly connection: Connection;
      readonly configs: Partial<Connections>;
    }
  | { readonly kind: "own" }
  | { readonly kind: "failed"; readonly reason: string };

const bindings = new WeakMap<Provider, Binding>();

/** Why a binding failed, without the error's text: a native message can echo a credential. */
function reasonOf(cause: unknown): string {
  const code = z.object({ code: z.string() }).safeParse(cause);

  return code.success ? `resolveConfig failed (${code.data.code})` : "resolveConfig failed";
}

/**
 * Record the connection of an adapter instance built with these factory options, resolved now,
 * as the adapter resolves it from the same options and environment. `loadProvider` calls this for
 * every instance it builds; anything that creates an adapter another way must too, or the
 * harness cannot read that adapter's sandboxes. A resolution failure (such as a missing key) is
 * kept and reported by every read through this instance.
 */
export function bindConnection<P extends Provider>(provider: P, options: FactoryOptions): P {
  const parsed = connectionOptions.safeParse(options);

  if (!parsed.success) {
    bindings.set(provider, { kind: "failed", reason: "connection options are not strings" });

    return provider;
  }

  try {
    const connection = resolve(provider.name, parsed.data);
    bindings.set(
      provider,
      connection ? { kind: "resolved", connection, configs: byName(connection) } : { kind: "own" },
    );
  } catch (error) {
    bindings.set(provider, { kind: "failed", reason: reasonOf(error) });
  }

  return provider;
}

/**
 * The connection `provider` was bound with. Throws, so the read reports `unavailable`, when the
 * instance was never bound, its connection failed to resolve, or it belongs to another provider:
 * the harness never falls back to the environment while an instance exists.
 */
export function connectionOf<N extends Connected>(provider: Provider, name: N): Connections[N] {
  const binding = bindings.get(provider);

  if (binding === undefined)
    throw new Error("Native lookup connection unknown: adapter instance not bound");

  if (binding.kind === "failed") throw new Error(`Native lookup connection: ${binding.reason}`);

  const config = binding.kind === "resolved" ? binding.configs[name] : undefined;

  if (config === undefined) throw new Error("Native lookup connection belongs to another provider");

  return config;
}

/** The base URL as the adapters' HTTP clients join it with a path: trailing slashes dropped. */
export function endpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** A connection's non-secret fields: endpoints, region and scope. Kept in the run's journal. */
export const savedConnectionSchema = z.record(z.string(), z.string().nullable());

export type SavedConnection = z.infer<typeof savedConnectionSchema>;

/** The endpoints, region and scope of a connection, without its credentials. */
function publicFields(connection: Connection): SavedConnection {
  switch (connection.name) {
    case "baseten":
      return { teamId: connection.config.teamId ?? null };
    case "boat":
    case "freestyle":
    case "instabox":
    case "upstash":
      return { baseUrl: connection.config.baseUrl };
    case "boxd":
      return { baseURL: connection.config.baseURL ?? null };
    case "daytona": {
      const { config } = connection;

      return {
        apiUrl: config.apiUrl,
        target: config.target,
        organizationId: "organizationId" in config ? config.organizationId : null,
      };
    }

    case "e2b":
      return { domain: connection.config.domain, apiUrl: connection.config.apiUrl };
    case "superserve":
      return {
        baseUrl: connection.config.baseUrl,
        sandboxHost: connection.config.sandboxHost,
      };
    case "tenki":
      return { baseUrl: connection.config.baseUrl ?? null };
    case "vercel": {
      const { config } = connection;

      return "token" in config
        ? { teamId: config.teamId, projectId: config.projectId }
        : { teamId: null, projectId: null };
    }

    default: {
      const exhaustive: never = connection;

      return exhaustive;
    }
  }
}

/** What to keep in the run's journal for this instance, or null when it has nothing to keep. */
export function savedConnectionOf(provider: Provider): SavedConnection | null {
  const binding = bindings.get(provider);

  return binding?.kind === "resolved" ? publicFields(binding.connection) : null;
}

/**
 * The factory options that rebuild a saved connection; credentials come from the environment.
 * E2B's API URL has no option (it comes from E2B_API_URL), so only the check below covers it.
 */
export function savedOptions(name: string, saved: SavedConnection): ConnectionOptions {
  const text = (key: string) => saved[key] ?? undefined;

  switch (name) {
    case "baseten":
      return { teamId: text("teamId") };
    case "boat":
    case "freestyle":
    case "instabox":
    case "superserve":
    case "upstash":
    case "tenki":
      return { baseUrl: text("baseUrl") };
    case "boxd":
      return { baseURL: text("baseURL") };
    case "daytona":
      return {
        baseUrl: text("apiUrl"),
        target: text("target"),
        organizationId: text("organizationId"),
      };
    case "e2b":
      return { domain: text("domain") };
    case "vercel":
      return { teamId: text("teamId"), projectId: text("projectId") };
    default:
      return {};
  }
}

/**
 * Whether an instance rebuilt for a saved run connects where the run did. A field that differs
 * (an E2B_API_URL that changed, a token now set where the run used OIDC) means reads through it
 * could miss the run's sandboxes, so recovery refuses that provider rather than read elsewhere.
 */
export function differingFields(provider: Provider, saved: SavedConnection): string[] {
  const current = savedConnectionOf(provider);

  if (current === null) return ["connection"];

  return [...new Set([...Object.keys(saved), ...Object.keys(current)])]
    .filter((key) => !isDeepStrictEqual(saved[key] ?? null, current[key] ?? null))
    .sort();
}

const journalConnections = z.object({
  connections: z.record(z.string(), savedConnectionSchema).default({}),
});

/**
 * The connections a run saved in its ownership journal, by provider. Empty when the journal is
 * missing, unreadable or older than saved connections; recovery reports a corrupt journal itself.
 */
export async function savedConnections(out: string): Promise<Record<string, SavedConnection>> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(out, "ownership.json"), "utf8"));
    const parsed = journalConnections.safeParse(raw);

    return parsed.success ? parsed.data.connections : {};
  } catch {
    return {};
  }
}
