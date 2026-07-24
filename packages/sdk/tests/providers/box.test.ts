import { expect, mock, test } from "bun:test";
import { createSandbox } from "../../src";

const files = new Map<string, string>();
const commands: Array<{ command: string; cwd?: string; timeoutSeconds?: number }> = [];
let readyError: Error | undefined;
let provisioning = false;
let getCalls = 0;
let nativeState: "ready" | "archived" = "ready";
let removeConflictOnce = false;
const stop = mock(async () => {
  nativeState = "archived";
  return { ok: true };
});
const resume = mock(async () => {
  nativeState = "ready";
  return { ok: true };
});
const remove = mock(async () => {
  if (removeConflictOnce) {
    removeConflictOnce = false;
    throw Object.assign(new Error("Box must be archived before deletion"), {
      response: { status: 409 },
    });
  }
  return { ok: true };
});
const create = mock(async () => {
  nativeState = "ready";
  return {
    box: {
      id: "bx_23456789",
      name: "Test Box",
      state: "provisioning",
      desktopAvailable: true,
      snapshotAvailable: false,
    },
  };
});

class NativeConfiguration {
  constructor(readonly options: unknown) {}
}

class NativeBoxApi {
  constructor(readonly configuration: NativeConfiguration) {}
  create = create;
  update = async () => ({
    box: {
      id: "bx_23456789",
      name: "Renamed",
      state: "ready",
      desktopAvailable: true,
      snapshotAvailable: false,
    },
  });
  writeFile = async ({
    fileWriteRequest,
  }: {
    fileWriteRequest: { path: string; content: string };
  }) => {
    files.set(fileWriteRequest.path, fileWriteRequest.content);
  };
  readFile = async ({ path }: { path: string }) => ({ content: files.get(path)! });
  command = async ({
    commandRequest,
  }: {
    commandRequest: { command: string; cwd?: string; timeoutSeconds?: number };
  }) => {
    commands.push(commandRequest);
    const command = commandRequest.command;
    if (command.startsWith("host "))
      return commandResult("https://box-test-3000.on.ascii.dev?_token=secret");
    if (command.includes("python3")) return commandResult("[]");
    if (command.includes("test") && command.includes("missing")) return commandResult("", 1);
    if (command.includes("printf box")) return commandResult("box");
    return commandResult("");
  };
  remove = remove;
  stop = stop;
  resume = resume;
  get = async () => {
    getCalls += 1;
    if (readyError) throw readyError;
    return {
      box: {
        id: "bx_23456789",
        name: "Test Box",
        state: provisioning ? "provisioning" : nativeState,
        desktopAvailable: true,
        snapshotAvailable: nativeState === "archived",
      },
    };
  };
}

function commandResult(stdout: string, exitCode = 0) {
  return {
    stdout,
    stderr: "",
    exitCode,
    success: exitCode === 0,
    timedOut: false,
  };
}

mock.module("@asciidev/box-sdk", () => ({
  BoxApi: NativeBoxApi,
  Configuration: NativeConfiguration,
}));

test("Ascii Box adapter maps the official SDK and protects hosted credentials", async () => {
  const { box } = await import("../../src/providers/box");
  const sandbox = await createSandbox({
    provider: box({
      apiKey: "box_test",
      baseUrl: "https://box.test/v1",
      ttlSeconds: 900,
      noEnv: true,
      name: "Renamed",
      public: false,
    }),
    env: { NODE_ENV: "test" },
  });

  await sandbox.files.write("file.bin", new Uint8Array([0, 1, 255]));
  expect(await sandbox.files.read("file.bin")).toEqual(new Uint8Array([0, 1, 255]));
  await sandbox.files.write("/tmp/absolute.bin", new Uint8Array([2, 3]));
  expect(files.has("tmp/absolute.bin")).toBe(true);
  expect(await sandbox.run("printf box")).toMatchObject({ stdout: "box", success: true });
  await sandbox.run({ command: "printf", args: ["hello world"] }, {
    cwd: "/tmp",
    env: { MESSAGE: "hello world" },
    timeout: 1_500,
  });
  const preview = await sandbox.ports.expose(3000);
  expect(preview).toMatchObject({ public: false, authenticated: true });
  expect(preview.url).not.toContain("_token");
  expect(preview.toJSON().url).not.toContain("_token");
  expect(create).toHaveBeenCalledWith(
    {
      createBoxRequest: {
        ttlSeconds: 900,
        noEnv: true,
        env: { NODE_ENV: "test" },
      },
    },
    { signal: undefined },
  );
  expect(sandbox.raw.client).toBeInstanceOf(NativeBoxApi);
  const nativeClient = sandbox.raw.client as unknown as NativeBoxApi;
  expect((nativeClient.configuration.options as { basePath: string }).basePath).toBe(
    "https://box.test/v1",
  );
  expect(commands.at(-3)).toMatchObject({ cwd: "tmp", timeoutSeconds: 2 });
  expect(commands.at(-3)?.command).toContain("MESSAGE=hello world");
  expect(commands.at(-3)?.command).toContain("sh -c");
  expect(commands.at(-3)?.command).not.toContain("sh -lc");

  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    requestedUrl = String(input);
    return new Response("ok");
  }) as unknown as typeof fetch;
  try {
    await preview.request!("/health?probe=1");
    expect(requestedUrl).toContain("probe=1");
    expect(requestedUrl).toContain("_token=secret");
    await expect(preview.request!("https://example.com/steal")).rejects.toThrow(
      "Protected Ascii Box preview requests must stay on the preview origin",
    );
    await expect(preview.request!("//example.com/steal")).rejects.toThrow(
      "Protected Ascii Box preview requests must stay on the preview origin",
    );
    expect(requestedUrl).not.toContain("example.com");
  } finally {
    globalThis.fetch = originalFetch;
  }

  await sandbox.stop();
  expect(remove).toHaveBeenCalledWith({ boxId: "bx_23456789" });
});

test("Ascii Box rejects command timeouts above the provider maximum", async () => {
  const { box } = await import("../../src/providers/box");
  const sandbox = await createSandbox({ provider: box({ apiKey: "box_test" }) });
  try {
    await expect(sandbox.run("true", { timeout: 60_001 })).rejects.toMatchObject({
      code: "invalid_input",
      provider: "box",
    });
  } finally {
    await sandbox.stop();
  }
});

test("Ascii Box cleans up failed provisioning and archives before deleting when required", async () => {
  const { box } = await import("../../src/providers/box");
  readyError = new Error("provisioning failed");
  try {
    await expect(createSandbox({ provider: box({ apiKey: "box_test" }) })).rejects.toThrow(
      "provisioning failed",
    );
    expect(remove).toHaveBeenCalledWith({ boxId: "bx_23456789" });
  } finally {
    readyError = undefined;
  }

  removeConflictOnce = true;
  const sandbox = await createSandbox({ provider: box({ apiKey: "box_test" }) });
  await sandbox.stop();
  expect(stop).toHaveBeenCalledWith({ boxId: "bx_23456789" });
  expect(remove).toHaveBeenCalledWith({ boxId: "bx_23456789" });
});

test("Ascii Box stops readiness polling when creation times out", async () => {
  const { box } = await import("../../src/providers/box");
  provisioning = true;
  getCalls = 0;
  try {
    await expect(
      createSandbox({ provider: box({ apiKey: "box_test" }), timeout: 5 }),
    ).rejects.toThrow("Sandbox creation timed out after 5ms");
    const callsAfterTimeout = getCalls;
    await Bun.sleep(20);
    expect(getCalls).toBe(callsAfterTimeout);
    expect(remove).toHaveBeenCalledWith({ boxId: "bx_23456789" });
  } finally {
    provisioning = false;
  }
});

test("Ascii Box managed sessions archive, resume, and destroy", async () => {
  const { box } = await import("../../src/providers/box");
  const provider = box({ apiKey: "box_test" });
  const session = await provider.managed!.create({ sessionId: "box-session" });

  await session.stop();
  await session.resume();
  await session.destroy();

  expect(stop).toHaveBeenCalledWith({ boxId: "bx_23456789" });
  expect(resume).toHaveBeenCalledWith({ boxId: "bx_23456789" });
  expect(remove).toHaveBeenCalledWith({ boxId: "bx_23456789" });
});
