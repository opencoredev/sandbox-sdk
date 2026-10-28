// One SANDBOX_PROVIDER value picks the provider; the sandbox code below is identical
// for all of them. Defaults to the keyless memory provider.
//
//   SANDBOX_PROVIDER=local bun src/multi-provider.ts   # Docker on this machine
//   SANDBOX_PROVIDER=e2b E2B_API_KEY=... bun src/multi-provider.ts
import { createSandbox, type Sandbox } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";

const providerNames = ["memory", "local", "e2b", "daytona", "vercel", "upstash", "railway", "tenki", "boxd", "freestyle", "superserve", "boat"] as const;
type ProviderName = (typeof providerNames)[number];

function parseProviderName(value: string | undefined): ProviderName {
  const name = value ?? "memory";
  const match = providerNames.find((candidate) => candidate === name);
  if (!match) throw new Error(`SANDBOX_PROVIDER must be one of ${providerNames.join(", ")}; got "${name}".`);
  return match;
}

// Dynamic imports keep each provider's peer package optional: only the one you pick must be installed.
async function loadProvider(name: ProviderName): Promise<Provider> {
  switch (name) {
    case "memory":
      return (await import("@opencoredev/sandbox-sdk/memory")).memory();
    case "local":
      return (await import("@opencoredev/sandbox-sdk/local")).local();
    case "e2b":
      return (await import("@opencoredev/sandbox-sdk/e2b")).e2b();
    case "daytona":
      return (await import("@opencoredev/sandbox-sdk/daytona")).daytona();
    case "vercel":
      return (await import("@opencoredev/sandbox-sdk/vercel")).vercel();
    case "upstash":
      return (await import("@opencoredev/sandbox-sdk/upstash")).upstash();
    case "railway":
      return (await import("@opencoredev/sandbox-sdk/railway")).railway();
    case "tenki":
      return (await import("@opencoredev/sandbox-sdk/tenki")).tenki();
    case "boxd":
      return (await import("@opencoredev/sandbox-sdk/boxd")).boxd();
    case "freestyle":
      return (await import("@opencoredev/sandbox-sdk/freestyle")).freestyle();
    case "superserve":
      return (await import("@opencoredev/sandbox-sdk/superserve")).superserve();
    case "boat":
      return (await import("@opencoredev/sandbox-sdk/boat")).boat();
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown provider ${String(exhaustive)}`);
    }
  }
}

// Portable code takes the base `Sandbox` type, which has only the methods every provider supports.
async function greet(box: Sandbox): Promise<string> {
  await box.files.write("greeting.txt", `hello from ${box.provider}\n`);
  const result = await box.run("cat greeting.txt");
  if (!result.ok) throw new Error(`cat failed with exit code ${result.exitCode}: ${result.stderr}`);
  return result.stdout.trim();
}

const name = parseProviderName(process.env.SANDBOX_PROVIDER);
await using box = await createSandbox(await loadProvider(name));
console.log(`provider=${box.provider} id=${box.id}`);
console.log(await greet(box));
console.log(`capabilities: ${[...box.capabilities].join(", ") || "none"}`);

// A runtime-selected `Provider` types every optional method as present, so check
// `box.capabilities` before calling pause, resume, snapshot, or terminal.
if (box.capabilities.has("pause")) {
  await box.pause();
  await box.resume();
  console.log(`pause/resume: ok, still answers: ${(await box.run("echo alive")).stdout.trim()}`);
} else {
  console.log(`pause/resume: skipped, ${box.provider} cannot pause`);
}
