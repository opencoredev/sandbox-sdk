import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { connectSandbox, createSandbox, deleteSnapshot, SandboxError } from "../src/index.js";
import { buddy, type BuddyOptions } from "../src/providers/buddy/index.js";
import { isJsonObject, type JsonValue } from "../src/shared/json.js";
import { isString } from "../src/shared/narrow.js";
import type { ProviderSandbox } from "../src/types.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.BUDDY_TOKEN && process.env.BUDDY_WORKSPACE);

if (credentials) vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `buddy-${Date.now()}`;

/** Snapshot IDs this run made, checked gone at the end. */
const snapshots = new Set<string>();

// Every live sandbox carries this run's label, and Buddy stops it after 15 idle minutes regardless.
function liveProvider(options: BuddyOptions = {}) {
  const provider = buddy(options);
  const create = provider.create;
  const snapshot = provider.snapshot;

  if (!snapshot) throw new Error("the Buddy adapter has snapshots");

  provider.create = (input) =>
    create({ idleTimeoutMs: 900_000, ...input, labels: { ...input.labels, "live-run": run } });

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

/** The commands Buddy recorded for a sandbox, newest first. */
async function recorded(box: ProviderSandbox<ReturnType<typeof buddy>>) {
  const execs = await box.native.request<JsonValue>("GET", "/sandboxes/{sandbox_id}/execs", {
    query: { limit: 200 },
  });

  if (!Array.isArray(execs)) throw new Error("Buddy's execution list is not an array");

  return execs.map((e) => (isJsonObject(e) && isString(e.command) ? e.command : "")).join("\n");
}

describe.skipIf(!credentials)("Buddy live (billable)", () => {
  runConformance(() => liveProvider(), {
    live: true,
    snapshotExpiry: "refused",
    timeoutMs: 600_000,
  });
});

describe.skipIf(!credentials)("Buddy live options", { timeout: 900_000 }, () => {
  test("the default is 2x4 (decimal GB); 4x8 as an exact size; sizes Buddy has not fail first", async () => {
    const provider = liveProvider();
    const base = await createSandbox(provider);

    try {
      const probe = await base.run(
        "nproc; awk '/MemTotal/{print $2}' /proc/meminfo; df -BG --output=size / | tail -1; id -u; stat -c %u /workspace",
      );

      const [cpus, memoryKb, disk, uid, owner] = probe.stdout.trim().split("\n");

      expect(Number(cpus)).toBe(2);
      // 4 decimal GB: about 3.7 GiB to the guest.
      expect(Number(memoryKb)).toBeGreaterThan(3.4 * 1024 * 1024);
      expect(Number(disk?.trim().replace("G", ""))).toBeGreaterThanOrEqual(40);
      expect(owner).toBe(uid);
    } finally {
      await base.destroy();
    }

    const medium = await createSandbox(provider, { size: { cpu: 4, memoryMb: 8192 } });

    try {
      expect((await medium.run("nproc")).stdout.trim()).toBe("4");
    } finally {
      await medium.destroy();
    }

    await expect(
      createSandbox(provider, { size: { cpu: 2, memoryMb: 3000 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider, { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(await provider.list({ "live-run": run, suite: "options" })).toEqual([]);
  });

  test("timeout and abort kill the whole process group, with stdin closed or given", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const slow = await box.run("sleep 301 & sleep 302; echo late", { timeoutMs: 1500 });

      expect(slow).toMatchObject({ timedOut: true, exitCode: null, ok: false });
      expect(await survivors(box, "sleep 30")).toBe("");

      // A timeout keeps the output written before it.
      const partial = await box.run("echo early; sleep 303", { timeoutMs: 3000 });

      expect(partial).toMatchObject({ timedOut: true });
      expect(partial.stdout).toBe("early\n");

      const controller = new AbortController();

      const reading = box.run("cat >/dev/null; sleep 304 & sleep 305", {
        stdin: "data\n",
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 2000);
      expect(await reading).toMatchObject({ timedOut: true, exitCode: null });
      expect(await survivors(box, "sleep 30")).toBe("");

      // An abort before the command could register its process group never lets it start later.
      const early = new AbortController();

      const racing = box.run("echo started > /tmp/early-marker; sleep 306 & sleep 307", {
        signal: early.signal,
      });

      setTimeout(() => early.abort(), 50);
      expect(await racing).toMatchObject({ timedOut: true });
      expect(await survivors(box, "sleep 30")).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(await survivors(box, "sleep 30")).toBe("");
    } finally {
      await box.destroy();
    }
  });

  test("secrets, per-run env, stdin and long commands never reach Buddy's command history", async () => {
    const secret = `buddy-secret-${crypto.randomUUID()}`;
    const perRun = `per-run-${crypto.randomUUID()}`;
    const input = `stdin-${crypto.randomUUID()}`;
    const longMarker = `long-${crypto.randomUUID()}`;
    const box = await createSandbox(liveProvider(), { secrets: { LIVE_SECRET: secret } });

    try {
      const seen = await box.run('printf "%s|%s" "$LIVE_SECRET" "$PER_RUN"; cat', {
        env: { PER_RUN: perRun },
        stdin: input,
      });

      expect(seen.stdout).toBe(`[REDACTED]|${perRun}${input}`);
      const long = await box.run(`: '${"x".repeat(9000)}'; echo ${longMarker}`);

      expect(long.stdout.trim()).toBe(longMarker);

      const history = await recorded(box);

      expect(history).not.toContain(secret);
      expect(history).not.toContain(perRun);
      expect(history).not.toContain(input);
      expect(history).not.toContain(longMarker);

      // Buddy stores the create-time env encrypted: the API never returns it in plain text.
      const raw = JSON.stringify(await box.native.request("GET", "/sandboxes/{sandbox_id}"));

      expect(raw).not.toContain(secret);

      // A fresh client recovers the secret from the note and the environment, and redacts it.
      const again = await connectSandbox(liveProvider(), box.id);

      expect((await again.run('echo "$LIVE_SECRET"')).stdout).toBe("[REDACTED]\n");
      expect(await recorded(box)).not.toContain(secret);
    } finally {
      await box.destroy();
    }
  });

  test("a 10 MiB file, a 1.5 MB stdin, and output past Buddy's log limit arrive whole", async () => {
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

      // About 16 MB of frames: more than Buddy's log keeps, so the rest comes from the spool.
      const big = await box.run("head -c 12000000 /dev/zero | tr '\\0' y; echo; echo tail-marker", {
        maxOutputBytes: 13_000_000,
        timeoutMs: 300_000,
      });

      expect(big.exitCode).toBe(0);
      expect(big.stdout.length).toBe(12_000_000 + "\ntail-marker\n".length);
      expect(big.stdout.endsWith("\ntail-marker\n")).toBe(true);

      await expect(box.files.read("missing.txt")).rejects.toMatchObject({
        code: "file_not_found",
      });
      await expect(box.files.read("/workspace")).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await box.files.write("odd dir/ünï €.txt", "odd\n");
      expect(await box.files.read("odd dir/ünï €.txt")).toBe("odd\n");
      await box.files.write("repo/README.md", "hi\n");
      expect((await box.run("git init -q && git status --short", { cwd: "repo" })).ok).toBe(true);
    } finally {
      await box.destroy();
    }
  });

  test("two clients racing one key get one sandbox; the loser never deletes it", async () => {
    const key = `buddy-live-${crypto.randomUUID()}`;

    const [a, b] = await Promise.all([
      createSandbox(liveProvider(), { key }),
      createSandbox(liveProvider(), { key }),
    ]);

    try {
      expect(a.id).toBe(b.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      expect(a.labels["sandbox-sdk"]).toBe("1");

      const loser = a.created ? b : a;

      await loser.close();
      expect((await (a.created ? a : b).run("echo alive")).stdout).toBe("alive\n");
    } finally {
      await (a.created ? a : b).destroy();
    }

    expect(await liveProvider().find(key)).toBeUndefined();
  });

  test("pause and resume keep state; a restore keeps labels and the SDK marker; snapshots delete", async () => {
    const provider = liveProvider();
    const box = await createSandbox(provider, { labels: { team: "restore" } });

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
        const restored = await createSandbox(provider, {
          from: id,
          size: "medium",
          labels: { team: "restored" },
        });

        try {
          expect(await restored.files.read("state.txt")).toBe("kept\n");
          expect((await restored.run("pwd; nproc")).stdout).toBe("/workspace\n4\n");

          const info = await provider.connect(restored.id);

          expect(info.labels).toMatchObject({ team: "restored", "sandbox-sdk": "1" });
          expect(
            (await provider.list({ "live-run": run, team: "restored" })).map((s) => s.id),
          ).toEqual([restored.id]);
        } finally {
          await restored.destroy();
        }

        expect(await deleteSnapshot(provider, id)).toBe(true);
        expect(await deleteSnapshot(provider, id)).toBe(false);
      } finally {
        await deleteSnapshot(provider, id);
      }
    } finally {
      await box.destroy();
    }
  });

  test("a deleted sandbox is not_found everywhere, and a stale key recreates", async () => {
    const provider = liveProvider();
    const key = `buddy-live-${crypto.randomUUID()}`;
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

  test("a preview is private by Basic auth, reattaches without a new password, and public opts out", async () => {
    const box = await createSandbox(liveProvider());

    try {
      await box.files.write("site/index.html", "hello-buddy\n");
      await box.files.write("site/health", "healthy\n");
      await box.start("python3 -m http.server 3000 --bind 0.0.0.0", {
        name: "web",
        cwd: "site",
        ready: { port: 3000 },
      });

      const preview = await box.preview(3000, { waitMs: 60_000 });

      expect(preview.headers?.Authorization).toMatch(/^Basic /);

      const ok = await fetch(preview.url, { headers: preview.headers });

      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("hello-buddy\n");
      expect((await fetch(preview.url)).status).toBe(401);

      const health = await box.preview(3000, { path: "/health" });

      expect(await (await fetch(health.url, { headers: health.headers })).text()).toBe("healthy\n");

      // A fresh client reads the stored credentials: the same header, no new password.
      const again = await (await connectSandbox(liveProvider(), box.id)).preview(3000);

      expect(again.headers).toEqual(preview.headers);

      // A second port keeps the first endpoint working.
      await box.start("python3 -m http.server 3001 --bind 0.0.0.0", {
        name: "web2",
        cwd: "site",
        ready: { port: 3001 },
      });

      const second = await box.preview(3001, { waitMs: 60_000 });

      expect((await fetch(second.url, { headers: second.headers })).status).toBe(200);
      expect((await fetch(preview.url, { headers: preview.headers })).status).toBe(200);

      // A public preview needs no header.
      const open = await (
        await connectSandbox(liveProvider({ public: true }), box.id)
      ).preview(3001, { waitMs: 60_000 });

      expect(open.headers).toBeUndefined();
      expect((await fetch(open.url)).status).toBe(200);

      // Errors never carry the credentials.
      const password = Buffer.from(
        (preview.headers?.Authorization ?? "").slice("Basic ".length),
        "base64",
      )
        .toString()
        .split(":")[1];

      const error = await box.native
        .request("GET", "/sandboxes/{sandbox_id}/nothing-here", {
          query: { t: password ?? "" },
        })
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(SandboxError);
      expect(String(error)).not.toContain(password);
    } finally {
      await box.destroy();
    }
  });

  // destroy deletes the sandbox, so anything still listed here is a leak; snapshots too.
  test("no sandbox or snapshot from this run is left", async () => {
    const provider = liveProvider();
    const live = async () => (await provider.list({ "live-run": run })).map((s) => s.id);

    await expect.poll(live, { timeout: 30_000, interval: 3000 }).toEqual([]);

    for (const id of snapshots) expect(await deleteSnapshot(provider, id)).toBe(false);
  });
});
