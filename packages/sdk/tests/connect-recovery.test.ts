import { describe, expect, test, vi } from "vitest";
import { connectSandbox, createSandbox, hasCapability } from "../src/index.js";
import { memory } from "../src/memory.js";
import type { ExecInput, Provider } from "../src/provider.js";
import { secretRecoveryCommand } from "../src/run.js";

/** A memory sandbox whose exec always fails, like a stopped Vercel sandbox. */
async function stopped() {
  const backing = memory();
  const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
  const destroy = vi.fn((id: string) => backing.destroy(id));

  const exec = vi.fn(async (_id: string, _input: ExecInput): Promise<never> => {
    throw new Error("sandbox is stopped");
  });

  const provider: Provider = {
    ...backing,
    exec,
    destroy,
    capabilities: new Set(["pause", "snapshot"]),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    snapshot: vi.fn(async () => ({ id: "snap" })),
    usage: vi.fn(async () => ({ cpuMs: 1 })),
  };

  return { provider, id: created.id, exec, destroy };
}

describe("connectSandbox secret recovery", () => {
  test("connect then destroy reaches provider.destroy when the recovery exec throws", async () => {
    const { provider, id, exec, destroy } = await stopped();
    await connectSandbox(provider, id).then((box) => box.destroy());
    expect(destroy).toHaveBeenCalledWith(id);
    expect(exec).not.toHaveBeenCalled();
  });

  test("lifecycle calls never run recovery; the first command does and names the escape hatch", async () => {
    const { provider, id, exec } = await stopped();
    const box = await connectSandbox(provider, id);

    if (!hasCapability(box, "pause") || !hasCapability(box, "snapshot"))
      throw new Error("stub capabilities missing");
    await box.pause();
    await box.resume();
    await box.snapshot();
    expect(await box.usage()).toMatchObject({ cpuMs: 1, commands: 0 });
    expect(exec).not.toHaveBeenCalled();
    await expect(box.run("true")).rejects.toMatchObject({ code: "provider" });
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]?.[1].command).toBe(secretRecoveryCommand);
    await box.close();
  });

  test("a failed recovery exit names recoverSecrets: false and is retried on the next call", async () => {
    const backing = memory();
    const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
    let failing = true;

    const provider: Provider = {
      ...backing,
      exec: (id, input) =>
        failing && input.command === secretRecoveryCommand
          ? Promise.resolve({ exitCode: 1, timedOut: false })
          : backing.exec(id, input),
    };

    const box = await connectSandbox(provider, created.id);
    await expect(box.run("printenv TOKEN")).rejects.toMatchObject({
      code: "provider",
      message: expect.stringContaining("recoverSecrets: false"),
    });
    failing = false;
    expect((await box.run("printenv TOKEN")).stdout).toBe("[REDACTED]\n");
    await box.destroy();
  });

  test("recoverSecrets: false skips the recovery exec entirely", async () => {
    const backing = memory();
    const created = await createSandbox(backing, { secrets: { TOKEN: "secret-value" } });
    const commands: string[] = [];

    const provider: Provider = {
      ...backing,
      exec: (id, input) => {
        commands.push(input.command);

        return backing.exec(id, input);
      },
    };

    const box = await connectSandbox(provider, created.id, { recoverSecrets: false });
    expect((await box.run("true")).ok).toBe(true);
    expect(commands).toEqual(["true"]);
    await box.destroy();
  });

  test("a process handle taken first still recovers before reading logs", async () => {
    const provider = memory();
    const created = await createSandbox(provider, { secrets: { TOKEN: "secret-value" } });
    await (await created.start("printenv TOKEN", { name: "env" })).wait();
    const box = await connectSandbox(provider, created.id);
    const handle = box.process("env");
    expect(box.process("env")).toBe(handle);
    expect((await handle.logs()).text).toBe("[REDACTED]\n");
    await box.destroy();
  });
});

describe("files.write mode", () => {
  const modeOf = (provider: ReturnType<typeof memory>, id: string, path: string) =>
    provider.native(id).files.get(path)?.mode;

  test("providers without native modes get one chmod for the whole write", async () => {
    const backing = memory();
    const commands: string[] = [];

    const provider: Provider = {
      ...backing,
      files: {
        ...backing.files,
        writeSupportsMode: false,
        write: (id, path, data) => backing.files.write(id, path, data),
      },
      exec: (id, input) => {
        commands.push(input.command);

        return backing.exec(id, input);
      },
    };

    const box = await createSandbox(provider);
    await box.files.write({ "a.txt": "a", "dir/it's.txt": "b" }, { mode: 0o600 });
    expect(commands).toEqual(["chmod 600 '/workspace/a.txt' '/workspace/dir/it'\\''s.txt'"]);
    expect(modeOf(backing, box.id, "/workspace/a.txt")).toBe(0o600);
    expect(modeOf(backing, box.id, "/workspace/dir/it's.txt")).toBe(0o600);
    await box.files.write("plain.txt", "c");
    expect(commands).toHaveLength(1);
    await box.destroy();
  });

  test("a failed chmod is an error, not a silent default", async () => {
    const backing = memory();

    const provider: Provider = {
      ...backing,
      files: { ...backing.files, writeSupportsMode: false },
      exec: async () => ({ exitCode: 1, timedOut: false }),
    };

    const box = await createSandbox(provider);
    await expect(box.files.write("a.txt", "a", { mode: 0o600 })).rejects.toMatchObject({
      code: "provider",
      message: expect.stringContaining("chmod exited with 1"),
    });
    await box.destroy();
  });

  test("native modes pass through without an exec", async () => {
    const backing = memory();
    const exec = vi.fn(backing.exec);
    const box = await createSandbox({ ...backing, exec });
    await box.files.write("secret", "x", { mode: 0o640 });
    expect(exec).not.toHaveBeenCalled();
    expect(modeOf(backing, box.id, "/workspace/secret")).toBe(0o640);
    await box.destroy();
  });

  test("invalid modes are rejected before anything is written", async () => {
    const provider = memory();
    const box = await createSandbox(provider);

    for (const mode of [-1, 0o10000, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      await expect(box.files.write({ bad: "x" }, { mode })).rejects.toMatchObject({
        code: "invalid_argument",
      });
    expect(await box.files.exists("bad")).toBe(false);
    await box.destroy();
  });
});

test("snapshot expiresInMs is validated before the provider is called", async () => {
  const backing = memory();
  const snapshot = vi.fn(async () => ({ id: "snap" }));
  const box = await createSandbox({ ...backing, capabilities: new Set(["snapshot"]), snapshot });

  if (!hasCapability(box, "snapshot")) throw new Error("stub capabilities missing");

  for (const expiresInMs of [-1, 1.5, Number.NaN])
    await expect(box.snapshot({ expiresInMs })).rejects.toMatchObject({ code: "invalid_argument" });
  expect(snapshot).not.toHaveBeenCalled();
  expect(await box.snapshot({ expiresInMs: 0 })).toEqual({ id: "snap" });
  expect(snapshot).toHaveBeenCalledWith(box.id, { expiresInMs: 0 });
  await box.destroy();
});
