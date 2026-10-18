/** Only the Tenki control plane/transport is mocked; commands and files run on Linux. */
import { promises as fs } from "node:fs";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type {
  ClientOptions,
  CreateOptions,
  ProcessRunOptions,
  ProcessRunResult,
  Session,
} from "@tenkicloud/sandbox";
const missing = () => Object.assign(new Error("missing"), { name: "SessionNotFoundError" });
const configs: ClientOptions[] = [];
const creates: CreateOptions[] = [];
export const tenkiState = {
  configs,
  creates,
  boxes: new Map<string, MockSession>(),
  snapshots: new Map<string, string>(),
  failReady: false,
  delayMs: 0,
  retainedPeakBytes: 0,
};
export class MockSession {
  readonly id = crypto.randomUUID();
  state: Session["state"] = "RUNNING";
  metadata: Record<string, string>;
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
  outboundEnabled: boolean;
  egress: Session["egress"];
  private constructor(
    readonly root: string,
    readonly params: CreateOptions,
    readonly port: number,
  ) {
    this.metadata = params.metadata ?? {};
    this.cpuCores = params.cpuCores ?? 2;
    this.memoryMb = params.memoryMb ?? 4096;
    this.diskSizeGb = params.diskSizeGb ?? 5;
    this.outboundEnabled = params.allowOutbound ?? true;
    this.egress = { allowDomains: params.allowDomains ?? [], allowCidrs: [] };
  }
  static async create(params: CreateOptions) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const value = new MockSession(
      await fs.mkdtemp(join(tmpdir(), "sdk-tenki-")),
      params,
      address.port,
    );
    if (params.snapshotId) {
      const root = tenkiState.snapshots.get(params.snapshotId);
      if (!root) throw missing();
      await promisify(execFile)("cp", ["-a", `${root}/.`, value.root]);
      await fs.rm(join(value.root, "tmp/.sandbox-sdk"), { recursive: true, force: true });
    }
    await fs.mkdir(join(value.root, "home/tenki"), { recursive: true });
    tenkiState.boxes.set(value.id, value);
    return value;
  }
  private rewrite = (text: string) =>
    text
      .replace(/\/workspace|\/home\/tenki|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g, (path) =>
        join(this.root, path),
      )
      .replace(/\.listen\(3000/g, `.listen(${this.port}`);
  run(argv: string[], options: ProcessRunOptions = {}) {
    const supervised = argv[0] === "python3" && argv[2]?.includes("subprocess.Popen");
    const args = supervised ? [...argv] : argv.map((arg) => this.rewrite(arg));
    // Normalize VM-local paths before encoding spool records, just as the mock
    // normalizes native stdout below. Production guests need no path mapping.
    if (supervised && args[2]) args[2] = args[2].replace(
      "base64.b64encode(data)",
      `base64.b64encode(data.replace(${JSON.stringify(this.root)}.encode(),b''))`,
    );
    // /tmp is private to each fake VM; prepare creates a symlink there.
    if (args[0] === "sh" && args[2]?.includes("mkdir -p"))
      args[2] = args[2].replace(" /tmp;", ` ${join(this.root, "tmp")};`);
    const command = args.shift();
    if (!command) throw new Error("Missing command");
    const child = spawn(command, args, {
      cwd: options.cwd ? this.rewrite(options.cwd) : this.root,
      env: { ...process.env, ...this.params.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let retainedBytes = 0;
    const retain = (bytes: number) => {
      retainedBytes += bytes;
      tenkiState.retainedPeakBytes = Math.max(tenkiState.retainedPeakBytes, retainedBytes);
    };
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stdout.on("data", (data: Buffer) => {
          const value = Buffer.from(data.toString().split(this.root).join(""));
          retain(value.length);
          out.push(value);
          controller.enqueue(value);
        });
        child.stdout.on("end", () => controller.close());
      },
    });
    const stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        child.stderr.on("data", (data: Buffer) => {
          retain(data.length);
          err.push(data);
          controller.enqueue(data);
        });
        child.stderr.on("end", () => controller.close());
      },
    });
    child.stdin.on("error", () => {});
    const input = options.stdin;
    if (input)
      void (async () => {
        if (supervised) {
          const chunks: Uint8Array[] = [];
          for await (const chunk of input) chunks.push(chunk);
          const data: unknown = JSON.parse(Buffer.concat(chunks).toString());
          if (!data || typeof data !== "object") throw new Error("Invalid spec");
          const mapped = Object.fromEntries(
            Object.entries(data).map(([key, value]) => [
              key,
              typeof value === "string" && key !== "stdin"
                ? this.rewrite(value)
                : key === "env" && value && typeof value === "object"
                  ? Object.fromEntries(
                      Object.entries(value).map(([k, v]) => [
                        k,
                        typeof v === "string" ? this.rewrite(v) : v,
                      ]),
                    )
                  : value,
            ]),
          );
          child.stdin.end(JSON.stringify(mapped));
        } else {
          for await (const chunk of input) child.stdin.write(chunk);
          child.stdin.end();
        }
      })();
    const result = new Promise<ProcessRunResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) =>
        resolve({ exitCode: code ?? 137, stdout: Buffer.concat(out), stderr: Buffer.concat(err) }),
      );
    });
    return Object.assign(result, {
      pid: Promise.resolve(child.pid ?? 0),
      stdout,
      stderr,
      stdin: Writable.toWeb(child.stdin),
      signal: async (signal: string) => {
        child.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL");
      },
      kill: async () => {
        child.kill("SIGKILL");
      },
    });
  }
  async waitReady(_timeout?: number, signal?: AbortSignal) {
    if (tenkiState.delayMs) await new Promise((resolve) => setTimeout(resolve, tenkiState.delayMs));
    if (tenkiState.failReady || signal?.aborted) throw new Error("readiness failed");
  }
  async pause() {
    this.state = "PAUSED";
    await fs.rm(join(this.root, "tmp/.sandbox-sdk"), { force: true });
  }
  async waitPaused() {}
  async resume() {
    this.state = "RUNNING";
  }
  async waitResumed() {}
  async close() {
    tenkiState.boxes.delete(this.id);
    await fs.rm(this.root, { recursive: true, force: true });
  }
  async exposePort(_port: number) {
    return {
      port: _port,
      previewUrl: `http://127.0.0.1:${this.port}`,
      expiresAt: new Date(Date.now() + 60000),
    };
  }
}
export class MockTenki {
  constructor(config: ClientOptions) {
    tenkiState.configs.push(config);
  }
  async create(params: CreateOptions = {}) {
    tenkiState.creates.push(params);
    return MockSession.create(params);
  }
  async get(id: string) {
    const value = tenkiState.boxes.get(id);
    if (!value) throw missing();
    return value;
  }
  async list() {
    return [...tenkiState.boxes.values()];
  }
  async createSnapshotAndWait(id: string) {
    const box = await this.get(id);
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-tenki-snapshot-"));
    await promisify(execFile)("cp", ["-a", `${box.root}/.`, root]);
    const snapshot = crypto.randomUUID();
    tenkiState.snapshots.set(snapshot, root);
    return { id: snapshot };
  }
}
export async function cleanupTenki() {
  await Promise.all([...tenkiState.boxes.values()].map((value) => value.close()));
  await Promise.all(
    [...tenkiState.snapshots.values()].map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  tenkiState.snapshots.clear();
  tenkiState.configs.length = 0;
  tenkiState.creates.length = 0;
  tenkiState.failReady = false;
  tenkiState.delayMs = 0;
  tenkiState.retainedPeakBytes = 0;
}
