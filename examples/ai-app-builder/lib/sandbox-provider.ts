import type { Provider } from "@opencoredev/sandbox-sdk/provider";

export const providerNames = ["local", "e2b", "vercel", "daytona"] as const;
export type ProviderName = (typeof providerNames)[number];

export function parseProviderName(value: string | undefined): ProviderName {
  const name = value ?? "local";
  const match = providerNames.find((candidate) => candidate === name);
  if (!match)
    throw new Error(`SANDBOX_PROVIDER must be one of ${providerNames.join(", ")}; got "${name}".`);
  return match;
}

/** Each adapter is imported on demand, so only the provider you pick needs its SDK installed. */
export async function loadProvider(name: ProviderName): Promise<Provider> {
  switch (name) {
    case "local":
      return (await import("@opencoredev/sandbox-sdk/local")).local();
    case "e2b":
      return (await import("@opencoredev/sandbox-sdk/e2b")).e2b();
    case "vercel":
      return (await import("@opencoredev/sandbox-sdk/vercel")).vercel();
    case "daytona":
      return (await import("@opencoredev/sandbox-sdk/daytona")).daytona();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown provider ${String(exhaustive)}`);
    }
  }
}
