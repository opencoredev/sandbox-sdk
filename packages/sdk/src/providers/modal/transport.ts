import type {
  App,
  AppFromNameParams,
  ImageDockerfileCommandsParams,
  ModalWriteStream,
  SandboxCreateParams,
  SandboxExecParams,
  SandboxFilesystem,
  SandboxFromNameParams,
  SandboxListParams,
  SandboxSnapshotFilesystemParams,
  Tunnel,
} from "modal";

/** The App fields the adapter reads. */
export type NativeApp = Pick<App, "appId">;

/** A Modal Image: built lazily against an App, extended with Dockerfile commands. */
export interface NativeImage {
  readonly imageId: string;
  dockerfileCommands(commands: string[], params?: ImageDockerfileCommandsParams): NativeImage;
  build(app: NativeApp): Promise<NativeImage>;
}

/** One `sb.exec` in text mode: stdin, both output streams and the exit code. */
export interface NativeProcess {
  readonly stdin: Pick<ModalWriteStream<string>, "writeText" | "close">;
  readonly stdout: ReadableStream<string>;
  readonly stderr: ReadableStream<string>;
  wait(): Promise<number>;
}

export type NativeFilesystem = Pick<
  SandboxFilesystem,
  "readBytes" | "writeBytes" | "listFiles" | "stat" | "remove" | "makeDirectory"
>;

/** SDK-derived sandbox slice, structurally checked against the real `Sandbox` by the loader in index.ts. */
export interface NativeSandbox {
  readonly sandboxId: string;
  readonly filesystem: NativeFilesystem;
  exec(command: string[], params?: SandboxExecParams & { mode?: "text" }): Promise<NativeProcess>;
  getTags(): Promise<Record<string, string>>;
  setTags(tags: Record<string, string>): Promise<void>;
  poll(): Promise<number | null>;
  terminate(): Promise<void>;
  detach(): void;
  tunnels(timeoutMs?: number): Promise<Record<number, Pick<Tunnel, "url">>>;
  snapshotFilesystem(params?: SandboxSnapshotFilesystemParams): Promise<NativeImage>;
}

/** The `ModalClient` services the adapter uses. */
export interface ModalClientSlice<N extends NativeSandbox> {
  readonly apps: { fromName(name: string, params?: AppFromNameParams): Promise<NativeApp> };
  readonly images: {
    fromRegistry(tag: string): NativeImage;
    fromId(imageId: string): Promise<NativeImage>;
    delete(imageId: string): Promise<void>;
  };
  readonly sandboxes: {
    create(app: NativeApp, image: NativeImage, params?: SandboxCreateParams): Promise<N>;
    fromId(sandboxId: string): Promise<N>;
    fromName(appName: string, name: string, params?: SandboxFromNameParams): Promise<N>;
    list(params?: SandboxListParams): AsyncIterable<N>;
  };
  close(): void;
}
