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

/** The members every adapter has. Methods are checked to be functions, not their signatures. */
const providerSchema = z
  .object({
    name: z.string(),
    keyMode: z.enum(["exact", "best-effort"]),
    capabilities: z.instanceof(Set),
    create: z.function(),
    find: z.function(),
    connect: z.function(),
    list: z.function(),
    destroy: z.function(),
    exec: z.function(),
    files: z
      .object({
        read: z.function(),
        write: z.function(),
        list: z.function(),
        stat: z.function(),
        remove: z.function(),
        mkdir: z.function(),
      })
      .passthrough(),
    previewUrl: z.function(),
    native: z.function(),
  })
  .passthrough();

// Validate in place: the parsed copy would lose the adapter's class identity and method receivers.
function assertProvider(value: unknown): asserts value is Provider {
  providerSchema.parse(value);
}

const factoryOptions = z.record(z.string(), z.union([z.string(), z.boolean()]).optional());

export type FactoryOptions = z.infer<typeof factoryOptions>;

/** A provider entry point's factory. Its result is checked by `assertProvider`. */
const providerFactory = z.function({ input: [factoryOptions] });

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

/** How a Proxy reads each provider member: methods stay bound to the original adapter. */
const providerMembers = {
  name: (target) => target.name,
  keyMode: (target) => target.keyMode,
  processMode: (target) => target.processMode,
  previewMode: (target) => target.previewMode,
  inlineActivity: (target) => target.inlineActivity,
  commandShell: (target) => target.commandShell,
  processRecordRoot: (target) => target.processRecordRoot,
  capabilities: (target) => target.capabilities,
  create: (target) => target.create.bind(target),
  find: (target) => target.find.bind(target),
  connect: (target) => target.connect.bind(target),
  list: (target) => target.list.bind(target),
  destroy: (target) => target.destroy.bind(target),
  exec: (target) => target.exec.bind(target),
  files: (target) => target.files,
  previewUrl: (target) => target.previewUrl.bind(target),
  native: (target) => target.native.bind(target),
  close: (target) => target.close?.bind(target),
  usage: (target) => target.usage?.bind(target),
  pause: (target) => target.pause?.bind(target),
  resume: (target) => target.resume?.bind(target),
  snapshot: (target) => target.snapshot?.bind(target),
  terminal: (target) => target.terminal?.bind(target),
  startProcess: (target) => target.startProcess?.bind(target),
  readSecretEnvironment: (target) => target.readSecretEnvironment?.bind(target),
} satisfies { readonly [K in keyof Provider]-?: (target: Provider) => Provider[K] };

function isProviderKey(key: string | symbol): key is keyof Provider {
  return Object.hasOwn(providerMembers, key);
}

/** Read a provider member from a Proxy trap, keeping the provider as each method's receiver. */
export function providerMember(target: Provider, key: string | symbol) {
  if (!isProviderKey(key)) return undefined;

  return providerMembers[key](target);
}
