import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, ArrayBuffer>();
const destroyMock = mock(async () => ({ id: "sb_test", status: "destroyed" as const }));

class MockSandboxFiles {
  upload = mock(async (_path: string, data: Blob) => {
    files.set(_path, await data.arrayBuffer());
  });
  download = mock(async (path: string) => {
    const data = files.get(path);
    if (!data) throw new Error("Not found");
    return data;
  });
}

class MockSandbox {
  id = "sb_test";
  status = "running" as const;
  data = {
    id: "sb_test",
    status: "running" as const,
    ingress_enabled: true,
    ingress_url_template: "https://<port>-sb_test.sb.example.com",
    vcpu: 1,
    mem_mib: 256,
    disk_mib: 512,
    created_at: "2025-01-01T00:00:00Z",
  };
  files = new MockSandboxFiles();
  runCommand = mock(async (cmd: string, args: string[] = []) => {
    if (cmd === "mkdir") return { result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 };
    if (cmd === "test" && args[0] === "-e") return { result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 };
    if (cmd === "find") return { result: { stdout: "f\tfile1.txt\0d\tdir1\0", stderr: "", exit_code: 0 }, exec_ms: 1 };
    if (cmd === "rm") return { result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 };
    if (cmd === "bash") return { result: { stdout: "createos-output", stderr: "createos-err", exit_code: 0 }, exec_ms: 5 };
    return { result: { stdout: "", stderr: "", exit_code: 0 }, exec_ms: 1 };
  });
  async *streamCommand() {
    yield { type: "stdout" as const, data: "stream-out" };
    yield { type: "stderr" as const, data: "stream-err" };
    yield { type: "exit" as const, exitCode: 0 };
  }
  setIngress = mock(async () => {});
  previewUrl = mock((port: number) => `https://${port}-sb_test.sb.example.com`);
  destroy = destroyMock;
  pause = mock(async () => {});
  resume = mock(async () => {});
  fork = mock(async () => new MockSandbox());
  refresh = mock(async () => {});
}

class MockClient {
  createSandbox = mock(async () => new MockSandbox());
}

mock.module("@nodeops-createos/sandbox", () => ({
  CreateosSandboxClient: MockClient,
  Sandbox: MockSandbox,
  CreateosSandboxError: class extends Error {},
  CreateosSandboxApiError: class extends Error {},
  CreateosSandboxAuthError: class extends Error {},
  CreateosSandboxPermissionError: class extends Error {},
  CreateosSandboxNotFoundError: class extends Error {},
  CreateosSandboxTimeoutError: class extends Error {},
  CreateosSandboxRateLimitError: class extends Error {},
  CreateosSandboxValidationError: class extends Error {},
  CreateosSandboxServerError: class extends Error {},
  CreateosSandboxConnectionError: class extends Error {},
}));

test("createos adapter maps SDK operations", async () => {
  const { createos } = await import("../../src/providers/createos");
  const sandbox = await createSandbox({ provider: createos() });

  const result = await sandbox.run("echo hello");
  expect(result).toMatchObject({ stdout: "createos-output", exitCode: 0, success: true });
  expect(result.durationMs).toBeGreaterThanOrEqual(0);

  await sandbox.files.write("/test.txt", "hello createos");
  expect(await sandbox.files.text("/test.txt")).toBe("hello createos");

  const entries = await sandbox.files.list("/workspace");
  expect(entries).toEqual([
    { name: "file1.txt", path: "/workspace/file1.txt", type: "file" },
    { name: "dir1", path: "/workspace/dir1", type: "directory" },
  ]);

  await sandbox.files.mkdir("/workspace/newdir");
  await sandbox.files.remove("/workspace/oldfile");
  expect(await sandbox.files.exists("/workspace/test")).toBe(true);

  const port = await sandbox.ports.expose(8080);
  expect(port).toMatchObject({ port: 8080, authenticated: true, public: false });
  expect(port.url).toContain("8080");

  await sandbox.stop();
  expect(destroyMock).toHaveBeenCalled();
});

test("createos adapter: background process streaming", async () => {
  const { createos } = await import("../../src/providers/createos");
  const sandbox = await createSandbox({ provider: createos() });

  const proc = await sandbox.processes.start("echo streaming");
  const events: { stream: string; data: unknown }[] = [];
  for await (const event of proc.output()) events.push(event);

  expect(events[0]).toMatchObject({ stream: "stdout", data: "stream-out" });
  expect(events[1]).toMatchObject({ stream: "stderr", data: "stream-err" });
  expect(await proc.wait()).toEqual({ exitCode: 0 });

  await sandbox.stop();
});

test("createos adapter: stdin throws unsupported", async () => {
  const { createos } = await import("../../src/providers/createos");
  const sandbox = await createSandbox({ provider: createos() });

  const proc = await sandbox.processes.start("cat");
  await expect(proc.write("hello")).rejects.toMatchObject({ code: "unsupported", provider: "createos" });

  await sandbox.stop();
});

test("createos adapter: snapshots throw unsupported", async () => {
  const { createos } = await import("../../src/providers/createos");
  const sandbox = await createSandbox({ provider: createos() });

  await expect(sandbox.snapshots.create()).rejects.toMatchObject({ code: "unsupported", provider: "createos" });
  await expect(sandbox.snapshots.delete("snap-1")).rejects.toMatchObject({ code: "unsupported" });
  await expect(sandbox.snapshots.restore("snap-1")).rejects.toMatchObject({ code: "unsupported" });

  await sandbox.stop();
});

test("createos adapter: raw handle and capabilities", async () => {
  const { createos, createosCapabilities } = await import("../../src/providers/createos");
  const sandbox = await createSandbox({ provider: createos() });

  expect(sandbox.raw).toBeInstanceOf(MockSandbox);
  expect(sandbox.provider).toBe("createos");
  expect(sandbox.id).toBe("sb_test");
  expect(sandbox.capabilities).toBe(createosCapabilities);
  expect(sandbox.capabilities["files.read"]).toBe("full");
  expect(sandbox.capabilities["process.run"]).toBe("separate-streams");
  expect(sandbox.capabilities["process.stdin"]).toBe(false);
  expect(sandbox.capabilities["snapshot.create"]).toBe(false);
  expect(sandbox.capabilities["sandbox.resume"]).toBe("persistent");
  expect(sandbox.capabilities["image.custom"]).toBe("template");
  expect(sandbox.capabilities["compute.gpu"]).toBe(false);

  await sandbox.stop();
});
