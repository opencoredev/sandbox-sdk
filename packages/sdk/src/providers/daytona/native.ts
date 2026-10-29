import type { CreateSandboxFromSnapshotParams, DaytonaConfig, Sandbox } from "@daytonaio/sdk";
import type { Labels } from "../../provider.js";
import type { DaytonaErrorClasses } from "./errors.js";

/** The parts of a Daytona sandbox the adapter uses. */
export type DaytonaBox = Pick<
  Sandbox,
  | "id"
  | "labels"
  | "state"
  | "createdAt"
  | "public"
  | "cpu"
  | "memory"
  | "disk"
  | "start"
  | "stop"
  | "resize"
  | "delete"
  | "createSnapshot"
> & {
  getPreviewLink(
    port: number,
  ): Promise<Pick<Awaited<ReturnType<Sandbox["getPreviewLink"]>>, "url" | "token">>;
  fs: Pick<
    Sandbox["fs"],
    | "downloadFileStream"
    | "uploadFile"
    | "uploadFiles"
    | "createFolder"
    | "setFilePermissions"
    | "getFileDetails"
    | "listFiles"
    | "deleteFile"
  > & { downloadFile(path: string): Promise<Buffer> };
  process: Pick<
    Sandbox["process"],
    | "createSession"
    | "executeSessionCommand"
    | "getSessionCommand"
    | "deleteSession"
    | "executeCommand"
    | "codeRun"
  > & {
    getSessionCommandLogs(
      session: string,
      command: string,
      stdout: (text: string) => void,
      stderr: (text: string) => void,
    ): Promise<void>;
  };
};

/** The parts of the Daytona client the adapter uses. */
export interface DaytonaClient<B extends DaytonaBox> {
  create(params: CreateSandboxFromSnapshotParams, options: { timeout: number }): Promise<B>;
  get(id: string): Promise<B>;
  list(query: { labels: Labels }): AsyncIterable<B>;
}

/** The parts of the Daytona SDK the adapter uses: the real `@daytonaio/sdk` module, or a test fixture.
 * A fixture passes the SDK's own error classes, which the error mapper matches by identity. */
export interface DaytonaModule<B extends DaytonaBox> extends DaytonaErrorClasses {
  Daytona: new (config: DaytonaConfig) => DaytonaClient<B>;
}
