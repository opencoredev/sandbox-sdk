// E2B's optional features on the wire, against a scripted server: the User-Agent, snapshot deletion,
// template builds, metrics in usage() and box.ext.e2b, the PTY terminal and WatchDir file events.
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { buildTemplate, connectSandbox, deleteSnapshot } from "../src/index.js";
import type { FileEvent } from "../src/provider.js";
import type { JsonObject, JsonValue } from "../src/shared/json.js";
import { connectEnvelope } from "../src/streams.js";
import { e2b } from "../src/providers/e2b/index.js";
import { userAgent, version } from "../src/version.js";
import { fakeServer, type FakeServer, type RecordedRequest } from "./http-fake.js";
import { rejection } from "./rejection.js";

let server: FakeServer;
const saved = { api: process.env.E2B_API_URL, sandbox: process.env.E2B_SANDBOX_URL };

beforeAll(() => {
  delete process.env.E2B_API_URL;
  delete process.env.E2B_SANDBOX_URL;
});

beforeEach(async () => {
  server = await fakeServer();
  process.env.E2B_API_URL = server.url;
  process.env.E2B_SANDBOX_URL = server.url;
});

afterEach(async () => {
  await server.close();
});

afterAll(() => {
  for (const [name, value] of [
    ["E2B_API_URL", saved.api],
    ["E2B_SANDBOX_URL", saved.sandbox],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

const key = "e2b_secret_key_123456";
const token = "envd-token-abcdef123456";
const frame = (message: JsonValue | undefined, end = false) => connectEnvelope(message, end);
const done = frame({}, true);

const connectStream = (
  parts: Uint8Array[],
  extra: { hold?: boolean; intervalMs?: number } = {},
) => ({
  stream: parts,
  headers: { "content-type": "application/connect+json" },
  ...extra,
});

const bodyOf = (request: RecordedRequest | undefined): JsonObject =>
  JSON.parse(request?.body.toString() ?? "{}");

const envelopeOf = (request: RecordedRequest | undefined): JsonObject =>
  JSON.parse(request?.body.subarray(5).toString() ?? "{}");

/** Scripts the calls `connect()` makes and returns a provider attached to sandbox `sb1`. */
async function attached(envdVersion = "0.10.0") {
  server
    .on("GET /sandboxes/{id}", {
      json: {
        sandboxID: "sb1",
        templateID: "base",
        metadata: { "sandbox-sdk": "1" },
        startedAt: new Date().toISOString(),
        state: "running",
        envdVersion,
      },
    })
    .on("POST /v2/sandboxes/{id}/connect", {
      json: { sandboxID: "sb1", envdVersion, envdAccessToken: token, domain: "e2b.test" },
    })
    .on("POST /filesystem.Filesystem/Stat", {
      json: { entry: { name: "workspace", path: "/workspace", type: "FILE_TYPE_DIRECTORY" } },
    })
    .on("POST /files", { json: [] });
  const provider = e2b({ apiKey: key });
  await provider.connect("sb1");

  return provider;
}

test("every request names the SDK in User-Agent, and the version matches package.json", async () => {
  const pkg: { version: string } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );

  expect(version).toBe(pkg.version);
  expect(userAgent).toBe(`sandbox-sdk/${pkg.version}`);
  await attached();
  expect(server.requests.length).toBeGreaterThan(2);

  for (const request of server.requests) expect(request.headers["user-agent"]).toBe(userAgent);
});

describe("snapshots and templates", () => {
  test("deleteSnapshot deletes the template behind the snapshot, and reports a missing one", async () => {
    server.on("DELETE /templates/{id}", { status: 204 }, { status: 404, json: { code: 404 } });
    const provider = e2b({ apiKey: key });

    expect(await deleteSnapshot(provider, "snap-1")).toBe(true);
    expect(await deleteSnapshot(provider, "snap-1")).toBe(false);
    expect(server.calls("DELETE /templates/{id}").map((request) => request.url)).toEqual([
      "/templates/snap-1",
      "/templates/snap-1",
    ]);
    expect(server.requests[0]?.headers["x-api-key"]).toBe(key);
  });

  test("buildTemplate requests, triggers and polls one build, streaming its logs", async () => {
    server
      .on("POST /v3/templates", { json: { templateID: "tpl1", buildID: "b1", tags: ["default"] } })
      .on("POST /v2/templates/{tid}/builds/{bid}", { status: 202 })
      .on(
        "GET /templates/{tid}/builds/{bid}/status",
        { json: { status: "building", logEntries: [{ message: "step 1", level: "info" }] } },
        { json: { status: "ready", logEntries: [{ message: "done", level: "info" }] } },
        { json: { status: "ready", logEntries: [] } },
      );
    const logs: string[] = [];

    const template = await buildTemplate(
      e2b({ apiKey: key }),
      {
        name: "node-dev",
        image: "node:22-bookworm",
        env: { NODE_ENV: "development" },
        workdir: "/workspace",
        run: ["npm i -g pnpm", "pnpm --version"],
        size: { cpu: 2, memoryMb: 2048 },
        startCommand: "pnpm dev",
        readyCommand: "curl -s localhost:3000",
      },
      { onLog: (line) => logs.push(line) },
    );

    expect(template).toEqual({ id: "tpl1", name: "node-dev", buildId: "b1" });
    expect(logs).toEqual(["step 1", "done"]);
    expect(bodyOf(server.calls("POST /v3/templates")[0])).toEqual({
      name: "node-dev",
      cpuCount: 2,
      memoryMB: 2048,
    });
    expect(bodyOf(server.calls("POST /v2/templates/{tid}/builds/{bid}")[0])).toEqual({
      fromImage: "node:22-bookworm",
      steps: [
        { type: "ENV", args: ["NODE_ENV", "development"], force: false },
        { type: "WORKDIR", args: ["/workspace"], force: false },
        { type: "RUN", args: ["npm i -g pnpm", "root"], force: false },
        { type: "RUN", args: ["pnpm --version", "root"], force: false },
      ],
      startCmd: "pnpm dev",
      readyCmd: "curl -s localhost:3000",
      force: false,
    });
    expect(
      server.calls("GET /templates/{tid}/builds/{bid}/status").map((request) => request.url),
    ).toEqual([
      "/templates/tpl1/builds/b1/status?logsOffset=0",
      "/templates/tpl1/builds/b1/status?logsOffset=1",
      "/templates/tpl1/builds/b1/status?logsOffset=2",
    ]);
  });

  test("a failed build names its step but never E2B's reason text", async () => {
    server
      .on("POST /v3/templates", { json: { templateID: "tpl1", buildID: "b1" } })
      .on("POST /v2/templates/{tid}/builds/{bid}", { status: 202 })
      .on("GET /templates/{tid}/builds/{bid}/status", {
        json: {
          status: "error",
          logEntries: [],
          reason: { message: `apt failed with ${key}`, step: "2" },
        },
      });

    const error = await rejection(
      buildTemplate(e2b({ apiKey: key }), { name: "broken", run: ["apt-get install nope"] }),
    );

    expect(error).toMatchObject({ code: "provider", provider: "e2b" });
    expect(error.message).toContain("b1 failed at step 2");
    expect(`${error.message} ${String(error.cause)}`).not.toContain(key);
  });

  test("one deadline covers the build, and the error names the build still running", async () => {
    server
      .on("POST /v3/templates", { json: { templateID: "tpl1", buildID: "b1" } })
      .on("POST /v2/templates/{tid}/builds/{bid}", { status: 202 })
      .on("GET /templates/{tid}/builds/{bid}/status", {
        json: { status: "building", logEntries: [] },
      });

    const started = Date.now();

    const error = await rejection(
      buildTemplate(e2b({ apiKey: key }), { name: "slow" }, { timeoutMs: 300 }),
    );

    expect(Date.now() - started).toBeLessThan(2_000);
    expect(error.code).toBe("timeout");
    expect(error.message).toContain("build b1 of tpl1");
  });

  test("conflicting sources and a ready check without a start command are refused locally", async () => {
    const provider = e2b({ apiKey: key });

    for (const spec of [
      { name: "x", image: "node:22", fromTemplate: "base" },
      { name: "x", readyCommand: "true" },
    ])
      await expect(buildTemplate(provider, spec)).rejects.toMatchObject({
        code: "invalid_argument",
      });
    expect(server.requests).toHaveLength(0);
  });
});

describe("metrics", () => {
  const samples = [
    {
      timestamp: "2026-10-30T10:00:05Z",
      cpuCount: 2,
      cpuUsedPct: 40.5,
      memUsed: 300,
      memTotal: 1000,
      diskUsed: 7,
      diskTotal: 70,
    },
    {
      timestamp: "2026-10-30T10:00:00Z",
      cpuCount: 2,
      cpuUsedPct: 10,
      memUsed: 100,
      memTotal: 1000,
      diskUsed: 5,
      diskTotal: 70,
    },
  ];

  test("usage() reports the newest sample beside the core counters", async () => {
    const provider = await attached();
    server.on("GET /sandboxes/{id}/metrics", { json: samples });
    const box = await connectSandbox(provider, "sb1", { recoverSecrets: false });

    expect(await box.usage()).toMatchObject({
      commands: 0,
      bytesOut: 0,
      cpuCount: 2,
      cpuPercent: 40.5,
      memoryBytes: 300,
      memoryLimitBytes: 1000,
      diskBytes: 7,
      diskLimitBytes: 70,
      metricsAt: Date.parse("2026-10-30T10:00:05Z"),
    });

    server.on("GET /sandboxes/{id}/metrics", { json: [] });
    const empty = await box.usage();
    expect(empty.cpuPercent).toBeUndefined();
    expect(empty.commands).toBe(0);
  });

  test("usage() still returns the core counters when the metrics request fails", async () => {
    const provider = await attached();
    server.on("GET /sandboxes/{id}/metrics", { status: 404, json: { code: 404 } });
    const box = await connectSandbox(provider, "sb1", { recoverSecrets: false });

    const usage = await box.usage();
    expect(usage).toMatchObject({ commands: 0, bytesOut: 0 });
    expect(usage.cpuPercent).toBeUndefined();
    expect(usage.memoryBytes).toBeUndefined();
  });

  test("box.ext.e2b.metrics returns the window oldest first, in E2B's seconds", async () => {
    const provider = await attached();
    server.on("GET /sandboxes/{id}/metrics", { json: samples });
    const box = await connectSandbox(provider, "sb1", { recoverSecrets: false });

    const history = await box.ext.e2b.metrics({
      startMs: 1_700_000_000_500,
      endMs: 1_700_000_100_200,
    });

    expect(history.map((sample) => sample.cpuUsedPct)).toEqual([10, 40.5]);
    expect(server.calls("GET /sandboxes/{id}/metrics")[0]?.url).toBe(
      "/sandboxes/sb1/metrics?start=1700000000&end=1700000101",
    );

    server.on("GET /sandboxes/{id}/metrics", { status: 404, json: { code: 404 } });
    await expect(box.ext.e2b.metrics()).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("terminal", () => {
  test("starts a login shell on a PTY, keeps early output, and sends input, resizes and kills", async () => {
    const provider = await attached();

    const pty = (text: string) =>
      frame({ event: { data: { pty: Buffer.from(text).toString("base64") } } });

    server
      .on(
        "POST /process.Process/Start",
        connectStream(
          [frame({ event: { start: { pid: 42 } } }), pty("root@sb1:/workspace# "), pty("é")],
          { hold: true },
        ),
      )
      .on("POST /process.Process/SendInput", { json: {} })
      .on("POST /process.Process/Update", { json: {} })
      .on("POST /process.Process/SendSignal", { json: {} });

    const terminal = await provider.terminal("sb1", {
      cols: 120,
      rows: 40,
      cwd: "/workspace/app",
      env: { SECRET_NAME: "x" },
    });

    const start = envelopeOf(server.calls("POST /process.Process/Start")[0]);
    expect(start).toEqual({
      process: {
        cmd: "/bin/bash",
        args: ["-i", "-l"],
        cwd: "/workspace/app",
        envs: { TERM: "xterm-256color", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", SECRET_NAME: "x" },
      },
      pty: { size: { cols: 120, rows: 40 } },
    });
    expect(server.calls("POST /process.Process/Start")[0]?.headers["connect-timeout-ms"]).toBe(
      undefined,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    const seen: string[] = [];
    terminal.onData((data) => seen.push(data));
    expect(seen.join("")).toBe("root@sb1:/workspace# é");

    await terminal.write("ls\r");
    await terminal.resize(100, 30);
    expect(bodyOf(server.calls("POST /process.Process/SendInput")[0])).toEqual({
      process: { pid: 42 },
      input: { pty: Buffer.from("ls\r").toString("base64") },
    });
    expect(bodyOf(server.calls("POST /process.Process/Update")[0])).toEqual({
      process: { pid: 42 },
      pty: { size: { cols: 100, rows: 30 } },
    });
  });

  test("wait reports the shell's exit, and close kills a running shell", async () => {
    const provider = await attached();

    server
      .on(
        "POST /process.Process/Start",
        connectStream([
          frame({ event: { start: { pid: 7 } } }),
          frame({ event: { end: { exitCode: 3 } } }),
          done,
        ]),
        connectStream([frame({ event: { start: { pid: 8 } } })], { hold: true }),
      )
      .on("POST /process.Process/SendSignal", { json: {} });

    const exited = await provider.terminal("sb1", { cols: 80, rows: 24 });
    expect(await exited.wait?.()).toEqual({ exitCode: 3 });
    await exited.close();
    expect(server.calls("POST /process.Process/SendSignal")).toHaveLength(0);

    const running = await provider.terminal("sb1", { cols: 80, rows: 24 });
    const closing = running.close();
    await expect.poll(() => server.calls("POST /process.Process/SendSignal").length).toBe(1);
    expect(bodyOf(server.calls("POST /process.Process/SendSignal")[0])).toEqual({
      process: { pid: 8 },
      signal: "SIGNAL_SIGKILL",
    });
    await closing;
  }, 10_000);

  test("close stops reading even when the kill fails", async () => {
    const provider = await attached();

    server
      .on(
        "POST /process.Process/Start",
        connectStream([frame({ event: { start: { pid: 11 } } })], { hold: true }),
      )
      .on("POST /process.Process/SendSignal", {
        status: 403,
        json: { code: "permission_denied", message: "no" },
      });

    const terminal = await provider.terminal("sb1", { cols: 80, rows: 24 });
    const released = server.closed();
    await expect(terminal.close()).rejects.toMatchObject({ code: "auth" });
    await released;
  });

  test("box.terminal goes through the core: redacted output, sandbox env and /workspace", async () => {
    const provider = await attached();
    const secret = "pty-secret-value-123";

    server.on(
      "POST /process.Process/Start",
      connectStream(
        [
          frame({ event: { start: { pid: 9 } } }),
          frame({
            event: { data: { pty: Buffer.from(`token=${secret}\r\n`).toString("base64") } },
          }),
        ],
        { hold: true },
      ),
    );

    const box = await connectSandbox(provider, "sb1", {
      secrets: { TOKEN: secret },
      recoverSecrets: false,
    });

    const terminal = await box.terminal({ cols: 80, rows: 24 });
    const seen: string[] = [];
    terminal.onData((data) => seen.push(data));
    await expect.poll(() => seen.join("")).toContain("token=");
    expect(seen.join("")).not.toContain(secret);

    const start = envelopeOf(server.calls("POST /process.Process/Start")[0]);
    expect(start.process).toMatchObject({ cwd: "/workspace", envs: { TOKEN: secret } });
  });
});

describe("file watching", () => {
  test("WatchDir events become absolute added, modified and removed events", async () => {
    const provider = await attached();
    const change = (name: string, type: string) => frame({ filesystem: { name, type } });

    server.on(
      "POST /filesystem.Filesystem/WatchDir",
      connectStream(
        [
          frame({ start: {} }),
          change("a.txt", "EVENT_TYPE_CREATE"),
          change("a.txt", "EVENT_TYPE_WRITE"),
          frame({ keepalive: {} }),
          change("lib/b.txt", "EVENT_TYPE_CHMOD"),
          change("a.txt", "EVENT_TYPE_RENAME"),
          change("a.txt", "EVENT_TYPE_REMOVE"),
        ],
        { hold: true },
      ),
    );

    const events: FileEvent[] = [];
    const controller = new AbortController();

    const watching = provider.files.watch?.("sb1", "/workspace/src", {
      recursive: true,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

    await expect.poll(() => events.length).toBe(5);
    expect(events).toEqual([
      { type: "added", path: "/workspace/src/a.txt" },
      { type: "modified", path: "/workspace/src/a.txt" },
      { type: "modified", path: "/workspace/src/lib/b.txt" },
      { type: "removed", path: "/workspace/src/a.txt" },
      { type: "removed", path: "/workspace/src/a.txt" },
    ]);

    const request = server.calls("POST /filesystem.Filesystem/WatchDir")[0];
    expect(envelopeOf(request)).toEqual({ path: "/workspace/src", recursive: true });
    expect(request?.headers.authorization).toBe(`Basic ${Buffer.from("root:").toString("base64")}`);
    expect(request?.headers["x-access-token"]).toBe(token);

    controller.abort();
    await expect(watching).resolves.toBeUndefined();
  });

  test("a missing directory is file_not_found, and a stream that ends is unavailable", async () => {
    const provider = await attached();

    server.on(
      "POST /filesystem.Filesystem/WatchDir",
      connectStream([frame({ error: { code: "not_found", message: "no such dir" } }, true)]),
      connectStream([frame({ start: {} }), done]),
    );

    const watch = () =>
      provider.files.watch?.("sb1", "/workspace/gone", {
        recursive: false,
        signal: new AbortController().signal,
        onEvent() {},
      });

    await expect(watch()).rejects.toMatchObject({ code: "file_not_found" });
    await expect(watch()).rejects.toMatchObject({ code: "unavailable" });
  });

  test("recursive watching on an envd before 0.1.4 is unsupported, so the core polls instead", async () => {
    const provider = await attached("0.1.3");

    await expect(
      provider.files.watch?.("sb1", "/workspace", {
        recursive: true,
        signal: new AbortController().signal,
        onEvent() {},
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(server.calls("POST /filesystem.Filesystem/WatchDir")).toHaveLength(0);
  });
});

test("the E2B provider declares its capabilities and keeps box.native", async () => {
  const provider = await attached();
  expect([...provider.capabilities].sort()).toEqual([
    "network-policy",
    "pause",
    "snapshot",
    "snapshot-delete",
    "templates",
    "terminal",
  ]);

  const connected = await connectSandbox(provider, "sb1", { recoverSecrets: false });
  server.on("GET /sandboxes/{id}", { json: { sandboxID: "sb1", state: "running" } });
  expect(await connected.native.request("GET", "/sandboxes/{sandboxId}")).toMatchObject({
    sandboxID: "sb1",
  });
});
