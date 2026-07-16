import { SandboxError } from "./errors";
import type { Capability, CapabilityMap, CapabilityMode, Sandbox } from "./types";

export function defineCapabilities(
  values: Partial<Record<Capability, CapabilityMode>>,
): CapabilityMap {
  return new Proxy(values, {
    get(target, property) {
      return typeof property === "string" && property in target
        ? target[property as Capability]
        : false;
    },
  }) as CapabilityMap;
}

export function supports(sandbox: Pick<Sandbox, "capabilities">, capability: Capability): boolean {
  return sandbox.capabilities[capability] !== false;
}

export function capabilityMode(
  sandbox: Pick<Sandbox, "capabilities">,
  capability: Capability,
): CapabilityMode | false {
  return sandbox.capabilities[capability];
}

export function requireCapability(
  sandbox: Pick<Sandbox, "capabilities" | "provider">,
  capability: Capability,
): CapabilityMode {
  const mode = sandbox.capabilities[capability];
  if (mode === false) {
    throw new SandboxError({
      code: "unsupported",
      provider: sandbox.provider,
      operation: capability,
      message: `${sandbox.provider} does not support ${capability}`,
    });
  }
  return mode;
}
