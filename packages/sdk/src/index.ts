export { capabilityMode, requireCapability, supports } from "./core/capabilities";
export { isSandboxError, redactSensitive, SandboxError, sandboxErrorCodes } from "./core/errors";
export { createSandbox, withSandbox } from "./core/sandbox";
export { capabilityNames, providerNames } from "./core/types";
export type {
  Capability,
  CapabilityMap,
  CapabilityMode,
  CommandInput,
  CommandResult,
  ExposedPort,
  FileValue,
  ProcessOutputEvent,
  ProcessStatus,
  ProviderName,
  RunOptions,
  Sandbox,
  SandboxDirectoryEntry,
  SandboxFiles,
  SandboxPorts,
  SandboxProcess,
  SandboxProcesses,
  SandboxSnapshot,
  SandboxSnapshots,
} from "./core/types";
export type { SandboxErrorCode } from "./core/errors";
export type {
  ManagedSandboxCreateOptions,
  ManagedSandboxProvider,
  ManagedSandboxResumeOptions,
  ManagedSandboxSession,
  SandboxNetworkPolicy,
} from "./core/provider";
