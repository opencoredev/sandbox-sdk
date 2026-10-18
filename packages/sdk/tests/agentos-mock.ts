import { spawn } from "node:child_process";
import { lstatSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentOs, AgentOsOptions, CodeExecutionResult } from "@rivet-dev/agentos-core";

export const creates: AgentOsOptions[] = [];
export const installs: unknown[] = [];
export class MockAgentOs {
  private constructor(private root: string, private options: AgentOsOptions) {}
  static async create(options: AgentOsOptions = {}) {
    creates.push(options);
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-agentos-"));
    await fs.mkdir(join(root, "tmp"));
    return new MockAgentOs(root, options);
  }
  private mapped(path: string) { return join(this.root, path); }
  private rewrite(value: string) { return value.replace(/\/workspace|\/tmp\/\.sandbox-sdk[^\s'";)]*|\/tmp\/sdk-bare/g, path => this.mapped(path)); }
  readonly software = { install: async (source: unknown) => { installs.push(source); } };
  readonly filesystem = {
    readFile: async (path: string) => new Uint8Array(await fs.readFile(this.mapped(path))),
    writeFile: async (path: string, data: string | Uint8Array) => { await fs.writeFile(this.mapped(path), data); },
    mkdir: async (path: string, options: { recursive?: boolean } = {}) => { await fs.mkdir(this.mapped(path), options); },
    readdir: async (path: string) => fs.readdir(this.mapped(path)),
    readdirEntries: async (path: string) => (await fs.readdir(this.mapped(path), { withFileTypes: true })).map(item => ({ name: item.name, isDirectory: item.isDirectory(), isSymbolicLink: item.isSymbolicLink() })),
    stat: async (path: string) => { const stat = await fs.stat(this.mapped(path)); return { size: stat.size, mtimeMs: stat.mtimeMs, isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink() }; },
    remove: async (path: string, options: { recursive?: boolean } = {}) => { await fs.rm(this.mapped(path), options); },
  };
  readonly javascript = {
    evaluate: async (expression: string) => ({ outcome: "succeeded", value: new Function("require", `return ${expression}`)((name: string) => {
      if (name !== "node:fs") throw new Error("Unexpected mock module");
      return { lstatSync: (path: string) => lstatSync(this.mapped(path)) };
    }) }),
  };
  readonly process = {
    exec: async (command: string, options: Parameters<AgentOs["process"]["exec"]>[1] = {}): Promise<CodeExecutionResult> => {
      const env = { ...process.env, ...this.options.environment, ...options.env };
      if (env.GIT_INDEX_FILE) env.GIT_INDEX_FILE = this.rewrite(env.GIT_INDEX_FILE);
      const child = spawn("/bin/sh", ["-c", this.rewrite(command)], { cwd: this.mapped(options.cwd ?? "/workspace"), env, detached: true, stdio: "pipe" });
      child.stdout.on("data", data => options.onStdout?.(Buffer.from(data.toString().split(this.mapped("/workspace")).join("/workspace"))));
      child.stderr.on("data", data => options.onStderr?.(data));
      child.stdin.on("error", () => {}); child.stdin.end(options.stdin ?? "");
      let outcome: "timed_out" | "cancelled" | undefined;
      const kill = () => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } };
      const abort = () => { outcome = "cancelled"; kill(); };
      const timer = setTimeout(() => { outcome = "timed_out"; kill(); }, options.timeoutMs ?? 120000);
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        const exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code ?? 137)); });
        if (outcome || exitCode !== 0) return { outcome: outcome ?? "failed", exitCode, error: { code: "execution_failed", name: "ExecutionError", message: "Command failed" } };
        return { outcome: "succeeded", exitCode };
      } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
    },
  };
  async dispose() { await fs.rm(this.root, { recursive: true, force: true }); }
}
