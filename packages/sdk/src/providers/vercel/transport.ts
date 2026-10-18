import type { Sandbox, Command } from "@vercel/sandbox";
import type { Stats } from "node:fs";

export type NativeCommand = Pick<Command, "cmdId" | "kill"> & {
  wait(): Promise<Pick<Awaited<ReturnType<Command["wait"]>>, "exitCode">>;
  logs(): AsyncIterable<{ stream: "stdout" | "stderr"; data: string }>;
};
/** SDK-derived transport slice, structurally checked against the real SDK loader. */
export type NativeSandbox = Pick<Sandbox, "name" | "status" | "tags" | "routes" | "createdAt" | "cwd" | "domain" | "delete" | "update"> & {
  fs: Pick<Sandbox["fs"], "writeFile" | "mkdir" | "rm"> & {
    readFile(path: string): Promise<Buffer>;
    readdir(path: string): Promise<string[]>;
    lstat(path: string): Promise<Stats>;
  };
  stop(): Promise<unknown>;
  snapshot(): Promise<Pick<Awaited<ReturnType<Sandbox["snapshot"]>>, "snapshotId">>;
  runCommand(params: Parameters<Sandbox["runCommand"]>[0] & { detached: true }): Promise<NativeCommand>;
};
export interface VercelClient<N extends NativeSandbox> {
  create(params: NonNullable<Parameters<typeof Sandbox.create>[0]> & { onResume?: (box: N) => Promise<void> }): Promise<N>;
  get(params: Parameters<typeof Sandbox.get>[0] & { onResume?: (box: N) => Promise<void> }): Promise<N>;
  list(params: { tags: { "sandbox-sdk": string }; token?: string; teamId?: string; projectId?: string }): Promise<AsyncIterable<{ name: string }>>;
}
