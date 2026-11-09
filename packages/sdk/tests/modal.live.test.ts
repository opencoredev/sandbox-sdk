import { describe, expect, test, vi } from "vitest";
import { ModalClient } from "modal";
import { buildTemplate, createSandbox, deleteSnapshot } from "../src/index.js";
import { modal, type ModalOptions } from "../src/providers/modal/index.js";
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
  test("same-spec size gives 4 CPUs of throughput and 8 GiB", async () => {
    const box = await createSandbox(liveProvider(), { size: { cpu: 4, memoryMb: 8192 } });

    try {
      const probe = await box.run(
        "nproc; grep -c ^processor /proc/cpuinfo; awk '/MemTotal/{print $2}' /proc/meminfo",
      );

      expect(probe.stdout.trim().split("\n")).toEqual(["4", "4", String(8192 * 1024)]);
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

  test("destroy returns at once and the key is free for the next create", async () => {
    const provider = liveProvider();
    const key = `live-${crypto.randomUUID()}`;
    const first = await createSandbox(provider, { key });
    const started = Date.now();
    await first.destroy();
    expect(Date.now() - started).toBeLessThan(5000);
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

  // Destroyed sandboxes can take Modal ~30 s to stop, so wait that out before calling one a leak.
  test("no sandbox from this run is left running", { timeout: 150_000 }, async () => {
    const client = new ModalClient();
    const app = await client.apps.fromName("sandbox-sdk-conformance", { createIfMissing: true });

    const running = async () => {
      const left: string[] = [];

      for await (const box of client.sandboxes.list({
        appId: app.appId,
        tags: { "live-run": run },
      }))
        left.push(box.sandboxId);

      return left;
    };

    try {
      await expect.poll(running, { timeout: 90_000, interval: 5000 }).toEqual([]);
    } finally {
      client.close();
    }
  });
});
