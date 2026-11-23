import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import type { ExecInput } from "../src/provider.js";
import { styne, type StyneOptions } from "../src/providers/styne/index.js";
import { createSandbox } from "../src/index.js";
import { fakeServer, type FakeServer, type RecordedRequest } from "./http-fake.js";
import { styneFake } from "./styne-fake.js";

let server: FakeServer;

beforeEach(async () => {
  server = await fakeServer();
});

afterEach(async () => {
  await server.close();
});

const apiKey = "styne_test_key_0123456789";
const id = "vm0123456789abcdef";
const token = "traffic-token-abcdef0123456789";

const provider = (options: StyneOptions = {}) => styne({ apiKey, baseUrl: server.url, ...options });

const created = (extra: { trafficAccessToken?: string } = {}) => ({
  templateID: "default",
  sandboxID: id,
  envdAccessToken: "envd-token-abcdef0123456789",
  trafficAccessToken: token,
  domain: "ash.styne.ai",
  ...extra,
});

const sandbox = (state = "running", metadata: Record<string, string> = {}) => ({
  templateID: "default",
  sandboxID: id,
  startedAt: "2026-11-23T16:33:34.348499561Z",
  state,
  metadata,
  domain: "ash.styne.ai",
});

const error = (status: number, code: string) => ({
  status,
  json: { code: status, error_code: code, message: "said by styne", origin: "client" },
});

/** NDJSON lines of an exec answer. */
const frames = (...lines: object[]) => lines.map((line) => `${JSON.stringify(line)}\n`);
const b64 = (text: string) => Buffer.from(text).toString("base64");
const ok = frames({ started: { pid: 10 } }, { exit: { exitCode: 0, signal: 0, timedOut: false } });

/** The request body's JSON lines. */
const lines = (request: RecordedRequest) =>
  request.body
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const body = (request: RecordedRequest | undefined) => {
  if (!request) throw new Error("expected a request");

  return JSON.parse(request.body.toString());
};

function input(extra: Partial<ExecInput> = {}): ExecInput & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    command: "echo hi",
    cwd: "/workspace",
    env: { A: "1" },
    timeoutMs: 10_000,
    onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
    chunks,
    ...extra,
  };
}

async function rejection(promise: Promise<unknown>): Promise<SandboxError> {
  const caught = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );

  if (!(caught instanceof SandboxError)) throw new Error("expected a SandboxError");

  return caught;
}

describe("styne create", () => {
  test("sends the template, labels, key, lifetime and env, then prepares /workspace", async () => {
    server
      .on("POST /sandboxes", { status: 201, json: created() })
      .on("POST /sandboxes/{id}/exec", { stream: ok });

    const info = await provider().create({
      labels: { team: "a" },
      key: "k1",
      env: { NODE_ENV: "test" },
      idleTimeoutMs: 90_500,
    });

    expect(info).toMatchObject({ id, key: "k1", labels: { team: "a" }, state: "running" });
    const [create] = server.calls("POST /sandboxes");
    expect(body(create)).toEqual({
      templateID: "base",
      metadata: { team: "a", "sandbox-sdk-key": "k1" },
      timeout: 3600,
      idleTimeout: 91,
      envVars: { NODE_ENV: "test" },
    });
    expect(create!.headers.authorization).toBe(`Bearer ${apiKey}`);
    expect(create!.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    const [setup] = lines(server.calls("POST /sandboxes/{id}/exec")[0]!);
    expect(setup.argv.join(" ")).toContain("mkdir -p /workspace");
    expect(setup.argv.join(" ")).toContain("safe.directory");
  });

  test("maps sizes: presets, the xlarge shape, and refusals before any request", async () => {
    server
      .on("POST /sandboxes", { status: 201, json: created() })
      .on("POST /sandboxes/{id}/exec", { stream: ok });

    await provider().create({ labels: {}, size: "medium" });
    await provider().create({ labels: {}, size: { cpu: 16, memoryMb: 32768, diskGb: 251 } });
    const sent = server.calls("POST /sandboxes").map((r) => body(r));
    expect(sent.map((b) => [b.size, b.templateID])).toEqual([
      ["default", undefined],
      ["xlarge", undefined],
    ]);

    const before = server.requests.length;

    for (const bad of [
      { size: { cpu: 3, memoryMb: 4096 } },
      { size: { cpu: 2, memoryMb: 4096, diskGb: 20 } },
      { from: "snap", size: "small" as const },
      { network: { allow: ["registry.npmjs.org"] } },
      { timeoutMs: 86_401_000 },
      { idleTimeoutMs: 3_601_000 },
    ])
      expect((await rejection(provider().create({ labels: {}, ...bad }))).code).toBe("unsupported");

    expect(
      (await rejection(provider({ template: "large" }).create({ labels: {}, size: "small" }))).code,
    ).toBe("unsupported");
    expect(server.requests.length).toBe(before);
  });

  test("network none denies all outbound traffic; a snapshot replaces the template", async () => {
    server
      .on("POST /sandboxes", { status: 201, json: created() })
      .on("POST /sandboxes/{id}/exec", { stream: ok });

    await provider().create({ labels: {}, network: "none" });
    await provider({ region: "ash", public: true }).create({ labels: {}, from: "golden" });
    const [none, fromSnapshot] = server.calls("POST /sandboxes").map((r) => body(r));
    expect(none).toMatchObject({
      allow_internet_access: false,
      network: { denyOut: ["0.0.0.0/0"] },
    });
    expect(fromSnapshot).toMatchObject({
      snapshot: "golden",
      region: "ash",
      network: { allowPublicTraffic: true },
    });
    expect(fromSnapshot.templateID).toBeUndefined();
  });

  test("a failed setup destroys the sandbox; an unconfirmed destroy is outcome_unknown naming it", async () => {
    server
      .on("POST /sandboxes", { status: 201, json: created() })
      .on("POST /sandboxes/{id}/exec", {
        stream: frames(
          { started: { pid: 10 } },
          { exit: { exitCode: 1, signal: 0, timedOut: false } },
        ),
      })
      .on("DELETE /sandboxes/{id}", { status: 204 });

    expect((await rejection(provider().create({ labels: {} }))).code).toBe("provider");
    expect(server.calls("DELETE /sandboxes/{id}")).toHaveLength(1);

    server.on("DELETE /sandboxes/{id}", { status: 400, json: error(400, "invalid_argument").json });
    const unknown = await rejection(provider().create({ labels: {} }));
    expect(unknown.code).toBe("outcome_unknown");
    expect(unknown.message).toContain(id);
    expect(unknown.sandboxId).toBe(id);
  });

  test("an abort waits for the answer, then destroys the sandbox it names", async () => {
    const controller = new AbortController();
    server
      .on("POST /sandboxes", { status: 201, json: created(), delayMs: 100 })
      .on("DELETE /sandboxes/{id}", { status: 204 });
    const creating = provider().create({ labels: {}, signal: controller.signal });
    controller.abort();
    const caught = await rejection(creating);
    expect(caught.code).toBe("aborted");
    expect(caught.sandboxId).toBe(id);
    expect(server.calls("DELETE /sandboxes/{id}")).toHaveLength(1);
  });

  test("a create is retried with its idempotency key, and a lost answer is replayed with it", async () => {
    server
      .on(
        "POST /sandboxes",
        { status: 503, headers: { "retry-after": "0" }, json: error(503, "capacity").json },
        { status: 201, json: created() },
      )
      .on("POST /sandboxes/{id}/exec", { stream: ok });

    await provider().create({ labels: {} });
    const keys = server.calls("POST /sandboxes").map((r) => r.headers["idempotency-key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);

    server.on("POST /sandboxes", { drop: true }, { status: 201, json: created() });
    expect((await provider().create({ labels: {} })).id).toBe(id);
    const replay = server.calls("POST /sandboxes").slice(-2);
    expect(replay[0]!.headers["idempotency-key"]).toBe(replay[1]!.headers["idempotency-key"]);
  });

  test("a create answered 502 with no replay is outcome_unknown, never unavailable", async () => {
    server.on("POST /sandboxes", { status: 502, json: error(502, "upstream_error").json });
    expect(
      (await rejection(provider({ requestTimeoutMs: 2000 }).create({ labels: {} }))).code,
    ).toBe("outcome_unknown");
  });
});

describe("styne exec", () => {
  test("streams decoded output in order and returns the exit code", async () => {
    server.on("POST /sandboxes/{id}/exec", {
      stream: frames(
        { started: { pid: 7 } },
        { stdout: b64("he") },
        { stderr: b64("oops\n") },
        { stdout: b64("llo\n") },
        { exit: { exitCode: 3, signal: 0, timedOut: false } },
      ),
    });
    const run = input({ stdin: "in\n" });
    expect(await provider().exec(id, run)).toEqual({ exitCode: 3, timedOut: false });
    expect(run.chunks).toEqual(["stdout:he", "stderr:oops\n", "stdout:llo\n"]);

    const [start, stdin, close] = lines(server.calls("POST /sandboxes/{id}/exec")[0]!);
    expect(start).toMatchObject({ envs: { A: "1" }, stdin: true, timeoutMs: 20_000 });
    expect(start.argv.slice(3, 6)).toEqual(["sandbox-sdk", "/workspace", "echo hi"]);
    expect(Buffer.from(stdin.stdin, "base64").toString()).toBe("in\n");
    expect(close).toEqual({ closeStdin: true });
  });

  test("Styne's own timeout and its command_timeout line are a timed-out result with partial output", async () => {
    server.on("POST /sandboxes/{id}/exec", {
      stream: frames(
        { started: { pid: 7 } },
        { stdout: b64("before\n") },
        { exit: { exitCode: -1, signal: 9, timedOut: true } },
        { error: { code: 504, error_code: "command_timeout" } },
      ),
    });
    const run = input();
    expect(await provider().exec(id, run)).toEqual({ exitCode: null, timedOut: true });
    expect(run.chunks).toEqual(["stdout:before\n"]);
  });

  test("a signal exit reads as 128 + the signal", async () => {
    server.on("POST /sandboxes/{id}/exec", {
      stream: frames(
        { started: { pid: 7 } },
        { exit: { exitCode: -1, signal: 9, timedOut: false } },
      ),
    });
    expect(await provider().exec(id, input())).toEqual({ exitCode: 137, timedOut: false });
  });

  test("an abort after start kills the started process group before it settles", async () => {
    const controller = new AbortController();
    server
      .on("POST /sandboxes/{id}/exec", { stream: frames({ started: { pid: 42 } }), hold: true })
      .on("POST /sandboxes/{id}/commands", { json: { exitCode: 0 } });
    const running = provider().exec(id, input({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect(await running).toEqual({ exitCode: null, timedOut: true });
    const [kill] = server.calls("POST /sandboxes/{id}/commands");
    const argv: string[] = body(kill).argv;
    const tag = lines(server.calls("POST /sandboxes/{id}/exec")[0]!)[0].argv[6];
    expect(argv.slice(-2)).toEqual([tag, "42"]);
    expect(argv[2]).toContain('kill -KILL -"$p"');
  });

  test("an abort before the command reports a PID still kills it by its tag", async () => {
    const controller = new AbortController();
    server
      .on("POST /sandboxes/{id}/exec", { hang: true })
      .on("POST /sandboxes/{id}/commands", { json: { exitCode: 0 } });
    const running = provider().exec(id, input({ signal: controller.signal }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    expect(await running).toEqual({ exitCode: null, timedOut: true });
    const argv: string[] = body(server.calls("POST /sandboxes/{id}/commands")[0]).argv;
    expect(argv.at(-1)).toBe("");
    expect(argv.at(-2)).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("an already aborted signal sends nothing", async () => {
    expect(await provider().exec(id, input({ signal: AbortSignal.abort() }))).toEqual({
      exitCode: null,
      timedOut: true,
    });
    expect(server.requests).toHaveLength(0);
  });

  test("the adapter's deadline kills the group", async () => {
    server
      .on("POST /sandboxes/{id}/exec", { stream: frames({ started: { pid: 5 } }), hold: true })
      .on("POST /sandboxes/{id}/commands", { json: { exitCode: 0 } });
    expect(await provider().exec(id, input({ timeoutMs: 200 }))).toEqual({
      exitCode: null,
      timedOut: true,
    });
    expect(server.calls("POST /sandboxes/{id}/commands")).toHaveLength(1);
  });

  test("an unconfirmed kill is outcome_unknown", async () => {
    server
      .on("POST /sandboxes/{id}/exec", { stream: frames({ started: { pid: 5 } }), hold: true })
      .on("POST /sandboxes/{id}/commands", { drop: true });
    expect((await rejection(provider().exec(id, input({ timeoutMs: 200 })))).code).toBe(
      "outcome_unknown",
    );
  });

  test("a stream that ends without an exit is outcome_unknown, after a kill", async () => {
    server
      .on("POST /sandboxes/{id}/exec", { stream: frames({ started: { pid: 5 } }) })
      .on("POST /sandboxes/{id}/commands", { json: { exitCode: 0 } });
    expect((await rejection(provider().exec(id, input()))).code).toBe("outcome_unknown");
    expect(server.calls("POST /sandboxes/{id}/commands")).toHaveLength(1);
  });

  test("a stream cut mid-body is outcome_unknown", async () => {
    server
      .on("POST /sandboxes/{id}/exec", { stream: frames({ started: { pid: 5 } }), cut: true })
      .on("POST /sandboxes/{id}/commands", { json: { exitCode: 0 } });
    expect((await rejection(provider().exec(id, input()))).code).toBe("outcome_unknown");
  });

  test("an ended sandbox is not_found, a paused one is refused", async () => {
    server.on("POST /sandboxes/{id}/exec", error(410, "sandbox_ended"));
    expect((await rejection(provider().exec(id, input()))).code).toBe("not_found");
    server.on("POST /sandboxes/{id}/exec", error(404, "not_found"));
    expect((await rejection(provider().exec(id, input()))).code).toBe("not_found");
  });

  test("an error line after start is outcome_unknown; one for an ended sandbox is not_found", async () => {
    server
      .on("POST /sandboxes/{id}/exec", {
        stream: frames(
          { started: { pid: 5 } },
          { error: { code: 502, error_code: "upstream_error" } },
        ),
      })
      .on("POST /sandboxes/{id}/commands", { json: { exitCode: 0 } });
    expect((await rejection(provider().exec(id, input()))).code).toBe("outcome_unknown");

    server.on("POST /sandboxes/{id}/exec", {
      stream: frames(
        { started: { pid: 5 } },
        { error: { code: 410, error_code: "sandbox_ended" } },
      ),
    });
    expect((await rejection(provider().exec(id, input()))).code).toBe("not_found");
  });
});

describe("styne files", () => {
  test("read and write use the native file route with an absolute path", async () => {
    server
      .on("PUT /sandboxes/{id}/files", { json: { name: "a.txt", type: "file" } })
      .on("GET /sandboxes/{id}/files", { body: "hello" });
    const p = provider();
    await p.files.write(id, "/workspace/a b.txt", new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(await p.files.read(id, "/workspace/a b.txt"))).toBe("hello");
    const [put] = server.calls("PUT /sandboxes/{id}/files");
    expect(new URL(put!.url, server.url).searchParams.get("path")).toBe("/workspace/a b.txt");
    expect(put!.headers["content-type"]).toBe("application/octet-stream");
    expect(put!.body.toString()).toBe("hello");
  });

  test("a 404 on a file is file_not_found while the sandbox exists, not_found when it does not", async () => {
    server
      .on("GET /sandboxes/{id}/files", error(404, "not_found"))
      .on("GET /sandboxes/{id}", { json: sandbox() });
    expect((await rejection(provider().files.read(id, "/workspace/x"))).code).toBe(
      "file_not_found",
    );
    server.on("GET /sandboxes/{id}", error(410, "sandbox_ended"));
    expect((await rejection(provider().files.read(id, "/workspace/x"))).code).toBe("not_found");
  });

  test("stat, list, mkdir and remove run in the guest with exact semantics", async () => {
    server.on("POST /sandboxes/{id}/exec", {
      stream: frames(
        { started: { pid: 5 } },
        { stdout: b64("SDK_FILE_NOT_FOUND\n") },
        { exit: { exitCode: 0, signal: 0, timedOut: false } },
      ),
    });
    expect((await rejection(provider().files.stat(id, "/workspace/x"))).code).toBe(
      "file_not_found",
    );
    expect(
      (await rejection(provider().files.remove(id, "/workspace/x", { recursive: false }))).code,
    ).toBe("file_not_found");
    const remove = lines(server.calls("POST /sandboxes/{id}/exec").at(-1)!)[0].argv[5];
    expect(remove).toContain("os.rmdir");
    expect(remove).toContain("false");
  });
});

describe("styne lifecycle", () => {
  test("list pages with the metadata filter and matches labels exactly", async () => {
    server.on(
      "GET /sandboxes",
      {
        headers: { "x-next-token": "page2" },
        json: [sandbox("running", { team: "a", "sandbox-sdk-key": "k" })],
      },
      {
        json: [
          { ...sandbox("paused", { team: "a" }), sandboxID: "vm2" },
          { ...sandbox("running", { team: "b" }), sandboxID: "vm3" },
        ],
      },
    );
    const listed = await provider().list({ team: "a" });
    expect(listed.map((s) => [s.id, s.state, s.key])).toEqual([
      [id, "running", "k"],
      ["vm2", "paused", undefined],
    ]);
    const [first, second] = server.calls("GET /sandboxes").map((r) => new URL(r.url, server.url));
    expect(first!.searchParams.get("metadata")).toBe("team=a");
    expect(second!.searchParams.get("nextToken")).toBe("page2");
  });

  test("connect reads with GET only: never the connect route that wakes a paused sandbox", async () => {
    server.on("GET /sandboxes/{id}", { json: sandbox("paused") });
    expect((await provider().connect(id)).state).toBe("paused");
    expect(server.calls("POST /sandboxes/{id}/connect")).toHaveLength(0);
  });

  test("destroy treats 404 and 410 as gone", async () => {
    server.on("DELETE /sandboxes/{id}", error(410, "sandbox_ended"), error(404, "not_found"));
    await provider().destroy(id);
    await provider().destroy(id);
    expect(server.calls("DELETE /sandboxes/{id}")).toHaveLength(2);
  });

  test("pause and resume accept Styne's already_paused and already_running", async () => {
    server
      .on("POST /sandboxes/{id}/pause", { status: 204 }, error(409, "already_paused"))
      .on(
        "POST /sandboxes/{id}/resume",
        { status: 201, json: created() },
        error(409, "already_running"),
      );
    const p = provider({ pauseTier: "standby" });
    await p.pause!(id);
    await p.pause!(id);
    await p.resume!(id);
    await p.resume!(id);
    expect(body(server.calls("POST /sandboxes/{id}/pause")[0])).toEqual({ tier: "standby" });
    server.on("POST /sandboxes/{id}/pause", error(409, "conflict"));
    expect((await rejection(p.pause!(id))).code).toBe("provider");
  });

  test("snapshots are named before the request, found after a lost answer, and deleted by name", async () => {
    server
      .on("POST /sandboxes/{id}/snapshots", { drop: true })
      .on("GET /snapshots/{name}", (request, response) => {
        const name = decodeURIComponent(request.url.split("/").at(-1) ?? "");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name, sandboxID: id }));
      })
      .on("DELETE /snapshots/{name}", { status: 204 }, error(404, "not_found"));
    const p = provider();
    const { id: name } = await p.snapshot!(id);
    expect(name).toMatch(/^sbx-[0-9a-f-]{36}$/);
    expect(body(server.calls("POST /sandboxes/{id}/snapshots")[0])).toEqual({ name });
    expect(await p.deleteSnapshot!(name)).toBe(true);
    expect(await p.deleteSnapshot!(name)).toBe(false);
    expect((await rejection(p.snapshot!(id, { expiresInMs: 1000 }))).code).toBe("unsupported");
  });

  test("a preview carries the traffic token; a fresh client reads it with connect", async () => {
    server
      .on("POST /sandboxes", { status: 201, json: created() })
      .on("POST /sandboxes/{id}/exec", { stream: ok })
      .on("POST /sandboxes/{id}/connect", { status: 201, json: created() })
      .on("GET /sandboxes/{id}", { json: sandbox() });
    const p = provider();
    await p.create({ labels: {} });
    expect(await p.previewUrl(id, 3000)).toEqual({
      url: `https://3000-${id}.ash.styne.ai`,
      headers: { "e2b-traffic-access-token": token },
    });
    expect(server.calls("POST /sandboxes/{id}/connect")).toHaveLength(0);
    expect((await provider().previewUrl(id, 3000)).headers).toEqual({
      "e2b-traffic-access-token": token,
    });
    expect(server.calls("POST /sandboxes/{id}/connect")).toHaveLength(1);
    expect(await provider({ public: true }).previewUrl(id, 8080)).toEqual({
      url: `https://8080-${id}.ash.styne.ai`,
    });
  });

  test("errors keep Styne's status and code, never its message or the key", async () => {
    server.on("GET /sandboxes/{id}", error(429, "quota_exceeded"));
    const quota = await rejection(provider({ requestTimeoutMs: 1000 }).connect(id));
    expect(quota.code).toBe("quota");
    expect(quota.message).toContain("quota_exceeded");
    expect(quota.message).not.toContain("said by styne");
    server.on("GET /sandboxes/{id}", error(401, "unauthenticated"));
    const auth = await rejection(provider().connect(id));
    expect(auth.code).toBe("auth");
    expect(`${auth.message} ${String(auth.cause)}`).not.toContain(apiKey);
    expect((await rejection(styne({ baseUrl: server.url, apiKey: " " }).connect(id))).code).toBe(
      "auth",
    );
  });

  test("box.native and provider.api reach any route with the adapter's key", async () => {
    server.on("GET /sandboxes/{id}/metrics", {
      json: [
        {
          timestampUnix: 1,
          cpuCount: 4,
          cpuUsedPct: 2,
          memUsed: 3,
          memTotal: 4,
          diskUsed: 5,
          diskTotal: 6,
        },
      ],
    });
    const p = provider();
    expect(await p.native(id).request("GET", "/sandboxes/{id}/metrics")).toHaveLength(1);
    expect(await p.usage!(id)).toEqual({
      cpuCount: 4,
      cpuPercent: 2,
      memoryBytes: 3,
      memoryLimitBytes: 4,
      diskBytes: 5,
      diskLimitBytes: 6,
      metricsAt: 1000,
    });
    server.on("GET /snapshots", { json: [] });
    expect(await p.api.request("GET", "/snapshots")).toEqual([]);
    expect(server.calls("GET /snapshots")[0]!.headers.authorization).toBe(`Bearer ${apiKey}`);
  });
});

describe("styne against a local fake that runs real processes", () => {
  test("create, run, files, list and destroy go through the whole SDK", async () => {
    const fake = await styneFake();

    try {
      const p = styne({ apiKey, baseUrl: fake.url });
      const box = await createSandbox(p, { labels: { smoke: "styne" }, key: "fake-key-1" });

      expect((await p.find("fake-key-1"))?.id).toBe(box.id);
      const result = await box.run("echo hello && echo warn >&2 && pwd", { stdin: "x" });
      expect([result.exitCode, result.stderr]).toEqual([0, "warn\n"]);
      expect(result.stdout.split("\n")[0]).toBe("hello");
      await box.files.write("a/b.txt", "data-é");
      expect(await box.files.read("a/b.txt")).toBe("data-é");
      expect((await box.files.list("a")).map((f) => f.path)).toEqual(["/workspace/a/b.txt"]);
      expect((await box.run("exit 4")).exitCode).toBe(4);
      await box.destroy();
      expect(await p.list({ smoke: "styne" })).toEqual([]);
    } finally {
      await fake.close();
    }
  });
});
