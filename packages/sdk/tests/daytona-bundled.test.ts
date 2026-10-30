import { afterEach, expect, test, vi } from "vitest";
import { cleanupMock, daytona, type MockSandbox } from "./daytona-mock.js";
import { resetTransfers } from "../src/providers/daytona/transfer.js";
import { createSandbox } from "../src/index.js";

vi.setConfig({ testTimeout: 30_000 });

afterEach(async () => {
  vi.restoreAllMocks();
  resetTransfers();
  await cleanupMock();
});

// What the Daytona SDK throws in a bundle: it loads form-data and busboy through a require bundlers cannot see.
const unloadable = (module: string) =>
  new Error(
    `Uploading files is not supported:  Module "${module}" is not available in the "node" runtime: Cannot find module '${module}'`,
  );

function bundled(box: MockSandbox) {
  return {
    probe: vi.spyOn(box.fs, "uploadFiles").mockRejectedValue(unloadable("form-data")),
    upload: vi.spyOn(box.fs, "uploadFile").mockRejectedValue(unloadable("form-data")),
    download: vi.spyOn(box.fs, "downloadFile").mockRejectedValue(unloadable("busboy")),
    stream: vi.spyOn(box.fs, "downloadFileStream").mockRejectedValue(unloadable("busboy")),
  };
}

test("file transfers fall back to codeRun when the SDK cannot load form-data or busboy", async () => {
  const box = await createSandbox(daytona({ apiKey: "offline-test-key" }));

  try {
    await box.run("true"); // Prepares the workspace, so writes take the native upload path.
    const native = bundled(box.native);
    await box.files.write("notes/a.txt", "hello");
    expect(await box.files.read("notes/a.txt")).toBe("hello");
    const bytes = Uint8Array.from({ length: 70_000 }, (_, i) => i % 256);
    await box.files.write("data.bin", bytes);
    expect(await box.files.read("data.bin", { as: "bytes" })).toEqual(bytes);
    await expect(box.files.read("missing.txt")).rejects.toMatchObject({
      code: "file_not_found",
      provider: "daytona",
    });
    expect(await box.files.exists("missing.txt")).toBe(false);
    // stdin travels as a file, and a background process confirms its PID by reading one back.
    expect((await box.run("cat", { stdin: "piped" })).stdout).toBe("piped");
    const server = await box.start("sleep 30", { name: "sleeper" });
    expect(server.status).toBe("running");
    await server.stop();
    // One probe decides for the process. A native download is never started: it would open a
    // response before failing on busboy and leave that socket holding the process open.
    expect(native.probe).toHaveBeenCalledTimes(1);
    expect(native.upload).not.toHaveBeenCalled();
    expect(native.download).not.toHaveBeenCalled();
    expect(native.stream).not.toHaveBeenCalled();
  } finally {
    await box.destroy();
  }
});

test("the probe sends nothing and keeps native transfers when the modules load", async () => {
  const box = await createSandbox(daytona({ apiKey: "offline-test-key" }));

  try {
    await box.run("true");
    const probe = vi.spyOn(box.native.fs, "uploadFiles");
    const upload = vi.spyOn(box.native.fs, "uploadFile");
    const codeRun = vi.spyOn(box.native.process, "codeRun");
    await box.files.write("a.txt", "native");
    expect(await box.files.read("a.txt")).toBe("native");
    expect(probe).toHaveBeenCalledWith([{ source: "\0", destination: "/tmp/.sandbox-sdk/probe" }]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(codeRun).not.toHaveBeenCalled();
  } finally {
    await box.destroy();
  }
});

test("a module failure after a passing probe still falls back", async () => {
  const box = await createSandbox(daytona({ apiKey: "offline-test-key" }));

  try {
    await box.run("true");
    vi.spyOn(box.native.fs, "downloadFile").mockRejectedValue(unloadable("busboy"));
    await box.files.write("a.txt", "fallback");
    expect(await box.files.read("a.txt")).toBe("fallback");
  } finally {
    await box.destroy();
  }
});

test("any other native transfer failure is not retried through codeRun", async () => {
  const box = await createSandbox(daytona({ apiKey: "offline-test-key" }));

  try {
    await box.run("true");
    vi.spyOn(box.native.fs, "uploadFile").mockRejectedValue(
      Object.assign(new Error("private"), { statusCode: 403 }),
    );
    const codeRun = vi.spyOn(box.native.process, "codeRun");
    await expect(box.files.write("a.txt", "x")).rejects.toMatchObject({ code: "auth" });
    expect(codeRun).not.toHaveBeenCalled();
  } finally {
    await box.destroy();
  }
});
