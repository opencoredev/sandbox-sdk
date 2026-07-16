import { afterEach, describe, expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, string>();
const commands: Array<{ command: string; cwd?: string; timeoutSeconds?: number }> = [];
let state = "ready";
let failCreate = false;
let latestSnapshotId = "snap-0";
const removed = mock(async () => {
  if (state !== "archived" || latestSnapshotId === "snap-0")
    throw new NativeResponseError(
      Response.json(
        { error: { message: "Refusing box delete: no successful snapshot" } },
        { status: 409 },
      ),
    );
  return { ok: true, id: "bx_testbox", status: "deleted" };
});

const nativeBox = () => ({
  id: "bx_testbox",
  name: "test",
  state,
  desktopAvailable: true,
  snapshotAvailable: true,
});

class NativeConfiguration {
  constructor(readonly options: unknown) {}
}

class NativeResponseError extends Error {
  constructor(readonly response: Response) {
    super("Response returned an error code");
  }
}

class NativeBoxApi {
  async create() {
    if (failCreate)
      throw new NativeResponseError(
        Response.json({ error: { message: "Invalid Box API key" } }, { status: 401 }),
      );
    state = "ready";
    latestSnapshotId = "snap-0";
    return { ok: true, box: nativeBox(), status: "provisioning", ttlSeconds: 1800 };
  }
  async get() {
    return { ok: true, box: nativeBox() };
  }
  async writeFile({ fileWriteRequest }: { fileWriteRequest: { path: string; content: string } }) {
    files.set(fileWriteRequest.path, fileWriteRequest.content);
    return { ok: true };
  }
  async readFile({ path }: { path: string }) {
    const content = files.get(path);
    if (content === undefined)
      throw new NativeResponseError(
        Response.json(
          { error: { message: `ENOENT: no such file or directory, statx '${path}'` } },
          { status: 400 },
        ),
      );
    return { ok: true, content, encoding: "base64", path, size: content.length };
  }
  async command({ commandRequest }: { commandRequest: (typeof commands)[number] }) {
    commands.push(commandRequest);
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    if (commandRequest.command.startsWith("find "))
      stdout = ["file.txt", "f", "4", "folder", "d", "4096", ""].join("\0");
    else if (
      commandRequest.command.includes("node") &&
      commandRequest.command.includes("--version")
    )
      stdout = "v24.0.0\n";
    else if (commandRequest.command.includes("printf out")) {
      stdout = "out";
      stderr = "err";
      exitCode = 7;
    } else if (commandRequest.command.startsWith("test -e")) exitCode = 0;
    else if (commandRequest.command.startsWith("host "))
      stdout = "\x1b[32mhttps://box-test-3000.on.ascii.dev?_token=secret+token\x1b[0m\n";
    else if (commandRequest.command.includes("nohup setsid")) {
      const processId = commandRequest.command.match(/\.sandbox-sdk\/processes\/([\w-]+)/)?.[1];
      if (!processId) throw new Error("Missing process id");
      files.set(
        `.sandbox-sdk/processes/${processId}/stdout`,
        Buffer.from(commandRequest.command.includes("sleep 30") ? "" : "started\n").toString(
          "base64",
        ),
      );
      files.set(
        `.sandbox-sdk/processes/${processId}/stderr`,
        Buffer.from(commandRequest.command.includes("sleep 30") ? "" : "warning\n").toString(
          "base64",
        ),
      );
      if (!commandRequest.command.includes("sleep 30"))
        files.set(`.sandbox-sdk/processes/${processId}/exit`, Buffer.from("0").toString("base64"));
      stdout = "4242";
    } else if (commandRequest.command.startsWith("kill -s")) {
      const processId = commandRequest.command.match(/\.sandbox-sdk\/processes\/([\w-]+)/)?.[1];
      if (!processId) throw new Error("Missing process id");
      files.set(`.sandbox-sdk/processes/${processId}/exit`, Buffer.from("143").toString("base64"));
    }
    return {
      ok: true,
      success: exitCode === 0,
      exitCode,
      stdout,
      stderr,
      timedOut: false,
    };
  }
  async stop() {
    state = "archived";
    latestSnapshotId = `snap-${Number.parseInt(latestSnapshotId.slice(5), 10) + 1}`;
    return { ok: true };
  }
  async resume() {
    state = "ready";
    return { ok: true };
  }
  remove = removed;
  async getLatestBoxSnapshot() {
    return {
      ok: true,
      snapshot: {
        id: latestSnapshotId,
        boxId: "bx_testbox",
        status: "completed",
        generation: latestSnapshotId === "snap-0" ? 0 : 1,
        createdAt: new Date("2026-07-16T00:00:00Z"),
        sizeBytes: 1,
        fileCount: 1,
      },
    };
  }
}

mock.module("@asciidev/box-sdk", () => ({
  BoxApi: NativeBoxApi,
  Configuration: NativeConfiguration,
  ResponseError: NativeResponseError,
}));

afterEach(() => {
  files.clear();
  commands.length = 0;
  removed.mockClear();
  state = "ready";
  failCreate = false;
  latestSnapshotId = "snap-0";
});

describe("Ascii adapter", () => {
  test("maps files, commands, paths, ports, and cleanup", async () => {
    const { ascii } = await import("../../src/providers/ascii");
    const sandbox = await createSandbox({ provider: ascii({ pollIntervalMs: 1 }) });
    await sandbox.files.write("file.txt", "value");
    expect(await sandbox.files.text("file.txt")).toBe("value");
    expect(files.has("file.txt")).toBe(true);
    expect(await sandbox.files.list()).toEqual([
      { name: "file.txt", path: "/workspace/file.txt", type: "file", size: 4 },
      { name: "folder", path: "/workspace/folder", type: "directory" },
    ]);
    expect(await sandbox.run({ command: "node", args: ["--version"] })).toMatchObject({
      stdout: "v24.0.0\n",
      stderr: "",
      success: true,
    });
    expect(await sandbox.run("printf out; printf err >&2; exit 7")).toMatchObject({
      stdout: "out",
      stderr: "err",
      exitCode: 7,
      success: false,
    });
    const exposed = await sandbox.ports.expose(3000);
    expect(exposed).toMatchObject({
      url: "https://box-test-3000.on.ascii.dev/",
      public: false,
      authenticated: true,
    });
    expect(exposed.toJSON().url).not.toContain("secret-token");
    const originalFetch = globalThis.fetch;
    const requested: string[] = [];
    const requestCookies: Array<string | null> = [];
    globalThis.fetch = mock(async (input, init) => {
      requested.push(String(input));
      requestCookies.push(new Headers(init?.headers).get("cookie"));
      if (requested.length === 1)
        return new Response(null, {
          status: 302,
          headers: {
            location: "/health?check=1",
            "set-cookie": "ascii_preview=session-value; Path=/; HttpOnly",
          },
        });
      return new Response("ok");
    }) as unknown as typeof fetch;
    try {
      expect(await (await exposed.request!("/health?check=1")).text()).toBe("ok");
    } finally {
      globalThis.fetch = originalFetch;
    }
    const requestedUrl = new URL(requested[0]!);
    expect(requested[0]).toContain("_token=secret+token");
    expect(requestedUrl.searchParams.get("check")).toBe("1");
    expect(requestCookies).toEqual([null, "ascii_preview=session-value"]);
    await sandbox.stop();
    expect(sandbox.raw.id).toBe("bx_testbox");
    expect(removed).toHaveBeenCalled();
  });

  test("streams detached process output and returns its exit code", async () => {
    const { ascii } = await import("../../src/providers/ascii");
    const sandbox = await createSandbox({ provider: ascii({ pollIntervalMs: 1 }) });
    const process = await sandbox.processes.start("printf started; printf warning >&2");
    expect(commands.find((entry) => entry.command.includes("nohup setsid"))?.command).not.toContain(
      "&;",
    );
    const events = [];
    for await (const event of process.output()) events.push(event);
    expect(
      events.map((event) => [
        event.stream,
        typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data),
      ]),
    ).toEqual([
      ["stdout", "started\n"],
      ["stderr", "warning\n"],
    ]);
    expect(await process.wait()).toEqual({ exitCode: 0 });
    expect(await process.status()).toBe("exited");
    await expect(process.write("input")).rejects.toMatchObject({
      code: "unsupported",
      provider: "ascii",
    });
    await sandbox.stop();
  });

  test("cancels a detached process group", async () => {
    const { ascii } = await import("../../src/providers/ascii");
    const sandbox = await createSandbox({ provider: ascii({ pollIntervalMs: 1 }) });
    const process = await sandbox.processes.start("sleep 30");
    expect(await process.status()).toBe("running");
    await process.kill();
    expect(await process.status()).toBe("killed");
    expect(await process.wait()).toEqual({ exitCode: 143 });
    await sandbox.stop();
  });

  test("archives, snapshots, resumes, and destroys managed sessions", async () => {
    const { ascii } = await import("../../src/providers/ascii");
    const provider = ascii({ pollIntervalMs: 1 });
    const sandbox = await createSandbox({ provider });
    expect(await sandbox.snapshots.create({ name: "prepared" })).toMatchObject({
      id: "snap-1",
      name: "prepared",
      mode: "filesystem",
    });
    expect(state).toBe("ready");
    await expect(sandbox.snapshots.delete("snap-1")).rejects.toMatchObject({
      code: "unsupported",
      provider: "ascii",
    });
    expect(sandbox.capabilities["snapshot.delete"]).toBe(false);
    await sandbox.stop();

    const session = await provider.managed!.create({ sessionId: "session-1" });
    await session.stop();
    expect(state).toBe("archived");
    await session.resume();
    expect(state).toBe("ready");
    await session.destroy();
    expect(removed).toHaveBeenCalled();
  });

  test("normalizes official SDK HTTP errors", async () => {
    failCreate = true;
    const { ascii } = await import("../../src/providers/ascii");
    await expect(createSandbox({ provider: ascii() })).rejects.toMatchObject({
      code: "authentication",
      provider: "ascii",
      operation: "sandbox.create",
      message: "Invalid Box API key",
    });
  });
});
