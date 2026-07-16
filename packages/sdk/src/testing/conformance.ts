import { createSandbox, type CreateSandboxOptions } from "../core/sandbox";
import { supports } from "../core/capabilities";
import type { SandboxProvider } from "../core/provider";

export const conformanceCases = [
  "create and stop",
  "idempotent stop",
  "text files",
  "binary files",
  "directories",
  "relative paths",
  "invalid paths",
  "successful command",
  "stdout",
  "stderr",
  "nonzero exit",
  "timeout",
  "background process",
  "stdin",
  "ports",
  "snapshot create",
  "snapshot delete",
  "snapshot restore",
  "cleanup after failure",
] as const;

export interface ConformanceSubject<TProvider extends SandboxProvider<unknown>> {
  create: CreateSandboxOptions<TProvider>;
  commands: {
    success: string;
    stdout: string;
    stderr: string;
    nonzero: string;
    timeout: string;
    background: string;
    stdin: string;
  };
}

export interface ConformanceResult {
  name: (typeof conformanceCases)[number];
  status: "passed" | "failed" | "skipped";
  error?: unknown;
}

export async function runConformance<TProvider extends SandboxProvider<unknown>>(
  subject: ConformanceSubject<TProvider>,
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const check = async (name: ConformanceResult["name"], test: () => Promise<void>) => {
    try {
      await test();
      results.push({ name, status: "passed" });
    } catch (error) {
      results.push({ name, status: "failed", error });
    }
  };
  await check("create and stop", async () => {
    const sandbox = await createSandbox(subject.create);
    await sandbox.stop();
  });
  await check("idempotent stop", async () => {
    const sandbox = await createSandbox(subject.create);
    await sandbox.stop();
    await sandbox.stop();
  });
  const sandbox = await createSandbox(subject.create);
  try {
    await check("text files", async () => {
      await sandbox.files.write("text.txt", "hello");
      if ((await sandbox.files.text("text.txt")) !== "hello") throw new Error("text mismatch");
    });
    await check("binary files", async () => {
      const expected = new Uint8Array([0, 1, 2, 255]);
      await sandbox.files.write("binary.bin", expected);
      const actual = await sandbox.files.read("binary.bin");
      if (!actual.every((value, index) => value === expected[index]))
        throw new Error("binary mismatch");
    });
    await check("directories", async () => {
      await sandbox.files.mkdir("nested");
      await sandbox.files.write("nested/item.txt", "item");
      if (!(await sandbox.files.list("nested")).some((entry) => entry.name === "item.txt"))
        throw new Error("list mismatch");
      await sandbox.files.remove("nested");
    });
    await check("relative paths", async () => {
      await sandbox.files.write("relative.txt", "yes");
      if (!(await sandbox.files.exists("relative.txt")))
        throw new Error("relative path not resolved");
    });
    await check("invalid paths", async () => {
      try {
        await sandbox.files.read("../escape");
      } catch {
        return;
      }
      throw new Error("path traversal accepted");
    });
    await check("successful command", async () => {
      if (!(await sandbox.run(subject.commands.success)).success) throw new Error("command failed");
    });
    await check("stdout", async () => {
      if (!(await sandbox.run(subject.commands.stdout)).stdout.includes("stdout"))
        throw new Error("stdout missing");
    });
    await check("stderr", async () => {
      const result = await sandbox.run(subject.commands.stderr);
      const output =
        sandbox.capabilities["process.run"] === "combined-stream"
          ? `${result.stdout}${result.stderr}`
          : result.stderr;
      if (!output.includes("stderr")) throw new Error("stderr missing");
    });
    await check("nonzero exit", async () => {
      if ((await sandbox.run(subject.commands.nonzero)).exitCode === 0)
        throw new Error("expected nonzero exit");
    });
    await check("timeout", async () => {
      try {
        await sandbox.run(subject.commands.timeout, { timeout: 20 });
      } catch {
        return;
      }
      throw new Error("timeout not enforced");
    });
    if (supports(sandbox, "process.background"))
      await check("background process", async () => {
        const process = await sandbox.processes.start(subject.commands.background);
        await process.kill();
      });
    else results.push({ name: "background process", status: "skipped" });
    if (supports(sandbox, "process.stdin"))
      await check("stdin", async () => {
        const process = await sandbox.processes.start(subject.commands.stdin);
        await process.write("received\n");
        for await (const event of process.output()) {
          const data =
            typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
          if (data.includes("received")) return;
        }
        throw new Error("stdin output missing");
      });
    else results.push({ name: "stdin", status: "skipped" });
    if (supports(sandbox, "ports.expose"))
      await check("ports", async () => {
        const port = await sandbox.ports.expose(30_00);
        if (port.port !== 3000 || !port.url) throw new Error("invalid exposed port");
      });
    else results.push({ name: "ports", status: "skipped" });
    let createdSnapshot: Awaited<ReturnType<typeof sandbox.snapshots.create>> | undefined;
    if (supports(sandbox, "snapshot.create"))
      await check("snapshot create", async () => {
        await sandbox.files.write("snapshot.txt", "before");
        createdSnapshot = await sandbox.snapshots.create({ name: "conformance" });
      });
    else results.push({ name: "snapshot create", status: "skipped" });
    if (createdSnapshot && supports(sandbox, "snapshot.restore"))
      await check("snapshot restore", async () => {
        await sandbox.files.write("snapshot.txt", "after");
        await sandbox.snapshots.restore(createdSnapshot!);
        if ((await sandbox.files.text("snapshot.txt")) !== "before")
          throw new Error("snapshot not restored");
      });
    else results.push({ name: "snapshot restore", status: "skipped" });
    if (createdSnapshot && supports(sandbox, "snapshot.delete"))
      await check("snapshot delete", async () => {
        await sandbox.snapshots.delete(createdSnapshot!);
      });
    else results.push({ name: "snapshot delete", status: "skipped" });
  } finally {
    await sandbox.stop();
  }
  await check("cleanup after failure", async () => {
    const temporary = await createSandbox(subject.create);
    try {
      throw new Error("expected");
    } catch {
      /* expected */
    } finally {
      await temporary.stop();
    }
  });
  return results;
}
