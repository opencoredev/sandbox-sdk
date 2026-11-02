import { afterEach, beforeEach, describe, expect, expectTypeOf, test } from "vitest";
import { createSandbox, connectSandbox, listSandboxes } from "../src/index.js";
import { createos } from "../src/providers/createos/index.js";
import { createosApi } from "../src/providers/createos/api.js";
import { createDeadline } from "../src/provider.js";
import type { JsonObject } from "../src/shared/json.js";
import { fakeCreateos } from "./createos-fake.js";
import { fakeServer, type FakeServer } from "./http-fake.js";

let fake: Awaited<ReturnType<typeof fakeCreateos>>;

beforeEach(async () => {
  fake = await fakeCreateos();
});

afterEach(async () => {
  await fake.close();
});

describe("CreateOS provider", () => {
  test("creates, reconnects by key, resumes, lists only SDK resources, and destroys", async () => {
    const provider = createos(fake.options);

    const box = await createSandbox(provider, {
      key: "project:a/b",
      labels: { app: "test" },
      size: "medium",
      idleTimeoutMs: 60_001,
    });

    const body = JSON.parse(fake.server.calls("POST /v1/sandboxes")[0]!.body.toString());
    expect(body).toMatchObject({
      // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Assert CreateOS's wire field.
      shape: "s-2vcpu-2gb",
      auto_pause_after_seconds: 61,
      ingress_enabled: true,
    });
    expect(body.name).toMatch(/^sdk-[a-f0-9]{18}$/);
    expect(box.created).toBe(true);
    await box.pause();
    const connected = await createSandbox(createos(fake.options), { key: "project:a/b" });
    expect(connected.id).toBe(box.id);
    expect(connected.created).toBe(false);
    expect(fake.server.calls("POST /v1/sandboxes/sb-test/resume")).toHaveLength(1);
    expect(await listSandboxes(provider, { labels: { app: "other" } })).toEqual([]);
    expect(await box.preview(3000)).toEqual({ url: "https://sb-test-3000.example.com/" });
    await connected.close();
    await box.close();
    expect(await provider.list({ app: "test" })).toHaveLength(1);
    await provider.destroy(box.id);
    expect(await provider.list({})).toEqual([]);
  });

  test("runs nonzero commands, sends stdin and arbitrary env without secrets in argv", async () => {
    await using box = await createSandbox(createos(fake.options), {
      secrets: { TOKEN: "secret-at-create" },
    });

    const command = "printf '%s\\n' \"$DYNAMIC\"; cat; printf err >&2; exit 7";

    const result = await box.run(command, {
      env: { DYNAMIC: "a'b\n$(not-a-command)" },
      stdin: "hello\n",
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 7,
      stdout: "a'b\n$(not-a-command)\nhello\n",
      stderr: "err",
      timedOut: false,
    });
    expect((await box.run('printf %s "$TOKEN"')).stdout).toBe("[REDACTED]");

    const launches = fake.server
      .calls("POST /v1/sandboxes/sb-test/processes")
      .map((r) => r.body.toString());

    expect(launches.join("\n")).not.toContain("secret-at-create");
    expect(launches.join("\n")).not.toContain("not-a-command");
    const connected = await connectSandbox(createos(fake.options), box.id);
    expect((await connected.run('printf %s "$TOKEN"')).stdout).toBe("[REDACTED]");
    await connected.close();
  });

  test("kills descendants on timeout and returns partial output", async () => {
    await using box = await createSandbox(createos(fake.options));
    const result = await box.run("printf started; sleep 30 & wait", { timeoutMs: 500 });
    expect(result).toMatchObject({ exitCode: null, timedOut: true, ok: false, stdout: "started" });
    expect(fake.server.calls("DELETE /v1/sandboxes/sb-test/processes/{id}")).toHaveLength(1);

    const state = await box.native.request<{ data: { tree_exited: boolean } }>(
      "GET",
      "/v1/sandboxes/{sandboxId}/processes/p-2/wait",
    );

    expect(state.data.tree_exited).toBe(true);
  });

  test("abort uses a fresh cleanup request and keeps partial output", async () => {
    await using box = await createSandbox(createos(fake.options));
    const controller = new AbortController();
    const handle = box.run("echo ready; sleep 30", { signal: controller.signal });

    for await (const chunk of handle) if (chunk.text.includes("ready")) controller.abort();
    expect(await handle).toMatchObject({ timedOut: true, exitCode: null, stdout: "ready\n" });
    expect(fake.server.calls("DELETE /v1/sandboxes/sb-test/processes/{id}")).toHaveLength(1);
  });

  test("binary transfers, parent creation, metadata, edit and search use shared file helpers", async () => {
    await using box = await createSandbox(createos(fake.options));
    const bytes = new Uint8Array([0, 255, 128, 10]);
    await box.files.write("nested/data.bin", bytes);
    expect(await box.files.read("nested/data.bin", { as: "bytes" })).toEqual(bytes);
    await box.files.write("app/a.txt", "hello world\n");
    await box.files.edit("app/a.txt", { find: "world", replace: "CreateOS" });
    expect(await box.files.read("app/a.txt")).toBe("hello CreateOS\n");
    // Guest metadata paths are local in this fixture; verify native parsing rather than fake path rewriting.
    expect(await box.files.stat("app/a.txt")).toMatchObject({ type: "file", size: 15 });
    await box.files.remove("app", { recursive: true });
    await expect(box.files.read("app/a.txt")).rejects.toMatchObject({ code: "file_not_found" });
  });

  test("pause and terminal are available while snapshots and templates are absent", async () => {
    const provider = createos(fake.options);
    expect([...provider.capabilities].sort()).toEqual([
      "network-policy",
      "pause",
      "size",
      "terminal",
    ]);
    await using box = await createSandbox(provider);
    expectTypeOf(box.pause).toBeFunction();
    expectTypeOf(box.terminal).toBeFunction();

    expectTypeOf(box).not.toHaveProperty("snapshot");
    const terminal = await box.terminal({ cols: 80, rows: 24, env: { CUSTOM: "terminal-secret" } });
    let output = "";
    terminal.onData((text) => {
      output += text;
    });
    await terminal.resize(100, 30);
    await terminal.write("echo $CUSTOM; exit\n");
    expect(await terminal.wait?.()).toEqual({ exitCode: 0 });
    expect(output).toContain("terminal-secret");
    expect(
      fake.server
        .calls("POST /v1/sandboxes/sb-test/processes")
        .map((r) => r.body.toString())
        .join("\n"),
    ).not.toContain("terminal-secret");
    await terminal.close();
    await terminal.close();
  });

  test.each([
    { timeoutMs: 60_000 },
    { network: "none" as const },
    { network: { allow: [] } },
    { idleTimeoutMs: 1000 },
    { idleTimeoutMs: 86_400_001 },
    { from: "snapshot" },
  ])("rejects unsupported creation options before any request: %j", async (options) => {
    await expect(createSandbox(createos(fake.options), options)).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(fake.server.requests).toHaveLength(0);
  });

  test("matches exact shapes, rejects unavailable allocations, and maps disk units", async () => {
    const provider = createos(fake.options);
    await expect(
      createSandbox(provider, { size: { cpu: 3, memoryMb: 3072 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fake.server.calls("POST /v1/sandboxes")).toHaveLength(0);

    await using box = await createSandbox(provider, {
      size: { cpu: 2, memoryMb: 2048, diskGb: 20 },
      network: { allow: ["registry.npmjs.org"] },
    });

    expect(box.id).toBe("sb-test");
    expect(JSON.parse(fake.server.calls("POST /v1/sandboxes")[0]!.body.toString())).toMatchObject({
      disk_mib: 20_480,
      egress: ["registry.npmjs.org"],
    });
  });

  test("native SDK bridge preserves caller types and configuration without a package import", async () => {
    class CreateosSandboxClient {
      constructor(readonly config: { apiKey: string; baseUrl: string }) {}
      async getSandbox(id: string) {
        return { id, nativeFeature: true };
      }
    }

    const provider = createos(fake.options);
    const client = await provider.api.sdk(async () => ({ CreateosSandboxClient }));
    expectTypeOf(client).toEqualTypeOf<CreateosSandboxClient>();
    expect(client.config).toMatchObject(fake.options);
    expect(await provider.native("my-id").sdk(async () => ({ CreateosSandboxClient }))).toEqual({
      id: "my-id",
      nativeFeature: true,
    });
  });

  test("native background hook survives local close and can still be stopped", async () => {
    const provider = createos(fake.options);
    await using box = await createSandbox(provider);

    const running = await provider.startProcess!(box.id, {
      command: "sleep 30",
      cwd: "/workspace",
      env: {},
      onChunk() {},
    });

    await box.close();
    expect(fake.server.calls("DELETE /v1/sandboxes/sb-test/processes/{id}")).toHaveLength(0);
    await running.stop({ graceMs: 100 });
    expect(fake.server.calls("DELETE /v1/sandboxes/sb-test/processes/{id}")).toHaveLength(1);
  });
});

describe("CreateOS HTTP boundaries", () => {
  let server: FakeServer;
  beforeEach(async () => {
    server = await fakeServer();
  });
  afterEach(async () => {
    await server.close();
  });

  const api = () =>
    createosApi({
      baseUrl: () => server.url,
      apiKey: () => "boundary-secret",
      requestTimeoutMs: 1000,
    });

  const processRoot = "/v1/sandboxes/sb/processes";
  const processView = { process_id: "p1", pid: 42, tree_exited: true, exit_code: 0, signal: null };
  const success = (data: JsonObject) => ({ json: { status: "success", data } });

  const frame = (seq: number, bytes: number[], stream = "stdout") =>
    JSON.stringify({
      type: "data",
      seq,
      stream,
      data_base64: Buffer.from(bytes).toString("base64"),
    }) + "\n";

  function commandApi() {
    server.on(`POST ${processRoot}`, success(processView));
    server.on(`POST ${processRoot}/p1/input`, success({ input_seq: 1 }));
    server.on(`POST ${processRoot}/p1/stdin/close`, success({ ok: true }));
    server.on(`GET ${processRoot}/p1/wait`, success(processView));
    server.on(`DELETE ${processRoot}/p1`, success(processView));

    return createos({ apiKey: "boundary-secret", baseUrl: server.url, requestTimeoutMs: 1000 });
  }

  test("a server wait timeout keeps a background process alive until its real exit", async () => {
    const provider = commandApi();
    server.on(
      `GET ${processRoot}/p1/wait`,
      { status: 408, json: { status: "fail", data: { error: "wait_timeout" } } },
      success({ ...processView, exit_code: 7 }),
    );
    server.on(
      `GET ${processRoot}/p1`,
      success({ ...processView, tree_exited: false, exit_code: null }),
    );

    const running = await provider.startProcess!("sb", {
      command: "sleep 2; exit 7",
      cwd: "/",
      env: {},
      onChunk() {},
    });

    expect(await running.wait()).toEqual({ exitCode: 7, signal: null });
    expect(server.calls(`DELETE ${processRoot}/p1`)).toHaveLength(0);
    expect(server.calls(`GET ${processRoot}/p1`)).toHaveLength(1);
    await provider.close?.("sb");
  });

  test("replays after a disconnect without duplicating bytes, preserving split UTF-8", async () => {
    const provider = commandApi();
    server.on(
      `GET ${processRoot}/p1/connect`,
      { stream: [frame(1, [0xe2])], cut: true },
      {
        stream: [
          frame(1, [0xe2]),
          frame(2, [0x82, 0xac]),
          frame(3, [33], "stderr"),
          '{"type":"exit","exit_code":0}\n',
        ],
      },
    );
    const output: string[] = [];
    expect(
      await provider.exec("sb", {
        command: "test",
        cwd: "/workspace",
        env: {},
        timeoutMs: 2000,
        onChunk: (chunk) => {
          output.push(`${chunk.stream}:${chunk.text}`);
        },
      }),
    ).toEqual({ exitCode: 0, timedOut: false });
    expect(output).toEqual(["stdout:€", "stderr:!"]);
    expect(server.calls(`GET ${processRoot}/p1/connect`)[1]?.url).toContain("after=1");
  });

  test("missing output is an error and terminates the owned process", async () => {
    const provider = commandApi();
    server.on(`GET ${processRoot}/p1/connect`, { stream: [frame(2, [65])] });
    await expect(
      provider.exec("sb", {
        command: "test",
        cwd: "/workspace",
        env: {},
        timeoutMs: 2000,
        onChunk() {},
      }),
    ).rejects.toMatchObject({ code: "provider" });
    expect(server.calls(`DELETE ${processRoot}/p1`)).toHaveLength(1);
  });

  test("a command that exits before stdin closes still returns its exit code", async () => {
    const provider = commandApi();
    server.on(`POST ${processRoot}/p1/stdin/close`, {
      status: 409,
      json: { error: "process_exited" },
    });
    server.on(`GET ${processRoot}/p1/connect`, { stream: ['{"type":"exit","exit_code":0}\n'] });
    expect(
      await provider.exec("sb", {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 2000,
        onChunk() {},
      }),
    ).toEqual({ exitCode: 0, timedOut: false });
    expect(server.calls(`DELETE ${processRoot}/p1`)).toHaveLength(0);
  });

  test("failed cleanup cannot masquerade as a successful timeout", async () => {
    const provider = commandApi();
    server.on(`DELETE ${processRoot}/p1`, { status: 403 });
    server.on(`GET ${processRoot}/p1/connect`, { stream: [], hold: true });
    await expect(
      provider.exec("sb", {
        command: "test",
        cwd: "/workspace",
        env: {},
        timeoutMs: 100,
        onChunk() {},
      }),
    ).rejects.toMatchObject({ code: "provider", message: expect.stringContaining("termination") });
  });

  test("a process arriving after abort is terminated before settling", async () => {
    const provider = commandApi();
    server.on(`POST ${processRoot}`, { ...success(processView), delayMs: 100 });
    const controller = new AbortController();

    const pending = provider.exec("sb", {
      command: "test",
      cwd: "/workspace",
      env: {},
      timeoutMs: 2000,
      signal: controller.signal,
      onChunk() {},
    });

    await expect.poll(() => server.calls(`POST ${processRoot}`).length).toBe(1);
    controller.abort();
    expect(await pending).toEqual({ exitCode: null, timedOut: true });
    expect(server.calls(`DELETE ${processRoot}/p1`)).toHaveLength(1);
    expect(server.calls(`POST ${processRoot}/p1/input`)).toHaveLength(0);
  });

  test("pagination follows actual page counts, not the requested limit", async () => {
    server.on(
      "GET /v1/shapes",
      { json: { status: "success", data: { data: [1], pagination: { total: 2 } } } },
      { json: { status: "success", data: { data: [2], pagination: { total: 2 } } } },
    );
    expect(
      await api().pages(
        { method: "GET", path: "/v1/shapes", deadline: createDeadline(1000) },
        "shapes",
      ),
    ).toEqual([1, 2]);
    expect(server.requests[1]?.url).toContain("offset=1");
  });

  test("malformed success envelopes and stalled pagination fail loudly", async () => {
    server.on("GET /malformed", {
      json: { status: "success", data: { data: [], pagination: { total: 10 } } },
    });
    await expect(
      api().pages({ method: "GET", path: "/malformed" }, "sandboxes"),
    ).rejects.toMatchObject({ code: "provider" });
    server.on("GET /failure", { json: { status: "fail", data: { secret: "boundary-secret" } } });
    await expect(api().json({ method: "GET", path: "/failure" })).rejects.toMatchObject({
      code: "provider",
    });
  });

  test("dropped create is outcome_unknown and is not retried", async () => {
    server.on("POST /v1/sandboxes", { drop: true });
    await expect(
      createSandbox(createos({ baseUrl: server.url, apiKey: "boundary-secret" })),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(server.requests).toHaveLength(1);
  });
});
