import { expect, test } from "bun:test";
import { createSandbox } from "../../src";
import { createos } from "../../src/providers/createos";

const hasKeys = Boolean(
  process.env.CREATEOS_SANDBOX_API_KEY && process.env.CREATEOS_SANDBOX_BASE_URL,
);

test.skipIf(!hasKeys)(
  "CreateOS live: run command",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      expect((await sandbox.run("printf live-createos")).stdout).toContain("live-createos");
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: file operations",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      await sandbox.files.write("/tmp/test.txt", "hello createos");
      expect(await sandbox.files.text("/tmp/test.txt")).toBe("hello createos");
      expect(await sandbox.files.exists("/tmp/test.txt")).toBe(true);
      expect(await sandbox.files.exists("/tmp/nonexistent-file")).toBe(false);

      const entries = await sandbox.files.list("/tmp");
      expect(entries.some((e) => e.name === "test.txt")).toBe(true);

      await sandbox.files.mkdir("/tmp/testdir");
      expect(await sandbox.files.exists("/tmp/testdir")).toBe(true);

      await sandbox.files.remove("/tmp/test.txt");
      expect(await sandbox.files.exists("/tmp/test.txt")).toBe(false);
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: process execution with exit code",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      const result = await sandbox.run("printf out; printf err >&2; exit 7");
      expect(result).toMatchObject({ stdout: "out", stderr: "err", exitCode: 7, success: false });
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: background process streaming",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      const proc = await sandbox.processes.start("printf streamed");
      const events: { stream: string; data: unknown }[] = [];
      for await (const event of proc.output()) events.push(event);
      expect(events.some((e) => e.stream === "stdout" && String(e.data).includes("streamed"))).toBe(true);
      expect(await proc.wait()).toEqual({ exitCode: 0 });
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: port exposure",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000, ingressEnabled: true }),
      timeout: 120_000,
    });
    try {
      const port = await sandbox.ports.expose(8080);
      expect(port).toMatchObject({ port: 8080, authenticated: true });
      expect(port.url).toContain("8080");
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: snapshots unsupported",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      await expect(sandbox.snapshots.create()).rejects.toMatchObject({ code: "unsupported" });
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: pause and resume via raw handle",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      expect((await sandbox.run("printf before-pause")).stdout).toContain("before-pause");

      await sandbox.raw.pause();
      await sandbox.raw.waitUntilPaused({ timeoutMs: 60_000 });
      expect(sandbox.raw.status).toBe("paused");

      await sandbox.raw.resume();
      await sandbox.raw.waitUntilRunning({ timeoutMs: 60_000 });
      expect(sandbox.raw.status).toBe("running");

      expect((await sandbox.run("printf after-resume")).stdout).toContain("after-resume");
    } finally {
      await sandbox.stop();
    }
  },
  300_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: create with custom options",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({
        timeout: 120_000,
        shape: "s-1vcpu-256mb",
        ingressEnabled: true,
        envs: { MY_VAR: "hello-from-createos" },
      }),
      timeout: 120_000,
    });
    try {
      expect(sandbox.raw.data.shape).toBe("s-1vcpu-256mb");
      expect(sandbox.raw.data.vcpu).toBe(1);
      expect(sandbox.raw.data.mem_mib).toBe(256);
      expect((await sandbox.run("printenv MY_VAR")).stdout.trim()).toBe("hello-from-createos");
      expect(sandbox.raw.data.ingress_enabled).toBe(true);
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: fork a paused sandbox",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    let forked;
    try {
      await sandbox.files.write("/tmp/fork-test.txt", "fork-data");
      expect(await sandbox.files.text("/tmp/fork-test.txt")).toBe("fork-data");

      await sandbox.raw.pause();
      await sandbox.raw.waitUntilPaused({ timeoutMs: 60_000 });

      forked = await sandbox.raw.fork();
      await forked.waitUntilRunning({ timeoutMs: 60_000 });
      expect(forked.id).not.toBe(sandbox.raw.id);

      const forkResult = await forked.runCommand("cat", ["/tmp/fork-test.txt"]);
      expect(forkResult.result.stdout).toBe("fork-data");
    } finally {
      if (forked) await forked.destroy().catch(() => {});
      await sandbox.raw.resume().catch(() => {});
      await sandbox.stop();
    }
  },
  300_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: per-command cwd and env",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      await sandbox.files.mkdir("/tmp/mydir");
      expect((await sandbox.run("pwd", { cwd: "/tmp/mydir" })).stdout.trim()).toBe("/tmp/mydir");
      expect((await sandbox.run("printenv CUSTOM_VAR", { env: { CUSTOM_VAR: "per-command" } })).stdout.trim()).toBe("per-command");
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);

test.skipIf(!hasKeys)(
  "CreateOS live: stdin throws unsupported",
  async () => {
    const sandbox = await createSandbox({
      provider: createos({ timeout: 120_000 }),
      timeout: 120_000,
    });
    try {
      const proc = await sandbox.processes.start("cat");
      await expect(proc.write("hello")).rejects.toMatchObject({ code: "unsupported", provider: "createos" });
    } finally {
      await sandbox.stop();
    }
  },
  150_000,
);
