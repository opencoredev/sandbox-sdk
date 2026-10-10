import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Machine } from "smolmachines";
import { createSandbox } from "../../src";
import { smol } from "../../src/providers/smol";
import { runConformance } from "../../src/testing";

test.skipIf(!Machine.localAvailability().available)(
  "Smol local VM runs the normalized sandbox contract",
  async () => {
    const results = await runConformance({
      create: {
        provider: smol({ target: "local", image: "mirror.gcr.io/library/node:22" }),
        timeout: 180_000,
      },
      commands: {
        success: "true",
        stdout: "printf stdout",
        stderr: "printf stderr >&2",
        nonzero: "exit 3",
        timeout: "sleep 2",
        background: "sleep 60",
        stdin: "cat",
      },
    });
    const failed = results.filter((result) => result.status === "failed");
    expect(failed).toEqual([]);
    expect(results.filter((result) => result.status === "passed").length).toBeGreaterThan(12);
  },
  300_000,
);

test.skipIf(!Machine.localAvailability().available)(
  "Smol local process emits output and exposes native checkpoint methods",
  async () => {
    const sandbox = await createSandbox({
      provider: smol({ target: "local", image: "mirror.gcr.io/library/node:22" }),
      env: { GREETING: "from-sandbox" },
      timeout: 180_000,
    });
    try {
      expect(typeof sandbox.raw.checkpoint).toBe("function");
      expect((await sandbox.run('printf "%s" "$GREETING"')).stdout).toBe("from-sandbox");
      const process = await sandbox.processes.start("printf 'live-stream\\n'");
      const output = [];
      for await (const event of process.output()) output.push(event.data);
      expect(output.join("")).toContain("live-stream");
      expect(await process.wait()).toEqual({ exitCode: 0 });
    } finally {
      await sandbox.stop();
    }
  },
  180_000,
);

test.skipIf(!Machine.localAvailability().available)(
  "Smol native checkpoint restores guest files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "sandbox-sdk-smol-"));
    const sandbox = await createSandbox({
      provider: smol({
        target: "local",
        image: "mirror.gcr.io/library/node:22",
        machine: { branchable: true },
      }),
      timeout: 180_000,
    });
    let restored: Machine | undefined;
    try {
      await sandbox.files.write("checkpoint.txt", "before");
      const artifact = join(root, "agent.smolcheckpoint");
      const info = await sandbox.raw.checkpoint(artifact);
      expect(info.sizeBytes).toBeGreaterThan(0);
      await sandbox.files.write("checkpoint.txt", "after");
      restored = await Machine.restoreCheckpoint(artifact, `sdk-smol-${crypto.randomUUID()}`, {
        target: "local",
        handleSignals: false,
      });
      expect((await restored.readFile("/workspace/checkpoint.txt")).toString()).toBe("before");
    } finally {
      try {
        await restored?.delete();
      } finally {
        try {
          await sandbox.stop();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }
    }
  },
  300_000,
);

test.skipIf(!Machine.localAvailability().available)(
  "Smol local published port serves a live guest process",
  async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    if (!address || typeof address === "string") throw new Error("No free host port");
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const sandbox = await createSandbox({
      provider: smol({
        target: "local",
        image: "mirror.gcr.io/library/node:22",
        machine: { ports: [{ host: address.port, guest: 3000 }] },
      }),
      timeout: 180_000,
    });
    try {
      const proc = await sandbox.processes.start(
        `node -e 'require("http").createServer((_,res)=>res.end("smol-port-ok")).listen(3000,"0.0.0.0")'`,
      );
      try {
        const exposed = await sandbox.ports.expose(3000);
        let response: Response | undefined;
        let lastError: unknown;
        for (let i = 0; i < 600; i++) {
          try {
            response = await exposed.request?.("/health");
            break;
          } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
        if (!response)
          throw new Error(`Published port ${exposed.url} did not respond: ${String(lastError)}`);
        expect(await response.text()).toBe("smol-port-ok");
      } finally {
        await proc.kill();
      }
    } finally {
      await sandbox.stop();
    }
  },
  180_000,
);

test.skipIf(!Machine.localAvailability().available)(
  "Smol Alpine lists files with BusyBox find and stat",
  async () => {
    const sandbox = await createSandbox({
      provider: smol({ target: "local", image: "alpine:3.22" }),
      timeout: 180_000,
    });
    try {
      await sandbox.files.write("name\n with spaces.txt", "hello");
      await sandbox.files.mkdir("nested");
      const entries = await sandbox.files.list();
      expect(entries).toContainEqual({
        name: "name\n with spaces.txt",
        path: "/workspace/name\n with spaces.txt",
        type: "file",
        size: 5,
      });
      expect(entries.find((entry) => entry.name === "nested")?.type).toBe("directory");
    } finally {
      await sandbox.stop();
    }
  },
  180_000,
);

test.skipIf(process.env.SMOL_TEST_CLOUD !== "1")(
  "Smol Cloud VM runs commands and preserves byte-exact files",
  async () => {
    const sandbox = await createSandbox({
      provider: smol({
        target: "cloud",
        image: "node:22-alpine",
        ttlSeconds: 600,
        resources: { cpus: 1, memoryMb: 1024, network: true },
      }),
      timeout: 180_000,
    });
    try {
      const bytes = new Uint8Array([0, 255, 1]);
      await sandbox.files.write("nested/odd name.bin", bytes);
      expect(await sandbox.files.read("nested/odd name.bin")).toEqual(bytes);
      expect(await sandbox.files.list("nested")).toContainEqual({
        name: "odd name.bin",
        path: "/workspace/nested/odd name.bin",
        type: "file",
        size: bytes.length,
      });
      expect((await sandbox.run("printf cloud-ok")).stdout).toBe("cloud-ok");
      await expect(sandbox.processes.start("sleep 60")).rejects.toMatchObject({
        code: "unsupported",
      });
    } finally {
      await sandbox.stop();
    }
  },
  240_000,
);
