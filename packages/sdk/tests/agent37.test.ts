import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox } from "../src/index.js";
import { agent37 } from "../src/providers/agent37/index.js";
import { agent37Fake, type Agent37Fake } from "./agent37-fake.js";

let fake: Agent37Fake;

beforeAll(async () => {
  fake = await agent37Fake();
});

afterAll(async () => {
  await fake.close();
});

const provider = () =>
  agent37({ apiKey: "fake-key", baseUrl: fake.url, execUrl: `${fake.url}/exec` });

const bodies = (path: string) =>
  fake.requests
    .filter((r) => r.method === "POST" && r.path === path)
    .map((r) => JSON.parse(r.body));

describe("Agent 37 adapter", () => {
  test("a size maps to one of Agent 37's shapes, and anything else is refused before a create", async () => {
    const before = bodies("/v1/instances").length;

    await expect(
      createSandbox(provider(), { size: { cpu: 3, memoryMb: 6144 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      createSandbox(provider(), { size: { cpu: 4, memoryMb: 8192, diskGb: 30 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(bodies("/v1/instances")).toHaveLength(before);

    await using box = await createSandbox(provider(), {
      size: { cpu: 4, memoryMb: 8192, diskGb: 20 },
    });

    expect(bodies("/v1/instances").at(-1)).toMatchObject({
      template: "agent37-base",
      type: "default",
      resources: { cpu: 4, memory: 8, disk: 20 },
    });
    expect(box.id).toMatch(/^[a-z0-9]{10}$/);
  });

  test("timeoutMs is refused: an instance has no time limit", async () => {
    await expect(createSandbox(provider(), { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("network and idle timeout map to Agent 37's fields", async () => {
    await using _box = await createSandbox(provider(), {
      network: { allow: ["github.com"] },
      idleTimeoutMs: 600_000,
    });

    expect(bodies("/v1/instances").at(-1)).toMatchObject({
      network: { allow: ["github.com"] },
      auto_sleep: true,
      idle_timeout_seconds: 600,
    });
  });

  test("a command still running when the exec host answers 504 try_again is waited for by name, never run twice", async () => {
    await using box = await createSandbox(provider());
    fake.stallExec(2);
    const result = await box.run("echo once >> /workspace/count; cat /workspace/count");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("once\n");

    const names = bodies(`/exec/v1/instances/${box.id}/exec`)
      .slice(-3)
      .map((b) => b.name);

    expect(new Set(names).size).toBe(1);
  });

  test("output past the inline limit is read back from the guest in full", async () => {
    await using box = await createSandbox(provider());

    const result = await box.run(
      "head -c 700000 /dev/zero | tr '\\0' a; head -c 300000 /dev/zero | tr '\\0' b >&2",
      {
        maxOutputBytes: 2_000_000,
      },
    );

    expect(result.stdout).toBe("a".repeat(700_000));
    expect(result.stderr).toBe("b".repeat(300_000));
    const root = fake.instances.get(box.id)?.root ?? "";
    const left = await readdir(join(root, "tmp/.sandbox-sdk/exec"));
    expect(left.filter((name) => name.endsWith(".out") || name.endsWith(".err"))).toEqual([]);
  });

  test("a file bigger than one chunk round-trips through parallel parts", async () => {
    await using box = await createSandbox(provider());
    const bytes = new Uint8Array(1_500_000).map((_, i) => (i * 7) & 255);

    await box.files.write("data/big.bin", bytes);
    const back = await box.files.read("data/big.bin", { as: "bytes" });

    expect(Buffer.compare(Buffer.from(back), Buffer.from(bytes))).toBe(0);
    expect((await box.run("ls /workspace/data")).stdout).toBe("big.bin\n");
  });

  test("a snapshot is a stopped fork that is never listed, and a sandbox made from it has its files", async () => {
    const p = provider();
    await using box = await createSandbox(p, { labels: { suite: "snap" } });
    await box.files.write("note.txt", "kept");
    const snapshot = await box.snapshot();

    expect(fake.instances.get(snapshot.id)?.status).toBe("stopped");
    expect((await p.list({})).map((i) => i.id)).not.toContain(snapshot.id);
    await expect(p.connect(snapshot.id)).rejects.toMatchObject({ code: "not_found" });

    await using copy = await createSandbox(p, { from: snapshot.id });
    expect(await copy.files.read("note.txt")).toBe("kept");
    expect((await p.list({ suite: "snap" })).map((i) => i.id).sort()).toEqual([box.id]);

    expect(await p.deleteSnapshot?.(snapshot.id)).toBe(true);
    expect(await p.deleteSnapshot?.(snapshot.id)).toBe(false);
  });

  test("from must name a snapshot", async () => {
    const p = provider();
    await using box = await createSandbox(p);

    await expect(createSandbox(p, { from: box.id })).rejects.toMatchObject({
      code: "invalid_argument",
    });
  });

  test("a preview is a signed URL with an expiry unless public is set", async () => {
    const p = provider();
    await using box = await createSandbox(p);
    const preview = await p.previewUrl(box.id, 3000);

    expect(new URL(preview.url).searchParams.get("a37_token")).toMatch(/^a37tok_/);
    expect(preview.expiresAt).toBeGreaterThan(Date.now());

    const open = agent37({
      apiKey: "fake-key",
      baseUrl: fake.url,
      execUrl: `${fake.url}/exec`,
      public: true,
    });

    const first = await open.previewUrl(box.id, 3000);

    expect(first.expiresAt).toBeUndefined();
    expect((await open.previewUrl(box.id, 3000)).url).toBe(first.url);
  });

  test("a missing API key is an auth error", async () => {
    const saved = process.env.AGENT37_API_KEY;
    delete process.env.AGENT37_API_KEY;

    try {
      await expect(
        createSandbox(agent37({ baseUrl: fake.url, execUrl: `${fake.url}/exec` })),
      ).rejects.toMatchObject({ code: "auth" });
    } finally {
      if (saved !== undefined) process.env.AGENT37_API_KEY = saved;
    }
  });
});
