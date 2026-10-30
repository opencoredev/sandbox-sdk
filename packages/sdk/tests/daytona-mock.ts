/** Daytona's control plane and toolbox as a local HTTP server, backed by isolated real Linux files and
 * processes. Session launch, log streaming, PID/group cancellation and durable wrappers are real; the
 * adapter talks to it over HTTP exactly as to Daytona. No cloud calls or credentials.
 *
 * Importing this module starts one server for the test file and points DAYTONA_API_URL at it. Each route
 * calls a method on the sandbox's MockSandbox (`guest(id).fs.listFiles`, `guest(id).process.executeCommand`),
 * so tests replace one guest operation with `vi.spyOn`, as they would a native SDK method.
 */
import type { JsonValue } from "../src/shared/json.js";
import { isNumber, isObject, isString } from "../src/shared/narrow.js";
import { createReadStream, promises as fs } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { afterAll } from "vitest";
import type { OutputChunk } from "../src/provider.js";
import { fakeServer, type RecordedRequest } from "./http-fake.js";
import { daytonaHttp } from "../src/providers/daytona/api.js";

/** An error a guest operation throws; the server answers with its status, code and headers. */
export type NativeFailure = Error & {
  statusCode: number;
  code?: string;
  headers?: Record<string, string>;
};

export const failure = (
  statusCode: number,
  message: string,
  extra: { code?: string; headers?: Record<string, string> } = {},
): NativeFailure => Object.assign(new Error(message), { statusCode, ...extra });

const missing = () => failure(404, "not found", { code: "FILE_NOT_FOUND" });

export interface CreateBody {
  snapshot?: string;
  buildInfo?: { dockerfileContent: string };
  env?: Record<string, string>;
  labels?: Record<string, string>;
  public?: boolean;
  target?: string;
  cpu?: number;
  memory?: number;
  disk?: number;
  networkBlockAll?: boolean;
  domainAllowList?: string;
  autoStopInterval?: number;
  autoPauseInterval?: number;
  autoArchiveInterval?: number;
  autoDeleteInterval?: number;
  ttlMinutes?: number;
  volumes?: unknown[];
  outboundProxyUrl?: string;
}

type Command = {
  chunks: OutputChunk[];
  listeners: ((chunk: OutputChunk) => void)[];
  done: Promise<void>;
  exitCode?: number;
  pid?: number;
};

export const mockState = {
  // SAFETY: an empty start value, typed for what the tests store in it later.
  creates: [] as CreateBody[],
  // SAFETY: an empty start value, typed for what the tests store in it later.
  permissions: [] as { path: string; mode?: string }[],
  boxes: new Map<string, MockSandbox>(),
  snapshots: new Map<string, string>(),
  launchDelayMs: 0,
  failStatus: false,
  failLogs: false,
  /** State a new sandbox reports; anything but "started" makes the adapter poll. */
  createState: "started",
  /** Polls a sandbox reports `creating` before `started`. */
  startPolls: 0,
  /** How long a snapshot stays `snapshotting`, in ms. */
  snapshotMs: 0,
  /** Sandboxes per list page. */
  pageSize: 100,
  /** How long a deleted sandbox stays `destroying`, in ms. */
  deleteDelayMs: 0,
};

export class MockSandbox {
  readonly id = crypto.randomUUID();
  readonly createdAt = new Date().toISOString();
  state = "started";
  labels: Record<string, string>;
  public = false;
  cpu = 1;
  memory = 1;
  disk = 3;
  pollsUntilStarted = 0;
  private sessions = new Map<string, Map<string, Command>>();
  private constructor(
    readonly root: string,
    readonly params: CreateBody,
    readonly port: number,
  ) {
    this.labels = params.labels ?? {};
  }
  static async create(params: CreateBody) {
    const socket = createServer();
    await new Promise<void>((resolve) => socket.listen(0, "127.0.0.1", resolve));
    const address = socket.address();

    if (!address || isString(address)) throw new Error("No test port");
    await new Promise<void>((resolve, reject) =>
      socket.close((error) => (error ? reject(error) : resolve())),
    );

    const box = new MockSandbox(
      await fs.mkdtemp(join(tmpdir(), "sdk-daytona-")),
      params,
      address.port,
    );

    if (params.buildInfo)
      Object.assign(box, {
        cpu: params.cpu ?? 1,
        memory: params.memory ?? 1,
        disk: params.disk ?? 3,
      });
    box.public = params.public ?? false;

    if (params.snapshot) {
      if (params.snapshot === "daytona-large") Object.assign(box, { cpu: 4, memory: 8, disk: 10 });
      else {
        const root = mockState.snapshots.get(params.snapshot);

        if (!root) throw failure(404, "snapshot not found");
        await fs.cp(root, box.root, { recursive: true });
      }
    }

    mockState.boxes.set(box.id, box);

    return box;
  }
  private mapped = (path: string) => join(this.root, path);
  private rewrite = (text: string) =>
    text
      .replace(
        "base64.b64encode(data)",
        `base64.b64encode(data.replace(${JSON.stringify(this.root)}.encode(),b""))`,
      )
      .replace(/sudo -n install/g, "install")
      .replace(/\/workspace|\/tmp\/\.sandbox-sdk|\/tmp\/sdk-bare/g, (path) => this.mapped(path))
      .replace(/\.listen\(3000/g, `.listen(${this.port}`);
  private file = async (path: string) => {
    try {
      const s = await fs.lstat(this.mapped(path));

      return {
        name: posix.basename(path),
        isDir: s.isDirectory(),
        size: s.size,
        modTime: s.mtime.toISOString(),
        modifiedAt: s.mtime.toISOString(),
        group: "test",
        owner: "test",
        permissions: "644",
        mode: s.isSymbolicLink() ? "Lrwxrwxrwx" : "-rw-r--r--",
      };
    } catch {
      throw missing();
    }
  };
  fs = {
    /** Every download, whole or streamed, reads through this. */
    downloadFileStream: async (path: string): Promise<Readable> => {
      try {
        if ((await fs.stat(this.mapped(path))).isDirectory())
          throw failure(400, `invalid file path: path points to a directory: ${path}`, {
            code: "INVALID_FILE_PATH",
          });
      } catch (error) {
        if (error instanceof Error && "statusCode" in error) throw error;
        throw missing();
      }

      return createReadStream(this.mapped(path));
    },
    uploadFiles: async (files: { source: Uint8Array; destination: string }[]) => {
      for (const file of files) {
        await fs.mkdir(posix.dirname(this.mapped(file.destination)), { recursive: true });
        await fs.writeFile(this.mapped(file.destination), file.source);
      }
    },
    createFolder: async (path: string, _mode: string) => {
      await fs.mkdir(this.mapped(path), { recursive: true });
    },
    setFilePermissions: async (path: string, permissions: { mode?: string }) => {
      mockState.permissions.push({ path, mode: permissions.mode });

      if (permissions.mode) await fs.chmod(this.mapped(path), Number.parseInt(permissions.mode, 8));
    },
    getFileDetails: (path: string) => this.file(path),
    listFiles: async (path: string) => {
      try {
        return await Promise.all(
          (await fs.readdir(this.mapped(path))).map((name) => this.file(posix.join(path, name))),
        );
      } catch {
        throw missing();
      }
    },
    deleteFile: async (path: string, recursive = false) => {
      try {
        await fs.rm(this.mapped(path), { recursive });
      } catch {
        throw missing();
      }
    },
  };
  private run(command: string, cwd = "/", env: Record<string, string> = {}) {
    const chunks: OutputChunk[] = [];
    const listeners: ((chunk: OutputChunk) => void)[] = [];

    const child = spawn("sh", ["-c", this.rewrite(command)], {
      cwd: this.mapped(cwd),
      env: {
        ...process.env,
        ...this.params.env,
        ...Object.fromEntries(
          Object.entries(env).map(([key, value]) => [key, this.rewrite(value)]),
        ),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const entry: Command = { chunks, listeners, pid: child.pid, done: Promise.resolve() };

    const emit = (stream: OutputChunk["stream"], data: Buffer) => {
      const chunk = { stream, text: data.toString().split(this.root).join("") };
      chunks.push(chunk);

      for (const listener of listeners) listener(chunk);
    };

    child.stdout.on("data", (data) => emit("stdout", data));
    child.stderr.on("data", (data) => emit("stderr", data));
    entry.done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        entry.exitCode = code ?? 137;
        resolve();
      });
    });

    return entry;
  }
  process = {
    codeRun: async (code: string) => {
      const child = spawn("python3", ["-"], { cwd: this.root });
      let stdout = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stdin.end(this.rewrite(code));

      const exitCode = await new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 137));
      });

      return { exitCode, result: stdout };
    },
    createSession: async (id: string) => {
      this.sessions.set(id, new Map());
    },
    executeSessionCommand: async (
      id: string,
      request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
    ): Promise<{ cmdId: string }> => {
      if (mockState.launchDelayMs)
        await new Promise((resolve) => setTimeout(resolve, mockState.launchDelayMs));
      const commands = this.sessions.get(id);

      if (!commands) throw failure(404, "session not found", { code: "PROCESS_NOT_FOUND" });
      const cmdId = crypto.randomUUID();
      commands.set(cmdId, this.run(request.command));

      return { cmdId };
    },
    getSessionCommand: async (
      id: string,
      cmdId: string,
    ): Promise<{ id: string; command: string; exitCode?: number }> => {
      if (mockState.failStatus) throw failure(503, "unavailable");
      const entry = this.sessions.get(id)?.get(cmdId);

      if (!entry) throw failure(404, "command not found", { code: "PROCESS_NOT_FOUND" });

      return { id: cmdId, command: "", exitCode: entry.exitCode };
    },
    /** Feeds the follow stream: like Daytona's HTTP log stream, stdout and stderr arrive merged and unlabelled. */
    getSessionCommandLogs: async (
      id: string,
      cmdId: string,
      stdout: (text: string) => void,
      stderr: (text: string) => void,
    ) => {
      const entry = this.sessions.get(id)?.get(cmdId);

      if (!entry) throw failure(404, "command not found", { code: "PROCESS_NOT_FOUND" });

      if (mockState.failLogs) throw failure(503, "connection failed");

      const emit = (chunk: OutputChunk) =>
        chunk.stream === "stdout" ? stdout(chunk.text) : stderr(chunk.text);

      for (const chunk of entry.chunks) emit(chunk);
      entry.listeners.push(emit);
      await entry.done;
    },
    deleteSession: async (id: string) => {
      if (!this.sessions.delete(id))
        throw failure(404, "session not found", { code: "PROCESS_NOT_FOUND" });
    },
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      _timeout?: number,
    ) => {
      const entry = this.run(command, cwd, env);
      await entry.done;

      return {
        exitCode: entry.exitCode ?? 0,
        result: entry.chunks.map((chunk) => chunk.text).join(""),
      };
    },
  };
  async stop() {
    this.state = "stopped";
  }
  async start() {
    this.state = "started";
  }
  async resize(resources: { cpu?: number; memory?: number; disk?: number }) {
    Object.assign(this, resources);
  }
  async delete() {
    if (!mockState.boxes.has(this.id))
      throw failure(404, `Sandbox with ID or name ${this.id} not found`);
    mockState.boxes.delete(this.id);
    await fs.rm(this.root, { recursive: true, force: true });
  }
  async createSnapshot(name: string) {
    const root = await fs.mkdtemp(join(tmpdir(), "sdk-daytona-snapshot-"));
    await fs.cp(this.root, root, { recursive: true });
    mockState.snapshots.set(name, root);
  }
  async getPreviewLink(port: number) {
    return { url: `http://127.0.0.1:${this.port}/?port=${port}`, token: "mock-preview-token" };
  }
  dto() {
    return {
      id: this.id,
      state: this.state,
      labels: this.labels,
      createdAt: this.createdAt,
      public: this.public,
      cpu: this.cpu,
      memory: this.memory,
      disk: this.disk,
      toolboxProxyUrl: `${server.url}/toolbox`,
    };
  }
}

/** Account-level operations, spied on as `MockDaytona.prototype.create` and friends. */
export class MockDaytona {
  async create(params: CreateBody) {
    mockState.creates.push(params);

    return MockSandbox.create(params);
  }
  async get(id: string) {
    const box = mockState.boxes.get(id);

    if (!box) throw failure(404, `Sandbox with ID or name ${id} not found`);

    return box;
  }
  async *list(query: { labels?: Record<string, string> } = {}) {
    for (const box of mockState.boxes.values())
      if (Object.entries(query.labels ?? {}).every(([key, value]) => box.labels[key] === value))
        yield box;
  }
}

const daytona = new MockDaytona();

const server = await fakeServer();

/** The control plane's base URL. The adapter reaches it through DAYTONA_API_URL. */
export const apiUrl = `${server.url}/api`;

/** Every request the adapter sent, with headers and bodies. */
export const requests: RecordedRequest[] = server.requests;

process.env.DAYTONA_API_URL = apiUrl;

afterAll(() => server.close());

export const guest = (id: string) => {
  const box = mockState.boxes.get(id);

  if (!box) throw new Error(`No mock sandbox ${id}`);

  return box;
};

function query(request: RecordedRequest) {
  return new URL(request.url, "http://mock").searchParams;
}

function json(request: RecordedRequest): JsonValue | undefined {
  return request.body.length ? JSON.parse(request.body.toString()) : undefined;
}

function reply(response: ServerResponse, status: number, body?: JsonValue | undefined) {
  response
    .writeHead(status, body === undefined ? {} : { "content-type": "application/json" })
    .end(body === undefined ? undefined : JSON.stringify(body));
}

function fail(response: ServerResponse, cause: unknown, path: string) {
  const status =
    cause instanceof Error && "statusCode" in cause && isNumber(cause.statusCode)
      ? cause.statusCode
      : 500;

  const code =
    cause instanceof Error && "code" in cause && isString(cause.code) ? cause.code : undefined;

  const headers =
    cause instanceof Error && "headers" in cause && cause.headers && isObject(cause.headers)
      ? cause.headers
      : {};

  if (!response.headersSent)
    response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(
    JSON.stringify({
      statusCode: status,
      message: cause instanceof Error ? cause.message : String(cause),
      code,
      source: "DAYTONA_DAEMON",
      path,
    }),
  );
}

/** Registers `METHOD path` with `handler(request, response, segments)`; a thrown failure becomes an error response. */
function route(
  method: string,
  path: string,
  handler: (
    request: RecordedRequest,
    response: ServerResponse,
    segments: string[],
  ) => Promise<JsonValue | undefined>,
) {
  server.on(`${method} ${path}`, async (request, response) => {
    const segments = new URL(request.url, "http://mock").pathname
      .split("/")
      .map(decodeURIComponent);

    try {
      const body = await handler(request, response, segments);

      if (!response.headersSent) reply(response, 200, body);
    } catch (error) {
      fail(response, error, path);
    }
  });
}

// Control plane: /api/sandbox/... Segments: ["", "api", "sandbox", id, action, ...].
route("POST", "/api/sandbox", async (request) => {
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  const box = await daytona.create(json(request) as CreateBody);
  box.state =
    mockState.createState === "started" && mockState.startPolls
      ? "creating"
      : mockState.createState;
  box.pollsUntilStarted = mockState.startPolls;

  return box.dto();
});

route("GET", "/api/sandbox", async (request) => {
  const params = query(request);
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  const labels = JSON.parse(params.get("labels") ?? "{}") as Record<string, string>;
  const all: MockSandbox[] = [];

  for await (const box of daytona.list({ labels })) all.push(box);
  const start = Number(params.get("cursor") ?? 0);
  const page = all.slice(start, start + mockState.pageSize);

  return {
    items: page.map((box) => box.dto()),
    nextCursor: start + mockState.pageSize < all.length ? String(start + mockState.pageSize) : null,
  };
});

route("GET", "/api/sandbox/{id}", async (_request, _response, [, , , id = ""]) => {
  const box = await daytona.get(id);

  if (
    box.state === "creating" &&
    box.pollsUntilStarted-- <= 0 &&
    mockState.createState === "started"
  )
    box.state = "started";

  return box.dto();
});

route("DELETE", "/api/sandbox/{id}", async (_request, _response, [, , , id = ""]) => {
  const box = await daytona.get(id);

  // Daytona answers before the sandbox is gone; a deleting sandbox reports `destroying` until then.
  if (mockState.deleteDelayMs) {
    box.state = "destroying";
    setTimeout(() => {
      void box.delete().catch(() => {});
    }, mockState.deleteDelayMs);

    return box.dto();
  }

  await box.delete();

  return { ...box.dto(), state: "destroyed" };
});

route(
  "GET",
  "/api/sandbox/{id}/toolbox-proxy-url",
  async (_request, _response, [, , , id = ""]) => {
    await daytona.get(id);

    return { url: `${server.url}/toolbox` };
  },
);

route("POST", "/api/sandbox/{id}/stop", async (_request, _response, [, , , id = ""]) => {
  const box = await daytona.get(id);
  await box.stop();

  return box.dto();
});

route("POST", "/api/sandbox/{id}/start", async (_request, _response, [, , , id = ""]) => {
  const box = await daytona.get(id);
  await box.start();

  return box.dto();
});

route("POST", "/api/sandbox/{id}/resize", async (request, _response, [, , , id = ""]) => {
  const box = await daytona.get(id);
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  await box.resize(json(request) as { cpu: number });

  return box.dto();
});

route("POST", "/api/sandbox/{id}/snapshot", async (request, _response, [, , , id = ""]) => {
  const box = await daytona.get(id);
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  const { name } = json(request) as { name: string };
  await box.createSnapshot(name);

  if (mockState.snapshotMs) {
    box.state = "snapshotting";
    setTimeout(() => {
      box.state = "started";
    }, mockState.snapshotMs);
  }

  return box.dto();
});

route(
  "GET",
  "/api/sandbox/{id}/ports/{port}/preview-url",
  async (_request, _response, [, , , id = "", , port = ""]) => ({
    sandboxId: id,
    ...(await (await daytona.get(id)).getPreviewLink(Number(port))),
  }),
);

// Toolbox: /toolbox/{id}/... Segments: ["", "toolbox", id, ...].
const tool = (
  method: string,
  path: string,
  handler: (
    box: MockSandbox,
    request: RecordedRequest,
    response: ServerResponse,
    segments: string[],
  ) => Promise<JsonValue | undefined>,
) =>
  route(method, `/toolbox/{id}${path}`, async (request, response, segments) =>
    handler(await daytona.get(segments[2] ?? ""), request, response, segments),
  );

tool("POST", "/files/bulk-upload", async (box, request) => {
  const form = await new Response(new Uint8Array(request.body), {
    headers: { "content-type": request.headers["content-type"] ?? "" },
  }).formData();

  const files: { source: Uint8Array; destination: string }[] = [];

  for (let i = 0; form.has(`files[${i}].path`); i++) {
    const file = form.get(`files[${i}].file`);

    if (!(file instanceof Blob)) throw failure(400, "missing file part");
    files.push({
      destination: String(form.get(`files[${i}].path`)),
      source: new Uint8Array(await file.arrayBuffer()),
    });
  }

  await box.fs.uploadFiles(files);

  return {
    files: files.map((file) => ({ path: file.destination, bytes: file.source.byteLength })),
  };
});

/** The daemon's bulk-download: one `file` or `error` part per path, with Daytona's fixed boundary. */
tool("POST", "/files/bulk-download", async (box, request, response) => {
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  const { paths } = json(request) as { paths: string[] };
  response.writeHead(200, {
    "content-type": "multipart/form-data; boundary=DAYTONA-FILE-BOUNDARY",
  });

  for (const path of paths) {
    const disposition = (name: string) =>
      `--DAYTONA-FILE-BOUNDARY\r\nContent-Disposition: form-data; name="${name}"; filename="${path}"\r\n`;

    let stream: Readable;

    try {
      stream = await box.fs.downloadFileStream(path);
    } catch (error) {
      const status =
        error instanceof Error && "statusCode" in error && isNumber(error.statusCode)
          ? error.statusCode
          : 500;

      const code =
        error instanceof Error && "code" in error && isString(error.code) ? error.code : undefined;

      response.write(
        `${disposition("error")}Content-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify({ statusCode: status, message: error instanceof Error ? error.message : "", code, source: "DAYTONA_DAEMON" })}\r\n`,
      );
      continue;
    }

    response.write(`${disposition("file")}Content-Type: application/octet-stream\r\n\r\n`);
    response.on("close", () => stream.destroy());

    for await (const chunk of stream)
      if (!response.write(chunk)) await new Promise((resolve) => response.once("drain", resolve));
    response.write("\r\n");
  }

  response.end("--DAYTONA-FILE-BOUNDARY--\r\n");
});

tool("GET", "/files", async (box, request) => box.fs.listFiles(query(request).get("path") ?? ""));

tool("GET", "/files/info", async (box, request) =>
  box.fs.getFileDetails(query(request).get("path") ?? ""),
);

tool("DELETE", "/files", async (box, request) => {
  await box.fs.deleteFile(
    query(request).get("path") ?? "",
    query(request).get("recursive") === "true",
  );
});

tool("POST", "/files/folder", async (box, request) => {
  await box.fs.createFolder(query(request).get("path") ?? "", query(request).get("mode") ?? "");
});

tool("POST", "/files/permissions", async (box, request) => {
  await box.fs.setFilePermissions(query(request).get("path") ?? "", {
    mode: query(request).get("mode") ?? undefined,
  });
});

tool("POST", "/process/execute", async (box, request) => {
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  const body = json(request) as {
    command: string;
    cwd?: string;
    envs?: Record<string, string>;
    timeout?: number;
  };

  return box.process.executeCommand(body.command, body.cwd, body.envs, body.timeout);
});

tool("POST", "/process/code-run", async (box, request) => {
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  const body = json(request) as { code: string; language: string };

  if (body.language !== "python") throw failure(400, "unsupported language");

  return box.process.codeRun(body.code);
});

tool("POST", "/process/session", async (box, request) => {
  // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
  await box.process.createSession((json(request) as { sessionId: string }).sessionId);
});

tool(
  "DELETE",
  "/process/session/{session}",
  async (box, _request, _response, [, , , , , session = ""]) => {
    await box.process.deleteSession(session);
  },
);

tool(
  "POST",
  "/process/session/{session}/exec",
  async (box, request, _response, [, , , , , session = ""]) =>
    // SAFETY: the adapter under test sends this body shape, and the fake trusts its own client.
    box.process.executeSessionCommand(session, json(request) as { command: string }),
);

tool(
  "GET",
  "/process/session/{session}/command/{command}",
  async (box, _request, _response, [, , , , , session = "", , command = ""]) =>
    box.process.getSessionCommand(session, command),
);

tool(
  "GET",
  "/process/session/{session}/command/{command}/logs",
  async (box, request, response, [, , , , , session = "", , command = ""]) => {
    if (query(request).get("follow") !== "true")
      throw failure(400, "the mock serves follow=true only");

    const write = (text: string) => {
      if (!response.headersSent) {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
      }

      if (!response.destroyed) response.write(text);
    };

    await box.process.getSessionCommandLogs(session, command, write, write);

    if (!response.headersSent)
      response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end();
  },
);

export async function cleanupMock() {
  await Promise.all([...mockState.boxes.values()].map((box) => box.delete().catch(() => {})));
  await Promise.all(
    [...mockState.snapshots.values()].map((root) => fs.rm(root, { recursive: true, force: true })),
  );
  mockState.snapshots.clear();
  mockState.creates.length = 0;
  mockState.permissions.length = 0;
  mockState.launchDelayMs = 0;
  mockState.failLogs = false;
  mockState.failStatus = false;
  mockState.createState = "started";
  mockState.startPolls = 0;
  mockState.snapshotMs = 0;
  mockState.pageSize = 100;
  mockState.deleteDelayMs = 0;
  requests.length = 0;
}

/** A toolbox client for `id`, for tests that call the exec transports directly. */
export const toolboxFor = (id: string) =>
  daytonaHttp({
    baseUrl: () => apiUrl,
    credentials: () => ({ apiKey: "offline-test-key" }),
    requestTimeoutMs: 30_000,
    secrets: () => [],
  }).toolbox(id);
