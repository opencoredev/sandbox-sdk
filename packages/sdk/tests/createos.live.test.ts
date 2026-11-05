import { afterAll, describe, expect, test, vi } from "vitest";
import { createSandbox, connectSandbox, deleteSnapshot } from "../src/index.js";
import { createos, type CreateosOptions } from "../src/providers/createos/index.js";
import { runConformance } from "../src/testing.js";

// Live provisioning is explicit; having credentials in a developer shell alone is insufficient.
const live =
  process.env.CREATEOS_LIVE_TESTS === "1" && Boolean(process.env.CREATEOS_SANDBOX_API_KEY);

if (live) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(!live)("CreateOS live (billable)", () => {
  const run = crypto.randomUUID();
  const owned = new Set<string>();
  const ownedSnapshots = new Set<string>();

  function liveProvider(options?: CreateosOptions) {
    const provider = createos(options);
    const create = provider.create;
    provider.create = async (input) => {
      const box = await create({ ...input, labels: { ...input.labels, "createos-live-run": run } });
      owned.add(box.id);

      return box;
    };

    return provider;
  }

  afterAll(async () => {
    const provider = createos();

    for (const box of await provider.list({ "createos-live-run": run })) owned.add(box.id);

    for (const id of owned) await provider.destroy(id);

    for (const id of ownedSnapshots) await deleteSnapshot(provider, id);
    expect(await provider.list({ "createos-live-run": run })).toEqual([]);
    console.info(
      `CreateOS cleanup verified: ${owned.size} test sandboxes, no remaining live resources (run ${run}).`,
    );
  });

  runConformance(() => liveProvider(), { live: true, snapshotExpiry: "refused" });

  test.each(["disk", "full"] as const)(
    "reusable %s snapshot survives source deletion",
    { timeout: 600_000 },
    async (snapshotType) => {
      const provider = liveProvider({ snapshotType, requestTimeoutMs: 300_000 });
      await using source = await createSandbox(provider);
      await source.files.write("saved.txt", "original");
      const snapshot = await source.snapshot();
      ownedSnapshots.add(snapshot.id);

      try {
        expect((await source.run("cat saved.txt")).stdout).toBe("original");
        await source.destroy();
        await using restored = await createSandbox(provider, { from: snapshot.id });
        expect(await restored.files.read("saved.txt")).toBe("original");
        await restored.files.write("saved.txt", "changed");
        await using other = await createSandbox(provider, { from: snapshot.id });
        expect(await other.files.read("saved.txt")).toBe("original");
        expect(await deleteSnapshot(provider, snapshot.id)).toBe(true);
        expect(await deleteSnapshot(provider, snapshot.id)).toBe(false);
        ownedSnapshots.delete(snapshot.id);
      } finally {
        await deleteSnapshot(provider, snapshot.id);
      }
    },
  );

  test(
    "ranged reads exceed 12 MiB and preserve missing-file errors",
    { timeout: 180_000 },
    async () => {
      // A bulk read spans multiple bounded command round trips; allow for live network latency.
      const provider = liveProvider({ requestTimeoutMs: 120_000 });
      await using box = await createSandbox(provider);
      const bytes = Buffer.alloc(13 * 1024 * 1024 + 71);

      for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
      await box.files.write("large.bin", bytes);
      expect(Buffer.from(await box.files.read("large.bin", { as: "bytes" })).equals(bytes)).toBe(
        true,
      );

      const range = await provider.files.readRange!(box.id, "/workspace/large.bin", {
        offset: 37,
        length: bytes.length,
      });

      expect(Buffer.from(range).equals(bytes.subarray(37))).toBe(true);
      await expect(
        provider.files.readRange!(box.id, "/workspace/missing", { offset: 0, length: 4096 }),
      ).rejects.toMatchObject({ code: "file_not_found" });
    },
  );

  test("terminal preserves output produced before subscribing", async () => {
    await using box = await createSandbox(liveProvider());
    const terminal = await box.terminal({ cols: 80, rows: 24 });

    try {
      await terminal.write("printf 'back%s\\n' log; sleep 1; exit 7\n");
      expect(await terminal.wait?.()).toEqual({ exitCode: 7 });
      let output = "";

      const off = terminal.onData((text) => {
        output += text;
      });

      expect(output).toContain("backlog");
      off();
    } finally {
      await terminal.close();
    }
  });

  test("closing a running terminal settles wait without cancellation", async () => {
    await using box = await createSandbox(liveProvider());
    const terminal = await box.terminal({ cols: 80, rows: 24 });

    try {
      await terminal.write("sleep 60\n");
      const exited = terminal.wait?.();
      await terminal.close();
      expect(await exited).toHaveProperty("exitCode");
    } finally {
      await terminal.close();
    }
  });

  test("pause, explicit resume, and reconnect preserve files", async () => {
    await using box = await createSandbox(liveProvider(), { idleTimeoutMs: 60_001 });
    await box.files.write("persist.txt", "preserved");
    await box.pause();

    const paused = await box.native.request<{ data: { status: string } }>(
      "GET",
      "/v1/sandboxes/{sandboxId}",
    );

    expect(paused.data.status).toBe("paused");
    await box.resume();
    expect(await box.files.read("persist.txt")).toBe("preserved");
    await box.pause();
    const connected = await connectSandbox(createos(), box.id);

    try {
      expect((await connected.run("cat persist.txt")).stdout).toBe("preserved");
    } finally {
      await connected.close();
    }
  });

  test("PTY supports dimensions, resize, environment, stdin, output, and exit", async () => {
    await using box = await createSandbox(liveProvider());
    const terminal = await box.terminal({ cols: 80, rows: 24, env: { SDK_PTY: "pty-value" } });
    let output = "";

    const unsubscribe = terminal.onData((data) => {
      output += data;
    });

    try {
      await terminal.write("stty size; printf '%s\\n' \"$SDK_PTY\"\n");
      await expect.poll(() => output, { timeout: 15_000 }).toContain("24 80");
      await expect.poll(() => output, { timeout: 15_000 }).toContain("pty-value");
      await terminal.resize(100, 30);
      await terminal.write("stty size\n");
      await expect.poll(() => output, { timeout: 15_000 }).toContain("30 100");
      await terminal.write("exit 7\n");
      expect(await terminal.wait?.()).toEqual({ exitCode: 7 });
    } finally {
      unsubscribe();
      await terminal.close();
    }
  });

  test.each(["small", "medium", "large"] as const)("portable size %s is enforced", async (size) => {
    await using box = await createSandbox(liveProvider(), { size });
    const expected = { small: [1, 1024], medium: [2, 2048], large: [4, 4096] }[size];

    const details = await box.native.request<{ data: { vcpu: number; mem_mib: number } }>(
      "GET",
      "/v1/sandboxes/{sandboxId}",
    );

    expect([details.data.vcpu, details.data.mem_mib]).toEqual(expected);
    expect((await box.run("true")).ok).toBe(true);
  });

  test("network allowlist permits an allowed host and blocks another", async () => {
    await using box = await createSandbox(liveProvider(), {
      network: { allow: ["registry.npmjs.org"] },
    });

    const allowed = await box.run("curl -fsS --max-time 15 https://registry.npmjs.org/-/ping", {
      timeoutMs: 25_000,
    });

    expect(allowed.ok).toBe(true);

    const denied = await box.run("curl -fsS --max-time 5 https://example.com", {
      timeoutMs: 15_000,
    });

    expect(denied.ok).toBe(false);
    expect(denied.timedOut).toBe(false);
  });

  test("binary transfers, dynamic environment, and secrets survive reconnect", async () => {
    const secret = `live-secret-${crypto.randomUUID()}`;
    await using box = await createSandbox(liveProvider(), { secrets: { SDK_SECRET: secret } });
    const bytes = new Uint8Array(1024 * 1024);

    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await box.files.write("nested/binary.dat", bytes);
    expect(await box.files.read("nested/binary.dat", { as: "bytes" })).toEqual(bytes);
    const connected = await connectSandbox(createos(), box.id);

    try {
      const result = await connected.run('printf "%s\\n%s" "$SDK_SECRET" "$DYNAMIC"', {
        env: { DYNAMIC: "a'b\n$(not-a-command)" },
      });

      expect(result.stdout).toBe("[REDACTED]\na'b\n$(not-a-command)");
    } finally {
      await connected.close();
    }
  });

  test("background restart, line streaming, and reattach after close", async () => {
    await using box = await createSandbox(liveProvider());

    const process = await box.start("echo READY; sleep 60", {
      name: "restart",
      ready: { log: /READY/ },
      readyTimeoutMs: 15_000,
    });

    expect(process.ready).toBe(true);

    for await (const line of process.lines()) {
      expect(line.text).toContain("READY");
      break;
    }

    await box.close();
    const connected = await connectSandbox(createos(), box.id);

    try {
      const reattached = connected.process("restart");
      expect((await reattached.logs()).text).toContain("READY");
      await reattached.restart();
      expect((await reattached.logs()).text).toContain("READY");
      await reattached.stop({ graceMs: 100 });
      expect((await reattached.wait()).exitCode).not.toBeNull();
    } finally {
      await connected.close();
    }
  });

  test("exact CPU, memory, and disk allocation match native metadata", async () => {
    await using box = await createSandbox(liveProvider({ rootfs: "devbox:1" }), {
      size: { cpu: 1, memoryMb: 1024, diskGb: 20 },
    });

    const details = await box.native.request<{
      data: { vcpu: number; mem_mib: number; disk_mib: number };
    }>("GET", "/v1/sandboxes/{sandboxId}");

    expect(details.data).toMatchObject({ vcpu: 1, mem_mib: 1024, disk_mib: 20 * 1024 });
  });

  test(
    "idle timeout actually auto-pauses and reconnect resumes",
    { timeout: 210_000 },
    async () => {
      await using box = await createSandbox(liveProvider(), { idleTimeoutMs: 60_000 });
      await expect
        .poll(
          async () => {
            const response = await box.native.request<{
              data: { status: string; auto_pause_after_seconds: number };
            }>("GET", "/v1/sandboxes/{sandboxId}");

            expect(response.data.auto_pause_after_seconds).toBe(60);

            return response.data.status;
          },
          { timeout: 180_000, interval: 10_000 },
        )
        .toBe("paused");
      const connected = await connectSandbox(createos(), box.id);

      try {
        expect((await connected.run("echo awake")).stdout).toBe("awake\n");
      } finally {
        await connected.close();
      }
    },
  );
});
