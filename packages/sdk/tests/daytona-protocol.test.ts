// Daytona's wire protocol against scripted HTTP replies: multipart transfers, the session log stream and the
// toolbox proxy URL, including the faults a real network produces (cuts, truncation, splits, hangs).
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SandboxError } from "../src/index.js";
import type { OutputChunk } from "../src/provider.js";
import { daytona } from "../src/providers/daytona/index.js";
import { daytonaHttp } from "../src/providers/daytona/api.js";
import { fakeServer, pieces, type FakeServer } from "./http-fake.js";

let api: FakeServer;
let toolbox: FakeServer;

beforeEach(async () => {
  api = await fakeServer();
  toolbox = await fakeServer();
});

afterEach(async () => {
  await api.close();
  await toolbox.close();
});

const multipart = { "content-type": "multipart/form-data; boundary=DAYTONA-FILE-BOUNDARY" };

const part = (
  name: string,
  data: string | Uint8Array,
  headers = "Content-Type: application/octet-stream",
) => {
  const head = `--DAYTONA-FILE-BOUNDARY\r\nContent-Disposition: form-data; name="${name}"; filename="/tmp/a"\r\n${headers}\r\n\r\n`;

  return Buffer.concat([
    Buffer.from(head),
    Buffer.from(data),
    Buffer.from("\r\n--DAYTONA-FILE-BOUNDARY--\r\n"),
  ]);
};

const dto = (proxy = `${toolbox.url}/toolbox`) => ({
  id: "sb-1",
  state: "started",
  labels: { "sandbox-sdk": "1" },
  createdAt: new Date().toISOString(),
  toolboxProxyUrl: proxy,
});

const client = () =>
  daytonaHttp({
    baseUrl: () => `${api.url}/api`,
    credentials: () => ({ apiKey: "proto-key-123456" }),
    requestTimeoutMs: 3_000,
    secrets: () => [],
  });

async function failure(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);

    // SAFETY: the call under test rejects only with a SandboxError.
    return error as SandboxError;
  }

  throw new Error("expected a rejection");
}

describe("file transfer", () => {
  test("uploads build multipart/form-data with Web FormData: Daytona's field names and the exact bytes", async () => {
    toolbox.on("POST /toolbox/sb-1/files/bulk-upload", { json: { files: [] } });
    api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", { json: { url: `${toolbox.url}/toolbox` } });
    const data = Uint8Array.from({ length: 256 }, (_, i) => i);
    await client().toolbox("sb-1").fs.upload(data, "/workspace/a b.bin");
    const [request] = toolbox.requests;
    expect(request?.headers.authorization).toBe("Bearer proto-key-123456");

    const form = await new Response(new Uint8Array(request?.body ?? []), {
      headers: { "content-type": request?.headers["content-type"] ?? "" },
    }).formData();

    expect(form.get("files[0].path")).toBe("/workspace/a b.bin");
    const file = form.get("files[0].file");
    expect(file).toBeInstanceOf(Blob);
    // SAFETY: the multipart part under test is a file upload.
    expect(new Uint8Array(await (file as Blob).arrayBuffer())).toEqual(data);
    // SAFETY: the multipart part under test is a file upload.
    expect((file as File).name).toBe("/workspace/a b.bin");
  });

  test("downloads read Daytona's multipart reply split at every chunk size", async () => {
    api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", { json: { url: `${toolbox.url}/toolbox` } });
    const data = Uint8Array.from({ length: 400 }, (_, i) => (i * 7) % 256);
    const box = client().toolbox("sb-1");

    for (const size of [1, 2, 3, 5, 8, 13, 64, 4096]) {
      toolbox.on("POST /toolbox/sb-1/files/bulk-download", {
        headers: multipart,
        stream: pieces(part("file", data, `Content-Length: ${data.length}`), size),
        intervalMs: 0,
      });
      expect(await box.fs.download("/tmp/a")).toEqual(data);
    }

    expect(JSON.parse(toolbox.requests[0]?.body.toString() ?? "")).toEqual({ paths: ["/tmp/a"] });
  });

  test("an error part maps like the daemon's own status: missing is file_not_found, a directory is invalid_argument", async () => {
    api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", { json: { url: `${toolbox.url}/toolbox` } });
    const box = client().toolbox("sb-1");
    toolbox.on("POST /toolbox/sb-1/files/bulk-download", {
      headers: multipart,
      body: part(
        "error",
        JSON.stringify({
          statusCode: 404,
          message: "file not found: /tmp/a",
          code: "FILE_NOT_FOUND",
          source: "DAYTONA_DAEMON",
        }),
        "Content-Type: application/json; charset=utf-8",
      ),
    });
    expect(await failure(box.fs.download("/tmp/a"))).toMatchObject({
      code: "file_not_found",
      provider: "daytona",
      sandboxId: "sb-1",
    });
    toolbox.on("POST /toolbox/sb-1/files/bulk-download", {
      headers: multipart,
      body: part(
        "error",
        JSON.stringify({
          statusCode: 400,
          message: "invalid file path: path points to a directory: /tmp",
          code: "INVALID_FILE_PATH",
        }),
      ),
    });
    const error = await failure(box.fs.download("/tmp"));
    expect(error.code).toBe("invalid_argument");
    expect(error.message).not.toContain("points to a directory");
  });

  test("a download cut mid-part, or ended before the delimiter, is unavailable and retryable", async () => {
    api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", { json: { url: `${toolbox.url}/toolbox` } });
    const box = client().toolbox("sb-1");
    const whole = part("file", new Uint8Array(5000).fill(1));
    toolbox.on("POST /toolbox/sb-1/files/bulk-download", {
      headers: multipart,
      stream: [whole.subarray(0, 3000)],
      cut: true,
    });
    expect(await failure(box.fs.download("/tmp/a"))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    toolbox.on("POST /toolbox/sb-1/files/bulk-download", {
      headers: multipart,
      stream: [whole.subarray(0, whole.length - 30)],
    });
    expect(await failure(box.fs.download("/tmp/a"))).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  test("a reply that is not multipart is a provider error", async () => {
    api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", { json: { url: `${toolbox.url}/toolbox` } });
    toolbox.on("POST /toolbox/sb-1/files/bulk-download", { json: { unexpected: true } });
    expect(await failure(client().toolbox("sb-1").fs.download("/tmp/a"))).toMatchObject({
      code: "provider",
    });
  });

  test("a streamed download is cancelled by its signal while the part is still arriving", async () => {
    api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", { json: { url: `${toolbox.url}/toolbox` } });
    toolbox.on("POST /toolbox/sb-1/files/bulk-download", {
      headers: multipart,
      stream: [part("file", "x".repeat(100)).subarray(0, 180)],
      hold: true,
    });
    const controller = new AbortController();

    const stream = await client()
      .toolbox("sb-1")
      .fs.downloadStream("/tmp/a", { signal: controller.signal, timeoutMs: 10_000 });

    const closed = toolbox.closed();
    const reader = stream.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toMatchObject({ code: "aborted" });
    await closed;
  });
});

describe("toolbox proxy URL", () => {
  test("a DTO without a proxy URL asks for one; a newer DTO's URL wins", async () => {
    const other = await fakeServer();

    try {
      api.on(
        "GET /api/sandbox/sb-1",
        { json: { ...dto(), toolboxProxyUrl: undefined } },
        { json: dto(`${other.url}/toolbox/`) },
      );
      api.on("GET /api/sandbox/sb-1/toolbox-proxy-url", {
        json: { url: `${toolbox.url}/toolbox` },
      });

      for (const server of [toolbox, other])
        server.on("GET /toolbox/sb-1/files/info", { json: { name: "a", isDir: false, size: 1 } });
      const { control, toolbox: open } = client();
      await control.get("sb-1");
      await open("sb-1").fs.getFileDetails("/a");
      expect(api.calls("GET /api/sandbox/sb-1/toolbox-proxy-url")).toHaveLength(1);
      expect(toolbox.requests.map((request) => request.url)).toEqual([
        "/toolbox/sb-1/files/info?path=%2Fa",
      ]);
      await control.get("sb-1");
      await open("sb-1").fs.getFileDetails("/a");
      expect(other.requests.map((request) => request.url)).toEqual([
        "/toolbox/sb-1/files/info?path=%2Fa",
      ]);
      expect(other.requests[0]?.headers.authorization).toBe("Bearer proto-key-123456");
    } finally {
      await other.close();
    }
  });
});

describe("session log stream", () => {
  /** Scripts one streamed exec: session, launch, PID file, status and the follow stream. */
  function script(
    logs: Parameters<FakeServer["on"]>[1],
    status: () => { exitCode?: number } = () => ({ exitCode: 0 }),
  ) {
    api.on("GET /api/sandbox/sb-1", { json: dto() });
    toolbox
      .on("POST /toolbox/sb-1/process/session", { status: 201 })
      .on("POST /toolbox/sb-1/process/session/{session}/exec", {
        status: 202,
        json: { cmdId: "c1" },
      })
      .on("POST /toolbox/sb-1/files/bulk-download", {
        headers: multipart,
        body: part("file", "4321"),
      })
      .on("GET /toolbox/sb-1/process/session/{session}/command/c1", (_request, response) => {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ id: "c1", command: "", ...status() }));
      })
      .on("GET /toolbox/sb-1/process/session/{session}/command/c1/logs", logs)
      .on("DELETE /toolbox/sb-1/process/session/{session}", { status: 200 })
      .on("DELETE /toolbox/sb-1/files", { status: 200 })
      .on("POST /toolbox/sb-1/process/execute", { json: { exitCode: 0, result: "" } });
  }

  async function run(options: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    const provider = daytona({
      apiKey: "proto-key-123456",
      baseUrl: `${api.url}/api`,
      requestTimeoutMs: 3_000,
    });

    await provider.connect("sb-1");
    const chunks: OutputChunk[] = [];

    const result = await provider.exec("sb-1", {
      command: "ignored",
      cwd: "/workspace",
      env: {},
      timeoutMs: options.timeoutMs ?? 5_000,
      streaming: true,
      signal: options.signal,
      onChunk: (chunk) => chunks.push(chunk),
    });

    const text = (stream: string) =>
      chunks
        .filter((chunk) => chunk.stream === stream)
        .map((chunk) => chunk.text)
        .join("");

    return { result, stdout: text("stdout"), stderr: text("stderr") };
  }

  const frames = (text: string) => `O:${Buffer.from(text).toString("base64")}\n`;

  test("frames split at every boundary, including inside UTF-8 characters, give exact output", async () => {
    const output = `${frames("héllo ")}${`E:${Buffer.from("wärn").toString("base64")}\n`}${frames("wörld 🌍")}X:\n`;

    for (const size of [1, 2, 3, 7]) {
      script({ stream: pieces(output, size), intervalMs: 0 });
      expect(await run()).toMatchObject({
        result: { exitCode: 0, timedOut: false },
        stdout: "héllo wörld 🌍",
        stderr: "wärn",
      });
    }

    // The follow is a GET with follow=true, with credentials, on the toolbox plane.
    const follow = toolbox.calls("GET /toolbox/sb-1/process/session/{session}/command/c1/logs")[0];
    expect(follow?.url).toMatch(/\?follow=true$/);
    expect(follow?.headers.authorization).toBe("Bearer proto-key-123456");
  });

  test("lines the bridge did not frame are the wrapper's stderr, in order", async () => {
    script({ stream: ["sh: 1: cd: can't cd to /nope\n"] }, () => ({ exitCode: 2 }));
    expect(await run()).toMatchObject({
      result: { exitCode: 2 },
      stdout: "",
      stderr: "sh: 1: cd: can't cd to /nope\n",
    });
  });

  test("a mid-stream disconnect fails the command as unavailable and kills it", async () => {
    let killed = false;
    script({ stream: [frames("partial")], cut: true }, () => (killed ? { exitCode: 137 } : {}));
    toolbox.on("POST /toolbox/sb-1/process/execute", (request, response) => {
      if (request.body.toString().includes("/bin/kill -KILL")) killed = true;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ exitCode: 0, result: "" }));
    });
    expect(await failure(run())).toMatchObject({ code: "unavailable", provider: "daytona" });
    expect(killed).toBe(true);
  });

  test("a stream that ends inside a frame is incomplete output, not success", async () => {
    script({ stream: ["O:ZXhh"] });
    expect(await failure(run())).toMatchObject({ code: "provider" });
  });

  test("output after the terminal frame fails closed", async () => {
    script({ stream: [`X:\n${frames("late")}`] });
    expect(await failure(run())).toMatchObject({ code: "provider" });
  });

  test("an abort while the stream has not started kills the group and closes the stream", async () => {
    let killed = false;
    script({ hang: true }, () => (killed ? { exitCode: 137 } : {}));
    toolbox.on("POST /toolbox/sb-1/process/execute", (request, response) => {
      if (request.body.toString().includes("/bin/kill -KILL -- -4321")) killed = true;
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ exitCode: 0, result: "" }));
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    expect((await run({ signal: controller.signal })).result).toMatchObject({
      exitCode: null,
      timedOut: true,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(killed).toBe(true);
    expect(toolbox.calls("DELETE /toolbox/sb-1/process/session/{session}")).toHaveLength(1);
  });

  test("a silent command is not cut off by the request timeout", async () => {
    // Headers and output arrive only after the 3 s request timeout of this client.
    script(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 3_500));
      response
        .writeHead(200, { "content-type": "application/octet-stream" })
        .end(`${frames("late but fine")}X:\n`);
    });
    expect(await run({ timeoutMs: 10_000 })).toMatchObject({
      result: { exitCode: 0, timedOut: false },
      stdout: "late but fine",
    });
  }, 15_000);
});
