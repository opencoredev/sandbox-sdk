import { describe, expect, test } from "bun:test";
import {
  DirectoryNotEmptyError,
  FileExistsError,
  WorkspaceReadOnlyError,
} from "@mastra/core/workspace";
import {
  createMastraSandbox,
  createMastraWorkspace,
  SandboxSDKMastraFilesystem,
  SandboxSDKMastraSandbox,
} from "../../src/mastra";
import { local } from "../../src/providers/local";

describe("Mastra integration", () => {
  test("executes commands with args, environment, cwd, and streaming output", async () => {
    const sandbox = createMastraSandbox({
      provider: local(),
      env: { BASE_VALUE: "base" },
    });
    const stdout: string[] = [];

    try {
      const unsafe = "$HOME;echo unsafe";
      const result = await sandbox.executeCommand!(
        "node",
        [
          "-e",
          "process.stdout.write(`${process.env.BASE_VALUE}:${process.env.RUN_VALUE}:${process.argv[1]}`)",
          unsafe,
        ],
        {
          cwd: "/workspace",
          env: { RUN_VALUE: "run" },
          onStdout: (data) => stdout.push(data),
        },
      );

      expect(result).toMatchObject({
        success: true,
        exitCode: 0,
        stdout: `base:run:${unsafe}`,
      });
      expect(stdout.join("")).toBe(`base:run:${unsafe}`);
      expect(sandbox.status).toBe("running");
      expect(sandbox.getInfo().metadata).toMatchObject({
        sandboxProvider: "local",
        cwd: "/workspace",
      });
    } finally {
      await sandbox._destroy();
    }
  });

  test("supports managed background processes and stdin", async () => {
    const sandbox = createMastraSandbox({ provider: local() });

    try {
      const handle = await sandbox.processes.spawn(
        "node -e \"process.stdin.once('data', d => { console.log(d.toString().trim()); process.exit(0) })\"",
      );
      await handle.sendStdin("mastra-ok\n");
      const result = await handle.wait();

      expect(result.success).toBe(true);
      expect(result.stdout).toContain("mastra-ok");
      expect(await sandbox.processes.list()).toContainEqual(
        expect.objectContaining({
          pid: handle.pid,
          running: false,
          exitCode: 0,
        }),
      );
      expect(await sandbox.processes.get(handle.pid)).toBe(handle);
      expect(await sandbox.processes.get(handle.pid)).toBeUndefined();
    } finally {
      await sandbox._destroy();
    }
  });

  test("stops and resumes without losing workspace files", async () => {
    const sandbox = createMastraSandbox({ provider: local() });

    try {
      await sandbox._start();
      await sandbox.sandboxSdk.files.write("state.txt", "one");
      await sandbox._stop();
      expect(sandbox.status).toBe("stopped");
      await sandbox._start();
      expect(await sandbox.sandboxSdk.files.text("state.txt")).toBe("one");
    } finally {
      await sandbox._destroy();
    }
  });

  test("creates a coherent Mastra workspace filesystem", async () => {
    const workspace = createMastraWorkspace({
      provider: local(),
      workspace: { id: "sandbox-sdk-mastra-test" },
    });

    expect(workspace.sandbox).toBeInstanceOf(SandboxSDKMastraSandbox);
    expect(workspace.filesystem).toBeInstanceOf(SandboxSDKMastraFilesystem);

    try {
      await workspace.init();
      const filesystem = workspace.filesystem;
      await filesystem.writeFile("src/input.txt", "one", { recursive: true });
      await filesystem.appendFile("/src/input.txt", "-two");
      expect(await filesystem.readFile("/src/input.txt", { encoding: "utf8" })).toBe("one-two");

      await filesystem.copyFile("/src/input.txt", "/src/copied.txt");
      await filesystem.moveFile("/src/copied.txt", "/output/moved.txt");
      expect(await filesystem.exists("/src/copied.txt")).toBe(false);
      expect(await workspace.sandbox.sandboxSdk.files.text("output/moved.txt")).toBe("one-two");

      const listing = await filesystem.readdir("/", { recursive: true });
      expect(listing.map((entry) => entry.name)).toEqual(
        expect.arrayContaining(["src", "src/input.txt", "output", "output/moved.txt"]),
      );
      expect(await filesystem.stat("/output/moved.txt")).toMatchObject({
        name: "moved.txt",
        path: "/output/moved.txt",
        type: "file",
        size: 7,
      });
    } finally {
      await workspace.destroy();
    }
  });

  test("honors overwrite and recursive directory behavior", async () => {
    const workspace = createMastraWorkspace({ provider: local() });

    try {
      await workspace.init();
      const filesystem = workspace.filesystem;
      await filesystem.writeFile("file.txt", "one");
      await expect(
        filesystem.writeFile("file.txt", "two", { overwrite: false }),
      ).rejects.toBeInstanceOf(FileExistsError);

      await filesystem.mkdir("folder");
      await filesystem.writeFile("folder/nested.txt", "nested");
      await expect(filesystem.rmdir("folder")).rejects.toBeInstanceOf(DirectoryNotEmptyError);
      await filesystem.rmdir("folder", { recursive: true });
      expect(await filesystem.exists("folder")).toBe(false);

      await filesystem.mkdir("move-source");
      await filesystem.writeFile("move-source/file.txt", "move");
      await filesystem.moveFile("move-source", "move-destination");
      expect(await filesystem.exists("move-source")).toBe(false);
      expect(
        await filesystem.readFile("move-destination/file.txt", {
          encoding: "utf8",
        }),
      ).toBe("move");
    } finally {
      await workspace.destroy();
    }
  });

  test("supports read-only workspace filesystems", async () => {
    const workspace = createMastraWorkspace({
      provider: local(),
      filesystem: { readOnly: true },
    });

    try {
      await workspace.init();
      expect(workspace.filesystem.readOnly).toBe(true);
      await expect(workspace.filesystem.writeFile("blocked.txt", "no")).rejects.toBeInstanceOf(
        WorkspaceReadOnlyError,
      );
    } finally {
      await workspace.destroy();
    }
  });
});
