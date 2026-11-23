import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createSandbox } from "../src/index.js";
import { SandboxError } from "../src/errors.js";
import type { Fetch } from "../src/http.js";
import type { CreateInput, ExecInput } from "../src/provider.js";
import type { JsonValue } from "../src/shared/json.js";
import {
  maritime,
  type MaritimeOptions,
  type MaritimeSdkModule,
} from "../src/providers/maritime/index.js";
import { commandSeconds, killer, wrapper } from "../src/providers/maritime/exec.js";
import { fakeServer, type FakeServer } from "./http-fake.js";
import { maritimeFake, type MaritimeFake } from "./maritime-fake.js";

let fake: MaritimeFake;

beforeEach(async () => {
  fake = await maritimeFake();
});

afterEach(async () => {
  await fake.close();
});

const apiKey = "fake-key";

const provider = (options: MaritimeOptions = {}) =>
  maritime({ apiKey, baseUrl: fake.url, requestTimeoutMs: 10_000, ...options });

const isStream = (init: RequestInit) =>
  new Headers(init.headers).get("accept") === "text/event-stream";

const isCommand = (url: string, init: RequestInit) =>
  init.method === "POST" && /\/dp\/[^/]+\/v1\/commands$/.test(new URL(url).pathname);

const streamCalls = () =>
  fake.requests.filter(
    (r) => r.path.endsWith("/commands") && r.headers.accept === "text/event-stream",
  );

const killCalls = () =>
  fake.requests.filter((r) => r.path.endsWith("/commands") && r.body.includes("read -r p"));

/** An exec input that collects output. */
function execInput(command: string, extra: Partial<ExecInput> = {}) {
  const out: string[] = [];

  const input: ExecInput = {
    command,
    cwd: "/workspace",
    env: {},
    timeoutMs: 10_000,
    onChunk: (chunk) => out.push(chunk.text),
    ...extra,
  };

  return { input, out };
}

/** Whether a host process is alive, for checks that a killed group is gone. */
function alive(pid: number) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

/** What the stand-in maritime-sdk client saw. */
interface SeenSdk {
  options?: object;
  got?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("maritime create", () => {
  test("sends from, metadata with the key and an allocation marker, a time limit and an idempotency key; never a name", async () => {
    const p = provider();
    const info = await p.create({ key: "k1", labels: { team: "a" } });
    const create = fake.requests.find((r) => r.method === "POST" && r.path === "/v1/sandboxes");

    expect(create).toBeDefined();
    const body = JSON.parse(create?.body ?? "{}");
    expect(body.name).toBeUndefined();
    expect(body.from).toBe("base");
    expect(body.timeLimitSeconds).toBe(3600);
    expect(body.idleTimeoutSeconds).toBeUndefined();
    expect(body.metadata).toMatchObject({ team: "a", "sandbox-sdk-key": "k1" });
    expect(body.metadata["sandbox-sdk-alloc"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(create?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

    expect(info).toMatchObject({ key: "k1", labels: { team: "a" }, state: "running" });
    // The allocation marker never shows as a label.
    expect((await p.connect(info.id)).labels).toEqual({ team: "a" });
    expect((await p.find("k1"))?.id).toBe(info.id);
  });

  test("maps sizes, timers and network; refuses what Maritime cannot honour before any request", async () => {
    const bodies: JsonValue[] = [];

    const recording: Fetch = async (url, init) => {
      if (init.method === "POST" && new URL(url).pathname === "/v1/sandboxes")
        bodies.push(JSON.parse(String(init.body)));

      return fetch(url, init);
    };

    const p = provider({ fetch: recording });

    await p.create({ labels: {}, size: "large", network: "none", idleTimeoutMs: 90_000 });
    await p.create({ labels: {}, size: { cpu: 4, memoryMb: 8192 } });
    await p.create({
      labels: {},
      size: { cpu: 3, memoryMb: 6144, diskGb: 20 },
      network: { allow: [] },
    });
    await p.create({
      labels: {},
      size: { cpu: 16, memoryMb: 32768, diskGb: 250 },
      timeoutMs: 5000,
    });

    expect(bodies[0]).toMatchObject({
      size: "large",
      network: { egress: "none" },
      idleTimeoutSeconds: 90,
    });
    // An exact preset with no disk asked for gets the preset's disk (medium: 50 GiB).
    expect(bodies[1]).toMatchObject({ size: "medium" });
    expect(bodies[1]).not.toHaveProperty("vcpu");
    expect(bodies[2]).toMatchObject({
      vcpu: 3,
      memoryMib: 6144,
      diskGib: 20,
      network: { egress: "none" },
    });
    expect(bodies[3]).toMatchObject({ size: "xlarge", timeLimitSeconds: 5 });

    const before = fake.requests.length;

    const refused: Omit<CreateInput, "labels">[] = [
      { size: { cpu: 2, memoryMb: 3000 } },
      { size: { cpu: 17, memoryMb: 4096 } },
      { size: { cpu: 2, memoryMb: 4096, diskGb: 4 } },
      { network: { allow: ["registry.npmjs.org"] } },
      { idleTimeoutMs: 10_000 },
      { timeoutMs: 90_000_000 },
    ];

    for (const input of refused)
      await expect(p.create({ labels: {}, ...input })).rejects.toMatchObject({
        code: "unsupported",
      });

    expect(fake.requests.length).toBe(before);
  });

  test("prepares a writable /workspace and the exec directory", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    const sandbox = fake.sandboxes.get(id);

    expect(sandbox).toBeDefined();

    const { input, out } = execInput(
      "test -w /workspace && test -d /tmp/.sandbox-sdk/exec && echo ok",
    );

    expect(await p.exec(id, input)).toEqual({ exitCode: 0, timedOut: false });
    expect(out.join("")).toBe("ok\n");
  });

  test("a lost create answer is replayed with the same idempotency key and returns the one sandbox", async () => {
    let dropped = false;

    const losing: Fetch = async (url, init) => {
      const response = await fetch(url, init);

      if (!dropped && init.method === "POST" && new URL(url).pathname === "/v1/sandboxes") {
        dropped = true;
        await response.body?.cancel();
        throw new TypeError("fetch failed");
      }

      return response;
    };

    const info = await provider({ fetch: losing }).create({ labels: {} });
    const creates = fake.requests.filter((r) => r.method === "POST" && r.path === "/v1/sandboxes");

    expect(creates).toHaveLength(2);
    expect(creates[1]?.headers["idempotency-key"]).toBe(creates[0]?.headers["idempotency-key"]);
    expect(fake.sandboxes.size).toBe(1);
    expect(fake.sandboxes.has(info.id)).toBe(true);
  });

  test("when the replay fails too, the sandbox is found by this call's allocation marker", async () => {
    let creates = 0;

    const losing: Fetch = async (url, init) => {
      if (init.method === "POST" && new URL(url).pathname === "/v1/sandboxes") {
        creates++;

        if (creates === 1) {
          await (await fetch(url, init)).body?.cancel();
          throw new TypeError("fetch failed");
        }

        // The replay is refused outright.
        return new Response(JSON.stringify({ code: "rate_limited" }), { status: 429 });
      }

      return fetch(url, init);
    };

    const info = await provider({ fetch: losing }).create({ labels: {} });

    expect(fake.sandboxes.size).toBe(1);
    expect(info.id).toBe([...fake.sandboxes.keys()][0]);
    expect(fake.requests.some((r) => r.path.includes("metadata%5Bsandbox-sdk-alloc%5D="))).toBe(
      true,
    );
  });

  test("an abort while the create is in flight ends the sandbox it names on a fresh deadline", async () => {
    const controller = new AbortController();

    const aborting: Fetch = async (url, init) => {
      const response = await fetch(url, init);

      if (init.method === "POST" && new URL(url).pathname === "/v1/sandboxes") controller.abort();

      return response;
    };

    await expect(
      provider({ fetch: aborting }).create({ labels: {}, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });

    const [sandbox] = [...fake.sandboxes.values()];
    expect(sandbox?.state).toBe("ended");
  });

  test("a failed setup ends the sandbox; an unconfirmed end is outcome_unknown naming it", async () => {
    const failing: Fetch = async (url, init) => {
      if (isCommand(url, init))
        return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });

      return fetch(url, init);
    };

    await expect(provider({ fetch: failing }).create({ labels: {} })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect([...fake.sandboxes.values()].every((s) => s.state === "ended")).toBe(true);

    const stuck: Fetch = async (url, init) => {
      if (isCommand(url, init))
        return new Response(JSON.stringify({ code: "invalid_request" }), { status: 400 });

      if (init.method === "DELETE") throw new TypeError("fetch failed");

      return fetch(url, init);
    };

    const error = await provider({ fetch: stuck })
      .create({ labels: {} })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SandboxError);
    expect(error).toMatchObject({ code: "outcome_unknown" });
    expect(error instanceof SandboxError && error.message).toMatch(/sbx-/);
  }, 30_000);
});

describe("maritime create ownership against scripted answers", () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await fakeServer();
  });

  afterEach(async () => {
    await server.close();
  });

  const scripted = () => maritime({ apiKey, baseUrl: server.url, requestTimeoutMs: 5000 });

  const sandbox = (metadata: Record<string, string>) => ({
    id: "sbx-other",
    state: "running",
    metadata,
    createdAt: "2026-11-23T20:46:00Z",
    dataPlaneUrl: `${server.url}/dp/sbx-other/v1`,
    secret: "mst_other_secret_0123456789",
    urlToken: "mut_other_token_0123456789",
  });

  test("an answer naming a sandbox without this call's marker is outcome_unknown, and nothing is ended", async () => {
    server.on("POST /v1/sandboxes", {
      status: 200,
      json: sandbox({ "sandbox-sdk-alloc": "another-call" }),
    });

    const error = await scripted()
      .create({ labels: {} })
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "outcome_unknown" });
    expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(0);
    expect(server.calls("POST /dp/{id}/v1/commands")).toHaveLength(0);
    // The other caller's credentials never show in the error.
    expect(String(error)).not.toContain("mst_other");
  });

  test("a create Maritime refused for capacity is tried again with a new idempotency key", async () => {
    server.on(
      "POST /v1/sandboxes",
      {
        status: 503,
        json: { code: "out_of_capacity", sandboxId: "sbx-failed", retryAfterSeconds: 30 },
        headers: { "retry-after": "30" },
      },
      (request, response) => {
        const body = JSON.parse(request.body.toString());
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ...sandbox(body.metadata),
            id: "sbx-made",
            dataPlaneUrl: `${server.url}/dp/sbx-made/v1`,
          }),
        );
      },
    );
    server.on("POST /dp/{id}/v1/commands", {
      stream: [
        `event: result\ndata: ${JSON.stringify({ state: "exited", exitCode: 0, signal: null })}\n\n`,
      ],
      headers: { "content-type": "text/event-stream" },
    });

    const info = await scripted().create({ labels: {} });
    const keys = server.calls("POST /v1/sandboxes").map((r) => r.headers["idempotency-key"]);

    expect(info.id).toBe("sbx-made");
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  }, 20_000);

  test("a create answered 500 with an unreadable replay is outcome_unknown and ends nothing", async () => {
    server.on(
      "POST /v1/sandboxes",
      { status: 500, json: { code: "internal_error" } },
      { status: 200, body: "not json" },
    );
    server.on("GET /v1/sandboxes", { status: 200, json: { data: [], nextCursor: null } });

    await expect(scripted().create({ labels: {} })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(0);
  });
});

describe("maritime exec", () => {
  test("streams output in order and returns the exit code; env, stdin and cwd apply", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    const { input, out } = execInput('echo "$A"; pwd; cat; exit 3', {
      env: { A: "from-env" },
      stdin: "piped",
    });

    expect(await p.exec(id, input)).toEqual({ exitCode: 3, timedOut: false });
    expect(out.join("")).toBe("from-env\n/workspace\npiped");
  });

  test("runs every command in its own process group through setsid", () => {
    expect(wrapper).toContain('echo $$ > "$t"');
    // The PID is recorded before the cancel marker is checked, and the killer writes the marker before reading.
    expect(wrapper.indexOf('echo $$ > "$t"')).toBeLessThan(wrapper.indexOf('"$t.cancel"'));
    expect(killer.indexOf(': > "$t.cancel"')).toBeLessThan(killer.indexOf('read -r p < "$t"'));
    expect(commandSeconds(5000)).toBe(15);
    expect(commandSeconds(10 * 3_600_000)).toBe(3600);
  });

  test("a timeout kills the whole group, children included, before it settles", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    const { input } = execInput(
      "sleep 30 & echo $! > /workspace/child; echo $$ > /workspace/pid; sleep 30; touch /workspace/late",
      { timeoutMs: 1500 },
    );

    expect(await p.exec(id, input)).toEqual({ exitCode: null, timedOut: true });
    const root = fake.sandboxes.get(id)?.root ?? "";

    for (const file of ["pid", "child"]) {
      const pid = Number(await readFile(join(root, "workspace", file), "utf8"));
      expect(alive(pid)).toBe(false);
    }

    expect(killCalls().length).toBeGreaterThan(0);
  });

  test("an abort before the command registered its PID stops it from ever running", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let late: Promise<Response> | undefined;

    // Holds the command's stream request until after the cancel, then delivers it anyway: a request that
    // reaches the guest after the killer ran.
    const holding: Fetch = async (url, init) => {
      if (isCommand(url, init) && isStream(init)) {
        late = gate.then(() => fetch(url, { ...init, signal: null }));

        return new Promise<Response>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          ),
        );
      }

      return fetch(url, init);
    };

    const held = maritime({ apiKey, baseUrl: fake.url, fetch: holding });
    const controller = new AbortController();
    const { input } = execInput("touch /workspace/ran", { signal: controller.signal });
    const running = held.exec(id, input);

    await sleep(100);
    controller.abort();
    expect(await running).toEqual({ exitCode: null, timedOut: true });
    expect(killCalls()).toHaveLength(1);

    release();
    const response = await late;
    const text = await response?.text();

    // The wrapper found the cancel marker and exited 137 without running the command.
    expect(text).toContain('"exitCode":137');
    await expect(
      readFile(join(fake.sandboxes.get(id)?.root ?? "", "workspace", "ran")),
    ).rejects.toThrow();
  });

  test("a stream that breaks after the command started is outcome_unknown, kills the group and is never sent again", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    // Passes the first event, then breaks the connection.
    const breaking: Fetch = async (url, init) => {
      const response = await fetch(url, init);

      if (!isCommand(url, init) || !isStream(init) || !response.body) return response;
      const reader = response.body.getReader();
      let sent = false;

      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent) {
            await reader.cancel();
            controller.error(new TypeError("terminated"));

            return;
          }

          const { value, done } = await reader.read();

          if (done) controller.close();
          else {
            sent = true;
            controller.enqueue(value);
          }
        },
      });

      return new Response(body, { status: response.status, headers: response.headers });
    };

    const broken = maritime({ apiKey, baseUrl: fake.url, fetch: breaking });
    const { input, out } = execInput("echo $$ > /workspace/pid; echo started; sleep 30");
    const before = streamCalls().length;

    await expect(broken.exec(id, input)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(out.join("")).toBe("started\n");
    // One stream request: output was emitted, so the command is never replayed.
    expect(streamCalls().length - before).toBe(1);
    expect(killCalls().length).toBeGreaterThan(0);

    const pid = Number(
      await readFile(join(fake.sandboxes.get(id)?.root ?? "", "workspace", "pid"), "utf8"),
    );

    expect(alive(pid)).toBe(false);
  });

  test("a connection that fails after the request was sent is never sent again", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    const cut: Fetch = async (url, init) => {
      if (isCommand(url, init) && isStream(init)) {
        void fetch(url, init).catch(() => {});
        await sleep(200);
        throw new TypeError("fetch failed");
      }

      return fetch(url, init);
    };

    const before = streamCalls().length;
    const { input } = execInput("sleep 20");

    await expect(
      maritime({ apiKey, baseUrl: fake.url, fetch: cut }).exec(id, input),
    ).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(streamCalls().length - before).toBe(1);
    expect(killCalls().length).toBeGreaterThan(0);
  });

  test("a request that never left this process is sent again", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    let refused = false;

    const refusing: Fetch = async (url, init) => {
      if (!refused && isCommand(url, init) && isStream(init)) {
        refused = true;
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
      }

      return fetch(url, init);
    };

    const { input, out } = execInput("echo once");

    expect(await maritime({ apiKey, baseUrl: fake.url, fetch: refusing }).exec(id, input)).toEqual({
      exitCode: 0,
      timedOut: false,
    });
    expect(out.join("")).toBe("once\n");
  });

  test("a rotated secret is read again after a 401, before anything ran", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    const sandbox = fake.sandboxes.get(id);

    if (!sandbox) throw new Error("no sandbox");
    sandbox.secret = "mst_rotated_secret_0123456789";
    const { input, out } = execInput("echo after-rotation");

    expect(await p.exec(id, input)).toEqual({ exitCode: 0, timedOut: false });
    expect(out.join("")).toBe("after-rotation\n");
  });

  test("an already aborted signal sends nothing", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    const before = fake.requests.length;
    const { input } = execInput("true", { signal: AbortSignal.abort() });

    expect(await p.exec(id, input)).toEqual({ exitCode: null, timedOut: true });
    expect(fake.requests.length).toBe(before);
  });
});

describe("maritime exec against scripted streams", () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await fakeServer();
    server.on("GET /v1/sandboxes/{id}", {
      json: {
        id: "sbx-s",
        state: "running",
        metadata: {},
        createdAt: "2026-11-23T20:46:00Z",
        dataPlaneUrl: `${server.url}/dp/sbx-s/v1`,
        secret: "mst_scripted_secret_0123456789",
        urlToken: "mut_scripted_token_0123456789",
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const scripted = () => maritime({ apiKey, baseUrl: server.url, requestTimeoutMs: 5000 });

  const event = (name: string, data: JsonValue) =>
    `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

  const sse = { "content-type": "text/event-stream" };
  const killed = { json: { state: "exited", exitCode: 0, signal: null } };

  const streamThen = (stream: string[], ...kills: object[]) =>
    server.on(
      "POST /dp/{id}/v1/commands",
      (request, response) => {
        response.writeHead(200, sse);
        response.end(stream.join(""));
        void request;
      },
      ...(kills.length ? kills : [killed]),
    );

  test("Maritime's own command_timeout still kills the group and reads as timed out", async () => {
    streamThen([
      event("stdout", "partial\n"),
      event("error", {
        code: "command_timeout",
        command: { state: "killed", exitCode: null, signal: "SIGKILL" },
      }),
    ]);
    const { input, out } = execInput("sleep 100");

    expect(await scripted().exec("sbx-s", input)).toEqual({ exitCode: null, timedOut: true });
    expect(out.join("")).toBe("partial\n");
    expect(server.calls("POST /dp/{id}/v1/commands")).toHaveLength(2);
  });

  test("a result killed by a signal reads as 128 + the signal", async () => {
    streamThen([event("result", { state: "killed", exitCode: null, signal: "SIGTERM" })]);

    expect(await scripted().exec("sbx-s", execInput("x").input)).toEqual({
      exitCode: 143,
      timedOut: false,
    });
  });

  test("a stream that ends without a result is outcome_unknown, after a kill", async () => {
    streamThen([event("stdout", "a")]);

    await expect(scripted().exec("sbx-s", execInput("x").input)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    expect(server.calls("POST /dp/{id}/v1/commands")).toHaveLength(2);
  });

  test.each([
    [
      "a result that is still running",
      [event("result", { state: "running", exitCode: null, signal: null })],
    ],
    ["output that is not text", [event("stdout", { not: "text" })]],
    ["an event that is not JSON", ["event: stdout\ndata: {oops\n\n"]],
    ["an error after start", [event("stdout", "x"), event("error", { code: "internal_error" })]],
  ])("%s is outcome_unknown", async (_name, stream) => {
    streamThen(stream);

    await expect(scripted().exec("sbx-s", execInput("x").input)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  });

  test("an error event for an ended sandbox is not_found", async () => {
    streamThen([event("error", { code: "sandbox_ended" })]);

    await expect(scripted().exec("sbx-s", execInput("x").input)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("a kill that does not exit 0 does not confirm the cancel: outcome_unknown, not a clean timeout", async () => {
    server.on(
      "POST /dp/{id}/v1/commands",
      { stream: [event("stdout", "x")], hold: true, headers: sse },
      { json: { state: "exited", exitCode: 1, signal: null } },
    );

    const error = await scripted()
      .exec("sbx-s", execInput("sleep 100", { timeoutMs: 300 }).input)
      .catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "outcome_unknown" });
    // Two kill attempts, each on its own deadline.
    expect(server.calls("POST /dp/{id}/v1/commands")).toHaveLength(3);
  });

  test("a sandbox still waking is refused before anything runs, so the command is sent again", async () => {
    server.on(
      "POST /dp/{id}/v1/commands",
      { status: 409, json: { code: "sandbox_paused" } },
      (request, response) => {
        response.writeHead(200, sse);
        response.end(event("result", { state: "exited", exitCode: 0, signal: null }));
        void request;
      },
    );

    expect(await scripted().exec("sbx-s", execInput("x").input)).toEqual({
      exitCode: 0,
      timedOut: false,
    });
  });

  test("a write answered with a 5xx Maritime does not document as a refusal is outcome_unknown", async () => {
    server.on(
      "POST /dp/{id}/v1/commands",
      { status: 502, json: { code: "internal_error" } },
      killed,
    );

    await expect(scripted().exec("sbx-s", execInput("x").input)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  });
});

describe("maritime lifecycle", () => {
  test("connect and list never return an ended sandbox; destroy is safe to repeat", async () => {
    const p = provider();
    const { id } = await p.create({ labels: { suite: "x" } });

    expect((await p.list({ suite: "x" })).map((s) => s.id)).toEqual([id]);
    await p.destroy(id);
    await p.destroy(id);
    await expect(p.connect(id)).rejects.toMatchObject({ code: "not_found" });
    expect(await p.list({ suite: "x" })).toEqual([]);
    await expect(p.connect("sbx-missing")).rejects.toMatchObject({ code: "not_found" });

    const listing = fake.requests.find(
      (r) => r.method === "GET" && r.path.startsWith("/v1/sandboxes?"),
    );

    const query = new URL(listing?.path ?? "/", "http://x").searchParams;
    expect(query.getAll("state")).not.toContain("ended");
    expect(query.get("metadata[suite]")).toBe("x");
  });

  test("pause, then resume wakes the sandbox through the data plane", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    await p.pause?.(id);
    expect((await p.connect(id)).state).toBe("paused");
    await p.pause?.(id);
    await p.resume?.(id);
    expect((await p.connect(id)).state).toBe("running");
    expect(fake.requests.some((r) => r.path.includes("/resume"))).toBe(false);
  });

  test("snapshots are named before the request, restore files and are deleted by name", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    await p.files.write(id, "/workspace/kept.txt", new TextEncoder().encode("kept"));
    const snap = await p.snapshot?.(id);
    expect(snap?.id).toMatch(/^sandbox-sdk-[0-9a-f-]{36}$/);
    const restored = await p.create({ labels: {}, from: snap?.id });
    expect(new TextDecoder().decode(await p.files.read(restored.id, "/workspace/kept.txt"))).toBe(
      "kept",
    );
    expect(await p.deleteSnapshot?.(snap?.id ?? "")).toBe(true);
    expect(await p.deleteSnapshot?.(snap?.id ?? "")).toBe(false);
    await expect(p.snapshot?.(id, { expiresInMs: 1000 })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("a lost snapshot answer is looked up by its name, and only a snapshot of this sandbox counts", async () => {
    let lose = true;

    const losing: Fetch = async (url, init) => {
      const response = await fetch(url, init);

      if (lose && init.method === "POST" && new URL(url).pathname.endsWith("/save")) {
        await response.body?.cancel();
        throw new TypeError("fetch failed");
      }

      return response;
    };

    const p = provider({ fetch: losing });
    const { id } = await p.create({ labels: {} });
    const snap = await p.snapshot?.(id);
    expect(fake.snapshots.get(snap?.id ?? "")?.source).toBe(id);

    // The same lookup for a name whose snapshot came from another sandbox stays unknown.
    const other = await p.create({ labels: {} });

    const spoofing: Fetch = async (url, init) => {
      if (init.method === "POST" && new URL(url).pathname.endsWith("/save")) {
        const name = JSON.parse(String(init.body)).name;
        await (await fetch(url.replace(id, other.id), init)).body?.cancel();
        void name;
        throw new TypeError("fetch failed");
      }

      return fetch(url, init);
    };

    lose = false;
    await expect(provider({ fetch: spoofing }).snapshot?.(id)).rejects.toMatchObject({
      code: "outcome_unknown",
    });
  });

  test("usage maps Maritime's measurements to the shared names", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });

    expect(await p.usage?.(id)).toMatchObject({
      cpuPercent: 1.5,
      memoryBytes: 100 * 1024 * 1024,
      memoryLimitBytes: 4096 * 1024 * 1024,
      diskLimitBytes: 12 * 1024 ** 3,
    });
  });
});

describe("maritime previews and redaction", () => {
  test("a preview is private by default: its URL carries the URL token, and a path keeps it", async () => {
    const p = provider();
    const box = await createSandbox(p);

    try {
      const sandbox = fake.sandboxes.get(box.id);
      const preview = await box.preview(3000);
      expect(new URL(preview.url).searchParams.get("token")).toBe(sandbox?.urlToken);
      expect(preview.headers).toBeUndefined();

      const probe = new URL(
        (await box.preview(3000, { path: "/health?probe=1&token=caller" })).url,
      );

      expect(probe.pathname).toBe("/health");
      expect(probe.searchParams.getAll("token")).toEqual([sandbox?.urlToken]);
      expect(probe.searchParams.get("probe")).toBe("1");

      const urls = fake.requests.filter((r) => r.path.endsWith("/urls"));
      expect(JSON.parse(urls[0]?.body ?? "{}")).toEqual({ port: 3000, token: true });
    } finally {
      await box.destroy();
    }
  });

  test("public asks Maritime for a public port", async () => {
    const p = provider({ public: true });
    const { id } = await p.create({ labels: {} });
    const preview = await p.previewUrl(id, 8080);

    expect(new URL(preview.url).searchParams.has("token")).toBe(false);
    const urls = fake.requests.filter((r) => r.path.endsWith("/urls"));
    expect(JSON.parse(urls[0]?.body ?? "{}")).toEqual({ port: 8080, token: false });
  });

  test("errors never carry the API key, a sandbox secret or a URL token", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    const sandbox = fake.sandboxes.get(id);

    if (!sandbox) throw new Error("no sandbox");
    await p.previewUrl(id, 3000);
    const leaky = `bad ${apiKey} ${sandbox.secret} ${sandbox.urlToken}`;

    const echoing: Fetch = async (url, init) => {
      if (new URL(url).pathname.endsWith("/boom"))
        return new Response(JSON.stringify({ code: "invalid_request", message: leaky }), {
          status: 400,
        });

      return fetch(url, init);
    };

    const p2 = provider({ fetch: echoing });
    await p2.connect(id);
    const native = p2.native(id);

    for (const plane of ["control", "data"] as const) {
      const error = await native
        .request("GET", plane === "control" ? "/sandboxes/{id}/boom" : "/boom", { plane })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(SandboxError);
      const text = error instanceof SandboxError ? `${error.message} ${String(error.cause)}` : "";

      for (const secret of [apiKey, sandbox.secret, sandbox.urlToken])
        expect(text).not.toContain(secret);
    }
  });

  test("box.native reaches the control and data planes with the adapter's credentials", async () => {
    const p = provider();
    const { id } = await p.create({ labels: {} });
    const native = p.native(id);

    expect(await native.request("GET", "/sandboxes/{id}")).toMatchObject({ id });

    const command = await native.request("POST", "/commands", {
      plane: "data",
      body: { cmd: ["echo", "native"], cwd: "/" },
    });

    expect(command).toMatchObject({ exitCode: 0, stdout: "native\n" });
    await expect(p.api.request("POST", "/commands", { plane: "data" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  test("native.sdk builds maritime-sdk's client with this key and reads the sandbox without resuming it", async () => {
    const seen: SeenSdk = {};

    class Maritime {
      readonly sandboxes = {
        get: async (sandboxId: string) => {
          seen.got = sandboxId;

          return { id: sandboxId };
        },
      };

      constructor(options: { apiKey?: string; baseUrl?: string }) {
        seen.options = options;
      }
    }

    const module = { Maritime } satisfies MaritimeSdkModule;
    const p = provider();
    const bound = await p.native("sbx-abc").sdk(async () => module);

    expect(seen).toEqual({ options: { apiKey, baseUrl: fake.url }, got: "sbx-abc" });
    expect(bound.sandbox).toEqual({ id: "sbx-abc" });
    expect(await p.api.sdk(async () => module)).toBeInstanceOf(Maritime);
  });
});

describe("maritime through the whole SDK on the fake", () => {
  test("create, run, files, list and destroy", async () => {
    const box = await createSandbox(provider(), { labels: { whole: "yes" } });

    try {
      expect((await box.run("echo hi && whoami >/dev/null")).stdout).toBe("hi\n");
      await box.files.write("a/b.txt", "content");
      expect(await box.files.read("a/b.txt")).toBe("content");
      expect((await box.files.list("a")).map((f) => f.path)).toEqual(["/workspace/a/b.txt"]);
    } finally {
      await box.destroy();
    }
  });
});

describe("maritime live findings, 2026-11-23", () => {
  let server: FakeServer;

  beforeEach(async () => {
    server = await fakeServer();
    server.on("GET /v1/sandboxes/{id}", {
      json: {
        id: "sbx-l",
        state: "ended",
        metadata: {},
        createdAt: "2026-11-23T20:46:00Z",
        dataPlaneUrl: `${server.url}/dp/sbx-l/v1`,
        secret: "mst_live_secret_0123456789",
      },
    });
  });

  afterEach(async () => {
    await server.close();
  });

  const scripted = () => maritime({ apiKey, baseUrl: server.url, requestTimeoutMs: 5000 });

  test("an end answered 500 is sent again; a read that says ended confirms it", async () => {
    server.on(
      "DELETE /v1/sandboxes/{id}",
      { status: 500, json: { code: "internal_error" } },
      { json: {} },
    );

    await expect(scripted().destroy("sbx-l")).resolves.toBeUndefined();
    expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(2);
  });

  test("an end that keeps failing is confirmed only by an ended read", async () => {
    server.on("DELETE /v1/sandboxes/{id}", { status: 500, json: { code: "internal_error" } });

    await expect(scripted().destroy("sbx-l")).resolves.toBeUndefined();
    expect(server.calls("DELETE /v1/sandboxes/{id}")).toHaveLength(4);

    server.on("GET /v1/sandboxes/{id}", {
      json: { id: "sbx-l", state: "running", metadata: {}, createdAt: "2026-11-23T20:46:00Z" },
    });
    await expect(scripted().destroy("sbx-l")).rejects.toBeInstanceOf(SandboxError);
  }, 20_000);

  test("resume is proven by a wake command that exits 0, not by the control plane's state", async () => {
    server.on("GET /v1/sandboxes/{id}", {
      json: {
        id: "sbx-l",
        state: "paused",
        metadata: {},
        createdAt: "2026-11-23T20:46:00Z",
        dataPlaneUrl: `${server.url}/dp/sbx-l/v1`,
        secret: "mst_live_secret_0123456789",
      },
    });
    server.on(
      "POST /dp/{id}/v1/commands",
      { json: { state: "exited", exitCode: 0, signal: null } },
      { json: { state: "exited", exitCode: 1, signal: null } },
    );

    const p = scripted();

    await expect(p.resume?.("sbx-l")).resolves.toBeUndefined();
    await expect(p.resume?.("sbx-l")).rejects.toMatchObject({ code: "provider" });
    expect(
      JSON.parse(server.calls("POST /dp/{id}/v1/commands")[0]?.body.toString() ?? "{}"),
    ).toMatchObject({
      cmd: ["true"],
    });
  });
});

test("a timeout past Node's timer range does not fire at once", async () => {
  const p = provider();
  const { id } = await p.create({ labels: {} });
  const { input, out } = execInput("sleep 0.3; echo done", { timeoutMs: 2 ** 32 });

  expect(await p.exec(id, input)).toEqual({ exitCode: 0, timedOut: false });
  expect(out.join("")).toBe("done\n");
});
