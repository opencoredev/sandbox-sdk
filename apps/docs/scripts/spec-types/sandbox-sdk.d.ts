/**
 * The 1.0 API as written in docs/spec.md, for `bun run snippets --spec`.
 * It lets the docs snippets be type-checked before packages/sdk is built.
 * The real check runs against packages/sdk/dist; when the two disagree, the
 * SDK wins and this file should be updated or deleted.
 */

declare module "@opencoredev/sandbox-sdk" {
  export type Capability = "pause" | "snapshot" | "terminal" | "network-policy" | "size";
  export type Labels = Record<string, string>;
  export type Size = "small" | "medium" | "large" | { cpu: number; memoryMb: number; diskGb: number };
  export type Network = "all" | "none" | { allow: string[] };

  export interface SandboxInfo {
    id: string;
    key?: string;
    labels: Labels;
    state: "running" | "paused" | "stopped";
    createdAt: number;
  }

  export interface Provider<Native = unknown, C extends Capability = Capability> {
    readonly name: string;
    readonly keyMode: "exact" | "best-effort";
    readonly capabilities: ReadonlySet<C>;
    /** Phantom marker so the native type flows into Sandbox<N, C>. */
    readonly __native?: Native;
  }

  export interface Locator {
    get(key: string): Promise<string | null | undefined>;
    set(key: string, id: string): Promise<void>;
    delete?(key: string): Promise<void>;
  }

  export interface CreateOptions {
    key?: string;
    locator?: Locator;
    size?: Size;
    env?: Record<string, string>;
    secrets?: Record<string, string>;
    network?: Network;
    ports?: number[];
    idleTimeoutMs?: number;
    timeoutMs?: number;
    labels?: Labels;
    from?: string;
    signal?: AbortSignal;
  }

  export interface OutputChunk {
    stream: "stdout" | "stderr";
    text: string;
  }

  export interface RunOptions {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    maxOutputBytes?: number;
    stdin?: string;
    signal?: AbortSignal;
  }

  export interface RunResult {
    ok: boolean;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    output: string;
    durationMs: number;
    truncated: boolean;
    timedOut: boolean;
    cwd: string;
    command: string;
  }

  export interface RunHandle extends PromiseLike<RunResult>, AsyncIterable<OutputChunk> {
    cwd(path: string): RunHandle;
    env(env: Record<string, string>): RunHandle;
    timeout(timeoutMs: number): RunHandle;
  }

  export type Readiness = { port: number } | { http: { port: number; path?: string } } | { log: RegExp };

  export interface StartOptions {
    name: string;
    cwd?: string;
    env?: Record<string, string>;
    ready?: Readiness;
    readyTimeoutMs?: number;
  }

  export interface ProcessInfo {
    name: string;
    command: string;
    status: "starting" | "running" | "exited" | "failed";
    pid: number;
    ports: number[];
    startedAt: number;
    exitCode: number | null;
  }

  export interface ProcessHandle {
    readonly name: string;
    readonly url?: string;
    readonly ready: boolean;
    readonly status: ProcessInfo["status"];
    lines(options?: { after?: string }): AsyncIterable<{ text: string; stream: "stdout" | "stderr"; cursor: string }>;
    logs(options?: { after?: string; maxBytes?: number }): Promise<{ text: string; nextCursor: string; truncated: boolean }>;
    stop(options?: { graceMs?: number }): Promise<void>;
    restart(): Promise<void>;
    wait(): Promise<{ exitCode: number | null; signal: string | null }>;
  }

  export interface Preview {
    url: string;
    headers?: Record<string, string>;
    expiresAt?: number;
  }

  export interface FileInfo {
    path: string;
    type: "file" | "directory" | "symlink";
    size: number;
    modifiedAt: number;
  }

  export interface FileEvent {
    type: "added" | "modified" | "removed";
    path: string;
  }

  export interface FileDiff {
    added: string[];
    modified: string[];
    removed: string[];
    patch: string;
  }

  export interface Files {
    read(path: string): Promise<string>;
    read(path: string, options: { as: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
    write(files: Record<string, string | Uint8Array>): Promise<void>;
    edit(path: string, edit: { find: string; replace: string }): Promise<void>;
    list(path?: string, options?: { recursive?: boolean; glob?: string }): Promise<FileInfo[]>;
    stat(path: string): Promise<FileInfo>;
    exists(path: string): Promise<boolean>;
    remove(path: string, options?: { recursive?: boolean }): Promise<void>;
    upload(source: string, target: string, options?: { ignore?: string[] }): Promise<void>;
    download(source: string, target: string): Promise<void>;
    search(query: string, options?: { path?: string; glob?: string; maxMatches?: number }): Promise<{ path: string; line: number; text: string }[]>;
    watch(path: string, callback: (event: FileEvent) => void, options?: { recursive?: boolean }): () => void;
    mark(name?: string): Promise<string>;
    changes(options?: { since?: string }): Promise<FileDiff>;
  }

  export interface Git {
    clone(url: string, options?: { dir?: string; branch?: string; depth?: number; token?: string }): Promise<RunResult>;
    status(dir?: string): Promise<RunResult>;
    diff(dir?: string): Promise<RunResult>;
    commit(dir: string, options: { message: string; all?: boolean; author?: string }): Promise<RunResult>;
    push(dir: string, options?: { token?: string; remote?: string; branch?: string }): Promise<RunResult>;
    checkout(dir: string, options: { branch: string; create?: boolean }): Promise<RunResult>;
  }

  export interface Terminal {
    write(data: string): void | Promise<void>;
    resize(cols: number, rows: number): void | Promise<void>;
    onData(callback: (data: string) => void): () => void;
    close(): void | Promise<void>;
  }

  export interface SandboxBase<N> {
    readonly id: string;
    readonly key?: string;
    readonly provider: string;
    readonly created: boolean;
    readonly labels: Labels;
    readonly capabilities: ReadonlySet<Capability>;
    readonly native: N;
    readonly files: Files;
    readonly git: Git;
    run(command: string, options?: RunOptions): RunHandle;
    $(strings: TemplateStringsArray, ...values: unknown[]): RunHandle;
    start(command: string, options: StartOptions): Promise<ProcessHandle>;
    process(name: string): ProcessHandle;
    processes(): Promise<ProcessInfo[]>;
    preview(port: number, options?: { path?: string; waitMs?: number }): Promise<Preview>;
    usage(): Promise<{ createdAt: number; runningMs: number; commands: number; bytesOut: number } & Record<string, number>>;
    close(): Promise<void>;
    destroy(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
  }

  export type Sandbox<N = unknown, C extends Capability = never> = SandboxBase<N> &
    ("pause" extends C ? { pause(): Promise<void>; resume(): Promise<void> } : {}) &
    ("snapshot" extends C ? { snapshot(): Promise<{ id: string }> } : {}) &
    ("terminal" extends C ? { terminal(options: { cols: number; rows: number }): Promise<Terminal> } : {});

  export function createSandbox<N, C extends Capability>(provider: Provider<N, C>, options?: CreateOptions): Promise<Sandbox<N, C>>;
  export function connectSandbox<N, C extends Capability>(provider: Provider<N, C>, id: string): Promise<Sandbox<N, C>>;
  export function listSandboxes(provider: Provider<any, any>, options?: { labels?: Labels }): Promise<SandboxInfo[]>;
  export function reapSandboxes(provider: Provider<any, any>, options?: { olderThanMs?: number; labels?: Labels; idleOnly?: boolean }): Promise<number>;

  export type ErrorCode =
    | "auth" | "not_found" | "quota" | "unavailable" | "unsupported" | "timeout" | "aborted"
    | "outcome_unknown" | "process_exited" | "port_not_ready" | "edit_not_found"
    | "edit_not_unique" | "file_not_found" | "invalid_argument" | "provider";

  export class SandboxError extends Error {
    code: ErrorCode;
    retryable: boolean;
    hint: string;
    provider: string;
    sandboxId?: string;
    cause?: unknown;
  }
}

declare module "@opencoredev/sandbox-sdk/local" {
  import type { Provider } from "@opencoredev/sandbox-sdk";
  export interface LocalNative { readonly containerId: string }
  export function local(options?: { image?: string }): Provider<LocalNative, "network-policy" | "size">;
}

declare module "@opencoredev/sandbox-sdk/e2b" {
  import type { Provider } from "@opencoredev/sandbox-sdk";
  export function e2b(options?: { template?: string }): Provider<unknown, "pause" | "snapshot" | "terminal">;
}

declare module "@opencoredev/sandbox-sdk/vercel" {
  import type { Provider } from "@opencoredev/sandbox-sdk";
  export function vercel(options?: Record<string, never>): Provider<unknown, "snapshot" | "network-policy" | "size">;
}

declare module "@opencoredev/sandbox-sdk/daytona" {
  import type { Provider } from "@opencoredev/sandbox-sdk";
  export function daytona(options?: Record<string, never>): Provider<unknown, "snapshot" | "size">;
}

declare module "@opencoredev/sandbox-sdk/memory" {
  import type { Provider } from "@opencoredev/sandbox-sdk";
  export interface CommandContext {
    args: string[];
    cwd: string;
    env: Record<string, string>;
    stdin: string;
    signal: AbortSignal;
    stdout(text: string): void;
    stderr(text: string): void;
    files: {
      read(path: string): Promise<Uint8Array>;
      write(path: string, data: string | Uint8Array): Promise<void>;
    };
  }
  export type CommandHandler = (context: CommandContext) => number | Promise<number>;
  export function memory(options?: { handlers?: Record<string, CommandHandler> }): Provider<unknown, "size" | "network-policy"> & {
    register(name: string, handler: CommandHandler): void;
  };
}

declare module "@opencoredev/sandbox-sdk/testing" {
  import type { Provider } from "@opencoredev/sandbox-sdk";
  export function runConformance(factory: () => Provider<any, any>, options: { live: boolean }): void;
}

declare module "@opencoredev/sandbox-sdk/ai" {
  import type { SandboxBase } from "@opencoredev/sandbox-sdk";
  import type { ToolSet } from "ai";
  export interface SandboxToolsOptions {
    root?: string;
    allow?: string[];
    deny?: string[];
    beforeRun?: (command: string) => string | false | Promise<string | false>;
    onEvent?: (event: unknown) => void;
  }
  export function sandboxTools(box: SandboxBase<unknown>, options?: SandboxToolsOptions): ToolSet;
}

declare module "@opencoredev/sandbox-sdk/mastra" {
  import type { SandboxBase } from "@opencoredev/sandbox-sdk";
  import type { ToolsInput } from "@mastra/core/agent";
  export function sandboxTools(box: SandboxBase<unknown>, options?: import("@opencoredev/sandbox-sdk/ai").SandboxToolsOptions): ToolsInput;
}

declare module "@opencoredev/sandbox-sdk/openai" {
  import type { SandboxBase } from "@opencoredev/sandbox-sdk";
  import type { Tool } from "@openai/agents";
  export function sandboxTools(box: SandboxBase<unknown>, options?: import("@opencoredev/sandbox-sdk/ai").SandboxToolsOptions): Tool[];
}
