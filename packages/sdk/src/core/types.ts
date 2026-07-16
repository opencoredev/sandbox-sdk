export const providerNames = ["local", "e2b", "daytona", "vercel", "upstash", "railway"] as const;
export type ProviderName = (typeof providerNames)[number];

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

export interface SandboxFiles {
  write(path: string, value: FileValue): Promise<void>;
  read(path: string): Promise<Uint8Array>;
  text(path: string): Promise<string>;
  list(path?: string): Promise<SandboxDirectoryEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
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
  run(command: CommandInput, options?: RunOptions): Promise<CommandResult>;
  /** Stops the provider runtime. Repeated calls share the same cleanup operation. */
  stop(): Promise<void>;
  /** Stops the sandbox when an `await using` scope exits. */
  [Symbol.asyncDispose](): Promise<void>;
}
