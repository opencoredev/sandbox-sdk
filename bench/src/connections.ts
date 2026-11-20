import { z } from "zod";
import { createHash } from "node:crypto";
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
      readonly configs: Partial<Connections>;
      readonly fingerprint: string;
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
      connection
        ? { kind: "resolved", configs: byName(connection), fingerprint: fingerprint(connection) }
        : { kind: "own" },
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

/** A connection's fingerprint: the first 16 hex characters of a SHA-256 over all of it. */
export const fingerprintSchema = z.string().regex(/^[0-9a-f]{16}$/);

/** Every adapter's resolved connection is flat: named strings, some of them unset. */
const connectionFields = z.record(z.string(), z.string().optional());

/**
 * What a connection takes from the environment through the provider's own SDK, where
 * `resolveConfig` leaves the field unset: Boxd's and Tenki's endpoints, Vercel's OIDC token.
 */
function sdkEnvironment(connection: Connection): z.infer<typeof connectionFields> {
  const env = process.env;

  switch (connection.name) {
    case "boxd":
      return connection.config.baseURL === undefined
        ? { BOXD_BASE_URL: env.BOXD_BASE_URL, BOXD_API_URL: env.BOXD_API_URL }
        : {};
    case "tenki":
      return connection.config.baseUrl === undefined
        ? { TENKI_API_ENDPOINT: env.TENKI_API_ENDPOINT, TENKI_API_URL: env.TENKI_API_URL }
        : {};
    case "vercel":
      return "token" in connection.config ? {} : { VERCEL_OIDC_TOKEN: env.VERCEL_OIDC_TOKEN };
    default:
      return {};
  }
}

/** A connection's set fields, sorted by name. */
function setFields(fields: z.infer<typeof connectionFields>): [string, string][] {
  return Object.entries(fields)
    .filter((field): field is [string, string] => field[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The fingerprint of a whole resolved connection: provider, endpoints, scope and credentials,
 * with what the provider's SDK reads from the environment itself. It identifies the connection
 * without holding any of it, so the run's journal can keep it and a reap can tell whether its
 * environment rebuilds the same connection. Fields are sorted and unset ones dropped, so equal
 * connections hash alike whatever order `resolveConfig` built them in.
 */
function fingerprint(connection: Connection): string {
  const serialized = JSON.stringify([
    connection.name,
    setFields(connectionFields.parse(connection.config)),
    setFields(sdkEnvironment(connection)),
  ]);

  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/** This instance's connection fingerprint for the run's journal, or null when it has none. */
export function fingerprintOf(provider: Provider): string | null {
  const binding = bindings.get(provider);

  return binding?.kind === "resolved" ? binding.fingerprint : null;
}

const connectedNames = {
  baseten: true,
  boat: true,
  boxd: true,
  daytona: true,
  e2b: true,
  freestyle: true,
  instabox: true,
  superserve: true,
  tenki: true,
  upstash: true,
  vercel: true,
} satisfies Record<Connected, true>;

/**
 * Whether a reap may read through `provider` for a run that journaled `journaled` as its
 * connection fingerprint. A connected provider passes only when this instance resolved the very
 * connection the run used: any other endpoint, account, team or project would answer 404 for the
 * run's live sandboxes. The refusal says why without any connection value.
 */
export function reapConnection(
  provider: Provider,
  journaled: string | undefined,
): { readonly kind: "same" } | { readonly kind: "differs"; readonly reason: string } {
  const binding = bindings.get(provider);

  if (
    binding?.kind === "own" ||
    (binding === undefined && !Object.hasOwn(connectedNames, provider.name))
  )
    return { kind: "same" };

  if (binding === undefined) return { kind: "differs", reason: "adapter instance not bound" };

  if (binding.kind === "failed") return { kind: "differs", reason: binding.reason };

  if (journaled === undefined)
    return { kind: "differs", reason: "the run's journal has no connection fingerprint for it" };

  return binding.fingerprint === journaled
    ? { kind: "same" }
    : {
        kind: "differs",
        reason:
          "connection fingerprint differs from the run's: this environment's endpoint, credentials or scope are not the ones the run used",
      };
}
