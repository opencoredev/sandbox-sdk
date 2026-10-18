import type { Capability, CreateInput, OutputChunk, Provider, SandboxInfo, Terminal, Preview } from "./provider.js";
import type { Files } from "./files.js";
import type { Git } from "./git.js";
import type { ProcessHandle, ProcessInfo, StartOptions } from "./processes.js";
export interface Locator {
  get(key: string): Promise<string | undefined | null>;
  set(key: string, id: string): Promise<void>;
  delete?(key: string): Promise<void>;
  /** Required for cross-host exactness with a best-effort provider. */
  withLock?<T>(key: string, action: () => Promise<T>): Promise<T>;
}
export interface CreateOptions extends Omit<CreateInput, "labels"> {
  labels?: Record<string, string>;
  secrets?: Record<string, string>;
  locator?: Locator;
  keyMode?: "exact" | "best-effort";
}
export interface RunOptions {
  cwd?: string; env?: Record<string, string>; timeoutMs?: number; maxOutputBytes?: number;
  stdin?: string; signal?: AbortSignal;
}
export interface RunResult {
  ok: boolean; exitCode: number | null; stdout: string; stderr: string; output: string;
  durationMs: number; truncated: boolean; timedOut: boolean; cwd: string; command: string;
}
export interface RunHandle extends PromiseLike<RunResult>, AsyncIterable<OutputChunk> {
  cwd(path: string): RunHandle;
  env(env: Record<string, string>): RunHandle;
  timeout(timeoutMs: number): RunHandle;
}
export interface SandboxBase<N> {
  readonly id: string; readonly key?: string; readonly provider: string; readonly created: boolean;
  readonly labels: Record<string, string>; readonly capabilities: ReadonlySet<Capability>; readonly native: N;
  run(command: string, options?: RunOptions): RunHandle;
  $(strings: TemplateStringsArray, ...values: unknown[]): RunHandle;
  readonly files: Files;
  readonly git: Git;
  start(command: string, options: StartOptions): Promise<ProcessHandle>;
  process(name: string): ProcessHandle;
  processes(): Promise<ProcessInfo[]>;
  preview(port: number, options?: { path?: string; waitMs?: number }): Promise<Preview>;
  usage(): Promise<{ createdAt: number; runningMs: number; commands: number; bytesOut: number } & Record<string, number>>;
  close(): Promise<void>;
  destroy(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
export type Sandbox<N = unknown, C extends Capability = never> = SandboxBase<N>
  & ("pause" extends C ? { pause(): Promise<void>; resume(): Promise<void> } : {})
  & ("snapshot" extends C ? { snapshot(): Promise<{ id: string }> } : {})
  & ("terminal" extends C ? { terminal(options: { cols: number; rows: number }): Promise<Terminal> } : {});
export type ProviderSandbox<P extends Provider> = P extends Provider<infer N, infer C> ? Sandbox<N, C> : never;
export type { OutputChunk, Capability, SandboxInfo };
