/** Primitive boundary for adapters. Paths are absolute POSIX paths; times are epoch ms.
 * Adapters translate native failures to SandboxError. Exec must close stdin, emit
 * chunks in arrival order, and kill the ENTIRE remote process group before settling
 * on timeout/abort. Optional methods must agree with capabilities. No core policy
 * (redaction, edit, git, process records, readiness) belongs in an adapter.
 */
export type Capability = "pause" | "snapshot" | "terminal" | "network-policy" | "size";
export type Labels = Record<string, string>;
export interface SandboxInfo {
  id: string;
  key?: string;
  labels: Labels;
  state: "running" | "paused" | "stopped";
  createdAt: number;
}
export interface CreateInput {
  key?: string;
  size?: "small" | "medium" | "large" | { cpu: number; memoryMb: number; diskGb?: number };
  env?: Record<string, string>;
  network?: "all" | "none" | { allow: string[] };
  ports?: number[];
  idleTimeoutMs?: number;
  timeoutMs?: number;
  labels: Labels;
  from?: string;
  signal?: AbortSignal;
}
export interface OutputChunk { stream: "stdout" | "stderr"; text: string }
export interface ExecInput {
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Stable handle environment; adapters may reuse private guest env files. */
  envMode?: "sandbox";
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Core-owned activity record, maintained atomically by opted-in exec transports. */
  activityPath?: string;
  /** false permits buffered execution; true requests live chunks. Omission preserves adapter defaults. */
  streaming?: boolean;
  onChunk(chunk: OutputChunk): void;
}
export interface ExecResult { exitCode: number | null; timedOut: boolean }
export interface FileInfo { path: string; type: "file" | "directory" | "symlink"; size: number; modifiedAt: number }
/** Options for one file write. */
export interface WriteOptions {
  /** POSIX permission bits for the file, such as `0o600`. */
  mode?: number;
}
/** Options for {@link Provider.snapshot}. */
export interface SnapshotOptions {
  /** Delete the snapshot after this many milliseconds. `0` keeps it until you delete it, where the provider allows that. */
  expiresInMs?: number;
}
export interface ProviderFiles {
  /** Use primitive file transfers when guest tar is incompatible with GNU archives. */
  readonly transfer?: "files";
  /** Write handles missing parents itself, avoiding an unconditional mkdir RPC. */
  readonly writeCreatesParents?: boolean;
  /** Write applies `options.mode` itself. Without it, the core runs `chmod` after the write. */
  readonly writeSupportsMode?: boolean;
  /** Top-level /workspace entries the provider itself owns. File checkpoints and changes() skip them. */
  readonly internal?: readonly string[];
  readRange?(id: string, path: string, options: { offset: number; length: number }): Promise<Uint8Array>;
  read(id: string, path: string): Promise<Uint8Array>;
  write(id: string, path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  list(id: string, path: string): Promise<FileInfo[]>;
  stat(id: string, path: string): Promise<FileInfo>;
  remove(id: string, path: string, options: { recursive: boolean }): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
}
export interface Preview { url: string; headers?: Record<string, string>; expiresAt?: number }
export interface Terminal {
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  onData(callback: (data: string) => void): () => void;
  close(): void | Promise<void>;
}
/** Native hooks are optional optimizations. Persistent records remain core-owned. */
export interface NativeProcess {
  pid: number;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
  stop(options: { graceMs: number }): Promise<void>;
}
export interface Provider<Native = unknown, C extends Capability = Capability> {
  readonly name: string;
  readonly keyMode: "exact" | "best-effort";
  /** Omission uses native hooks or the portable shell process-record shim. */
  readonly processMode?: "shell" | "unsupported";
  /** Exec creates/removes input.activityPath without separate file RPCs. */
  readonly inlineActivity?: boolean;
  /** Native command dialect for portable run wrappers; defaults to POSIX sh. */
  readonly commandShell?: "bash";
  /** Durable absolute directory for core-owned process records. */
  readonly processRecordRoot?: string;
  readonly capabilities: ReadonlySet<C>;
  create(input: CreateInput): Promise<SandboxInfo>;
  find(key: string): Promise<SandboxInfo | undefined>;
  connect(id: string): Promise<SandboxInfo>;
  list(labels: Labels): Promise<SandboxInfo[]>;
  destroy(id: string): Promise<void>;
  exec(id: string, input: ExecInput): Promise<ExecResult>;
  readonly files: ProviderFiles;
  previewUrl(id: string, port: number): Promise<Preview>;
  native(id: string): Native;
  close?(id: string): Promise<void>;
  usage?(id: string): Promise<Record<string, number>>;
  pause?(id: string): Promise<void>;
  resume?(id: string): Promise<void>;
  snapshot?(id: string, options?: SnapshotOptions): Promise<{ id: string }>;
  terminal?(id: string, options: { cols: number; rows: number }): Promise<Terminal>;
  startProcess?(id: string, input: Omit<ExecInput, "timeoutMs">): Promise<NativeProcess>;
}
// For adapter authors: the HTTP client and native API helpers the built-in direct-HTTP adapters use.
export { createHttpClient, createDeadline } from "./http.js";
export type { HttpClient, HttpClientOptions, HttpPlane, HttpRequest, StreamRequest, HttpResponse, HttpFailure, FailedRequest, ErrorBody, PlaneContext, Fetch, Deadline } from "./http.js";
export { createNativeApi, sdkConstruct, sdkCall } from "./native.js";
export type { NativeApi, NativeApiOptions, NativeSdkBinding, NativeRequestOptions, NativeSdkLoader, AnyNativeSdk, HttpMethod } from "./native.js";
