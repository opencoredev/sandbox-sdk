import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import type { ConfigV2 } from "./v2-config.js";

const templateKeys = new Map([
  ["e2b", "template"],
  ["superserve", "template"],
  ["daytona", "snapshot"],
  ["freestyle", "snapshotId"],
  ["tenki", "image"],
  ["boxd", "image"],
  ["local", "image"],
]);

export function templateOptions(name: string, template: string | undefined) {
  if (template === undefined) return {};

  const key = templateKeys.get(name);

  if (!key) throw new Error(`${name} has no template/image factory option`);

  return { [key]: template };
}

/** Factory options selecting a native product; validated by parseV2. */
export function productOptions(name: string, product: string | undefined) {
  if (product === undefined || product === "box") return {};

  if (name === "upstash" && product === "ephemeral") return { ephemeral: true };
  throw new Error(`${name} has no ${product} product`);
}

export interface ReadyProvider {
  kind: "ready";
  name: string;
  cloud: boolean;
  region: string | null;
  provider: Provider;
}

export interface SkippedProvider {
  kind: "skipped";
  name: string;
  note: string;
}

export type LoadedProvider = ReadyProvider | SkippedProvider;

const credentials = new Map([
  ["superserve", ["SUPERSERVE_API_KEY"]],
  ["e2b", ["E2B_API_KEY"]],
  ["railway", ["RAILWAY_API_TOKEN", "RAILWAY_ENVIRONMENT_ID"]],
  ["vercel", ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"]],
  ["daytona", ["DAYTONA_API_KEY"]],
  ["upstash", ["UPSTASH_BOX_API_KEY"]],
  ["boat", ["BOAT_API_KEY"]],
  ["tenki", ["TENKI_API_KEY"]],
  ["boxd", ["BOXD_API_KEY"]],
  ["freestyle", ["FREESTYLE_API_KEY"]],
]);

const regionKeys = new Map([
  ["e2b", "E2B_REGION"],
  ["vercel", "VERCEL_REGION"],
  ["daytona", "DAYTONA_TARGET"],
]);

function isFunction(value: unknown): value is (...args: never[]) => void {
  return typeof value === "function";
}

const method = <T>() => z.custom<T>(isFunction);

const providerSchema: z.ZodType<Provider> = z
  .object({
    name: z.string(),
    keyMode: z.enum(["exact", "best-effort"]),
    capabilities: z.custom<Provider["capabilities"]>((value) => value instanceof Set),
    create: method<Provider["create"]>(),
    find: method<Provider["find"]>(),
    connect: method<Provider["connect"]>(),
    list: method<Provider["list"]>(),
    destroy: method<Provider["destroy"]>(),
    exec: method<Provider["exec"]>(),
    files: z
      .object({
        read: method<Provider["files"]["read"]>(),
        write: method<Provider["files"]["write"]>(),
        list: method<Provider["files"]["list"]>(),
        stat: method<Provider["files"]["stat"]>(),
        remove: method<Provider["files"]["remove"]>(),
        mkdir: method<Provider["files"]["mkdir"]>(),
      })
      .passthrough(),
    previewUrl: method<Provider["previewUrl"]>(),
    native: method<Provider["native"]>(),
  })
  .passthrough();

// Validate in place: the parsed copy would lose the adapter's class identity and method receivers.
function assertProvider(value: unknown): asserts value is Provider {
  providerSchema.parse(value);
}

export type FactoryOptions = Record<string, string | boolean | undefined>;

/** A provider entry point's factory. Its result is checked by `assertProvider`. */
type ProviderFactory = (options: FactoryOptions) => Provider | Promise<Provider>;

const providerFactory = z.custom<ProviderFactory>(isFunction);

export function missingCredentials(name: string, env: NodeJS.ProcessEnv): string[] {
  if (name === "tenki" && env.TENKI_AUTH_TOKEN?.trim()) return [];

  if (name === "vercel" && env.VERCEL_OIDC_TOKEN?.trim() && !env.VERCEL_TOKEN) return [];

  return (credentials.get(name) ?? []).filter((key) => !env[key]?.trim());
}

export async function loadProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  importer: (specifier: string) => Promise<object> = (specifier) => import(specifier),
  config?: Pick<ConfigV2, "template" | "product">,
): Promise<LoadedProvider> {
  if (!credentials.has(name) && name !== "local" && name !== "memory" && name !== "agentos")
    return {
      kind: "skipped",
      name,
      note: "Unknown provider; add its credential policy before enabling it",
    };
  const missing = missingCredentials(name, env);

  if (missing.length)
    return { kind: "skipped", name, note: `Missing credentials: ${missing.join(", ")}` };
  let module: object;

  try {
    module = await importer(`@opencoredev/sandbox-sdk/${name}`);
  } catch {
    return {
      kind: "skipped",
      name,
      note: "Provider entry point unavailable; build/install the adapter and its native SDK",
    };
  }

  const exports = z.record(z.string(), z.unknown()).parse(module);
  const factory = providerFactory.safeParse(exports[name]);

  if (!factory.success)
    return { kind: "skipped", name, note: `Entry point does not export ${name}()` };

  // Factory failures are real configuration errors, not missing-provider skips.
  const provider = await factory.data({
    ...templateOptions(name, config?.template[name]),
    ...productOptions(name, config?.product[name]),
  });

  assertProvider(provider);

  return {
    kind: "ready",
    name,
    cloud: credentials.has(name),
    region: env[`BENCH_REGION_${name.toUpperCase()}`] ?? env[regionKeys.get(name) ?? ""] ?? null,
    provider,
  };
}

export function checkBudget(
  providers: LoadedProvider[],
  config: { runs: number; warmup: number; "max-sandboxes": number; yes: boolean },
): number {
  const planned =
    providers.filter((provider) => provider.kind === "ready" && provider.cloud).length *
    (config.runs + config.warmup);

  if (planned > config["max-sandboxes"] && !config.yes)
    throw new Error(
      `Refusing ${planned} cloud sandboxes (including warmup); budget is ${config["max-sandboxes"]}. Raise --max-sandboxes or pass --yes.`,
    );

  return planned;
}

type ProviderKey = keyof Provider;

type ProviderMethod = Extract<Provider[ProviderKey], (...args: never[]) => void>;

function isProviderKey(target: Provider, key: string | symbol): key is ProviderKey {
  return key in target;
}

function isProviderMethod(value: Provider[ProviderKey]): value is ProviderMethod {
  return typeof value === "function";
}

/** Read a provider member from a Proxy trap, keeping the provider as each method's receiver. */
export function providerMember(target: Provider, key: string | symbol) {
  if (!isProviderKey(target, key)) return undefined;

  const value = target[key];

  return isProviderMethod(value) ? value.bind(target) : value;
}
