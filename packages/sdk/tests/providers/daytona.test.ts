import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, Buffer>();
const executeCommand = mock(async () => ({ result: "daytona", exitCode: 0 }));
const executeSessionCommand = mock(
  async (
    _sessionId: string,
    _request: { command: string; runAsync: boolean; suppressInputEcho: boolean },
  ) => ({ cmdId: "command-1" }),
);
const createFolder = mock(async () => {});
const native = {
  id: "daytona-test",
  public: false,
  fs: {
    uploadFile: async (value: Buffer, path: string) => {
      files.set(path, value);
    },
    downloadFile: async (path: string) => files.get(path)!,
    listFiles: async () => [],
    createFolder,
    deleteFile: async (path: string) => {
      files.delete(path);
    },
    getFileDetails: async (path: string) => {
      if (path === "/home/daytona/workspace") throw new Error("not found");
      if (path.endsWith("missing.txt"))
        throw Object.assign(new Error("request failed"), { statusCode: 404 });
      return {};
    },
  },
  process: {
    executeCommand,
    createSession: mock(async () => {}),
    executeSessionCommand,
    getSessionCommandLogs: mock(
      async (_sessionId: string, _commandId: string, onStdout: (value: string) => void) =>
        onStdout("background"),
    ),
    getSessionCommand: mock(async () => ({ exitCode: 0 })),
  },
  getWorkDir: async () => "/home/daytona",
  getPreviewLink: async () => ({
    url: "https://daytona.test",
    token: "secret",
  }),
};
class NativeDaytona {
  create = mock(async () => native);
  delete = mock(async () => {});
}
mock.module("@daytona/sdk", () => ({ Daytona: NativeDaytona }));

test("Daytona adapter maps official SDK operations", async () => {
  const { daytona } = await import("../../src/providers/daytona");
  const sandbox = await createSandbox({ provider: daytona() });
  expect(createFolder).toHaveBeenCalledWith("/home/daytona/workspace", "755");
  await sandbox.files.write("file.txt", "value");
  expect(await sandbox.files.text("file.txt")).toBe("value");
  expect(await sandbox.files.exists("missing.txt")).toBe(false);
  expect(await sandbox.run("command")).toMatchObject({
    stdout: "daytona",
    success: true,
  });
  expect(executeCommand).toHaveBeenCalledWith("command", "/home/daytona/workspace", {}, undefined);
  const process = await sandbox.processes.start("background-command");
  expect((await Array.fromAsync(process.output())).map((event) => event.data)).toEqual([
    "background",
  ]);
  expect(await process.wait()).toEqual({ exitCode: 0 });
  expect(executeSessionCommand.mock.calls[0]?.[1]).toMatchObject({
    command: expect.stringContaining("background-command"),
    runAsync: true,
    suppressInputEcho: true,
  });
  expect((await sandbox.ports.expose(3000)).toJSON()).not.toHaveProperty("request");
  await sandbox.stop();
  expect(sandbox.raw.id).toBe("daytona-test");
});
