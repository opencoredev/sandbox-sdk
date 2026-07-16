import { describe, expect, test } from "bun:test";
import { createSandbox, SandboxError, withSandbox } from "../../src";
import { local } from "../../src/providers/local";

async function sandbox() {
  return createSandbox({ provider: local(), cwd: "/workspace" });
}

describe("Local provider", () => {
  test("is powered by an isolated AgentOS VM", async () => {
    const instance = await sandbox();
    try {
      expect(instance.provider).toBe("local");
      expect(instance.raw.vm).toBeDefined();

      await instance.files.write("hello.txt", "hello");
      await instance.files.write("bytes.bin", new Uint8Array([0, 1, 255]));
      expect(await instance.files.text("hello.txt")).toBe("hello");
      expect([...(await instance.files.read("bytes.bin"))]).toEqual([0, 1, 255]);
    } finally {
      await instance.stop();
    }
  });

  test("executes shell strings and direct AgentOS commands", async () => {
    const instance = await sandbox();
    try {
      const shell = await instance.run("printf out; printf err >&2; exit 7");
      expect(shell).toMatchObject({ stdout: "outerr", exitCode: 7, success: false });

      const argument = "$HOME;echo unsafe";
      const direct = await instance.run({
        command: "node",
        args: ["-e", "process.stdout.write(process.argv[1])", argument],
      });
      expect(direct.stdout).toBe(argument);
    } finally {
      await instance.stop();
    }
  });

  test("times out commands", async () => {
    const instance = await sandbox();
    try {
      await expect(instance.run("sleep 2", { timeout: 20 })).rejects.toMatchObject({
        code: "timeout",
        provider: "local",
      });
    } finally {
      await instance.stop();
    }
  });

  test("streams background output and accepts stdin", async () => {
    const instance = await sandbox();
    try {
      const processHandle = await instance.processes.start({
        command: "node",
        args: [
          "-e",
          "process.stdin.once('data', d => { console.log(d.toString().trim()); process.exit(0) })",
        ],
      });
      await processHandle.write("hello\n");
      const output: string[] = [];
      for await (const event of processHandle.output())
        output.push(
          typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data),
        );
      expect(output.join("")).toContain("hello");
    } finally {
      await instance.stop();
    }
  });

  test("creates, restores, and deletes filesystem snapshots", async () => {
    const instance = await sandbox();
    try {
      await instance.files.write("state.txt", "one");
      const snapshot = await instance.snapshots.create({ name: "one" });
      await instance.files.write("state.txt", "two");
      await instance.snapshots.restore(snapshot);
      expect(await instance.files.text("state.txt")).toBe("one");
      await instance.snapshots.delete(snapshot);
    } finally {
      await instance.stop();
    }
  });

  test("rejects traversal and outbound networking by default", async () => {
    const instance = await sandbox();
    try {
      await expect(instance.files.read("../outside")).rejects.toBeInstanceOf(SandboxError);
      const outbound = await instance.run({
        command: "node",
        args: ["-e", 'fetch("https://example.com")'],
      });
      expect(outbound.success).toBe(false);
    } finally {
      await instance.stop();
    }
  });

  test("suspends and resumes the VM without losing files", async () => {
    const instance = await sandbox();
    try {
      await instance.files.write("state.txt", "one");
      await instance.raw.suspend();
      await expect(instance.files.text("state.txt")).rejects.toMatchObject({
        code: "terminated",
      });
      await instance.raw.resume();
      expect(await instance.files.text("state.txt")).toBe("one");
    } finally {
      await instance.stop();
    }
  });

  test("withSandbox preserves callback errors", async () => {
    const error = new Error("callback");
    await expect(
      withSandbox({ provider: local() }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });
});
