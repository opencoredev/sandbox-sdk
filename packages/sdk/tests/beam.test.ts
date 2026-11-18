import { describe, expect, test } from "vitest";
import { SandboxError } from "../src/errors.js";
import {
  createBeamProvider,
  type BeamModule,
  type BeamTemplateConfig,
} from "../src/providers/beam/provider.js";

/** A gateway fake: containers by ID, each with a file map. Routes match beam-js 1.1.6. */
interface FakeContainer {
  stubId: string;
  status: string;
  files: Map<string, string>;
}

function fakeBeam() {
  const containers = new Map<string, FakeContainer>();

  const creates: BeamTemplateConfig[] = [];
  const stops: string[] = [];
  let stopRefusals = 0;
  let next = 0;

  const add = (status = "RUNNING") => {
    const stubId = "0b4e1a7c-0000-4000-8000-00000000000" + next;
    const id = `sandbox-${stubId}-${(next++).toString(16).padStart(8, "0")}`;

    containers.set(id, { stubId, status, files: new Map() });

    return { containerId: id, stubId };
  };

  type Body = Record<string, string | number | boolean | Array<Record<string, string>>>;

  const json = (body: Body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetchFake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1/gateway", "");
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (path === "/containers")
      return json({
        ok: true,
        containers: [...containers].map(([containerId, c]) => ({
          containerId,
          stubId: c.stubId,
          status: c.status,
        })),
      });

    const stop = /^\/containers\/([^/]+)\/stop$/.exec(path);

    if (stop) {
      const id = decodeURIComponent(stop[1] ?? "");

      stops.push(id);

      if (stopRefusals > 0) {
        stopRefusals--;

        return json({ ok: false, errorMsg: "container is stopping" });
      }

      const c = containers.get(id);

      if (c) c.status = "STOPPED";

      return json({ ok: true });
    }

    const pod = /^\/pods\/([^/]+)\/(.+)$/.exec(path);
    const c = pod ? containers.get(decodeURIComponent(pod[1] ?? "")) : undefined;

    if (!pod || !c || c.status !== "RUNNING")
      return json({ ok: false, errorMsg: "Failed to connect to sandbox" });
    const route = pod[2] ?? "";

    if (route === "files/upload") {
      c.files.set(body.containerPath, Buffer.from(body.data, "base64").toString());

      return json({ ok: true });
    }

    if (route.startsWith("files/download/")) {
      const file = c.files.get(decodeURIComponent(route.slice("files/download/".length)));

      return file === undefined
        ? json({ ok: false, errorMsg: "openat x: no such file or directory" })
        : json({ ok: true, data: Buffer.from(file).toString("base64") });
    }

    if (route === "ttl") return json({ ok: true });

    if (route === "ports/expose") return json({ ok: true, url: `https://${body.port}.example` });

    if (route === "snapshot-memory") return json({ ok: true, checkpointId: "snap-1" });

    return json({ ok: false, errorMsg: "unexpected route" }, 500);
  };

  const module: BeamModule = {
    configure() {},
    template: (config) => ({
      async create() {
        creates.push(config);

        return add();
      },
    }),
    restore: async () => add(),
  };

  return {
    containers,
    creates,
    stops,
    add,
    refuseStops: (n: number) => {
      stopRefusals = n;
    },
    provider: (options = {}) =>
      createBeamProvider(
        { token: "t", workspaceId: "w", fetch: fetchFake, ...options },
        async () => module,
      ),
  };
}

describe("beam adapter", () => {
  test("missing credentials fail as auth before any request", async () => {
    const provider = createBeamProvider({ token: "", workspaceId: "w" }, async () => {
      throw new Error("not loaded");
    });

    await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "auth" });
  });

  test("sizes map to whole vCPUs and MiB; disk sizes are unsupported", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    await provider.create({ labels: {}, size: "medium" });
    await provider.create({ labels: {}, size: { cpu: 4, memoryMb: 8192 } });
    await provider.create({ labels: {} });

    expect(beam.creates.map((c) => [c.cpu, c.memoryMb])).toEqual([
      [2, 4096],
      [4, 8192],
      [1, 128],
    ]);
    await expect(
      provider.create({ labels: {}, size: { cpu: 1, memoryMb: 1024, diskGb: 10 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("lifetime comes from timeoutMs, else an hour", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    await provider.create({ labels: {}, timeoutMs: 90_500 });
    await provider.create({ labels: {} });

    expect(beam.creates.map((c) => c.keepWarmSeconds)).toEqual([91, 3600]);
  });

  test("list and find read the marker; containers without one are not the SDK's", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const mine = await provider.create({ key: "k1", labels: { run: "a" } });

    await provider.create({ labels: { run: "b" } });
    beam.add();

    expect((await provider.list({ run: "a" })).map((i) => i.id)).toEqual([mine.id]);
    expect((await provider.list({})).length).toBe(2);
    expect((await provider.find("k1"))?.id).toBe(mine.id);
    expect(await provider.find("missing")).toBeUndefined();
  });

  test("connect finds live SDK sandboxes only", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const mine = await provider.create({ labels: { a: "1" } });
    const foreign = beam.add();

    expect((await provider.connect(mine.id)).labels).toEqual({ a: "1" });
    await expect(provider.connect(foreign.containerId)).rejects.toMatchObject({
      code: "not_found",
    });
    await provider.destroy(mine.id);
    await expect(provider.connect(mine.id)).rejects.toMatchObject({ code: "not_found" });
  });

  test("create env goes to the private env file; a restore always rewrites it", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const plain = await provider.create({ labels: {} });
    const withEnv = await provider.create({ labels: {}, env: { A: "1" } });
    const restored = await provider.create({ labels: {}, from: "snap-1" });
    const env = (id: string) => beam.containers.get(id)?.files.get("/var/lib/sandbox-sdk-env.json");

    expect(env(plain.id)).toBeUndefined();
    expect(env(withEnv.id)).toBe('{"A":"1"}');
    expect(env(restored.id)).toBe("{}");
  });

  test("a refused stop counts as done once the container is gone", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const box = await provider.create({ labels: {} });
    const entry = beam.containers.get(box.id);

    if (entry) entry.status = "STOPPED";
    beam.refuseStops(1);

    await expect(provider.destroy(box.id)).resolves.toBeUndefined();
  });

  test("a refused stop of a running container is an error", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const box = await provider.create({ labels: {} });

    beam.refuseStops(1);

    await expect(provider.destroy(box.id)).rejects.toBeInstanceOf(SandboxError);
  });

  test("snapshot and preview pass the container's stub", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const box = await provider.create({ labels: {} });

    expect(await provider.snapshot?.(box.id)).toEqual({ id: "snap-1" });
    expect((await provider.previewUrl(box.id, 3000)).url).toBe("https://3000.example");
  });
});
