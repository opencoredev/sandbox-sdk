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

  test("destroy marks the sandbox gone for every client while Modal is still stopping it", async () => {
    const key = `slow-${crypto.randomUUID()}`;
    const box = await createSandbox(provider(), { key, labels: { slow: key } });
    const native = mock.sandboxes.get(box.id)!;
    native.stopDelayMs = 2000;
    const started = Date.now();
    await box.destroy();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await native.poll()).toBe(null);
    expect(native.tags).toMatchObject({
      "sandbox-sdk": "destroyed",
      "sandbox-sdk-key": key,
      slow: key,
    });
    await expect(provider().connect(box.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await provider().find(key)).toBeUndefined();
    expect(await listSandboxes(provider(), { labels: { slow: key } })).toEqual([]);
    await native.stopping;
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
