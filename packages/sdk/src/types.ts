import type { Capability, CreateInput, FileInfo, Labels, OutputChunk, Provider, SandboxInfo, Terminal, Preview, SnapshotOptions } from "./provider.js";
import type { Files } from "./files.js";
import type { Git } from "./git.js";
import type { ProcessHandle, ProcessInfo, StartOptions } from "./processes.js";
/** Your own key-to-ID store (Redis, a database row) so `createSandbox({ key })` finds the same sandbox from any server. */
export interface Locator {
  /** Return the sandbox ID stored for `key`, or `undefined`/`null` when there is none. */
  get(key: string): Promise<string | undefined | null>;
  /** Store the sandbox ID for `key`. Called after every create or lookup. */
  set(key: string, id: string): Promise<void>;
  /** Forget `key`. Called by `destroy()`. */
  delete?(key: string): Promise<void>;
  /** Run `action` while holding a distributed lock on `key`. Required for cross-host exactness with a best-effort provider. */
  withLock?<T>(key: string, action: () => Promise<T>): Promise<T>;
}
/** Options for `createSandbox`. Every field is optional. */
export interface CreateOptions extends Omit<CreateInput, "labels"> {
  /** Your own tags. `listSandboxes` and `reapSandboxes` filter on them. The `sandbox-sdk` label is reserved. */
  labels?: Record<string, string>;
  /** Environment variables that are redacted from output, errors, and agent tool results. Names must be valid shell identifiers. */
  secrets?: Record<string, string>;
  /** Advanced. External key store used with `key`. Most apps only need `key`. */
  locator?: Locator;
  /** Advanced. `"exact"` refuses to run unless one sandbox per key is guaranteed (a provider with unique names, or `locator.withLock`). Default: best effort. */
  keyMode?: "exact" | "best-effort";
  /** Record a "start" checkpoint at create so `files.changes()` works without `since`. Costs one exec. */
  trackChanges?: boolean;
}
/** Options for `connectSandbox`. */
export interface ConnectOptions extends Pick<CreateOptions, "secrets"> {
  /**
   * Read back the secrets recorded at creation so they stay in the environment and redacted. It costs one
   * command, run before the first `run`, `start`, `process`, `files`, or `terminal` call, never on connect.
   * `destroy`, `close`, `pause`, `resume`, `snapshot`, and `usage` never need it. Pass `false` to skip it,
   * for example when the handle only inspects or cleans up a sandbox. Default: `true`.
   */
  recoverSecrets?: boolean;
}
/** Options for `listSandboxes`. */
export interface ListOptions {
  /** Only return sandboxes that carry every one of these labels. */
  labels?: Labels;
}
/** Options for `reapSandboxes`. */
export interface ReapOptions extends ListOptions {
  /** Only destroy sandboxes at least this old, in milliseconds. Default: 0. */
  olderThanMs?: number;
  /** Skip sandboxes with an active SDK command or a running background process. */
  idleOnly?: boolean;
}
/** Per-command options for `box.run`. */
export interface RunOptions {
  /** Working directory. Relative paths resolve against `/workspace`. Default: `/workspace`. */
  cwd?: string;
  /** Extra environment variables for this command only. */
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds and resolve with `timedOut: true`. Default: 120000. */
  timeoutMs?: number;
  /** Keep at most this many bytes per stream; older output is dropped and `truncated` is set. Default: 1048576 (1 MB). */
  maxOutputBytes?: number;
  /** Text written to the command's stdin, which is then closed. */
  stdin?: string;
  /** Abort the command. It resolves with a result rather than throwing. */
  signal?: AbortSignal;
}
/** The outcome of a finished command. A non-zero exit, a timeout, or an abort is a result, not an error. */
export interface RunResult {
  /** `true` when the command exited with code 0. */
  ok: boolean;
  /** Exit code, or `null` when the command was killed (timeout or abort). */
  exitCode: number | null;
  /** Standard output, with secrets redacted. */
  stdout: string;
  /** Standard error, with secrets redacted. */
  stderr: string;
  /** stdout and stderr interleaved in arrival order. */
  output: string;
  /** Wall-clock time of the command, in milliseconds. */
  durationMs: number;
  /** `true` when output exceeded `maxOutputBytes` and the oldest bytes were dropped. */
  truncated: boolean;
  /** `true` when `timeoutMs` ran out and the command was killed. */
  timedOut: boolean;
  /** Absolute working directory the command ran in. */
  cwd: string;
  /** The command as it was sent to the shell. */
  command: string;
}
/**
 * A lazy command. Nothing runs until you `await` it (for the {@link RunResult})
 * or iterate it with `for await` (for live {@link OutputChunk}s).
 * Chain `cwd`, `env`, or `timeout` before starting it.
 */
export interface RunHandle extends PromiseLike<RunResult>, AsyncIterable<OutputChunk> {
  /** Run in this directory. */
  cwd(path: string): RunHandle;
  /** Add environment variables for this command. */
  env(env: Record<string, string>): RunHandle;
  /** Set the timeout in milliseconds. */
  timeout(timeoutMs: number): RunHandle;
}
/** Options for `box.preview`. */
export interface PreviewOptions {
  /** Path appended to the preview URL. */
  path?: string;
  /** Wait up to this many milliseconds for the URL to answer with a 2xx. Fails with `port_not_ready` when it runs out. */
  waitMs?: number;
}
/** Counters from `box.usage()`. Providers may add their own numeric fields. */
export type Usage = {
  /** When the sandbox was created, in epoch milliseconds. */
  createdAt: number;
  /** Milliseconds since `createdAt`. */
  runningMs: number;
  /** Commands run through this handle. */
  commands: number;
  /** Output bytes received through this handle. */
  bytesOut: number;
} & Record<string, number>;
/** The methods every sandbox has, whatever the provider. `N` is the provider's native client type. */
export interface SandboxBase<N> {
  /** The provider's sandbox ID. Pass it to `connectSandbox` to reattach. */
  readonly id: string;
  /** The key passed to `createSandbox`, when there was one. */
  readonly key?: string;
  /** Provider name, such as `"e2b"`. */
  readonly provider: string;
  /** `true` when this call created the sandbox, `false` when it reattached to an existing one. */
  readonly created: boolean;
  /** Labels on the sandbox. */
  readonly labels: Record<string, string>;
  /** What this provider supports. The optional methods on {@link Sandbox} follow it. */
  readonly capabilities: ReadonlySet<Capability>;
  /** The provider's own SDK object, fully typed, for anything this SDK does not cover. */
  readonly native: N;
  /** Run a shell command. Await the handle for the result, or iterate it to stream output. */
  run(command: string, options?: RunOptions): RunHandle;
  /** Run a command from a template literal. Every interpolated value is shell-quoted. */
  $(strings: TemplateStringsArray, ...values: unknown[]): RunHandle;
  /** Read, write, edit, search, and sync files. Relative paths resolve against `/workspace`. */
  readonly files: Files;
  /** Git helpers that run inside the sandbox. Tokens never reach argv, env, or shell history. */
  readonly git: Git;
  /** Start a named background process and optionally wait until it is ready. The name lets any client find it again with {@link process}; without one, the name is derived from the command and returned on the handle. */
  start(command: string, options?: StartOptions): Promise<ProcessHandle>;
  /** Get a handle to a background process by name, including one started by another client. */
  process(name: string): ProcessHandle;
  /** List the background processes started through the SDK. */
  processes(): Promise<ProcessInfo[]>;
  /** Get a URL for a port in the sandbox. Send the returned `headers` with every request. */
  preview(port: number, options?: PreviewOptions): Promise<Preview>;
  /** Counters for this handle, plus provider metrics when available. */
  usage(): Promise<Usage>;
  /** Detach this handle and leave the sandbox running. Reattach later with the key or ID. */
  close(): Promise<void>;
  /** Delete the sandbox. */
  destroy(): Promise<void>;
  /** For `await using`: calls `close()` when the sandbox has a key, otherwise `destroy()`. */
  [Symbol.asyncDispose](): Promise<void>;
}
/** The methods each optional capability adds to a sandbox. */
export interface CapabilityMethods {
  pause: {
    /** Pause the sandbox. Billing and the hard lifetime depend on the provider. */
    pause(): Promise<void>;
    /** Resume a paused sandbox. */
    resume(): Promise<void>;
  };
  snapshot: {
    /** Save the sandbox state. Pass the returned `id` as `createSandbox(provider, { from: id })`. */
    snapshot(options?: SnapshotOptions): Promise<{ id: string }>;
  };
  terminal: {
    /** Open an interactive PTY. */
    terminal(options: { cols: number; rows: number }): Promise<Terminal>;
  };
}
type MethodCapability = keyof CapabilityMethods;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
/** The methods added by the capabilities in `C`. */
export type MethodsFor<C extends Capability> = [Extract<C, MethodCapability>] extends [never] ? {} : UnionToIntersection<CapabilityMethods[Extract<C, MethodCapability>]>;
/**
 * A sandbox handle. `N` is the native client type; `C` is the provider's capability union.
 * With a concrete provider, `pause`/`resume`, `snapshot`, and `terminal` exist only when
 * `C` includes them, so calling one on a provider that lacks it is a type error. With a
 * provider typed as plain `Provider` (any capability), the methods are optional: check
 * them with {@link hasCapability} first. `createSandbox(e2b())` infers the precise type.
 */
export type Sandbox<N = unknown, C extends Capability = never> = SandboxBase<N>
  & (Capability extends C ? Partial<MethodsFor<MethodCapability>> : MethodsFor<C>);
/** The sandbox type a provider produces: `ProviderSandbox<ReturnType<typeof e2b>>`. */
export type ProviderSandbox<P extends Provider> = P extends Provider<infer N, infer C> ? Sandbox<N, C> : never;
export type { OutputChunk, Capability, SandboxInfo, FileInfo, Labels, Preview, Terminal };
