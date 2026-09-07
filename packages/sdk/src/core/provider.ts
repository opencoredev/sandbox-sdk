import type {
  CapabilityMap,
  CommandInput,
  CommandResult,
  ExposedPort,
  FileValue,
  FileWatchEvent,
  ProviderName,
  PtyCreateOptions,
  RunOptions,
  SandboxDirectoryEntry,
  SandboxFileStat,
  SandboxInfo,
  SandboxMetrics,
  SandboxNetworkPolicy,
  SandboxProcess,
  SandboxPty,
  SandboxSnapshot,
  SandboxSummary,
  Sandbox,
} from "./types";

export interface ProviderCreateOptions {
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface ProviderConnectOptions {
  id: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface ProviderListOptions {
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
    /** Optional native implementation. The core falls back to shell commands inside the sandbox. */
    stat?(path: string): Promise<SandboxFileStat>;
    /** Optional native implementation. The core falls back to `mv` inside the sandbox. */
    move?(source: string, destination: string): Promise<void>;
    /** Optional native implementation. The core falls back to `cp -r` inside the sandbox. */
    copy?(source: string, destination: string): Promise<void>;
    /** Optional native watcher. The core falls back to polling with shell commands. */
    watch?(
      path: string,
      onEvent: (event: FileWatchEvent) => void,
      options: { recursive: boolean; signal?: AbortSignal },
    ): Promise<{ stop(): Promise<void> }>;
  };
  run(command: CommandInput, options: RunOptions): Promise<CommandResult>;
  start(command: CommandInput, options: RunOptions): Promise<SandboxProcess>;
  expose(port: number): Promise<ExposedPort>;
  snapshots: {
    create(options?: { name?: string }): Promise<SandboxSnapshot>;
    delete(snapshot: SandboxSnapshot | string): Promise<void>;
    restore(snapshot: SandboxSnapshot | string): Promise<void>;
  };
  /** Optional. Extends the sandbox lifetime where the provider supports it. */
  extendTimeout?(ms: number): Promise<void>;
  info?(): Promise<Partial<SandboxInfo>>;
  metrics?(): Promise<SandboxMetrics[]>;
  pty?: {
    create(options?: PtyCreateOptions): Promise<SandboxPty>;
  };
  setNetworkPolicy?(policy: SandboxNetworkPolicy): Promise<void>;
  /** Permanent delete. Distinct from `stop()`. */
  destroy?(): Promise<void>;
  stop(): Promise<void>;
}

export interface SandboxProvider<TRaw> {
  readonly id: ProviderName;
  readonly capabilities: CapabilityMap;
  create(options: ProviderCreateOptions): Promise<SandboxRuntime<TRaw>>;
  /** Preferred runtime constructor. `createSandbox()` uses this when present. */
  createRuntime?(options: ProviderCreateOptions): Promise<SandboxRuntime<TRaw>>;
  /** Optional. Reattaches to an existing sandbox by id. Used by `connectSandbox()`. */
  connect?(options: ProviderConnectOptions): Promise<SandboxRuntime<TRaw>>;
  /** Optional. Lists sandboxes for the account. Used by `listSandboxes()`. */
  list?(options?: ProviderListOptions): Promise<SandboxSummary[]>;
  readonly managed?: ManagedSandboxProvider;
}

export type { SandboxNetworkPolicy };

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
  resume(options?: { signal?: AbortSignal }): Promise<void>;
  destroy(): Promise<void>;
  setPorts?(ports: ReadonlyArray<number>, options?: { signal?: AbortSignal }): Promise<void>;
  setNetworkPolicy?(policy: SandboxNetworkPolicy): Promise<void>;
}

export interface ManagedSandboxProvider {
  create(options: ManagedSandboxCreateOptions): Promise<ManagedSandboxSession>;
  resume(options: ManagedSandboxResumeOptions): Promise<ManagedSandboxSession>;
}
