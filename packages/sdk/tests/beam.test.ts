import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SandboxError } from "../src/errors.js";
import { createGateway } from "../src/providers/beam/api.js";
import { beamError } from "../src/providers/beam/errors.js";
import {
  createBeamProvider,
  pieceCommand,
  type BeamModule,
  type BeamTemplateConfig,
} from "../src/providers/beam/provider.js";
import { userAgent } from "../src/version.js";

/** A gateway fake: containers by ID, each with a file map. Routes match beam-js 1.1.6. */
interface FakeContainer {
  stubId: string;
  status: string;
  files: Map<string, string>;
}

function fakeBeam() {
  const containers = new Map<string, FakeContainer>();

  const creates: BeamTemplateConfig[] = [];
  const configures: number[] = [];
  const stops: string[] = [];
  const agents: (string | null)[] = [];
  let createGate: Promise<void> | undefined;
  let stopRefusals = 0;
  let uploadRefusals = 0;
  let createFailure: Error | undefined;
  let restoreAnswer: "ok" | "truncated" | "5xx" | "refused" | "no-id" = "ok";
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

    agents.push(new Headers(init?.headers).get("user-agent"));
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

    if (path === "/pods" && init?.method === "POST") {
      if (restoreAnswer === "refused") return json({ ok: false, errorMsg: "no such checkpoint" });

      const made = add();

      if (restoreAnswer === "truncated")
        return new Response(`{"ok":true,"containerId":"${made.containerId}`, { status: 200 });

      if (restoreAnswer === "5xx") return json({ ok: false, errorMsg: "internal" }, 502);

      if (restoreAnswer === "no-id") return json({ ok: true });

      return json({ ok: true, ...made, stubId: "" });
    }

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

    if (route === "connect") return json({ ok: true });

    if (route === "files/upload") {
      if (uploadRefusals > 0) {
        uploadRefusals--;

        return json({ ok: false, errorMsg: "refused" });
      }

      c.files.set(body.containerPath, Buffer.from(body.data, "base64").toString());

      return json({ ok: true });
    }

    if (route.startsWith("files/download/")) {
      const file = c.files.get(decodeURIComponent(route.slice("files/download/".length)));

      return file === undefined
        ? json({ ok: false, errorMsg: "openat x: no such file or directory" })
        : json({ ok: true, data: Buffer.from(file).toString("base64") });
    }

    if (route === "ttl" && init?.method === "PATCH") return json({ ok: true });

    if (route === "ports/expose") return json({ ok: true, url: `https://${body.port}.example` });

    if (route === "snapshot-memory") return json({ ok: true, checkpointId: "snap-1" });

    return json({ ok: false, errorMsg: "unexpected route" }, 500);
  };

  const module: BeamModule = {
    configure(settings) {
      configures.push(settings.requestTimeoutMs);
    },
    template: (config) => ({
      async create() {
        // beam-js prints progress while it builds and allocates.
        console.log("Building image...");
        await createGate;

        // beam-js logs a failed request whole, Authorization header included, before it throws.
        if (createFailure) {
          console.error("Build failed: Bearer secret-token-123", createFailure);
          throw createFailure;
        }

        creates.push(config);

        return add();
      },
    }),
  };

  return {
    containers,
    creates,
    configures,
    stops,
    agents,
    fetch: fetchFake,
    add,
    holdCreates: (gate: Promise<void> | undefined) => {
      createGate = gate;
    },
    refuseStops: (n: number) => {
      stopRefusals = n;
    },
    refuseUploads: (n: number) => {
      uploadRefusals = n;
    },
    failCreates: (error: Error | undefined) => {
      createFailure = error;
    },
    answerRestores: (answer: typeof restoreAnswer) => {
      restoreAnswer = answer;
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

  test("options Beam cannot honour are refused before anything is made", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const box = await provider.create({ labels: {} });

    await expect(provider.create({ labels: {}, idleTimeoutMs: 10_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      provider.create({ labels: {}, from: "snap-1", size: { cpu: 4, memoryMb: 8192 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(provider.snapshot?.(box.id, { expiresInMs: 1 })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(beam.creates.length).toBe(1);
  });

  test("a create that cannot finish and cannot confirm the stop is outcome_unknown with its ID", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    beam.refuseUploads(1);
    beam.refuseStops(1);

    await expect(provider.create({ labels: {} })).rejects.toMatchObject({
      code: "outcome_unknown",
      sandboxId: expect.stringMatching(/^sandbox-/),
    });
  });

  test("a create that cannot finish but stops cleanly keeps its own error", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    beam.refuseUploads(1);

    await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "provider" });
    expect([...beam.containers.values()].every((c) => c.status === "STOPPED")).toBe(true);
  });

  test("a create with no answer is outcome_unknown; a refusal keeps its code", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    beam.failCreates(Object.assign(new Error("socket hang up"), { isAxiosError: true }));
    await expect(provider.create({ labels: {} })).rejects.toMatchObject({
      code: "outcome_unknown",
    });

    beam.failCreates(
      Object.assign(new Error("Request failed with status code 429"), {
        isAxiosError: true,
        response: { status: 429 },
      }),
    );
    await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "quota" });
  });

  test("beam-js errors logged during a create lose the token and any objects", async () => {
    const beam = fakeBeam();
    const provider = beam.provider({ token: "secret-token-123" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      beam.failCreates(
        Object.assign(new Error("Request failed with status code 401"), {
          isAxiosError: true,
          response: { status: 401 },
          config: { headers: { Authorization: "Bearer secret-token-123" } },
        }),
      );
      await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "auth" });
      expect(spy).toHaveBeenCalledWith("Build failed: Bearer [redacted]", "[Error]");
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret-token-123");
    } finally {
      spy.mockRestore();
    }

    expect(console.error).not.toBe(spy);
  });

  test("a restore whose answer cannot be read, or a 5xx, is outcome_unknown; a refusal is not", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    for (const answer of ["truncated", "5xx", "no-id"] as const) {
      beam.answerRestores(answer);
      await expect(provider.create({ labels: {}, from: "snap-1" })).rejects.toMatchObject({
        code: "outcome_unknown",
      });
    }

    beam.answerRestores("refused");
    await expect(provider.create({ labels: {}, from: "snap-1" })).rejects.toMatchObject({
      code: "provider",
    });
  });

  test("an allocation answer beam-js could not read is outcome_unknown", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();

    // beam-js's own message when the answer had no readable `ok`.
    beam.failCreates(new Error("Failed to create sandbox"));
    await expect(provider.create({ labels: {} })).rejects.toMatchObject({
      code: "outcome_unknown",
    });

    beam.failCreates(new Error("Failed to prepare runtime: image build failed"));
    await expect(provider.create({ labels: {} })).rejects.toMatchObject({ code: "provider" });
  });

  test("every gateway request names the SDK", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const box = await provider.create({ labels: {} });

    await provider.list({});
    await provider.native(box.id).request("GET", "/pods/{containerId}/connect");

    expect(beam.agents.length).toBeGreaterThan(3);
    expect(new Set(beam.agents)).toEqual(new Set([userAgent]));
  });

  test("native is the gateway, bound to the container, with its IDs", async () => {
    const beam = fakeBeam();
    const seen: { url: string; authorization: string | null }[] = [];

    const provider = beam.provider({
      token: "native-token-1234",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
        });

        return beam.fetch(input, init);
      },
    });

    const box = await provider.create({ labels: {} });
    const native = provider.native(box.id);

    expect(native.containerId).toBe(box.id);
    expect(native.stubId).toMatch(/^0b4e1a7c-/);
    expect(native.sandboxId).toBe(box.id);
    await expect(
      native.request("POST", "/pods/{containerId}/connect", { body: {} }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(seen.at(-1)).toEqual({
      url: `https://app.beam.cloud/api/v1/gateway/pods/${encodeURIComponent(box.id)}/connect`,
      authorization: "Bearer native-token-1234",
    });
  });

  test("a snapshot whose answer is lost is outcome_unknown, not a retryable failure", async () => {
    const beam = fakeBeam();
    let answer: "drop" | "504" | "no-id" = "drop";

    const provider = beam.provider({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/snapshot-memory")) {
          // Beam made the snapshot; the answer never arrives intact.
          if (answer === "drop") throw new TypeError("fetch failed");

          if (answer === "504") return new Response("", { status: 504 });

          return Response.json({ ok: true });
        }

        return beam.fetch(input, init);
      },
    });

    const box = await provider.create({ labels: {} });

    for (const next of ["drop", "504", "no-id"] as const) {
      answer = next;
      await expect(provider.snapshot?.(box.id)).rejects.toMatchObject({
        code: "outcome_unknown",
        sandboxId: box.id,
      });
    }
  });

  test("a lost read keeps its retryable code", async () => {
    const beam = fakeBeam();

    const provider = beam.provider({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });

    await expect(provider.list({})).rejects.toMatchObject({ code: "unavailable" });
  });

  test("a download over the gateway's message cap answered with ok:false moves in pieces", async () => {
    const gateway = createGateway({
      token: "t",
      url: "https://app.beam.cloud",
      requestTimeoutMs: 5000,
      fetch: async () =>
        Response.json({
          ok: false,
          errorMsg:
            "Failed to download file: rpc error: code = ResourceExhausted desc = grpc: received message larger than max (10485760 vs. 4194304)",
        }),
    });

    const error = await gateway.download("sandbox-x", "/workspace/big.bin").catch((e) => e);

    expect(beamError(error).code).toBe("quota");
  });

  test.skipIf(spawnSync("python3", ["--version"]).status !== 0)(
    "a piece is copied aside even when its scratch directory does not exist yet",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "beam-piece-"));

      try {
        const source = join(dir, "source.bin");
        const piece = join(dir, "scratch", "nested", "piece");

        writeFileSync(source, "0123456789");

        const run = spawnSync("sh", ["-c", pieceCommand(source, piece, 2, 5)], {
          encoding: "utf8",
          timeout: 10_000,
        });

        expect(run.stderr).toBe("");
        expect(readFileSync(piece, "utf8")).toBe("23456");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("fresh creates pass requestTimeoutMs to beam-js and re-check its configuration each time", async () => {
    const beam = fakeBeam();
    const provider = beam.provider({ requestTimeoutMs: 4321 });

    await provider.create({ labels: {} });
    await provider.create({ labels: {}, size: "small" });

    expect(beam.configures).toEqual([4321, 4321]);
  });

  test("console output from outside a create passes through while beam-js's is filtered", async () => {
    const beam = fakeBeam();
    const provider = beam.provider();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let release = () => {};

    try {
      beam.holdCreates(new Promise<void>((resolve) => (release = resolve)));
      const creating = provider.create({ labels: {} });

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Another request in the same process logs while the create is still running.
      const detail = new Error("unrelated failure");

      console.log("unrelated", { id: 1 });
      console.error("unrelated error", detail);
      release();
      await creating;

      expect(log.mock.calls).toEqual([["unrelated", { id: 1 }]]);
      expect(error.mock.calls).toEqual([["unrelated error", detail]]);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
