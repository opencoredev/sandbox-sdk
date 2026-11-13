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

      // Recovery looks Apps up without creating them: a journaled App that was never created is
      // null, and no App appears for it.
      const never = `bench-${attempt}-never`;
      const fresher = provider({ app: "sandbox-sdk-default" });
      expect(await fresher.prepareApp(never, { createIfMissing: false })).toBeNull();
      expect(await fresher.prepareApp(never, { createIfMissing: false })).toBeNull();
      await expect(
        createModalProvider(mock.load).prepareApp(`bench-${attempt}`, { createIfMissing: false }),
      ).resolves.toEqual({ name: `bench-${attempt}`, appId: `ap-bench-${attempt}` });

      // prepareApp takes the App lookup out of the create it would otherwise slow down.
      const next = `bench-${attempt}-2`;
      expect(await adapter.prepareApp(next)).toEqual({ name: next, appId: `ap-${next}` });
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
      // Modal answers it with FAILED_PRECONDITION (measured live on November 9, 2026).
      native.stdinFailure = {
        on: "write",
        error: grpcFailure(
          9,
          "/modal.task_command_router.TaskCommandRouter/TaskExecStdinWrite FAILED_PRECONDITION: Exec has already completed; stdin is no longer accepting writes",
        ),
        afterExit: true,
      };
      expect(await box.run("exit 3", { stdin: "unread" })).toMatchObject({
        exitCode: 3,
        timedOut: false,
      });

      // Any other stdin error rejects, even when the command exits right away: a stream reset
      // (gRPC INTERNAL) or an unmapped error is no proof the command saw all its input.
      for (const error of [grpcFailure(13, "RST_STREAM"), new Error("socket hang up")]) {
        native.stdinFailure = { on: "write", error, afterExit: true };
        await expect(box.run("exit 3", { stdin: "lost" })).rejects.toMatchObject({
          provider: "modal",
        });
      }

      // A refusal while the command is still running is no refusal: it rejects.
      native.stdinFailure = {
        on: "write",
        error: grpcFailure(9, "FAILED_PRECONDITION: Exec has already completed"),
      };
      await expect(box.run("sleep 3", { stdin: "x", timeoutMs: 10_000 })).rejects.toMatchObject({
        provider: "modal",
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
    const events: { sandboxId: string; requestMs: number | null; stoppedMs: number | null }[] = [];
    const observed = provider({ onDestroy: (event) => events.push(event) });
    await expect(observed.destroy("sb-unknown")).resolves.toBeUndefined();
    // A sandbox Modal reports gone is a confirmed stop, with no request latency to report.
    expect(events).toEqual([
      { sandboxId: "sb-unknown", requestMs: null, stoppedMs: expect.any(Number) },
    ]);
  });

  test("destroy resolves only once Modal reports the sandbox stopped, and reports both latencies", async () => {
    const key = `slow-${crypto.randomUUID()}`;
    const events: { sandboxId: string; requestMs: number | null; stoppedMs: number | null }[] = [];
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

  test("one deadline bounds destroy: a stalled tag write never holds it, a stalled poll times out", async () => {
    const adapter = provider({ destroyWaitMs: 20 });

    // The stop is confirmed at once; the advisory tag write never returns. (A little more than
    // 20 ms, since the mock's own terminate removes a directory before it returns.)
    const tagged = await createSandbox(provider({ destroyWaitMs: 60 }));
    const stalledTags = mock.sandboxes.get(tagged.id)!;
    stalledTags.stall.setTags = true;

    // How a destroy has settled 150 ms after it started: resolved, its error code, or pending.
    const outcome = async (promise: Promise<void>) => {
      try {
        await promise;

        return "resolved";
      } catch (error) {
        return modalError(error).code;
      }
    };

    const settled = (promise: Promise<void>) =>
      Promise.race([
        outcome(promise),
        new Promise((resolve) => setTimeout(() => resolve("pending"), 150)),
      ]);

    expect(await settled(provider({ destroyWaitMs: 60 }).destroy(tagged.id))).toBe("resolved");
    expect(await stalledTags.poll()).toBe(137);

    // Modal never answers the poll: destroy is a retryable timeout within the deadline.
    const polled = await createSandbox(adapter);
    const stalledPoll = mock.sandboxes.get(polled.id)!;
    stalledPoll.stall.poll = true;
    expect(await settled(adapter.destroy(polled.id))).toBe("timeout");
    stalledPoll.stall = {};

    // The terminate request itself never returns: also a timeout, inside the same deadline.
    const terminating = await createSandbox(adapter);
    const stalledTerminate = mock.sandboxes.get(terminating.id)!;
    stalledTerminate.stall.terminate = true;
    expect(await settled(adapter.destroy(terminating.id))).toBe("timeout");
    stalledTerminate.stall = {};
    await provider().destroy(terminating.id);
    await provider().destroy(polled.id);
  });

  test("a termination this process requested is never handed out, even when the tag write fails", async () => {
    const key = `dying-${crypto.randomUUID()}`;
    const adapter = provider({ destroyWaitMs: 5_000 });
    const box = await createSandbox(adapter, { key });
    const native = mock.sandboxes.get(box.id)!;
    native.stopDelayMs = 1500;
    native.tagFailure = grpcFailure(14, "tag write unavailable");
    const destroying = adapter.destroy(box.id);
    await new Promise((resolve) => setTimeout(resolve, 300));

    // The same provider tracks the pending termination locally.
    expect(await adapter.find(key)).toBeUndefined();
    expect(await adapter.connect(box.id)).toMatchObject({ id: box.id, state: "stopped" });
    expect(await adapter.list({})).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: box.id, state: "stopped" })]),
    );
    await destroying;

    // A tag write that fails once is retried, so another process sees the marker as well.
    const retried = await createSandbox(adapter, { key: `${key}-retry` });
    const flaky = mock.sandboxes.get(retried.id)!;
    flaky.stopDelayMs = 1500;
    flaky.tagFailure = grpcFailure(14, "tag write unavailable");
    flaky.tagFailureCount = 1;
    const second = adapter.destroy(retried.id);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(flaky.tags).toHaveProperty("sandbox-sdk-destroying");
    expect(await provider().find(`${key}-retry`)).toBeUndefined();
    await second;
  });

  test("a refused termination surfaces and leaves the sandbox listed and connectable", async () => {
    const label = crypto.randomUUID();
    const box = await createSandbox(provider(), { labels: { failing: label } });
    const native = mock.sandboxes.get(box.id)!;
    // PERMISSION_DENIED is Modal's definitive answer: it did not act on the request.
    native.terminateFailure = grpcFailure(7, "PERMISSION_DENIED: terminate refused");
    await expect(box.destroy()).rejects.toMatchObject({ code: "auth", provider: "modal" });
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

  test("a lost terminate response keeps the sandbox out of find() until a poll resolves it", async () => {
    const key = `lost-${crypto.randomUUID()}`;
    const events: { requestMs: number | null; stoppedMs: number | null }[] = [];

    const adapter = provider({ destroyWaitMs: 300, onDestroy: (event) => events.push(event) });

    const box = await createSandbox(adapter, { key, labels: { lost: key } });
    const native = mock.sandboxes.get(box.id)!;
    // Modal accepts the terminate, then the response is lost (gRPC UNAVAILABLE).
    native.stopDelayMs = 1500;
    native.terminateLostResponse = grpcFailure(14, "UNAVAILABLE: connection reset");
    await expect(adapter.destroy(box.id)).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });

    // Still terminating as far as this provider knows: never handed out, listed as stopped.
    expect(await adapter.find(key)).toBeUndefined();
    expect(await adapter.connect(box.id)).toMatchObject({ id: box.id, state: "stopped" });
    expect(await adapter.list({ lost: key })).toMatchObject([{ id: box.id, state: "stopped" }]);

    // A retry with time to spare waits for the stop already under way.
    native.terminateLostResponse = undefined;
    await provider().destroy(box.id);
    expect(await native.poll()).toBe(137);

    // With room in the deadline, the poll after a lost response confirms the stop itself.
    const second = await createSandbox(provider({ onDestroy: (event) => events.push(event) }));
    const secondNative = mock.sandboxes.get(second.id)!;
    secondNative.stopDelayMs = 200;
    secondNative.terminateLostResponse = grpcFailure(14, "UNAVAILABLE: connection reset");
    await provider({ onDestroy: (event) => events.push(event) }).destroy(second.id);
    expect(await secondNative.poll()).toBe(137);
    // The request's own latency is unknown when its response was lost.
    expect(events.at(-1)).toMatchObject({ requestMs: null, stoppedMs: expect.any(Number) });
  });

  test("a refused retry does not clear an earlier terminate whose response was lost", async () => {
    const key = `retry-${crypto.randomUUID()}`;
    const adapter = provider({ destroyWaitMs: 200 });
    const box = await createSandbox(adapter, { key });
    const native = mock.sandboxes.get(box.id)!;
    // The first terminate is accepted but its response is lost, and the stop takes a while.
    native.stopDelayMs = 3000;
    native.terminateLostResponse = grpcFailure(14, "UNAVAILABLE: connection reset");
    await expect(adapter.destroy(box.id)).rejects.toMatchObject({ code: "unavailable" });
    // The retry is refused outright; that says nothing about the first request.
    native.terminateLostResponse = undefined;
    native.terminateFailure = grpcFailure(7, "PERMISSION_DENIED: terminate refused");
    await expect(adapter.destroy(box.id)).rejects.toMatchObject({ code: "auth" });
    expect(await adapter.find(key)).toBeUndefined();
    expect(await adapter.connect(box.id)).toMatchObject({ id: box.id, state: "stopped" });
    native.terminateFailure = undefined;
  });

  test("FAILED_PRECONDITION on terminate is not taken as a refusal", async () => {
    const key = `precondition-${crypto.randomUUID()}`;
    const adapter = provider({ destroyWaitMs: 200 });
    const box = await createSandbox(adapter, { key });
    const native = mock.sandboxes.get(box.id)!;
    native.terminateFailure = grpcFailure(9, "FAILED_PRECONDITION: sandbox is stopping");
    await expect(adapter.destroy(box.id)).rejects.toBeDefined();
    // It may already be stopping, so it is never handed out again.
    expect(await adapter.find(key)).toBeUndefined();
    native.terminateFailure = undefined;
  });

  test("a restore whose setup fails after allocation reports the allocated sandbox", async () => {
    const box = await createSandbox(provider());
    const { id } = await box.snapshot();
    const create = mock.client.sandboxes.create;
    let restoredId: string | undefined;
    // The restored sandbox exists, then its tag write is refused (PERMISSION_DENIED).
    mock.client.sandboxes.create = async (...args: Parameters<typeof create>) => {
      const created = await create(...args);
      created.tagFailure = grpcFailure(7, "PERMISSION_DENIED: tags refused");
      restoredId = created.sandboxId;

      return created;
    };

    try {
      const attempt = createSandbox(provider(), { from: id });
      await expect(attempt).rejects.toMatchObject({ code: "auth", provider: "modal" });
      expect(restoredId).toBeDefined();
      await expect(attempt).rejects.toHaveProperty("sandboxId", restoredId);
    } finally {
      mock.client.sandboxes.create = create;
      await box.destroy();
    }
  });

  test("only Modal's finished-command refusal counts as stdin to an exited command", async () => {
    const box = await createSandbox(provider());
    const native = mock.sandboxes.get(box.id)!;

    try {
      // Another FAILED_PRECONDITION is no proof the command read its input, even once it exited.
      native.stdinFailure = {
        on: "write",
        error: grpcFailure(9, "FAILED_PRECONDITION: Sandbox is not accepting new execs"),
        afterExit: true,
      };
      await expect(box.run("exit 3", { stdin: "lost" })).rejects.toMatchObject({
        provider: "modal",
      });
    } finally {
      native.stdinFailure = undefined;
      await box.destroy();
    }
  });

  test("list() and listPending() look Apps up without creating them", async () => {
    const missing = `sandbox-sdk-never-${crypto.randomUUID().slice(0, 8)}`;
    const adapter = provider({ app: missing });
    expect(await adapter.list({})).toEqual([]);
    expect(mock.existingApps.has(missing)).toBe(false);
    expect(await adapter.listPending({})).toEqual([]);
    expect(mock.existingApps.has(missing)).toBe(false);
  });

  test("listPending finds a restore allocation still tagged pending, in Apps the provider knows", async () => {
    const run = crypto.randomUUID();
    const app = `bench-pending-${run.slice(0, 8)}`;
    // As a creator that crashed after Modal allocated the restore and before it cleared the marker.
    const owner = await mock.client.apps.fromName(app, { createIfMissing: true });

    const pending = await mock.client.sandboxes.create(
      owner,
      mock.client.images.fromRegistry("x"),
      {
        tags: { "sandbox-sdk": "pending", run, "sandbox-sdk-created": "1" },
      },
    );

    try {
      const fresh = provider();
      // list() shows only finished sandboxes, and a fresh provider does not know the App yet.
      expect(await fresh.listPending({ run })).toEqual([]);
      await fresh.prepareApp(app, { createIfMissing: false });
      expect(await fresh.list({ run })).toEqual([]);
      expect(await fresh.listPending({ run })).toEqual([
        { id: pending.sandboxId, labels: { "sandbox-sdk": "pending", run }, createdAt: 1 },
      ]);
      expect(await fresh.listPending({ run: "other" })).toEqual([]);

      // Destroy needs no attach, so cleanup does not wait for the marker to clear.
      await fresh.destroy(pending.sandboxId);
      expect(await pending.poll()).toBe(137);
      expect(await fresh.listPending({ run })).toEqual([]);
    } finally {
      await pending.terminate().catch(() => {});
    }
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
