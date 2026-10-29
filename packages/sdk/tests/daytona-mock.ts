/** SDK-shaped transport mock backed by isolated real Linux files and processes.
 * Session launch, streaming, PID/group cancellation and durable wrappers are real;
 * only Daytona's control plane is replaced. No cloud calls or credentials.
 */
import { createReadStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import type { DaytonaConfig, CreateSandboxFromImageParams, CreateSandboxFromSnapshotParams, Sandbox } from "@daytonaio/sdk";
import type { OutputChunk } from "../src/provider.js";
const missing = () => Object.assign(new Error("not found"), { statusCode: 404 });
type Params = CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams;
type Command = { chunks: OutputChunk[]; listeners: ((chunk: OutputChunk) => void)[]; done: Promise<void>; exitCode?: number; pid?: number };
export const mockState = { configs: [] as DaytonaConfig[], creates: [] as Params[], createOptions: [] as ({ timeout?: number } | undefined)[], permissions: [] as { path: string; mode?: string }[], boxes: new Map<string, MockSandbox>(), snapshots: new Map<string, string>(), launchDelayMs: 0, failStatus: false, failLogs: false };
export class MockSandbox {
  readonly id = crypto.randomUUID();
  readonly createdAt = new Date().toISOString();
  state: Sandbox["state"] = "started";
  labels: Record<string, string>;
  public = false;
  cpu = 1; memory = 1; disk = 3;
  private sessions = new Map<string, Map<string, Command>>();
  private constructor(readonly root: string, readonly params: Params, readonly port: number) { this.labels = params.labels ?? {}; }
  static async create(params: Params) {
    const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address(); if (!address || typeof address === "string") throw new Error("No test port");
    await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    const box = new MockSandbox(await fs.mkdtemp(join(tmpdir(), "sdk-daytona-")), params, address.port);
    if ("resources" in params) Object.assign(box, params.resources);
    box.public = params.public ?? false;
    if ("snapshot" in params && params.snapshot) {
      if (params.snapshot === "daytona-large") Object.assign(box, { cpu: 4, memory: 8, disk: 10 });
      else { const root = mockState.snapshots.get(params.snapshot); if (!root) throw missing();
      await fs.cp(root, box.root, { recursive: true }); }
    }
    mockState.boxes.set(box.id, box); return box;
  }
  private mapped = (path: string) => join(this.root, path);
  private rewrite = (text: string) => text.replace("base64.b64encode(data)", `base64.b64encode(data.replace(${JSON.stringify(this.root)}.encode(),b""))`).replace(/sudo -n install/g, "install").replace(/\/workspace|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g, path => this.mapped(path)).replace(/\.listen\(3000/g, `.listen(${this.port}`);
  private file = async (path: string) => {
    try { const s = await fs.lstat(this.mapped(path)); return { name: posix.basename(path), isDir: s.isDirectory(), size: s.size, modTime: s.mtime.toISOString(), modifiedAt: s.mtime.toISOString(), group: "test", owner: "test", permissions: "644", mode: s.isSymbolicLink() ? "Lrwxrwxrwx" : "-rw-r--r--" }; }
    catch { throw missing(); }
  };
  fs = {
    downloadFile: async (path: string) => { try { return await fs.readFile(this.mapped(path)); } catch { throw missing(); } },
    downloadFileStream: async (path: string, _options?: number | Parameters<Sandbox["fs"]["downloadFileStream"]>[1]) => createReadStream(this.mapped(path)),
    uploadFile: async (data: Buffer | string, path: string) => { await fs.mkdir(posix.dirname(this.mapped(path)), { recursive: true }); await fs.writeFile(this.mapped(path), typeof data === "string" ? await fs.readFile(data) : data); },
    createFolder: async (path: string, _mode: string) => { await fs.mkdir(this.mapped(path), { recursive: true }); },
    setFilePermissions: async (path: string, permissions: { mode?: string }) => { mockState.permissions.push({ path, mode: permissions.mode }); if (permissions.mode) await fs.chmod(this.mapped(path), Number.parseInt(permissions.mode, 8)); },
    getFileDetails: (path: string) => this.file(path),
    listFiles: async (path: string) => { try { return await Promise.all((await fs.readdir(this.mapped(path))).map(name => this.file(posix.join(path, name)))); } catch { throw missing(); } },
    deleteFile: async (path: string, recursive = false) => { try { await fs.rm(this.mapped(path), { recursive }); } catch { throw missing(); } },
  } satisfies Pick<Sandbox["fs"], "downloadFileStream" | "uploadFile" | "createFolder" | "setFilePermissions" | "getFileDetails" | "listFiles" | "deleteFile"> & { downloadFile(path: string): Promise<Buffer> };
  private run(command: string, cwd = "/", env: Record<string, string> = {}) {
    const chunks: OutputChunk[] = []; const listeners: ((chunk: OutputChunk) => void)[] = [];
    const child = spawn("sh", ["-c", this.rewrite(command)], { cwd: this.mapped(cwd), env: { ...process.env, ...this.params.envVars, ...Object.fromEntries(Object.entries(env).map(([key, value]) => [key, this.rewrite(value)])) }, stdio: ["ignore", "pipe", "pipe"] });
    const entry: Command = { chunks, listeners, pid: child.pid, done: Promise.resolve() };
    const emit = (stream: OutputChunk["stream"], data: Buffer) => { const chunk = { stream, text: data.toString().split(this.root).join("") }; chunks.push(chunk); for (const listener of listeners) listener(chunk); };
    child.stdout.on("data", data => emit("stdout", data)); child.stderr.on("data", data => emit("stderr", data));
    entry.done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => { entry.exitCode = code ?? 137; resolve(); }); });
    return entry;
  }
  process = {
    codeRun: async (code: string) => {
      const child = spawn("python3", ["-"], { cwd: this.root });
      let stdout = "";
      child.stdout.on("data", data => { stdout += data; });
      child.stdin.end(this.rewrite(code));
      const exitCode = await new Promise<number>((resolve, reject) => { child.on("error", reject); child.on("close", code => resolve(code ?? 137)); });
      return { exitCode, result: stdout, artifacts: { stdout } };
    },
    createSession: async (id: string) => { this.sessions.set(id, new Map()); },
    executeSessionCommand: async (id: string, request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean }) => {
      if (mockState.launchDelayMs) await new Promise(resolve => setTimeout(resolve, mockState.launchDelayMs));
      const commands = this.sessions.get(id); if (!commands) throw missing();
      const cmdId = crypto.randomUUID(); commands.set(cmdId, this.run(request.command)); return { cmdId };
    },
    getSessionCommand: async (id: string, cmdId: string) => { if (mockState.failStatus) throw Object.assign(new Error("unavailable"), { statusCode: 503 }); const entry = this.sessions.get(id)?.get(cmdId); if (!entry) throw missing(); return { id: cmdId, command: "", exitCode: entry.exitCode }; },
    getSessionCommandLogs: async (id: string, cmdId: string, stdout: (text: string) => void, stderr: (text: string) => void) => {
      const entry = this.sessions.get(id)?.get(cmdId); if (!entry) throw missing();
      if (mockState.failLogs) throw Object.assign(new Error("connection failed"), { statusCode: 503 });
      const emit = (chunk: OutputChunk) => chunk.stream === "stdout" ? stdout(chunk.text) : stderr(chunk.text);
      for (const chunk of entry.chunks) emit(chunk); entry.listeners.push(emit); await entry.done;
    },
    deleteSession: async (id: string) => { this.sessions.delete(id); },
    executeCommand: async (command: string, cwd?: string, env?: Record<string, string>, _timeout?: number) => { const entry = this.run(command, cwd, env); await entry.done; return { exitCode: entry.exitCode ?? 0, result: entry.chunks.map(chunk => chunk.text).join(""), artifacts: { stdout: entry.chunks.filter(c => c.stream === "stdout").map(c => c.text).join("") } }; },
  } satisfies Pick<Sandbox["process"], "createSession" | "executeSessionCommand" | "getSessionCommand" | "deleteSession" | "executeCommand" | "codeRun"> & { getSessionCommandLogs(session: string, command: string, stdout: (text: string) => void, stderr: (text: string) => void): Promise<void> };
  async stop() { this.state = "stopped"; }
  async start() { this.state = "started"; }
  async resize(resources: { cpu?: number; memory?: number; disk?: number }) { Object.assign(this, resources); }
  async delete(_timeout = 60, _wait = false) { if (!mockState.boxes.has(this.id)) throw missing(); mockState.boxes.delete(this.id); await fs.rm(this.root, { recursive: true, force: true }); }
  async createSnapshot(name: string) { const root = await fs.mkdtemp(join(tmpdir(), "sdk-daytona-snapshot-")); await fs.cp(this.root, root, { recursive: true }); mockState.snapshots.set(name, root); }
  async getPreviewLink(port: number) { return { url: `http://127.0.0.1:${this.port}/?port=${port}`, token: "mock-preview-token" }; }
}
export class MockDaytona {
  constructor(config: DaytonaConfig) { mockState.configs.push(config); }
  async create(params: Params = {}, options?: { timeout?: number }) { mockState.creates.push(params); mockState.createOptions.push(options); return MockSandbox.create(params); }
  async get(id: string) { const box = mockState.boxes.get(id); if (!box) throw missing(); return box; }
  async *list(query: { labels?: Record<string, string> } = {}) { for (const box of mockState.boxes.values()) if (Object.entries(query.labels ?? {}).every(([key, value]) => box.labels[key] === value)) yield box; }
}
export async function cleanupMock() {
  await Promise.all([...mockState.boxes.values()].map(box => box.delete()));
  await Promise.all([...mockState.snapshots.values()].map(root => fs.rm(root, { recursive: true, force: true })));
  mockState.snapshots.clear(); mockState.creates.length = 0; mockState.createOptions.length = 0; mockState.permissions.length = 0; mockState.configs.length = 0; mockState.launchDelayMs = 0; mockState.failLogs = false; mockState.failStatus = false;
}
