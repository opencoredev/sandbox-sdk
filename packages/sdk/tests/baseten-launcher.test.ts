import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { execute, type BasetenProcesses } from "../src/providers/baseten/execute.js";
import type { ExecInput } from "../src/provider.js";

// The real launcher, run by local python3 the way Baseten's process API runs it: one shell
// command, its stdout streamed back as output events, then its exit.
const local: BasetenProcesses = {
  async *execStream(request) {
    const child = spawn("sh", ["-c", request.command], {
      env: { ...process.env, ...request.env },
      cwd: request.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const exited = new Promise<number>((resolve) =>
      child.on("close", (code) => resolve(code ?? -1)),
    );

    request.callOptions?.signal?.addEventListener("abort", () => child.stdout.destroy());

    for await (const chunk of child.stdout)
      yield { type: "output", stream: "stdout", text: String(chunk) };

    if (request.callOptions?.signal?.aborted) throw new Error("aborted");

    yield { type: "exit", process: { exitCode: await exited } };
  },
  async exec(request) {
    const child = spawn("sh", ["-c", request.command], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";

    for await (const chunk of child.stdout) stdout += String(chunk);

    const exitCode = await new Promise<number>((resolve) =>
      child.on("close", (code) => resolve(code ?? -1)),
    );

    return { exitCode, stdout };
  },
};

async function run(command: string, extra: Partial<ExecInput> = {}) {
  const chunks: string[] = [];

  const result = await execute({
    processes: local,
    sandboxId: "local",
    input: {
      command,
      cwd: "/tmp",
      env: {},
      timeoutMs: 20_000,
      onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
      ...extra,
    },
    uploadSpec: async () => {
      throw new Error("not used");
    },
    removeSpec: async () => {},
  });

  return { ...result, chunks };
}

const records = async () =>
  (await readdir("/tmp/.sandbox-sdk").catch(() => [])).filter((name) => name.startsWith("exec-"));

describe.skipIf(process.platform !== "linux")("Baseten launcher, run locally", () => {
  test("exit codes, stdin and both streams", async () => {
    // Separate pipes may arrive in either order; each stream keeps its own order.
    const result = await run("printf A; printf B >&2; printf C; exit 5");
    expect(result).toMatchObject({ exitCode: 5, timedOut: false });

    const text = (stream: string) =>
      result.chunks
        .filter((chunk) => chunk.startsWith(`${stream}:`))
        .map((chunk) => chunk.slice(stream.length + 1))
        .join("");

    expect([text("stdout"), text("stderr")]).toEqual(["AC", "B"]);
    expect((await run("cat", { stdin: "piped" })).chunks).toEqual(["stdout:piped"]);
  });

  test("a launch that fails leaves no activity marker", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bt-launcher-"));
    const activityPath = join(dir, "activity", "exec-x");

    // No `sh` on the command's PATH: starting the process itself fails (OSError).
    const failed = await run("true", { env: { PATH: join(dir, "empty") }, activityPath });

    expect(failed).toMatchObject({ exitCode: 127 });
    expect(existsSync(activityPath)).toBe(false);
  });

  test("the deadline kills the whole group before its side effect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bt-launcher-"));

    expect(await run(`(sleep 2; touch ${dir}/late) & sleep 5`, { timeoutMs: 500 })).toMatchObject({
      exitCode: null,
      timedOut: true,
    });

    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(join(dir, "late"))).toBe(false);
  });

  test("an abort kills a redirected background child that outlived the shell", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bt-launcher-"));
    const controller = new AbortController();

    // The shell exits at once, so the launcher keeps the record for the live child.
    const started = run(`(sleep 2; touch ${dir}/late) >/dev/null 2>&1 & sleep 0.3`, {
      signal: controller.signal,
    });

    setTimeout(() => controller.abort(), 100);
    expect(await started).toMatchObject({ exitCode: null, timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(existsSync(join(dir, "late"))).toBe(false);
  });

  test("the next background command sweeps a kept record whose child has exited", async () => {
    const before = new Set(await records());
    const fresh = async () => (await records()).filter((name) => !before.has(name));
    await run("sleep 0.5 >/dev/null 2>&1 &");
    const first = await fresh();
    expect(first.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await run("sleep 5 >/dev/null 2>&1 &");
    const second = await fresh();
    expect(second.some((name) => first.includes(name))).toBe(false);
    expect(second.length).toBeGreaterThan(0);
  });
});
