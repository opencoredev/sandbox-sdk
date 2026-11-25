import { z } from "zod";
import { createHash } from "node:crypto";
import { request } from "node:http";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import type { FactoryOptions } from "./providers.js";
import {
  resolveConfig as basetenConfig,
  type BasetenConfig,
} from "@opencoredev/sandbox-sdk/baseten";
import { resolveConfig as beamConfig, type BeamConfig } from "@opencoredev/sandbox-sdk/beam";
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
 * recorded as absence. Archil, Local, Maritime, Modal, Railway and Styne have no `resolveConfig`;
 * their connection is read here from the same options and variables their adapters read.
 */
export interface Connections {
  archil: ArchilConfig;
  baseten: BasetenConfig;
  beam: BeamConfig;
  boat: BoatConfig;
  boxd: BoxdConfig;
  daytona: DaytonaConfig;
  e2b: E2BConfig;
  freestyle: FreestyleConfig;
  instabox: InstaboxConfig;
  local: LocalConfig;
  maritime: MaritimeConfig;
  modal: ModalConfig;
  railway: RailwayConfig;
  styne: StyneConfig;
  superserve: SuperserveConfig;
  tenki: TenkiConfig;
  upstash: UpstashConfig;
  vercel: VercelConfig;
}

/**
 * What `archil()` builds its client from (`connectClient` in the Archil adapter): the key, trimmed,
 * and the region the key belongs to. Archil keys are region-scoped, so the region picks the
 * control plane its requests reach.
 */
export interface ArchilConfig {
  readonly apiKey: string;
  readonly region: string;
}

/**
 * What `maritime()` sends its requests with (`createMaritimeProvider`): the key, trimmed, and the
 * API host without trailing slashes. The control plane is `${baseUrl}/v1`.
 */
export interface MaritimeConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

/**
 * What `styne()` sends its requests with (`createStyneProvider`): the key, trimmed, and the API
 * host without trailing slashes.
 */
export interface StyneConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
}

/** The Docker socket `local()` talks to (`new Docker(options.dockerHost)` in the local adapter). */
export interface LocalConfig {
  readonly socketPath: string;
}

/**
 * The `ModalClient` params `modal()` sets from its options. Unset ones are left to Modal's SDK,
 * which resolves them from the environment and then the profile file; the fingerprint reads the
 * profile the SDK resolved.
 */
export interface ModalConfig {
  readonly tokenId: string | undefined;
  readonly tokenSecret: string | undefined;
  readonly environment: string | undefined;
}

/** What `railway()` passes Railway's SDK (`api()` in the Railway adapter). */
export interface RailwayConfig {
  readonly token: string | undefined;
  readonly environmentId: string | undefined;
  readonly authType: string | undefined;
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
  authType: z.string().optional(),
  baseURL: z.string().optional(),
  baseUrl: z.string().optional(),
  dockerHost: z.string().optional(),
  domain: z.string().optional(),
  environment: z.string().optional(),
  environmentId: z.string().optional(),
  gatewayUrl: z.string().optional(),
  jwtToken: z.string().optional(),
  organizationId: z.string().optional(),
  projectId: z.string().optional(),
  region: z.string().optional(),
  target: z.string().optional(),
  teamId: z.string().optional(),
  token: z.string().optional(),
  tokenId: z.string().optional(),
  tokenSecret: z.string().optional(),
  workspaceId: z.string().optional(),
});

export type ConnectionOptions = z.infer<typeof connectionOptions>;

/** As the Archil adapter resolves it: options, then ARCHIL_API_KEY and ARCHIL_REGION. */
function archilConfig(options: ConnectionOptions): ArchilConfig {
  const apiKey = (options.apiKey ?? process.env.ARCHIL_API_KEY)?.trim();

  if (!apiKey) throw Object.assign(new Error("Archil API key is missing"), { code: "auth" });

  return { apiKey, region: options.region ?? process.env.ARCHIL_REGION ?? "aws-us-east-1" };
}

/** As the Maritime adapter resolves it: options, then MARITIME_API_KEY and MARITIME_API_URL. */
function maritimeConfig(options: ConnectionOptions): MaritimeConfig {
  const apiKey = (options.apiKey ?? process.env.MARITIME_API_KEY)?.trim();

  if (!apiKey) throw Object.assign(new Error("Maritime API key is missing"), { code: "auth" });

  return {
    apiKey,
    baseUrl: endpoint(options.baseUrl ?? process.env.MARITIME_API_URL ?? "https://api.maritime.sh"),
  };
}

/** As the Styne adapter resolves it: options, then STYNE_API_KEY and STYNE_API_URL. */
function styneConfig(options: ConnectionOptions): StyneConfig {
  const apiKey = (options.apiKey ?? process.env.STYNE_API_KEY)?.trim();

  if (!apiKey) throw Object.assign(new Error("Styne API key is missing"), { code: "auth" });

  return {
    apiKey,
    baseUrl: endpoint(options.baseUrl ?? process.env.STYNE_API_URL ?? "https://api.styne.ai"),
  };
}

/** The local adapter's socket: `dockerHost`, then DOCKER_HOST, then Docker's default socket. */
function localConfig(options: ConnectionOptions): LocalConfig {
  const host = options.dockerHost ?? process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock";

  // As the adapter's Docker client refuses it: only an absolute unix socket.
  if (!host.startsWith("unix://") || !host.slice(7).startsWith("/"))
    throw Object.assign(new Error("DOCKER_HOST is not an absolute unix socket"), {
      code: "unsupported",
    });

  return { socketPath: host.slice(7) };
}

/**
 * Providers with no connection to choose: they run in this process, so every instance reaches
 * the same sandboxes and none survives the process. Each fingerprints as a constant of its name,
 * so a journal still records it and a reap still compares it.
 */
const inProcess: ReadonlySet<string> = new Set(["memory", "agentos"]);

/**
 * The connection `name`'s adapter builds from these factory options and the environment: the
 * SDK's `resolveConfig` where it has one. Throws for a provider with no connection model, so an
 * adapter added to the registry without one is never treated as matching.
 */
function resolve(name: string, options: ConnectionOptions): Connection {
  const env = process.env;

  switch (name) {
    case "archil":
      return { name, config: archilConfig(options) };
    case "baseten":
      return { name, config: basetenConfig(options) };
    case "beam":
      return { name, config: beamConfig(options) };
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
    case "local":
      return { name, config: localConfig(options) };
    case "maritime":
      return { name, config: maritimeConfig(options) };
    case "modal":
      return {
        name,
        config: {
          tokenId: options.tokenId,
          tokenSecret: options.tokenSecret,
          environment: options.environment,
        },
      };
    case "railway":
      return {
        name,
        config: {
          token: options.token ?? env.RAILWAY_API_TOKEN,
          environmentId: options.environmentId ?? env.RAILWAY_ENVIRONMENT_ID,
          authType: options.authType,
        },
      };
    case "styne":
      return { name, config: styneConfig(options) };
    case "superserve":
      return { name, config: superserveConfig(options) };
    case "tenki":
      return { name, config: tenkiConfig(options) };
    case "upstash":
      return { name, config: upstashConfig(options) };
    case "vercel":
      return { name, config: vercelConfig(options) };
    default:
      throw Object.assign(new Error("No connection model for this provider"), {
        code: "unmodelled",
      });
  }
}

/** A connection keyed by its provider, for typed reads by name. */
function byName(connection: Connection): Partial<Connections> {
  switch (connection.name) {
    case "archil":
      return { archil: connection.config };
    case "baseten":
      return { baseten: connection.config };
    case "beam":
      return { beam: connection.config };
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
    case "local":
      return { local: connection.config };
    case "maritime":
      return { maritime: connection.config };
    case "modal":
      return { modal: connection.config };
    case "railway":
      return { railway: connection.config };
    case "styne":
      return { styne: connection.config };
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
      /** The fingerprint's input from the options and environment at bind time. */
      readonly configured: readonly (string | FieldList)[];
    }
  | { readonly kind: "in-process"; readonly fingerprint: string }
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
  if (inProcess.has(provider.name)) {
    bindings.set(provider, { kind: "in-process", fingerprint: hash([provider.name]) });

    return provider;
  }

  const parsed = connectionOptions.safeParse(options);

  if (!parsed.success) {
    bindings.set(provider, { kind: "failed", reason: "connection options are not strings" });

    return provider;
  }

  try {
    const connection = resolve(provider.name, parsed.data);
    bindings.set(provider, { kind: "resolved", connection, configured: configured(connection) });
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

  const config = binding.kind === "resolved" ? byName(binding.connection)[name] : undefined;

  if (config === undefined) throw new Error("Native lookup connection belongs to another provider");

  return config;
}

/** The part of Modal's SDK that resolves a connection; hand-typed from modal 0.11.1. */
export interface ModalModule {
  ModalClient: new (params: ModalClientParams) => { readonly profile?: unknown; close(): void };
}

/** The `ModalClient` params `modal()` sets from its options; the SDK resolves the rest. */
export interface ModalClientParams {
  tokenId?: string;
  tokenSecret?: string;
  environment?: string;
}

/**
 * The `ModalClient` params for a bound Modal connection, built as `modal()` builds its client:
 * set fields are passed, unset ones stay unset so the SDK resolves them. Every Modal client the
 * harness makes for an adapter instance (fingerprint, lookup, snapshot reads) uses these, so each
 * reaches the connection the adapter and its fingerprint reach.
 */
export function modalClientParams(config: ModalConfig): ModalClientParams {
  const params: ModalClientParams = {};

  if (config.tokenId !== undefined) params.tokenId = config.tokenId;

  if (config.tokenSecret !== undefined) params.tokenSecret = config.tokenSecret;

  if (config.environment !== undefined) params.environment = config.environment;

  return params;
}

const sdkPackage = new URL("../../packages/sdk/package.json", import.meta.url);

/** Docker's `/info`: the daemon's ID, which stays the same across its restarts. */
const dockerInfo = z.object({ ID: z.string().min(1) });

/**
 * The reads a connection fingerprint makes beyond the adapter's options and environment. Tests
 * replace `loadModal`; `dockerDaemonId` is a plain read on the socket.
 */
export const connectionProbes = {
  /** Modal's SDK from the SDK package's install, the module instance the adapter uses. */
  loadModal: async (): Promise<ModalModule> => {
    const module: ModalModule = await import(import.meta.resolve("modal", sdkPackage.href));

    return module;
  },
  /** The ID of the Docker daemon answering on `socketPath`. Rejects on any failure. */
  dockerDaemonId: (socketPath: string, timeoutMs: number) =>
    new Promise<string>((resolve, reject) => {
      const req = request({ socketPath, path: "/v1.44/info", method: "GET" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Docker /info answered ${res.statusCode ?? "no status"}`));

            return;
          }

          try {
            resolve(dockerInfo.parse(JSON.parse(Buffer.concat(chunks).toString())).ID);
          } catch (error) {
            reject(error);
          }
        });
      });

      req.setTimeout(timeoutMs, () => req.destroy(new Error("Docker /info timed out")));
      req.on("error", reject);
      req.end();
    }),
};

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
 * `resolveConfig` leaves the field unset: Boxd's and Tenki's endpoints, Boxd's region, Railway's
 * endpoints, Vercel's OIDC token. Modal's are read through its SDK (`modalProfileOf`).
 */
function sdkEnvironment(connection: Connection): z.infer<typeof connectionFields> {
  const env = process.env;

  switch (connection.name) {
    case "boxd":
      // The adapter has no region option: the SDK routes machine calls to BOXD_REGION, else the
      // account's home cluster.
      return connection.config.baseURL === undefined
        ? {
            BOXD_BASE_URL: env.BOXD_BASE_URL,
            BOXD_API_URL: env.BOXD_API_URL,
            BOXD_REGION: env.BOXD_REGION,
          }
        : { BOXD_REGION: env.BOXD_REGION };
    case "railway": {
      // Railway's SDK takes its endpoints from the environment, and its token from RAILWAY_TOKEN
      // when the adapter passes none.
      const fields: z.infer<typeof connectionFields> = {
        RAILWAY_GRAPHQL_ENDPOINT: env.RAILWAY_GRAPHQL_ENDPOINT,
        RAILWAY_TCP_PROXY_WS_ENDPOINT: env.RAILWAY_TCP_PROXY_WS_ENDPOINT,
      };

      if (connection.config.token === undefined) fields.RAILWAY_TOKEN = env.RAILWAY_TOKEN;

      return fields;
    }

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
type FieldList = [string, string][];

function setFields(fields: z.infer<typeof connectionFields>): FieldList {
  return Object.entries(fields)
    .filter((field): field is [string, string] => field[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The first 16 hex characters of a SHA-256 over the serialized input. */
function hash(input: readonly (string | FieldList)[]): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex").slice(0, 16);
}

/**
 * The fingerprint's input that the options and environment decide, taken at bind time: provider,
 * endpoints, scope and credentials, with what the provider's SDK reads from the environment
 * itself. Fields are sorted and unset ones dropped, so equal connections hash alike whatever
 * order `resolveConfig` built them in.
 */
function configured(connection: Connection): readonly (string | FieldList)[] {
  return [
    connection.name,
    setFields(connectionFields.parse(connection.config)),
    setFields(sdkEnvironment(connection)),
  ];
}

/** What a Modal client resolved its connection to, as `ModalClient` keeps it (`client.profile`). */
const modalProfile = z.object({
  serverUrl: z.string(),
  tokenId: z.string().optional(),
  tokenSecret: z.string().optional(),
  workspaceId: z.string().optional(),
  environment: z.string().optional(),
  oauthRefreshToken: z.string().optional(),
  oauthClientId: z.string().optional(),
  oauthClientSecret: z.string().optional(),
  oauthJwtKey: z.string().optional(),
});

/**
 * The connection Modal's SDK resolves for these params, by its own rules: each param, else its
 * environment variable, else the profile `MODAL_PROFILE` names (or the active one) in the file
 * `MODAL_CONFIG_PATH` names (or `~/.modal.toml`). Constructing the client makes no request.
 */
async function modalProfileOf(config: ModalConfig) {
  const { ModalClient } = await connectionProbes.loadModal();
  const client = new ModalClient(modalClientParams(config));

  try {
    return modalProfile.parse(client.profile);
  } finally {
    client.close();
  }
}

/** How long a fingerprint waits for Docker's `/info`. */
const dockerInfoTimeoutMs = 5_000;

/**
 * What identifies a connection beyond its configuration, read when the fingerprint is taken:
 * for local, the ID of the daemon behind the socket, so a socket path that now leads to another
 * daemon is told apart; for Modal, the connection its SDK resolved from the environment and the
 * profile file. `unknown` when that read fails, which leaves the connection unidentified.
 */
type Identity =
  | { readonly kind: "none" }
  | { readonly kind: "known"; readonly fields: FieldList }
  | { readonly kind: "unknown"; readonly reason: string };

async function identity(connection: Connection): Promise<Identity> {
  switch (connection.name) {
    case "local":
      try {
        const id = await connectionProbes.dockerDaemonId(
          connection.config.socketPath,
          dockerInfoTimeoutMs,
        );

        return { kind: "known", fields: [["daemonId", id]] };
      } catch {
        return {
          kind: "unknown",
          reason: "the Docker daemon did not answer /info, so it cannot be told from another",
        };
      }

    case "modal":
      try {
        return { kind: "known", fields: setFields(await modalProfileOf(connection.config)) };
      } catch {
        return { kind: "unknown", reason: "Modal's client did not resolve a connection" };
      }

    default:
      return { kind: "none" };
  }
}

export type Fingerprint =
  | { readonly kind: "known"; readonly value: string }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The fingerprint of a whole connection: its configuration from bind time and, where it has one,
 * its identity read now. It identifies the connection without holding any of it, so the run's
 * journal can keep it and a reap can tell whether its environment reaches the same connection.
 */
async function fingerprintNow(
  binding: Extract<Binding, { kind: "resolved" }>,
): Promise<Fingerprint> {
  const live = await identity(binding.connection);

  if (live.kind === "unknown") return live;
  const input = live.kind === "known" ? [...binding.configured, live.fields] : binding.configured;

  return { kind: "known", value: hash(input) };
}

/**
 * This instance's connection fingerprint for the run's journal, or why it has none: it was never
 * bound, its connection failed to resolve, or its identity could not be read. The reason names no
 * connection value.
 */
export async function journalFingerprint(provider: Provider): Promise<Fingerprint> {
  const binding = bindings.get(provider);

  if (binding === undefined) return { kind: "unknown", reason: "adapter instance not bound" };

  if (binding.kind === "failed") return { kind: "unknown", reason: binding.reason };

  if (binding.kind === "in-process") return { kind: "known", value: binding.fingerprint };

  return fingerprintNow(binding);
}

/** {@link journalFingerprint}'s value, or null when the instance has none. */
export async function fingerprintOf(provider: Provider): Promise<string | null> {
  const current = await journalFingerprint(provider);

  return current.kind === "known" ? current.value : null;
}

/**
 * Whether a reap may read through `provider` for a run that journaled `journaled` as its
 * connection fingerprint. It passes only when this instance reaches the very connection the run
 * used: any other endpoint, account, team, project, Docker daemon or Modal profile would answer
 * 404 for the run's live sandboxes. An in-process provider has one connection, so a journal that
 * lacks its fingerprint (a truncated one) still passes, but another fingerprint does not. The
 * refusal says why without any connection value.
 */
export async function reapConnection(
  provider: Provider,
  journaled: string | undefined,
): Promise<{ readonly kind: "same" } | { readonly kind: "differs"; readonly reason: string }> {
  const differs = {
    kind: "differs",
    reason:
      "connection fingerprint differs from the run's: this environment's endpoint, credentials, scope or daemon are not the ones the run used",
  } as const;

  const binding = bindings.get(provider);

  if (binding === undefined) return { kind: "differs", reason: "adapter instance not bound" };

  if (binding.kind === "failed") return { kind: "differs", reason: binding.reason };

  if (binding.kind === "in-process")
    return journaled === undefined || journaled === binding.fingerprint
      ? { kind: "same" }
      : differs;

  if (journaled === undefined)
    return { kind: "differs", reason: "the run's journal has no connection fingerprint for it" };
  const current = await fingerprintNow(binding);

  if (current.kind === "unknown") return { kind: "differs", reason: current.reason };

  return current.value === journaled ? { kind: "same" } : differs;
}
