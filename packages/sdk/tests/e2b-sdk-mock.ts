/** The E2B surface used by the adapter, backed by isolated Linux directories.
 * Native kill intentionally targets ONE pid, as envd does; adapter group kills
 * must stop descendants. Nonzero waits throw the real SDK CommandExitError.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createServer } from "node:net";
import type { SandboxOpts, SandboxInfo, CommandStartOpts, EntryInfo, CommandConnectOpts } from "e2b";
import { vi } from "vitest";
const { AuthenticationError, FileNotFoundError, SandboxNotFoundError, CommandExitError, FileType } = await vi.importActual<typeof import("e2b")>("e2b");

const machines = new Map<string, MockSandbox>();
const snapshots = new Map<string, string>();
export const calls: { template: string; options: SandboxOpts }[] = [];
export const listQueries: unknown[] = [];
export const nativeKills: number[] = [];
export const reconnects: number[] = [];
export let createDelayMs = 0;
let commandDelayMs = 0;
let launchGroupLeader = false;
export function makeLaunchGroupLeader(value: boolean) { launchGroupLeader = value; }
export function delayCommandStart(ms: number) { commandDelayMs = ms; }
export function delayCreation(ms: number) { createDelayMs = ms; }
export class MockSandbox {
  private processes = new Map<number, MockCommand>();
  private root: string;
  readonly sandboxId = crypto.randomUUID();
  private info: SandboxInfo;
  private timer?: ReturnType<typeof setTimeout>;
  private constructor(root: string, options: SandboxOpts, readonly port: number) {
    this.root = root;
    this.info = { sandboxId: this.sandboxId, templateId: options.template ?? "base", metadata: options.metadata ?? {}, startedAt: new Date(), endAt: new Date(Date.now() + (options.timeoutMs ?? 300_000)), state: "running", cpuCount: 2, memoryMB: 512, envdVersion: "0.5.0", allowInternetAccess: options.allowInternetAccess, network: { denyOut: Array.isArray(options.network?.denyOut) ? options.network.denyOut : undefined, allowOut: Array.isArray(options.network?.allowOut) ? options.network.allowOut : undefined } };
    this.environment = options.envs ?? {};
  }
  private environment: Record<string, string>;
  static async create(template: string, options: SandboxOpts = {}) {
    calls.push({ template, options });
    if (options.apiKey === "invalid") throw new AuthenticationError("secret-key-do-not-leak");
    if (createDelayMs) await new Promise(resolve => setTimeout(resolve, createDelayMs));
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No mock port");
    await new Promise<void>(resolve => server.close(() => resolve()));
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-e2b-"));
    await fs.mkdir(join(root, "tmp"));
    if (snapshots.has(template)) await fs.cp(snapshots.get(template) ?? "", root, { recursive: true });
    const box = new MockSandbox(root, options, address.port); machines.set(box.sandboxId, box);
    await box.setTimeout(options.timeoutMs ?? 300_000); return box;
  }
  static async getInfo(id: string) { return (await this.lookup(id)).getInfo(); }
  static async lookup(id: string) { const box = machines.get(id); if (!box) throw new SandboxNotFoundError("missing"); return box; }
  static async connect(id: string, options: { timeoutMs?: number } = {}) { const box = await this.lookup(id); box.info.state = "running"; if (options.timeoutMs) await box.setTimeout(options.timeoutMs); return box; }
  static list(options: { query?: { metadata?: Record<string, string> } } = {}) {
    listQueries.push(options);
    const found = [...machines.values()].filter(box => Object.entries(options.query?.metadata ?? {}).every(([key, value]) => box.info.metadata[key] === value));
    // Include an empty page followed by single-item pages to exercise pagination.
    let page = -1;
    return { get hasNext() { return page < found.length; }, async nextItems() { if (page++ === -1) return []; const box = found[page - 1]; return box ? [await box.getInfo()] : []; } };
  }
  static async kill(id: string) {
    const box = machines.get(id); if (!box) return false;
    machines.delete(id); clearTimeout(box.timer);
    // Recover session leaders from adapter marker records, even after disconnect.
    try { for (const file of await fs.readdir(join(box.root, "tmp"))) if (file.startsWith(".sandbox-sdk-e2b-")) { const pid = Number(await fs.readFile(join(box.root, "tmp", file), "utf8")); try { process.kill(-pid, "SIGKILL"); } catch {} } } catch {}
    for (const command of box.processes.values()) { await command.kill(); for (const group of command.groups) { try { process.kill(-group, "SIGKILL"); } catch {} } }
    await fs.rm(box.root, { recursive: true, force: true }); return true;
  }
  static async pause(id: string) { const box = await this.lookup(id); box.info.state = "paused"; clearTimeout(box.timer); return true; }
  async getInfo() { return { ...this.info, metadata: { ...this.info.metadata } }; }
  async setTimeout(ms: number) { clearTimeout(this.timer); this.info.endAt = new Date(Date.now() + ms); this.timer = setTimeout(() => { void MockSandbox.kill(this.sandboxId); }, ms); this.timer.unref(); }
  getHost(port: number) { return `${port}-${this.sandboxId}.e2b.test`; }
  async createSnapshot() { const id = crypto.randomUUID(); const path = await fs.mkdtemp(join(tmpdir(), "sdk-e2b-snapshot-")); await fs.cp(this.root, path, { recursive: true }); snapshots.set(id, path); return { snapshotId: id, names: [] }; }
  mapped = (path: string) => join(this.root, path);
  rewrite = (command: string) => command.replace(/\/workspace|\/tmp\/\.sandbox-sdk[^\s'";)]*|\/tmp\/sdk-bare/g, path => this.mapped(path)).replace(/\.listen\(3000,/g, `.listen(${this.port},`);
  files = {
    read: async (path: string, options: { format?: string } = {}) => { try { const data = await fs.readFile(this.mapped(path)); return options.format === "bytes" ? new Uint8Array(data) : data.toString(); } catch { throw new FileNotFoundError("missing file"); } },
    write: async (path: string, data: ArrayBuffer) => { await fs.mkdir(posix.dirname(this.mapped(path)), { recursive: true }); await fs.writeFile(this.mapped(path), new Uint8Array(data)); },
    makeDir: async (path: string) => { await fs.mkdir(this.mapped(path), { recursive: true }); },
    remove: async (path: string, options: { user?: string } = {}) => {
      if (path.startsWith("/tmp/.sandbox-sdk-e2b-") && options.user !== "root") throw new Error("Root-owned marker requires root in sticky /tmp");
      // Before deleting a PID marker preserve its value for sandbox-wide cleanup.
      if (path.startsWith("/tmp/.sandbox-sdk-e2b-")) { const pid = Number(await fs.readFile(this.mapped(path), "utf8")); for (const command of this.processes.values()) command.groups.add(pid); }
      await fs.rm(this.mapped(path), { recursive: true });
    },
    getInfo: async (path: string): Promise<EntryInfo> => {
      try { const stat = await fs.lstat(this.mapped(path)); return { path, name: posix.basename(path), type: stat.isDirectory() ? FileType.DIR : stat.isSymbolicLink() ? FileType.SYMLINK : FileType.FILE, size: stat.size, modifiedTime: stat.mtime, mode: stat.mode, permissions: "rwx", owner: "root", group: "root" }; }
      catch { throw new FileNotFoundError("missing file"); }
    },
    list: async (path: string) => Promise.all((await fs.readdir(this.mapped(path))).map(name => this.files.getInfo(posix.join(path, name)))),
  };
  commands = {
    run: async (command: string, options: CommandStartOpts = {}) => {
      const env = { ...process.env, ...this.environment, ...options.envs };
      if (env.GIT_INDEX_FILE) env.GIT_INDEX_FILE = this.rewrite(env.GIT_INDEX_FILE);
      if (env.BASH_ENV) env.BASH_ENV = this.rewrite(env.BASH_ENV);
      const child = spawn("/bin/bash", ["-l", "-c", this.rewrite(command)], { cwd: this.mapped(options.cwd ?? "/"), env, detached: launchGroupLeader, stdio: ["pipe", "pipe", "pipe"] });
      const handle = new MockCommand(child, options, this.root); this.processes.set(handle.pid, handle);
      if (commandDelayMs) await new Promise(resolve => setTimeout(resolve, commandDelayMs));
      return options.background ? handle : handle.wait();
    },
    connect: async (pid: number, _options?: CommandConnectOpts) => { const handle = this.processes.get(pid); if (!handle) throw new SandboxNotFoundError("missing command"); reconnects.push(pid); return { wait: () => handle.finished() }; },
  };
}
class MockCommand {
  readonly pid: number;
  readonly groups = new Set<number>();
  private result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
  private disconnected = false;
  private rejectDisconnect = (_error: Error) => {};
  private disconnection = new Promise<never>((_, reject) => { this.rejectDisconnect = reject; });
  get exitCode() { return this.completedCode; }
  private completedCode?: number;
  constructor(private child: ChildProcess, options: CommandStartOpts, root: string) {
    if (!child.pid) throw new Error("Mock command did not start"); this.pid = child.pid; this.groups.add(child.pid);
    let stdout = "", stderr = "";
    this.result = new Promise((resolve, reject) => {
      child.stdout?.on("data", data => { const text = data.toString().split(root).join(""); stdout += text; if (!this.disconnected) void options.onStdout?.(text); });
      child.stderr?.on("data", data => { const text = data.toString().split(root).join(""); stderr += text; if (!this.disconnected) void options.onStderr?.(text); });
      child.on("error", reject);
      child.on("close", (code, signal) => { const result = { exitCode: code ?? (signal === "SIGTERM" ? 143 : 137), stdout, stderr }; this.completedCode = result.exitCode; if (result.exitCode) reject(new CommandExitError(result)); else resolve(result); });
    });
    void this.result.catch(() => {});
    void this.disconnection.catch(() => {});
    child.stdin?.on("error", () => {}); if (!options.stdin) child.stdin?.end();
  }
  wait() { return Promise.race([this.result, this.disconnection]); }
  finished() { return this.result; }
  async kill() { nativeKills.push(this.pid); return this.child.kill("SIGKILL"); }
  async disconnect() { this.disconnected = true; this.rejectDisconnect(new Error("E2B command disconnected")); }
  async sendStdin(data: string) { this.child.stdin?.write(data); }
  async closeStdin() { this.child.stdin?.end(); }
}
export async function cleanupMock() { await Promise.all([...machines.keys()].map(id => MockSandbox.kill(id))); for (const path of snapshots.values()) await fs.rm(path, { recursive: true, force: true }); snapshots.clear(); }
export function mockFetch(original: typeof fetch): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const match = /^3000-(.+)\.e2b\.test$/.exec(url.hostname);
    if (!match?.[1]) return original(input, init);
    const box = await MockSandbox.lookup(match[1]); return original(`http://127.0.0.1:${box.port}${url.pathname}`, init);
  };
}
