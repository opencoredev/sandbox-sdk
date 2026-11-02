import { describe, expect, test, vi } from "vitest";
import { createSandbox, connectSandbox } from "../src/index.js";
import { createos } from "../src/providers/createos/index.js";
import { runConformance } from "../src/testing.js";

// Live provisioning is explicit; having credentials in a developer shell alone is insufficient.
const live =
  process.env.CREATEOS_LIVE_TESTS === "1" && Boolean(process.env.CREATEOS_SANDBOX_API_KEY);

if (live) vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

describe.skipIf(!live)("CreateOS live (billable)", () => {
  runConformance(() => createos(), { live: true });

  test("pause, explicit resume, and reconnect preserve files", async () => {
    await using box = await createSandbox(createos(), { idleTimeoutMs: 60_001 });
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
    await using box = await createSandbox(createos());
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
    await using box = await createSandbox(createos(), { size });
    const expected = { small: [1, 1024], medium: [2, 2048], large: [4, 4096] }[size];

    const details = await box.native.request<{ data: { vcpu: number; mem_mib: number } }>(
      "GET",
      "/v1/sandboxes/{sandboxId}",
    );

    expect([details.data.vcpu, details.data.mem_mib]).toEqual(expected);
    expect((await box.run("true")).ok).toBe(true);
  });

  test("network allowlist permits an allowed host and blocks another", async () => {
    await using box = await createSandbox(createos(), {
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
    await using box = await createSandbox(createos(), { secrets: { SDK_SECRET: secret } });
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
    await using box = await createSandbox(createos());

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
    await using box = await createSandbox(createos({ rootfs: "devbox:1" }), {
      size: { cpu: 1, memoryMb: 1024, diskGb: 20 },
    });

    const details = await box.native.request<{
      data: { vcpu: number; mem_mib: number; disk_mib: number };
    }>("GET", "/v1/sandboxes/{sandboxId}");

    expect(details.data).toMatchObject({ vcpu: 1, mem_mib: 1024, disk_mib: 20 * 1024 });
  });

  test("idle timeout actually auto-pauses and reconnect resumes", { timeout: 210_000 }, async () => {
    await using box = await createSandbox(createos(), { idleTimeoutMs: 60_000 });
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
  });
});
