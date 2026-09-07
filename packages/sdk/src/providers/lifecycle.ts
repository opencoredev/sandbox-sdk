import { builtInProviderNames, type BuiltInProviderName } from "../core/types";

export interface AdapterLifecycle {
  stop: string;
  destroy: string;
  createSignal: boolean;
}

export const adapterLifecycle = {
  local: { stop: "dispose ephemeral VM", destroy: "delete ephemeral VM", createSignal: true },
  e2b: { stop: "pause, else kill", destroy: "kill", createSignal: true },
  daytona: { stop: "sandbox.stop", destroy: "client.delete", createSignal: true },
  vercel: { stop: "sandbox.stop", destroy: "sandbox.delete", createSignal: true },
  upstash: { stop: "pause, else delete", destroy: "delete", createSignal: true },
  box: { stop: "client.stop", destroy: "destroyBox", createSignal: true },
  railway: { stop: "disconnect; idle timeout remains", destroy: "destroy", createSignal: true },
  cloudflare: { stop: "clear keepAlive", destroy: "destroy", createSignal: true },
  memory: { stop: "no-op", destroy: "clear files", createSignal: true },
} as const satisfies Record<BuiltInProviderName, AdapterLifecycle>;

export function lifecycleFor(id: BuiltInProviderName): AdapterLifecycle {
  return adapterLifecycle[id];
}

export const lifecycleIds = builtInProviderNames;
