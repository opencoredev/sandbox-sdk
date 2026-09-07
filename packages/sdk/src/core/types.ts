export const builtInProviderNames = [
  "local",
  "e2b",
  "daytona",
  "vercel",
  "upstash",
  "box",
  "railway",
  "cloudflare",
  "memory",
] as const;
export type BuiltInProviderName = (typeof builtInProviderNames)[number];
/** Open adapter id. Built-in names are documented in `builtInProviderNames`. */
export type ProviderName = string;
/** @deprecated Use `builtInProviderNames`. */
export const providerNames = builtInProviderNames;

export const capabilityNames = [
  "files.read",
  "files.write",
  "files.list",
  "files.remove",
  "process.run",
  "process.stream",
  "process.background",
  "process.stdin",
  "process.cancel",
  "ports.expose",
  "ports.authenticatedRequest",
  "snapshot.create",
  "snapshot.delete",
  "snapshot.restore",
  "sandbox.resume",
  "sandbox.connect",
  "sandbox.list",
  "sandbox.timeout",
  "filesystem.persistent",
  "image.custom",
  "network.policy",
  "process.pty",
  "compute.gpu",
] as const;

export type Capability = (typeof capabilityNames)[number];
export type CapabilityMode =
  | "filesystem"
  | "memory"
  | "template"
  | "fork"
  | "public"
  | "authenticated"
  | "combined-stream"
  | "separate-streams"
  | "ephemeral"
  | "persistent"
  | "localhost"
  | "in-process"
  | "full"
  | "native";

export type CapabilityMap = Readonly<Record<Capability, false | CapabilityMode>>;

export type CommandInput = string | { command: string; args?: readonly string[] };

export interface RunOptions {
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  timeout?: number;
  signal?: AbortSignal;
}

export interface RunCommandOptions extends RunOptions {
  /**
   * Receives stdout chunks as the command produces them. When the provider cannot stream,
   * the callback receives the full output once after the command exits.
   */
  onStdout?: (data: string) => void;
  /** Receives stderr chunks. Same fallback behavior as `onStdout`. */
  onStderr?: (data: string) => void;
}

export const runCodeLanguages = ["python", "javascript", "typescript", "bash"] as const;
export type RunCodeLanguage = (typeof runCodeLanguages)[number];

export interface RunCodeOptions extends RunCommandOptions {
  /** Defaults to `"python"`. */
  language?: RunCodeLanguage;
}

/** Values that can be interpolated into the `sandbox.$` tagged template. Arrays expand to multiple quoted arguments. */
export type ShellValue = string | number | boolean | ReadonlyArray<string | number | boolean>;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  signal?: string;
  durationMs?: number;
}

export type FileValue = string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>;

export interface SandboxDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size?: number;
}

export interface SandboxFileStat {
  path: string;
  type: "file" | "directory" | "symlink" | "unknown";
  size: number;
  modifiedAt?: Date;
}

export type FileWatchEventType = "create" | "modify" | "remove" | "rename" | "chmod";

export interface FileWatchEvent {
  type: FileWatchEventType;
  path: string;
}

export interface WatchOptions {
  /** Watch subdirectories too. Defaults to true. */
  recursive?: boolean;
  /** Poll interval in milliseconds for providers without native watching. Defaults to 1000. */
  pollInterval?: number;
  signal?: AbortSignal;
}

export interface SandboxFileWatcher {
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface SandboxFiles {
  write(path: string, value: FileValue): Promise<void>;
  /** Writes several files in parallel. */
  writeMany(files: ReadonlyArray<{ path: string; value: FileValue }>): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  text(path: string): Promise<string>;
  list(path?: string): Promise<SandboxDirectoryEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<SandboxFileStat>;
  /** Moves or renames a file or directory inside the sandbox. */
  move(source: string, destination: string): Promise<void>;
  /** Copies a file or directory inside the sandbox. */
  copy(source: string, destination: string): Promise<void>;
  /** Uploads a file from the machine running the SDK into the sandbox. Requires a Node-compatible runtime. */
  upload(localPath: string, path: string): Promise<void>;
  /** Downloads a sandbox file to the machine running the SDK. Requires a Node-compatible runtime. */
  download(path: string, localPath: string): Promise<void>;
  /**
   * Watches a directory for changes. Uses the provider's native watcher when available
   * and falls back to polling otherwise. Stop with `await using` or `watcher.stop()`.
   */
  watch(
    path: string,
    onEvent: (event: FileWatchEvent) => void,
    options?: WatchOptions,
  ): Promise<SandboxFileWatcher>;
}

export interface ProcessOutputEvent {
  stream: "stdout" | "stderr";
  data: string | Uint8Array;
  timestamp?: Date;
}

export type ProcessStatus = "starting" | "running" | "exited" | "killed" | "unknown";

export interface SandboxProcess {
  readonly id: string;
  status(): Promise<ProcessStatus>;
  output(): AsyncIterable<ProcessOutputEvent>;
  write(value: string | Uint8Array): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
  kill(signal?: string): Promise<void>;
}

export interface SandboxProcesses {
  start(command: CommandInput, options?: RunOptions): Promise<SandboxProcess>;
}

export interface ExposedPort {
  readonly port: number;
  readonly url: string;
  readonly public: boolean;
  readonly authenticated: boolean;
  request?(path?: string, init?: RequestInit): Promise<Response>;
  toJSON(): Omit<ExposedPort, "request" | "toJSON">;
}

export interface SandboxPorts {
  expose(port: number): Promise<ExposedPort>;
}

export interface SandboxSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly mode: CapabilityMode;
  readonly createdAt?: Date;
}

export interface SandboxSnapshots {
  create(options?: { name?: string }): Promise<SandboxSnapshot>;
  delete(snapshot: SandboxSnapshot | string): Promise<void>;
  restore(snapshot: SandboxSnapshot | string): Promise<void>;
}

export type SandboxState = "running" | "paused" | "stopped" | "pending" | "unknown";

/** Summary entry returned by `listSandboxes()`. */
export interface SandboxSummary {
  id: string;
  provider: ProviderName;
  name?: string;
  state: SandboxState;
  createdAt?: Date;
}

export interface GitCloneOptions {
  /** Target directory. Defaults to the repository name resolved against the sandbox cwd. */
  path?: string;
  branch?: string;
  depth?: number;
  /** Injected into the clone URL and redacted from any error output. */
  auth?: { username?: string; token: string };
  timeout?: number;
  signal?: AbortSignal;
}

export interface GitCommandOptions {
  /** Repository directory. Defaults to the sandbox cwd. */
  path?: string;
  timeout?: number;
  signal?: AbortSignal;
}

export interface GitStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty: boolean;
  entries: readonly { status: string; path: string }[];
}

export interface SandboxGit {
  clone(url: string, options?: GitCloneOptions): Promise<{ path: string }>;
  pull(options?: GitCommandOptions): Promise<void>;
  checkout(ref: string, options?: GitCommandOptions): Promise<void>;
  status(options?: GitCommandOptions): Promise<GitStatus>;
}

export interface SandboxInfo {
  id: string;
  provider: ProviderName;
  cwd: string;
  state?: SandboxState;
  createdAt?: Date;
  template?: string;
}

export interface SandboxMetrics {
  cpuMs?: number;
  memoryBytes?: number;
  timestamp?: Date;
}

export interface PtyCreateOptions {
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  command?: CommandInput;
}

export interface SandboxPty {
  readonly pid?: number;
  write(data: string | Uint8Array): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  output(): AsyncIterable<Uint8Array>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface GitSource {
  url: string;
  branch?: string;
  depth?: number;
  auth?: { username?: string; token: string };
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

export interface Sandbox<TRaw = unknown> {
  readonly id: string;
  readonly provider: ProviderName;
  readonly cwd: string;
  readonly capabilities: CapabilityMap;
  readonly raw: TRaw;
  readonly files: SandboxFiles;
  readonly processes: SandboxProcesses;
  readonly ports: SandboxPorts;
  readonly snapshots: SandboxSnapshots;
  readonly git: SandboxGit;
  run(command: CommandInput, options?: RunCommandOptions): Promise<CommandResult>;
  /**
   * Tagged template that runs a shell command with safely quoted interpolations.
   * Throws `CommandFailedError` when the command exits nonzero.
   *
   * ```ts
   * const { stdout } = await sandbox.$`ls -la ${directory}`;
   * ```
   */
  $(strings: TemplateStringsArray, ...values: ReadonlyArray<ShellValue>): Promise<CommandResult>;
  /** Writes `code` to a temporary file and runs it with the language's interpreter. */
  runCode(code: string, options?: RunCodeOptions): Promise<CommandResult>;
  /**
   * Extends how long the sandbox stays alive. Requires the `sandbox.timeout` capability
   * (throws `SandboxError` with code `unsupported` otherwise).
   */
  extendTimeout(ms: number): Promise<void>;
  /** Identity and provider-native metadata. Always available. */
  info(): Promise<SandboxInfo>;
  /** Provider resource metrics. Throws `unsupported` when the adapter has none. */
  metrics(): Promise<SandboxMetrics[]>;
  readonly pty: {
    create(options?: PtyCreateOptions): Promise<SandboxPty>;
  };
  setNetworkPolicy(policy: SandboxNetworkPolicy): Promise<void>;
  /** Stops the provider runtime. Repeated calls share the same cleanup operation. */
  stop(): Promise<void>;
  /** Permanently deletes the sandbox. Repeated calls share the same delete operation. */
  destroy(): Promise<void>;
  /** Stops the sandbox when an `await using` scope exits. Does not destroy it. */
  [Symbol.asyncDispose](): Promise<void>;
}
