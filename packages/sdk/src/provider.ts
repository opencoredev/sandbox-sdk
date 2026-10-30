/** Primitive boundary for adapters. Paths are absolute POSIX paths; times are epoch ms.
 * Adapters translate native failures to SandboxError. Exec must close stdin, emit
 * chunks in arrival order, and kill the ENTIRE remote process group before settling
 * on timeout/abort. Optional methods must agree with capabilities. No core policy
 * (redaction, edit, git, process records, readiness) belongs in an adapter.
 */
import type { SandboxBase } from "./types.js";

/**
 * Portable optional features. Sandbox-level ones add methods to the handle (`pause`, `snapshot`,
 * `terminal`); provider-level ones gate root functions (`snapshot-delete` for `deleteSnapshot`,
 * `templates` for `buildTemplate`); `network-policy` and `size` gate creation options.
 * Provider-specific features belong in {@link Provider.extensions} instead.
 */
export type Capability =
  | "pause"
  | "snapshot"
  | "snapshot-delete"
  | "templates"
  | "terminal"
  | "network-policy"
  | "size";

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

export interface OutputChunk {
  stream: "stdout" | "stderr";
  text: string;
}

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

export interface ExecResult {
  exitCode: number | null;
  timedOut: boolean;
}

export interface FileInfo {
  path: string;
  type: "file" | "directory" | "symlink";
  size: number;
  modifiedAt: number;
}

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

/** One file change. Paths are absolute. */
export interface FileEvent {
  type: "added" | "modified" | "removed";
  path: string;
}

export interface ProviderFiles {
  /** Use primitive file transfers when guest tar is missing or incompatible with GNU archives. */
  readonly transfer?: "files";
  /** Record mark() and changes() checkpoints by reading every workspace file instead of
   * running guest git. For runtimes without git; each call reads the whole workspace. */
  readonly checkpoints?: "files";
  /** Write handles missing parents itself, avoiding an unconditional mkdir RPC. */
  readonly writeCreatesParents?: boolean;
  /**
   * One exec carrying a small environment variable costs less than a read plus a write, so `files.edit`
   * runs as one guest python3 call that changes the file the way `write` does: `"in-place"` when `write`
   * truncates and rewrites the existing inode, `"replace"` when it renames a new file over it. Leave it
   * unset where extra env is staged through more requests; edit then reads and writes.
   */
  readonly editInGuest?: "in-place" | "replace";
  /**
   * The order `list` returns entries in: `"name"` sorted by name bytes, `"directory"` the filesystem's
   * own order (what `os.listdir` returns). When set, `files.search` walks the tree in one guest python3
   * call in that order, so `maxMatches` stops at the same files. Unset, search lists and reads each file.
   */
  readonly listOrder?: "name" | "directory";
  /**
   * How guest file commands (edit and search above) may take their input in this sandbox: `"stdin"`,
   * the default, also accepts input over 32 KiB on stdin; `"env"` only the environment, so larger input
   * uses the RPC path; `"none"` keeps those commands on the RPC path.
   */
  guestInput?(id: string): Promise<"stdin" | "env" | "none">;
  /** Write applies `options.mode` itself. Without it, the core runs `chmod` after the write. */
  readonly writeSupportsMode?: boolean;
  /** Top-level /workspace entries the provider itself owns. File checkpoints and changes() skip them. */
  readonly internal?: readonly string[];
  readRange?(
    id: string,
    path: string,
    options: { offset: number; length: number },
  ): Promise<Uint8Array>;
  /**
   * Native change events for `files.watch`, instead of the core's polling. Call `onEvent` for each change
   * under `path` (children only unless `recursive`) until `signal` aborts, then resolve. Reject when the
   * watch cannot start or breaks; reject with `unsupported` to make the core poll instead.
   */
  watch?(
    id: string,
    path: string,
    options: { recursive: boolean; signal: AbortSignal; onEvent(event: FileEvent): void },
  ): Promise<void>;
  read(id: string, path: string): Promise<Uint8Array>;
  write(id: string, path: string, data: Uint8Array, options?: WriteOptions): Promise<void>;
  list(id: string, path: string): Promise<FileInfo[]>;
  stat(id: string, path: string): Promise<FileInfo>;
  remove(id: string, path: string, options: { recursive: boolean }): Promise<void>;
  mkdir(id: string, path: string): Promise<void>;
}

export interface Preview {
  url: string;
  headers?: Record<string, string>;
  expiresAt?: number;
}

/** Options for `box.terminal()`. The adapter receives `cwd` as an absolute path and `env` merged with the handle's. */
export interface TerminalOptions {
  cols: number;
  rows: number;
  /** Working directory of the shell. Relative paths resolve against `/workspace`. Default: `/workspace`. */
  cwd?: string;
  /** Extra environment variables for the shell. */
  env?: Record<string, string>;
}

/** An interactive PTY. Output arrives as text through `onData`. */
export interface Terminal {
  write(data: string): void | Promise<void>;
  resize(cols: number, rows: number): void | Promise<void>;
  onData(callback: (data: string) => void): () => void;
  close(): void | Promise<void>;
  /** Resolves when the shell exits. Present only when the provider reports the exit. */
  wait?(): Promise<{ exitCode: number | null }>;
}

/** A portable template definition for {@link Provider.buildTemplate}. Providers may accept more fields. */
export interface TemplateSpec {
  /** Template name. Pass it to the provider factory's template option, or the returned `id` as `from`. */
  name: string;
  /** Base container image, such as `"node:22-bookworm"`. Default: the provider's base image. */
  image?: string;
  /** Environment variables for the build steps only. Give sandboxes their own with `createSandbox({ env })`. */
  env?: Record<string, string>;
  /** Working directory for the build steps that follow. Commands in sandboxes still default to `/workspace`. */
  workdir?: string;
  /** Shell commands run in order, each as one build step. */
  run?: readonly string[];
  /** CPU and memory for sandboxes made from the template, where the provider sets them per template. */
  size?: { cpu: number; memoryMb: number };
}

/** Options for one template build. */
export interface TemplateBuildOptions {
  /** One deadline for the whole build, polling included. Default: the provider's (30 minutes for E2B). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Build log lines as the provider reports them. */
  onLog?(line: string): void;
}

/** A finished template. */
export interface TemplateInfo {
  /** The provider's template ID, usable as `createSandbox(provider, { from: id })`. */
  id: string;
  name: string;
  buildId?: string;
}

/**
 * One provider-specific feature set: async methods only. The core binds it lazily to each handle as
 * `box.ext.<name>`, checks the handle is open before every call, and redacts the errors it throws.
 * Returned values are the provider's own data, as with `box.native`.
 */
export type ExtensionMethods = {
  readonly [method: string]: (...args: never[]) => Promise<ExtensionResult>;
};

/** What an extension method resolves with: any value, so each method keeps its own declared type. */
export type ExtensionResult =
  | object
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  | void;

/** Extension sets by name, such as `{ e2b: { metrics(): Promise<...> } }`. */
export type Extensions = { readonly [name: string]: ExtensionMethods };

/** What a provider declares for each extension: a factory given the sandbox ID and its handle. */
export type ExtensionFactories<Native, X extends Extensions> = {
  readonly [K in keyof X]: (id: string, box: SandboxBase<Native>) => X[K];
};

/** Native hooks are optional optimizations. Persistent records remain core-owned. */
export interface NativeProcess {
  pid: number;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
  stop(options: { graceMs: number }): Promise<void>;
}

export interface Provider<
  Native = unknown,
  C extends Capability = Capability,
  X extends Extensions = {},
> {
  readonly name: string;
  readonly keyMode: "exact" | "best-effort";
  /** Omission uses native hooks or the portable shell process-record shim. "stream" is for
   * runtimes without a POSIX shell: startProcess runs the command itself and streams its
   * output, and the core keeps the process records with file calls. Those logs stop when
   * the client that started the process goes away. */
  readonly processMode?: "shell" | "stream" | "unsupported";
  /** "placeholder": preview URLs are never served. Port readiness holds once the URL is
   * issued, without an HTTP probe. */
  readonly previewMode?: "placeholder";
  /** Exec creates/removes input.activityPath without separate file RPCs. */
  readonly inlineActivity?: boolean;
  /**
   * Every exec from every client shares one Linux PID namespace with `/proc` mounted, and the exec user
   * can read each process's environ (directly, or through passwordless sudo for root-owned ones). The
   * core then runs commands without a marker and idle reaping scans `/proc` for the SDK's env tag.
   */
  readonly procActivity?: boolean;
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
  terminal?(id: string, options: TerminalOptions): Promise<Terminal>;
  /** Delete a snapshot by ID. `false` when it was already gone. Requires `"snapshot-delete"`. */
  deleteSnapshot?(snapshotId: string): Promise<boolean>;
  /** Build a template and wait until it is ready. Requires `"templates"`. Widen `spec` for provider fields. */
  buildTemplate?(spec: TemplateSpec, options: TemplateBuildOptions): Promise<TemplateInfo>;
  /** Provider-specific features, exposed as `box.ext.<name>`. They keep the portable API free of one provider's shape. */
  readonly extensions?: ExtensionFactories<Native, X>;
  startProcess?(id: string, input: Omit<ExecInput, "timeoutMs">): Promise<NativeProcess>;
  /** Secret recovery without a shell, for runtimes that cannot run the core's recovery
   * command. Return the text of /tmp/.sandbox-sdk/secret-names.json and the environment a
   * new command starts with, or undefined when that file does not exist. The core validates
   * the record. Without this hook, the core reads both with one shell command. */
  readSecretEnvironment?(
    id: string,
  ): Promise<{ record: string; environment: Record<string, string> } | undefined>;
}

// For adapter authors: everything a built-in adapter uses, so one can live outside this repo. The E2B
// adapter imports only from this module (tests/provider-boundary.test.ts checks it).
export { SandboxError, describeNative, redacting, reason } from "./errors.js";

export type { ErrorCode, ErrorOptions, NativeDescription } from "./errors.js";

export { connectEnvelope, connectEnvelopes, streamFault } from "./streams.js";

export type { ConnectFrame, StreamFault, StreamOptions } from "./streams.js";

export type { JsonValue, JsonObject } from "./shared/json.js";

// The HTTP client and native API helpers the built-in direct-HTTP adapters use.
export { createHttpClient, createDeadline, sleep } from "./http.js";

export type {
  HttpClient,
  HttpClientOptions,
  HttpPlane,
  HttpRequest,
  StreamRequest,
  HttpResponse,
  HttpFailure,
  FailedRequest,
  ErrorBody,
  PlaneContext,
  Fetch,
  Deadline,
  StaleVerdict,
} from "./http.js";

export { createNativeApi, sdkConstruct, sdkCall } from "./native.js";

export type {
  NativeApi,
  NativeApiOptions,
  NativeSdkBinding,
  NativeRequestOptions,
  NativeSdkLoader,
  AnyNativeSdk,
  HttpMethod,
} from "./native.js";
