import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { connectSandbox, createSandbox, deleteSnapshot, SandboxError } from "../src/index.js";
import { maritime, type MaritimeOptions } from "../src/providers/maritime/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.MARITIME_API_KEY);

if (credentials) vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `maritime-${Date.now()}`;

/** Snapshot names this run made, checked gone at the end. */
const snapshots = new Set<string>();

// Every live sandbox carries this run's label, and Maritime ends it after 15 minutes regardless.
function liveProvider(options: MaritimeOptions = {}) {
  const provider = maritime(options);
  const create = provider.create;
  const snapshot = provider.snapshot;

  if (!snapshot) throw new Error("the Maritime adapter has snapshots");

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

describe.skipIf(!credentials)("Maritime live (billable)", () => {
  // A case makes up to three sandboxes, and each create may wait out Maritime's capacity refusals (up
  // to 3 minutes), so a case gets more than the suite's default 120 seconds.
  runConformance(() => liveProvider(), {
    live: true,
    snapshotExpiry: "refused",
    timeoutMs: 600_000,
  });
});

describe.skipIf(!credentials)("Maritime live options", { timeout: 900_000 }, () => {
  test("the default is small (2 vCPU / 4 GiB / 12 GiB); medium as an exact size gets its 50 GiB disk", async () => {
    const base = await createSandbox(liveProvider());

    try {
      const probe = await base.run(
        "nproc; awk '/MemTotal/{print $2}' /proc/meminfo; df -BG --output=size / | tail -1; id -u; stat -c %u /workspace",
      );

      const [cpus, memoryKb, disk, uid, owner] = probe.stdout.trim().split("\n");

      expect(Number(cpus)).toBe(2);
      expect(Number(memoryKb)).toBeGreaterThan(3.5 * 1024 * 1024);
      expect(Number(disk?.trim().replace("G", ""))).toBeGreaterThanOrEqual(11);
      expect(owner).toBe(uid);
    } finally {
      await base.destroy();
    }

    const medium = await createSandbox(liveProvider(), { size: { cpu: 4, memoryMb: 8192 } });

    try {
      const probe = await medium.run("nproc; df -BG --output=size / | tail -1");
      const [cpus, disk] = probe.stdout.trim().split("\n");

      expect(Number(cpus)).toBe(4);
      expect(Number(disk?.trim().replace("G", ""))).toBeGreaterThanOrEqual(45);
    } finally {
      await medium.destroy();
    }
  });

  test("sizes and policies the provider cannot honour fail before anything is created", async () => {
    const provider = liveProvider();

    await expect(
      createSandbox(provider, { size: { cpu: 2, memoryMb: 3000 } }),
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

      // An abort before the command could register its process group.
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

  test("a 10 MiB file and a 1.5 MB stdin arrive whole; large output streams whole", async () => {
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

      const input = "x".repeat(1_500_000);

      expect((await box.run("wc -c", { stdin: input })).stdout.trim()).toBe("1500000");

      const big = await box.run("head -c 2000000 /dev/zero | tr '\\0' y", {
        maxOutputBytes: 4_000_000,
      });

      expect(big.stdout.length).toBe(2_000_000);

      await expect(box.files.read("missing.txt")).rejects.toMatchObject({
        code: "file_not_found",
      });
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

      try {
        const restored = await createSandbox(provider, { from: id, size: "medium" });

        try {
          expect(await restored.files.read("state.txt")).toBe("kept\n");
          expect((await restored.run("pwd; nproc")).stdout).toBe("/workspace\n4\n");
        } finally {
          await restored.destroy();
        }

        expect(await deleteSnapshot(provider, id)).toBe(true);
        expect(await deleteSnapshot(provider, id)).toBe(false);
      } finally {
        // A failed restore must not leave the snapshot behind.
        await deleteSnapshot(provider, id);
      }
    } finally {
      await box.destroy();
    }
  });

  test("an ended sandbox is not_found everywhere, and a stale key recreates", async () => {
    const provider = liveProvider();
    const key = `maritime-live-${crypto.randomUUID()}`;
    const first = await createSandbox(provider, { key });
    const id = first.id;

    await first.destroy();
    await expect(provider.connect(id)).rejects.toMatchObject({ code: "not_found" });
    await expect(connectSandbox(provider, id)).rejects.toMatchObject({ code: "not_found" });
    expect(await provider.find(key)).toBeUndefined();
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

  test("a preview is private: its URL carries the token, a path keeps it, and no token is refused", async () => {
    const box = await createSandbox(liveProvider());

    try {
      await box.files.write("site/index.html", "hello-maritime\n");
      await box.files.write("site/health", "healthy\n");

      const server = await box.start("python3 -m http.server 3000 --bind 0.0.0.0", {
        name: "web",
        cwd: "site",
        ready: { port: 3000 },
      });

      const preview = await box.preview(3000, { waitMs: 30_000 });
      const url = new URL(preview.url);

      expect(url.searchParams.get("token")).toMatch(/^mut_/);
      expect(server.url).toBeTruthy();

      const ok = await fetch(preview.url);

      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-maritime\n");

      const health = await box.preview(3000, { path: "/health?probe=1" });

      expect(new URL(health.url).searchParams.get("token")).toBe(url.searchParams.get("token"));
      expect(await (await fetch(health.url)).text()).toBe("healthy\n");

      url.searchParams.delete("token");
      expect((await fetch(url, { redirect: "manual" })).status).not.toBe(200);

      // A fresh client asks Maritime for the URL again.
      const again = await (await connectSandbox(liveProvider(), box.id)).preview(3000);

      expect((await fetch(again.url)).status).toBe(200);

      // Errors never carry the URL token.
      const error = await box.native
        .request("GET", "/sandboxes/{id}/nothing-here", {
          query: { t: url.searchParams.get("token") ?? "" },
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(SandboxError);
      expect(String(error)).not.toMatch(/mut_|mst_|mk_/);
    } finally {
      await box.destroy();
    }
  });

  // destroy ends the sandbox, so anything still listed here is a leak; snapshots too.
  test("no sandbox or snapshot from this run is left", async () => {
    const provider = liveProvider();
    const live = async () => (await provider.list({ "live-run": run })).map((s) => s.id);

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);

    for (const name of snapshots) expect(await deleteSnapshot(provider, name)).toBe(false);
  });
});
