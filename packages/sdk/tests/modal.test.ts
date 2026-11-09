import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import {
  buildTemplate,
  connectSandbox,
  createSandbox,
  deleteSnapshot,
  listSandboxes,
} from "../src/index.js";
import { createModalProvider, type ModalOptions } from "../src/providers/modal/provider.js";
import { modalError } from "../src/providers/modal/errors.js";
import { runConformance } from "../src/testing.js";
import { grpcFailure, modalFailure, modalMock } from "./modal-mock.js";

const mock = await modalMock();

afterAll(() => mock.dispose());

const provider = (options: ModalOptions = {}) => createModalProvider(mock.load, options);

runConformance(() => provider(), { live: true, ports: [3000], snapshotExpiry: "honored" });

describe("Modal adapter", { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("sizes pin request and limit; presets map to Modal cpu units", async () => {
    const box = await createSandbox(provider(), { size: "large" });

    try {
      expect(mock.creates.at(-1)).toMatchObject({
        cpu: 4,
        cpuLimit: 4,
        memoryMiB: 8192,
        memoryLimitMiB: 8192,
      });
    } finally {
      await box.destroy();
    }

    const custom = await createSandbox(provider(), { size: { cpu: 0.5, memoryMb: 1024 } });
    await custom.destroy();
    expect(mock.creates.at(-1)).toMatchObject({ cpu: 0.5, cpuLimit: 0.5, memoryMiB: 1024 });
  });

  test("fails closed on disk, tiny sizes, size plus resources, long lifetimes and tag overflow", async () => {
    for (const size of [
      { cpu: 1, memoryMb: 2048, diskGb: 10 },
      { cpu: 0.1, memoryMb: 2048 },
      { cpu: 1, memoryMb: 100 },
      { cpu: 1, memoryMb: 1024.5 },
    ])
      await expect(createSandbox(provider(), { size })).rejects.toMatchObject({
        code: "unsupported",
      });

    await expect(
      createSandbox(provider({ resources: { cpu: 2 } }), { size: "small" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(
      createSandbox(provider(), { timeoutMs: 24 * 3_600_000 + 1 }),
    ).rejects.toMatchObject({ code: "unsupported" });
    const labels = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`l${i}`, "v"]));
    await expect(createSandbox(provider(), { labels })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(createSandbox(provider(), { key: "k".repeat(1000) })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("maps network, ports, lifetimes, region, runtime and resources to native params", async () => {
    vi.stubEnv("MODAL_SANDBOX_REGION", "us-east, us-central");

    const box = await createSandbox(
      provider({ runtime: "vm", resources: { cpu: 2, memoryMiB: 4096 }, app: "sandbox-sdk-unit" }),
      {
        ports: [3000, 3000, 8080],
        network: { allow: ["registry.npmjs.org", "*.github.com", "10.0.0.0/8", "1.2.3.4"] },
        timeoutMs: 1500,
        idleTimeoutMs: 61_001,
        labels: { app: "builder" },
      },
    );

    try {
      expect(mock.creates.at(-1)).toMatchObject({
        encryptedPorts: [3000, 8080],
        outboundDomainAllowlist: ["registry.npmjs.org", "*.github.com"],
        outboundCidrAllowlist: ["10.0.0.0/8", "1.2.3.4/32"],
        timeoutMs: 2000,
        idleTimeoutMs: 62_000,
        regions: ["us-east", "us-central"],
        runtime: "vm",
        cpu: 2,
        memoryMiB: 4096,
        workdir: "/workspace",
        tags: { app: "builder", "sandbox-sdk": "1" },
      });
      expect(mock.apps).toContain("sandbox-sdk-unit");
      expect((await box.preview(8080)).url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    } finally {
      await box.destroy();
    }

    const options = provider({ region: "us", timeoutMs: 3_600_000 });
    const blocked = await createSandbox(options, { network: "none" });
    await blocked.destroy();
    expect(mock.creates.at(-1)).toMatchObject({
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: [],
      regions: ["us"],
      timeoutMs: 3_600_000,
    });
    expect(mock.creates.at(-1)).not.toHaveProperty("blockNetwork");
    const empty = await createSandbox(options, { network: { allow: [] } });
    await empty.destroy();
    expect(mock.creates.at(-1)).toMatchObject({
      outboundCidrAllowlist: [],
      outboundDomainAllowlist: [],
    });
  });

  test("createApp picks the App per unkeyed create; list and find still see every sandbox", async () => {
    const attempt = crypto.randomUUID().slice(0, 8);

    const adapter = provider({
      app: "sandbox-sdk-default",
      createApp: ({ labels }) => (labels.attempt ? `bench-${labels.attempt}` : undefined),
    });

    const box = await createSandbox(adapter, { labels: { attempt } });
    const keyed = await createSandbox(adapter, { key: `k-${attempt}`, labels: { attempt } });

    try {
      expect(mock.creates.at(-2)?.name).toBeUndefined();
      expect(mock.sandboxes.get(box.id)?.appId).toBe(`ap-bench-${attempt}`);
      // Keys are unique names inside one App, so keyed sandboxes stay in the default App.
      expect(mock.sandboxes.get(keyed.id)?.appId).toBe("ap-sandbox-sdk-default");
      expect(
        (await listSandboxes(adapter, { labels: { attempt } })).map((info) => info.id).sort(),
      ).toEqual([box.id, keyed.id].sort());
      expect(await adapter.find(`k-${attempt}`)).toMatchObject({ id: keyed.id });

      // Modal deprecates environment-wide listing: list() scans only Apps this provider knows.
      expect(mock.lists.at(-1)).toHaveProperty("appId");
      expect(mock.lists.every((params) => params.appId !== undefined)).toBe(true);
      const fresh = provider({ app: "sandbox-sdk-default", createApp: () => undefined });
      expect((await fresh.list({ attempt })).map((info) => info.id)).toEqual([keyed.id]);
      await fresh.prepareApp(`bench-${attempt}`);
      expect((await fresh.list({ attempt })).map((info) => info.id).sort()).toEqual(
        [box.id, keyed.id].sort(),
      );

      await expect(
        createSandbox(provider({ createApp: () => "bad name!" }), {}),
      ).rejects.toMatchObject({ code: "invalid_argument" });

      // prepareApp takes the App lookup out of the create it would otherwise slow down.
      const next = `bench-${attempt}-2`;
      await adapter.prepareApp(next);
      const lookups = mock.apps.filter((name) => name === next).length;
      const prepared = await createSandbox(adapter, { labels: { attempt: `${attempt}-2` } });
      await prepared.destroy();
      expect(mock.apps.filter((name) => name === next).length).toBe(lookups);
    } finally {
      await box.destroy();
      await keyed.destroy();
    }
  });

  test("keys become short unique names, and concurrent creates share one sandbox", async () => {
    const key = `user:${crypto.randomUUID()}`;

    const [a, b] = await Promise.all([
      createSandbox(provider(), { key }),
      createSandbox(provider(), { key }),
    ]);

    try {
      expect(a.id).toBe(b.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      const name = mock.creates.find((params) => params.tags?.["sandbox-sdk-key"] === key)?.name;
      expect(name).toMatch(/^sdk-[0-9a-f]{56}$/);
      expect(await provider().find(key)).toMatchObject({ id: a.id, key });
      expect(await provider().find("other")).toBeUndefined();
    } finally {
      await a.destroy();
    }

    expect(await provider().find(key)).toBeUndefined();
  });

  test("command stderr survives the launch header, and timeout and abort kill descendants", async () => {
    const box = await createSandbox(provider());

    try {
      expect(await box.run("echo err >&2; printf out")).toMatchObject({
        stdout: "out",
        stderr: "err\n",
      });
      expect((await box.run("printf partial >&2")).stderr).toBe("partial");
      expect(await box.run("(sleep 0.3; echo bad > late) & wait", { timeoutMs: 50 })).toMatchObject(
        { timedOut: true, exitCode: null },
      );
      const controller = new AbortController();

      const aborted = Promise.resolve(
        box.run("(sleep 0.3; echo bad > aborted-child) & wait", { signal: controller.signal }),
      );

      setTimeout(() => controller.abort(), 50);
      expect(await aborted).toMatchObject({ timedOut: true });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await box.files.exists("late")).toBe(false);
      expect(await box.files.exists("aborted-child")).toBe(false);
    } finally {
      await box.destroy();
    }
  });

  test("stdin transport failures propagate and kill the command; refusals after exit do not", async () => {
    const box = await createSandbox(provider());
    const native = mock.sandboxes.get(box.id)!;

    try {
      native.stdinFailure = { on: "write", error: grpcFailure(14, "stdin unavailable") };
      const started = Date.now();
      await expect(
        box.run("sleep 1; echo late > after-write-failure", { stdin: "input", timeoutMs: 10_000 }),
      ).rejects.toMatchObject({ code: "unavailable", provider: "modal" });
      expect(Date.now() - started).toBeLessThan(5_000);

      native.stdinFailure = { on: "close", error: grpcFailure(14, "stdin close unavailable") };
      await expect(box.run("cat", { timeoutMs: 8_000 })).rejects.toMatchObject({
        code: "unavailable",
      });

      // A command that finishes before reading its input refuses the write; that is not a failure.
      native.stdinFailure = {
        on: "write",
        error: modalFailure("InvalidError", "process has exited"),
        afterExit: true,
      };
      expect(await box.run("exit 3", { stdin: "unread" })).toMatchObject({
        exitCode: 3,
        timedOut: false,
      });

      native.stdinFailure = undefined;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(await box.files.exists("after-write-failure")).toBe(false);
    } finally {
      native.stdinFailure = undefined;
      await box.destroy();
    }
  });

  test("a missing cwd is a request failure, not exit 125", async () => {
    const box = await createSandbox(provider());

    try {
      await expect(box.run("true", { cwd: "missing-directory" })).rejects.toMatchObject({
        code: "invalid_argument",
        provider: "modal",
      });
      expect((await box.run("exit 125")).exitCode).toBe(125);
    } finally {
      await box.destroy();
    }
  });

  test("snapshots honor expiry, restore files and fail restored processes", async () => {
    const box = await createSandbox(provider(), { labels: { origin: "source" } });

    try {
      await box.files.write("saved", "yes");
      await box.start("sleep 30", { name: "old" });
      await box.snapshot({ expiresInMs: 0 });
      const { id } = await box.snapshot({ expiresInMs: 1500 });
      expect(mock.snapshotCalls.slice(-2)).toEqual([{ ttlMs: null }, { ttlMs: 2000 }]);
      const clone = await createSandbox(provider(), { from: id, labels: { origin: "clone" } });

      try {
        expect(await clone.files.read("saved")).toBe("yes");
        expect((await clone.processes())[0]).toMatchObject({ status: "failed", exitCode: 137 });
        expect(mock.sandboxes.get(clone.id)?.tags).toMatchObject({
          "sandbox-sdk": "1",
          origin: "clone",
        });
        expect((await listSandboxes(provider(), { labels: { origin: "clone" } })).length).toBe(1);
      } finally {
        await clone.destroy();
      }

      expect(await deleteSnapshot(provider(), id)).toBe(true);
      expect(await deleteSnapshot(provider(), id)).toBe(false);
      await expect(createSandbox(provider(), { from: id })).rejects.toMatchObject({
        code: "not_found",
      });
    } finally {
      await box.destroy();
    }
  });

  test("templates build Dockerfile layers with build-only env and work as from", async () => {
    await expect(
      buildTemplate(provider(), { name: "sized", size: { cpu: 1, memoryMb: 1024 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      buildTemplate(provider(), { name: "relative", workdir: "app" }),
    ).rejects.toMatchObject({ code: "invalid_argument" });

    const template = await buildTemplate(provider(), {
      name: "tools",
      image: "node:22-slim",
      env: { GREETING: 'it\'s "quoted"' },
      workdir: "/srv",
      run: ["mkdir -p /workspace && printf '%s' \"$GREETING\" > /workspace/greeting"],
    });

    expect(template).toMatchObject({ id: expect.stringMatching(/^im-/), name: "tools" });
    const image = mock.images.get(template.id);
    expect(image).toMatchObject({
      tag: "node:22-slim",
      env: { GREETING: 'it\'s "quoted"' },
      commands: [
        "WORKDIR /srv",
        `RUN ${JSON.stringify(["sh", "-c", "mkdir -p /workspace && printf '%s' \"$GREETING\" > /workspace/greeting"])}`,
      ],
    });

    const box = await createSandbox(provider(), { from: template.id });

    try {
      expect(await box.files.read("greeting")).toBe('it\'s "quoted"');
      expect(await box.run("printf '%s' \"$GREETING\"")).toMatchObject({ stdout: "" });
    } finally {
      await box.destroy();
    }

    const slow = buildTemplate(provider(), { name: "t" }, { signal: AbortSignal.abort() });
    await expect(slow).rejects.toMatchObject({ code: "aborted" });
  });

  test("finished and unknown sandboxes are not_found; destroy is idempotent", async () => {
    const box = await createSandbox(provider());
    const id = box.id;
    await mock.sandboxes.get(id)?.terminate();
    await expect(provider().connect(id)).rejects.toMatchObject({ code: "not_found" });
    await expect(box.run("true")).rejects.toMatchObject({ code: "not_found", provider: "modal" });
    await provider().destroy(id);
    await expect(provider().connect("sb-unknown")).rejects.toMatchObject({ code: "not_found" });
    await expect(provider().destroy("sb-unknown")).resolves.toBeUndefined();
  });

  test("destroy resolves only once Modal reports the sandbox stopped, and reports both latencies", async () => {
    const key = `slow-${crypto.randomUUID()}`;
    const events: { sandboxId: string; requestMs: number; stoppedMs: number | null }[] = [];
    const adapter = provider({ onDestroy: (event) => events.push(event) });
    const box = await createSandbox(adapter, { key, labels: { slow: key } });
    const native = mock.sandboxes.get(box.id)!;
    native.stopDelayMs = 1500;
    const destroying = box.destroy();
    await new Promise((resolve) => setTimeout(resolve, 400));

    // While Modal stops it, the sandbox stays listed for cleanup but is not handed out for a key.
    expect(await listSandboxes(provider(), { labels: { slow: key } })).toMatchObject([
      { id: box.id, state: "stopped", labels: { slow: key, "sandbox-sdk": "1" } },
    ]);
    expect(await provider().connect(box.id)).toMatchObject({ id: box.id, state: "stopped" });
    expect(await provider().find(key)).toBeUndefined();

    await destroying;
    expect(await native.poll()).toBe(137);
    expect(native.terminateCalls).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.requestMs).toBeLessThan(500);
    expect(events[0]?.stoppedMs).toBeGreaterThanOrEqual(1400);
    await expect(provider().connect(box.id)).rejects.toMatchObject({ code: "not_found" });
  });

  test("a failed tag write still terminates the sandbox", async () => {
    const box = await createSandbox(provider());
    const native = mock.sandboxes.get(box.id)!;
    native.tagFailure = grpcFailure(14, "tag write unavailable");
    await box.destroy();
    expect(native.terminateCalls).toBe(1);
    expect(await native.poll()).toBe(137);
  });

  test("a failed termination surfaces and leaves the sandbox listed and connectable", async () => {
    const label = crypto.randomUUID();
    const box = await createSandbox(provider(), { labels: { failing: label } });
    const native = mock.sandboxes.get(box.id)!;
    native.terminateFailure = grpcFailure(14, "terminate unavailable");
    await expect(box.destroy()).rejects.toMatchObject({ code: "unavailable", provider: "modal" });
    expect(await native.poll()).toBe(null);
    expect(native.tags).not.toHaveProperty("sandbox-sdk-destroying");
    expect(await listSandboxes(provider(), { labels: { failing: label } })).toMatchObject([
      { id: box.id, state: "running" },
    ]);
    expect(await provider().connect(box.id)).toMatchObject({ id: box.id, state: "running" });
    native.terminateFailure = undefined;
    await provider().destroy(box.id);
    expect(await native.poll()).toBe(137);
  });

  test("a stop Modal does not confirm in time is a retryable timeout, still listed", async () => {
    const label = crypto.randomUUID();
    const events: { stoppedMs: number | null }[] = [];

    const adapter = provider({ destroyWaitMs: 300, onDestroy: (event) => events.push(event) });

    const box = await createSandbox(adapter, { labels: { unconfirmed: label } });
    const native = mock.sandboxes.get(box.id)!;
    native.stopDelayMs = 1500;
    await expect(box.destroy()).rejects.toMatchObject({ code: "timeout", retryable: true });
    expect(events).toMatchObject([{ stoppedMs: null }]);
    expect(await listSandboxes(provider(), { labels: { unconfirmed: label } })).toMatchObject([
      { id: box.id, state: "stopped" },
    ]);
    // A retry waits for the stop already in progress.
    await provider().destroy(box.id);
    expect(await native.poll()).toBe(137);
  });

  test("a key is reusable right after destroy, while Modal still holds the name", async () => {
    const key = `reuse-${crypto.randomUUID()}`;
    const first = await createSandbox(provider(), { key });
    mock.sandboxes.get(first.id)!.stopDelayMs = 1500;
    await first.destroy();
    const second = await createSandbox(provider(), { key });

    try {
      expect(second).toMatchObject({ created: true, key });
      expect(second.id).not.toBe(first.id);
    } finally {
      await second.destroy();
    }
  });

  test("previews of undeclared ports fail without waiting for tunnels", async () => {
    const box = await createSandbox(provider(), { ports: [3000] });

    try {
      const tunnels = vi.spyOn(mock.sandboxes.get(box.id)!, "tunnels");
      await expect(box.preview(8080)).rejects.toMatchObject({ code: "invalid_argument" });
      expect(tunnels).not.toHaveBeenCalled();
      const attached = await connectSandbox(provider(), box.id);
      await expect(attached.preview(8080)).rejects.toMatchObject({ code: "invalid_argument" });
      expect(tunnels).toHaveBeenCalledTimes(1);
    } finally {
      await box.destroy();
    }
  });

  test("loads the SDK on first use and retries a failed load", async () => {
    let fail = true;

    const load = vi.fn(async () => {
      if (fail) throw grpcFailure(16, "missing token");

      return mock.client;
    });

    const adapter = createModalProvider(load);
    expect(load).not.toHaveBeenCalled();
    await expect(adapter.list({})).rejects.toMatchObject({ code: "auth", provider: "modal" });
    fail = false;
    expect(await adapter.list({ never: "matches" })).toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("maps native failures without leaking credentials", () => {
    vi.stubEnv("MODAL_TOKEN_SECRET", "as-supersecret");

    for (const [error, code] of [
      [modalFailure("NotFoundError"), "not_found"],
      [modalFailure("SandboxFilesystemNotFoundError"), "file_not_found"],
      [modalFailure("SandboxFilesystemDirectoryNotEmptyError"), "invalid_argument"],
      [modalFailure("AlreadyExistsError"), "invalid_argument"],
      [modalFailure("InvalidError", '"sb-x" is not a valid sandbox ID'), "not_found"],
      [modalFailure("ResourceExhaustedError"), "quota"],
      [modalFailure("InternalFailure"), "unavailable"],
      [modalFailure("SandboxTimeoutError"), "timeout"],
      [grpcFailure(5), "not_found"],
      [grpcFailure(7), "auth"],
      [grpcFailure(16), "auth"],
      [grpcFailure(8), "quota"],
      [grpcFailure(14), "unavailable"],
      [grpcFailure(4), "timeout"],
      [new Error("boom as-supersecret"), "provider"],
    ] as const) {
      const mapped = modalError(error, "sb-1");
      expect(mapped).toMatchObject({ code, provider: "modal", sandboxId: "sb-1" });
      expect(`${mapped.message} ${String(mapped.cause)}`).not.toContain("as-supersecret");
    }

    expect(modalError(grpcFailure(14)).retryable).toBe(true);
  });
});
