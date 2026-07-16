import type {
  CapabilityMap,
  CommandInput,
  CommandResult,
  ExposedPort,
  FileValue,
  ProviderName,
  RunOptions,
  SandboxDirectoryEntry,
  SandboxProcess,
  SandboxSnapshot,
  Sandbox,
} from "./types";

export interface ProviderCreateOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface SandboxRuntime<TRaw> {
  readonly id: string;
  readonly raw: TRaw;
  readonly capabilities: CapabilityMap;
  files: {
    write(path: string, value: FileValue): Promise<void>;
    read(path: string): Promise<Uint8Array>;
    list(path: string): Promise<SandboxDirectoryEntry[]>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
  };
  run(command: CommandInput, options: RunOptions): Promise<CommandResult>;
  start(command: CommandInput, options: RunOptions): Promise<SandboxProcess>;
  expose(port: number): Promise<ExposedPort>;
  snapshots: {
    create(options?: { name?: string }): Promise<SandboxSnapshot>;
    delete(snapshot: SandboxSnapshot | string): Promise<void>;
    restore(snapshot: SandboxSnapshot | string): Promise<void>;
  };
  stop(): Promise<void>;
}

export interface SandboxProvider<TRaw> {
  readonly id: ProviderName;
  readonly capabilities: CapabilityMap;
  create(options: ProviderCreateOptions): Promise<SandboxRuntime<TRaw>>;
  readonly managed?: ManagedSandboxProvider;
}

export type SandboxNetworkPolicy =
  | { mode: "allow-all" }
  | { mode: "deny-all" }
  | { mode: "native"; value: unknown }
  | {
      mode: "custom";
      allowedHosts?: readonly string[];
      allowedCIDRs?: readonly string[];
      deniedCIDRs?: readonly string[];
    };

export interface ManagedSandboxCreateOptions {
  readonly sessionId: string;
  readonly identity?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly ports?: ReadonlyArray<number>;
  readonly signal?: AbortSignal;
  readonly onFirstCreate?: (sandbox: Sandbox) => void | Promise<void>;
}

export interface ManagedSandboxResumeOptions {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
}

/** Optional lifecycle surface implemented by providers for durable agent sessions. */
export interface ManagedSandboxSession {
  readonly id: string;
  readonly sandbox: Sandbox;
  readonly defaultWorkingDirectory: string;
  readonly ports: ReadonlyArray<number>;
  getPortUrl(options: { port: number; protocol?: "http" | "https" | "ws" }): Promise<string>;
  stop(): Promise<void>;
  /** Reattach or restart a session after managed stop. */
  resume(): Promise<void>;
  destroy(): Promise<void>;
  setPorts?(ports: ReadonlyArray<number>, options?: { signal?: AbortSignal }): Promise<void>;
  setNetworkPolicy?(policy: SandboxNetworkPolicy): Promise<void>;
}

export interface ManagedSandboxProvider {
  create(options: ManagedSandboxCreateOptions): Promise<ManagedSandboxSession>;
  resume(options: ManagedSandboxResumeOptions): Promise<ManagedSandboxSession>;
}
