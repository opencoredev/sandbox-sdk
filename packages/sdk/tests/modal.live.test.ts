import { describe, expect, test, vi } from "vitest";
import { ModalClient } from "modal";
import { buildTemplate, createSandbox, deleteSnapshot } from "../src/index.js";
import { modal, type ModalDestroyEvent, type ModalOptions } from "../src/providers/modal/index.js";
import { runConformance } from "../src/testing.js";

const credentials = Boolean(process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET);

// No Modal request or sandbox creation without credentials. Cleanup hooks cross the network too.
if (credentials) vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const run = process.env.SANDBOX_TEST_RUN_ID ?? `modal-${Date.now()}`;

// Every live sandbox lives in a sandbox-sdk- app and carries this run's label, so leftovers are findable.
function liveProvider(options: ModalOptions = {}) {
  const provider = modal({ app: "sandbox-sdk-conformance", timeoutMs: 600_000, ...options });
  const create = provider.create;
  provider.create = (input) => create({ ...input, labels: { ...input.labels, "live-run": run } });

  return provider;
}

describe.skipIf(!credentials)("Modal live (billable)", { timeout: 180_000 }, () => {
  runConformance(() => liveProvider(), { live: true, ports: [3000], snapshotExpiry: "honored" });
});

describe.skipIf(!credentials)("Modal live options", { timeout: 300_000 }, () => {
  test("same-spec size shows 4 CPUs and 8 GiB and runs 4 threads of parallel throughput", async () => {
    const box = await createSandbox(liveProvider(), { size: { cpu: 4, memoryMb: 8192 } });

    // Fixed pure-CPU work: SHA-256 over an in-memory 64 MiB buffer, 24 times. Wall seconds for k copies.
    const job = `python3 -c "import hashlib; b=b'x'*(64<<20); [hashlib.sha256(b).digest() for _ in range(24)]"`;

    const wall = async (copies: number) =>
      Number(
        (
          await box.run(
            `s=$(date +%s.%N); for i in $(seq ${copies}); do ${job} & done; wait; e=$(date +%s.%N); python3 -c "print($e-$s)"`,
            { timeoutMs: 120_000 },
          )
        ).stdout.trim(),
      );

    try {
      const probe = await box.run(
        "nproc; grep -c ^processor /proc/cpuinfo; awk '/MemTotal/{print $2}' /proc/meminfo",
      );

      expect(probe.stdout.trim().split("\n")).toEqual(["4", "4", String(8192 * 1024)]);
      await wall(1);
      const single = Math.min(await wall(1), await wall(1));
      const parallel = Math.min(await wall(4), await wall(4));
      // Effective threads: four copies finishing in about one copy's time means four full CPUs.
      expect((4 * single) / parallel).toBeGreaterThan(3.4);
    } finally {
      await box.destroy();
    }
  });

  test("snapshot restore keeps files; deleteSnapshot reports what it removed", async () => {
    const provider = liveProvider();
    const source = await createSandbox(provider);
    let snapshot: string | undefined;

    try {
      await source.files.write("captured", "original");
      snapshot = (await source.snapshot({ expiresInMs: 86_400_000 })).id;
      await source.files.write("captured", "changed");
      const restored = await createSandbox(provider, { from: snapshot, labels: { restored: "1" } });

      try {
        expect(await restored.files.read("captured")).toBe("original");
        expect(await provider.connect(restored.id)).toMatchObject({ labels: { restored: "1" } });
      } finally {
        await restored.destroy();
      }

      expect(await deleteSnapshot(provider, snapshot)).toBe(true);
      expect(await deleteSnapshot(provider, snapshot)).toBe(false);
      snapshot = undefined;
    } finally {
      if (snapshot) await deleteSnapshot(provider, snapshot).catch(() => false);
      await source.destroy();
    }
  });

  test("a template builds once and seeds a sandbox", async () => {
    const provider = liveProvider();

    const template = await buildTemplate(
      provider,
      { name: "sandbox-sdk-live", env: { WORD: "built" }, run: ['printf "$WORD" > /opt/marker'] },
      { timeoutMs: 240_000 },
    );

    const box = await createSandbox(provider, { from: template.id });

    try {
      expect((await box.run("cat /opt/marker")).stdout).toBe("built");
    } finally {
      await box.destroy();
      await deleteSnapshot(provider, template.id);
    }
  });

  test("network none and allow lists hold, previews still work, a pinned region is honored", async () => {
    const provider = liveProvider({ region: "us-east" });

    const fetch = (url: string) =>
      `node -e 'fetch("${url}").then(r=>console.log(r.status)).catch(()=>console.log("blocked"))'`;

    const none = await createSandbox(provider, { network: "none", ports: [3000] });

    try {
      expect((await none.run(fetch("https://registry.npmjs.org"))).stdout.trim()).toBe("blocked");
      expect((await none.run(fetch("http://1.1.1.1"))).stdout.trim()).toBe("blocked");
      expect((await none.run('printf "$MODAL_REGION"')).stdout).toBe("us-east");
      await none.start(
        'node -e \'require("http").createServer((_,r)=>r.end("ok")).listen(3000,"0.0.0.0")\'',
        { name: "http", ready: { http: { port: 3000 } } },
      );
      const preview = await none.preview(3000);
      expect(await (await globalThis.fetch(preview.url)).text()).toBe("ok");
    } finally {
      await none.destroy();
    }

    const allow = await createSandbox(provider, { network: { allow: ["registry.npmjs.org"] } });

    try {
      expect((await allow.run(fetch("https://registry.npmjs.org"))).stdout.trim()).toBe("200");
      expect((await allow.run(fetch("https://example.com"))).stdout.trim()).toBe("blocked");
    } finally {
      await allow.destroy();
    }
  });

  test("a sandbox without ports answers a tunnel request without the 50 s wait", async () => {
    const box = await createSandbox(liveProvider());

    try {
      const started = Date.now();
      const attached = modal({ app: "sandbox-sdk-conformance" });
      await attached.connect(box.id);
      await expect(attached.previewUrl(box.id, 3000)).rejects.toMatchObject({
        code: expect.stringMatching(/^(invalid_argument|timeout)$/),
      });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await box.destroy();
    }
  });

  test("destroy waits for a confirmed stop, reports both latencies, and frees the key", async () => {
    const events: ModalDestroyEvent[] = [];
    const provider = liveProvider({ onDestroy: (event) => events.push(event) });
    const key = `live-${crypto.randomUUID()}`;
    const first = await createSandbox(provider, { key });
    await first.destroy();
    expect(events).toEqual([
      { sandboxId: first.id, requestMs: expect.any(Number), stoppedMs: expect.any(Number) },
    ]);
    expect(events[0]!.stoppedMs!).toBeGreaterThanOrEqual(events[0]!.requestMs!);
    console.info(
      `Modal destroy: request ${events[0]?.requestMs} ms, stopped ${events[0]?.stoppedMs} ms`,
    );
    await expect(modal({ app: "sandbox-sdk-conformance" }).connect(first.id)).rejects.toMatchObject(
      {
        code: "not_found",
      },
    );
    const second = await createSandbox(provider, { key });

    try {
      expect(second).toMatchObject({ created: true });
      expect(second.id).not.toBe(first.id);
    } finally {
      await second.destroy();
    }
  });

  test("createApp puts an unkeyed sandbox in its own App, and list still finds it", async () => {
    const app = `sandbox-sdk-conformance-${run.slice(-12).replace(/[^\w.-]/g, "")}`;
    const provider = liveProvider({ createApp: () => app });
    await provider.prepareApp(app);
    const box = await createSandbox(provider, { labels: { "own-app": "1" } });

    try {
      const client = new ModalClient();

      try {
        const owner = await client.apps.fromName(app);
        const inApp: string[] = [];

        for await (const listed of client.sandboxes.list({ appId: owner.appId }))
          inApp.push(listed.sandboxId);
        expect(inApp).toContain(box.id);
      } finally {
        client.close();
      }

      expect((await provider.list({ "own-app": "1", "live-run": run })).map((i) => i.id)).toEqual([
        box.id,
      ]);

      // A restarted process lists the App only once it prepares it, without creating anything.
      const fresh = liveProvider();
      expect(await fresh.list({ "own-app": "1", "live-run": run })).toEqual([]);
      expect(await fresh.prepareApp(app, { createIfMissing: false })).toMatchObject({ name: app });
      expect((await fresh.list({ "own-app": "1", "live-run": run })).map((i) => i.id)).toEqual([
        box.id,
      ]);
    } finally {
      await box.destroy();
    }
  });

  test("recovery looks an App up without creating it", async () => {
    const never = `sandbox-sdk-never-${run.slice(-12).replace(/[^\w.-]/g, "")}`;
    expect(await liveProvider().prepareApp(never, { createIfMissing: false })).toBeNull();
    // Listing never creates the default App either.
    expect(await modal({ app: never }).list({})).toEqual([]);
    expect(await modal({ app: never }).listPending({})).toEqual([]);
    const client = new ModalClient();

    try {
      await expect(client.apps.fromName(never)).rejects.toMatchObject({ name: "NotFoundError" });
    } finally {
      client.close();
    }
  });

  test("a restore left tagged pending is found by listPending and stopped by destroy", async () => {
    const client = new ModalClient();
    const label = crypto.randomUUID();

    try {
      // As a creator that crashed after Modal allocated a restore, before it cleared the marker.
      const app = await client.apps.fromName("sandbox-sdk-conformance", { createIfMissing: true });

      const box = await client.sandboxes.create(
        app,
        client.images.fromRegistry("node:22-bookworm"),
        {
          timeoutMs: 600_000,
          tags: { "sandbox-sdk": "pending", "live-run": run, pending: label },
        },
      );

      try {
        const provider = liveProvider();
        expect(await provider.list({ pending: label })).toEqual([]);
        expect(await provider.listPending({ pending: label })).toMatchObject([
          { id: box.sandboxId, labels: { "sandbox-sdk": "pending", pending: label } },
        ]);
        await provider.destroy(box.sandboxId);
        expect(await box.poll()).not.toBeNull();
        expect(await provider.listPending({ pending: label })).toEqual([]);
      } finally {
        await box.terminate().catch(() => {});
      }
    } finally {
      client.close();
    }
  });

  test("stdin to a command that exits before reading it is no failure", async () => {
    const box = await createSandbox(liveProvider());

    try {
      expect(await box.run("exit 3", { stdin: "x".repeat(1 << 20) })).toMatchObject({
        exitCode: 3,
        timedOut: false,
      });
    } finally {
      await box.destroy();
    }
  });

  // destroy now waits for the stop, so anything still running here is a leak.
  test("no sandbox from this run is left running", { timeout: 150_000 }, async () => {
    const client = new ModalClient();

    // Every App in the Environment: the createApp test uses its own.
    const running = async () => {
      const left: string[] = [];

      for await (const box of client.sandboxes.list({ tags: { "live-run": run } }))
        left.push(box.sandboxId);

      return left;
    };

    try {
      await expect.poll(running, { timeout: 20_000, interval: 5000 }).toEqual([]);
    } finally {
      client.close();
    }
  });
});
