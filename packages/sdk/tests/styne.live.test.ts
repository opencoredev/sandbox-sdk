import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { connectSandbox, createSandbox, deleteSnapshot, SandboxError } from "../src/index.js";
import { styne, type StyneOptions } from "../src/providers/styne/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.STYNE_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `styne-${Date.now()}`;

/** Snapshot names this run made, checked gone at the end. */
const snapshots = new Set<string>();

// Every live sandbox carries this run's label, and Styne ends it after 15 minutes of running regardless.
function liveProvider(options: StyneOptions = {}) {
  const provider = styne(options);
  const create = provider.create;
  const snapshot = provider.snapshot;

  if (!snapshot) throw new Error("the Styne adapter has snapshots");

  provider.create = (input) =>
    create({ timeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

  provider.snapshot = async (id, snapshotOptions) => {
    const made = await snapshot(id, snapshotOptions);
    snapshots.add(made.id);

    return made;
  };

  return provider;
}

/** Processes in the sandbox whose command line has `marker`, as `pid pgid`. */
async function survivors(box: Awaited<ReturnType<typeof createSandbox>>, marker: string) {
  const ps = await box.run(
    `ps -eo pid=,pgid=,args= | grep -F -e ${JSON.stringify(marker)} | grep -v grep || true`,
  );

  return ps.stdout.trim();
}

describe.skipIf(!credentials)("Styne live (billable)", () => {
  runConformance(() => liveProvider(), { live: true, snapshotExpiry: "refused" });
});

describe.skipIf(!credentials)("Styne live options", { timeout: 300_000 }, () => {
  test("base is 4 vCPU / 8 GiB with a 51 GiB /workspace; small and xlarge are what they say", async () => {
    const base = await createSandbox(liveProvider());

    try {
      const probe = await base.run(
        "nproc; awk '/MemTotal/{print $2}' /proc/meminfo; df -BG --output=size /workspace | tail -1",
      );

      const [cpus, memoryKb, disk] = probe.stdout.trim().split("\n");
      expect(Number(cpus)).toBe(4);
      expect(Number(memoryKb)).toBeGreaterThan(7.5 * 1024 * 1024);
      expect(disk?.trim()).toBe("51G");
    } finally {
      await base.destroy();
    }

    for (const [size, cpus] of [
      ["small", 2],
      [{ cpu: 16, memoryMb: 32768 }, 16],
    ] as const) {
      const box = await createSandbox(liveProvider(), { size });

      try {
        expect(Number((await box.run("nproc")).stdout.trim())).toBe(cpus);
      } finally {
        await box.destroy();
      }
    }
  });

  test("sizes the provider cannot honour fail before anything is created", async () => {
    const provider = liveProvider();

    await expect(
      createSandbox(provider, { size: { cpu: 3, memoryMb: 4096 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      createSandbox(provider, { size: { cpu: 2, memoryMb: 4096, diskGb: 20 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider, { from: "any", size: "large" })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      createSandbox(liveProvider({ template: "large" }), { size: "small" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      createSandbox(provider, { network: { allow: ["registry.npmjs.org"] } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(await provider.list({ "live-run": run })).toEqual([]);
  });

  test("network none blocks outbound traffic, the default allows it", async () => {
    const open = await createSandbox(liveProvider());
    const closed = await createSandbox(liveProvider(), { network: "none" });
    const probe = "curl -s -o /dev/null -m 8 -w '%{http_code}' https://1.1.1.1/ || echo blocked";

    try {
      expect((await open.run(probe)).stdout).not.toContain("blocked");
      expect((await closed.run(probe)).stdout).toContain("blocked");
      expect(
        (await closed.run("curl -6 -s -o /dev/null -m 8 https://example.com/ || echo blocked"))
          .stdout,
      ).toContain("blocked");
    } finally {
      await Promise.all([open.destroy(), closed.destroy()]);
    }
  });

  test("timeout and abort kill the whole process group, with stdin closed or given", async () => {
    const box = await createSandbox(liveProvider());

    try {
      // A timeout: the command and a background child in its group both go.
      const slow = await box.run("sleep 301 & sleep 302; echo late", { timeoutMs: 1500 });
      expect(slow).toMatchObject({ timedOut: true, exitCode: null, ok: false });
      expect(await survivors(box, "sleep 30")).toBe("");

      // A timeout keeps the output written before it.
      const partial = await box.run("echo early; sleep 303", { timeoutMs: 1500 });
      expect(partial).toMatchObject({ timedOut: true });
      expect(partial.stdout).toBe("early\n");

      // An abort while stdin was given and closed.
      const controller = new AbortController();

      const reading = box.run("cat >/dev/null; sleep 304 & sleep 305", {
        stdin: "data\n",
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 1500);
      expect(await reading).toMatchObject({ timedOut: true, exitCode: null });
      expect(await survivors(box, "sleep 30")).toBe("");

      // An abort before the command could report that it started.
      const early = new AbortController();

      const racing = box.run("echo started > /tmp/early-marker; sleep 306 & sleep 307", {
        signal: early.signal,
      });

      early.abort();
      expect(await racing).toMatchObject({ timedOut: true });
      // Whether or not it began, nothing of it runs once run() settles, and it never starts later.
      expect(await survivors(box, "sleep 30")).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(await survivors(box, "sleep 30")).toBe("");
    } finally {
      await box.destroy();
    }
  });

  test("a 10 MiB file goes up and comes back whole; relative paths resolve in /workspace", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const bytes = new Uint8Array(10 * 1024 * 1024).map((_, i) => (i * 31) % 251);

      await box.files.write("big.bin", bytes);
      expect((await box.run("sha256sum /workspace/big.bin")).stdout.split(" ")[0]).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(
        Buffer.from(await box.files.read("/workspace/big.bin", { as: "bytes" })).equals(
          Buffer.from(bytes),
        ),
      ).toBe(true);

      // remove without recursive refuses a directory with files in it; with it, the tree goes.
      await box.files.write("tree/a/b.txt", "x");
      await expect(box.files.remove("tree", { recursive: false })).rejects.toBeInstanceOf(
        SandboxError,
      );
      expect(await box.files.exists("tree/a/b.txt")).toBe(true);
      await box.run("mkdir -p tree/empty");
      await box.files.remove("tree/empty", { recursive: false });
      expect(await box.files.exists("tree/empty")).toBe(false);
      await box.files.remove("tree", { recursive: true });
      expect(await box.files.exists("tree")).toBe(false);
      await expect(box.files.read("missing.txt")).rejects.toMatchObject({
        code: "file_not_found",
      });
      await expect(box.files.remove("missing.txt", { recursive: false })).rejects.toMatchObject({
        code: "file_not_found",
      });

      // git works in a folder the file API created.
      await box.files.write("repo/README.md", "hi\n");
      expect((await box.run("git init -q && git status --short", { cwd: "repo" })).ok).toBe(true);
    } finally {
      await box.destroy();
    }
  });

  test("pause and resume keep state and are idempotent; a snapshot restores and deletes", async () => {
    const provider = liveProvider();
    const box = await createSandbox(provider);

    try {
      await box.files.write("state.txt", "kept\n");
      await box.pause();
      await box.pause();
      expect((await provider.connect(box.id)).state).toBe("paused");
      await box.resume();
      await box.resume();
      expect(await box.files.read("state.txt")).toBe("kept\n");

      await box.run("sync");
      const { id } = await box.snapshot();
      const restored = await createSandbox(provider, { from: id });

      try {
        expect(await restored.files.read("state.txt")).toBe("kept\n");
        expect((await restored.run("pwd")).stdout).toBe("/workspace\n");
      } finally {
        await restored.destroy();
      }

      expect(await deleteSnapshot(provider, id)).toBe(true);
      expect(await deleteSnapshot(provider, id)).toBe(false);
    } finally {
      await box.destroy();
    }
  });

  test("an ended sandbox is not_found everywhere, and a stale key recreates", async () => {
    const provider = liveProvider();
    const key = `styne-live-${crypto.randomUUID()}`;
    const first = await createSandbox(provider, { key });
    const id = first.id;

    await first.destroy();
    // Styne answers 410 sandbox_ended for a while after a delete, then 404.
    await expect(provider.connect(id)).rejects.toMatchObject({ code: "not_found" });
    await expect(connectSandbox(provider, id)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      provider.exec(id, {
        command: "true",
        cwd: "/workspace",
        env: {},
        timeoutMs: 10_000,
        onChunk() {},
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(provider.destroy(id)).resolves.toBeUndefined();

    const stored = new Map([[key, id]]);

    const second = await createSandbox(provider, {
      key,
      locator: {
        get: async (k) => stored.get(k),
        set: async (k, value) => void stored.set(k, value),
        delete: async (k) => void stored.delete(k),
      },
    });

    try {
      expect(second.created).toBe(true);
      expect(second.id).not.toBe(id);
    } finally {
      await second.destroy();
    }
  });

  test("a preview needs the traffic token, which preview() returns", async () => {
    const box = await createSandbox(liveProvider());

    try {
      await box.files.write("site/index.html", "hello-styne\n");

      const server = await box.start("python3 -m http.server 3000 --bind 0.0.0.0", {
        name: "web",
        cwd: "site",
        ready: { port: 3000 },
      });

      const preview = await box.preview(3000);

      expect(preview.headers?.["e2b-traffic-access-token"]).toBeTruthy();
      expect(server.url).toBe(preview.url);
      const ok = await fetch(preview.url, { headers: preview.headers });
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-styne\n");
      expect((await fetch(preview.url)).status).toBe(401);

      // A fresh client has no token cached and reads it again.
      const again = await (await connectSandbox(liveProvider(), box.id)).preview(3000);
      expect((await fetch(again.url, { headers: again.headers })).status).toBe(200);
    } finally {
      await box.destroy();
    }
  });

  // destroy deletes the sandbox, so anything still listed here is a leak; snapshots too.
  test("no sandbox or snapshot from this run is left", async () => {
    const provider = liveProvider();
    const live = async () => (await provider.list({ "live-run": run })).map((s) => s.id);

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);

    for (const name of snapshots) expect(await deleteSnapshot(provider, name)).toBe(false);
  });
});
