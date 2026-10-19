import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";

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
const credentials: Record<string, string[]> = {
  e2b: ["E2B_API_KEY"],
  railway: ["RAILWAY_API_TOKEN", "RAILWAY_ENVIRONMENT_ID"],
  vercel: ["VERCEL_TOKEN", "VERCEL_TEAM_ID", "VERCEL_PROJECT_ID"],
  daytona: ["DAYTONA_API_KEY"],
  upstash: ["UPSTASH_BOX_API_KEY"],
  boat: ["BOAT_API_KEY"],
  tenki: ["TENKI_API_KEY"],
  boxd: ["BOXD_API_KEY"],
};
const regionKeys: Record<string, string> = {
  e2b: "E2B_REGION",
  vercel: "VERCEL_REGION",
  daytona: "DAYTONA_TARGET",
};
const providerSchema: z.ZodType<Provider> = z
  .object({
    name: z.string(),
    keyMode: z.enum(["exact", "best-effort"]),
    capabilities: z.custom<Provider["capabilities"]>((value) => value instanceof Set),
    create: z.custom<Provider["create"]>((value) => typeof value === "function"),
    find: z.custom<Provider["find"]>((value) => typeof value === "function"),
    connect: z.custom<Provider["connect"]>((value) => typeof value === "function"),
    list: z.custom<Provider["list"]>((value) => typeof value === "function"),
    destroy: z.custom<Provider["destroy"]>((value) => typeof value === "function"),
    exec: z.custom<Provider["exec"]>((value) => typeof value === "function"),
    files: z
      .object({
        read: z.custom<Provider["files"]["read"]>((value) => typeof value === "function"),
        write: z.custom<Provider["files"]["write"]>((value) => typeof value === "function"),
        list: z.custom<Provider["files"]["list"]>((value) => typeof value === "function"),
        stat: z.custom<Provider["files"]["stat"]>((value) => typeof value === "function"),
        remove: z.custom<Provider["files"]["remove"]>((value) => typeof value === "function"),
        mkdir: z.custom<Provider["files"]["mkdir"]>((value) => typeof value === "function"),
      })
      .passthrough(),
    previewUrl: z.custom<Provider["previewUrl"]>((value) => typeof value === "function"),
    native: z.custom<Provider["native"]>((value) => typeof value === "function"),
  })
  .passthrough();
// Preserve class identity / method receivers after validating the adapter boundary.
function parseProvider(value: unknown): Provider {
  providerSchema.parse(value);
  return value as Provider;
}
export function missingCredentials(name: string, env: NodeJS.ProcessEnv): string[] {
  if (name === "tenki" && env.TENKI_AUTH_TOKEN?.trim()) return [];
  if (name === "vercel" && env.VERCEL_OIDC_TOKEN?.trim() && !env.VERCEL_TOKEN) return [];
  return (credentials[name] ?? []).filter((key) => !env[key]?.trim());
}
export async function loadProvider(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  importer: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<LoadedProvider> {
  if (!(name in credentials) && name !== "local" && name !== "memory" && name !== "agentos")
    return {
      kind: "skipped",
      name,
      note: "Unknown provider; add its credential policy before enabling it",
    };
  const missing = missingCredentials(name, env);
  if (missing.length)
    return { kind: "skipped", name, note: `Missing credentials: ${missing.join(", ")}` };
  let module: unknown;
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
  const factory = exports[name];
  if (typeof factory !== "function")
    return { kind: "skipped", name, note: `Entry point does not export ${name}()` };
  // Factory failures are real configuration errors, not missing-provider skips.
  const value: unknown = await factory();
  return {
    kind: "ready",
    name,
    cloud: name in credentials,
    region: env[`BENCH_REGION_${name.toUpperCase()}`] ?? env[regionKeys[name] ?? ""] ?? null,
    provider: parseProvider(value),
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
