// The Microsandbox adapter's own invariants, against the local fake (tests/microsandbox-fake.ts) and,
// for the exec stream, a scripted peer handle. Each block names the plan invariant it covers.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { tokenPattern } from "../src/providers/microsandbox/api.js";
import { peerError } from "../src/providers/microsandbox/errors.js";
import type {
  MicrosandboxModule,
  PeerExecEvent,
  PeerExecHandle,
  PeerExecOptions,
  PeerSandbox,
} from "../src/providers/microsandbox/exec.js";
import {
  createMicrosandboxProvider,
  isOwnedSlug,
  type MicrosandboxHooks,
  type MicrosandboxOptions,
} from "../src/providers/microsandbox/provider.js";
import type { OutputChunk } from "../src/provider.js";
import { microsandboxFake, type MicrosandboxFake } from "./microsandbox-fake.js";
import { rejection } from "./rejection.js";

const apiKey = "msb_fake_key_0123456789";
let fake: MicrosandboxFake;

beforeAll(async () => {
  fake = await microsandboxFake();
});

afterAll(async () => {
  await fake.close();
});

afterEach(() => {
  for (const key of Object.keys(fake.faults)) Reflect.deleteProperty(fake.faults, key);
  fake.requests.length = 0;
});

/** Replaces the guest command handle for commands after setup; undefined runs them for real. */
type Script = (argv: string[]) => Promise<PeerExecHandle> | undefined;

/** A test's hold on the guest commands that follow setup. */
interface Scripted {
  run?: Script;
}

function provider(extra: Partial<MicrosandboxOptions> = {}, script?: Scripted) {
  const module: MicrosandboxModule = {
    RemoteContext: class {
      private readonly inner: InstanceType<MicrosandboxModule["RemoteContext"]>;

      constructor(options: ConstructorParameters<MicrosandboxModule["RemoteContext"]>[0]) {
        this.inner = new fake.peer.RemoteContext(options);
      }

      readonly sandboxes = {
        get: async (name: string): Promise<PeerSandbox> => {
          const real = await this.inner.sandboxes.get(name);

          return {
            fs: () => real.fs(),
            execStreamWith: (cmd, configure) => {
              const recorded: string[] = [];

              const probe: PeerExecOptions = {
                args(args) {
                  recorded.push(...args);

                  return this;
                },
                cwd() {
                  return this;
                },
                envs() {
                  return this;
                },
                tty() {
                  return this;
                },
                stdinNull() {
                  return this;
                },
                stdinBytes() {
                  return this;
                },
              };

              configure(probe);
              const scripted = script?.run?.(recorded);

              return scripted ?? real.execStreamWith(cmd, configure);
            },
          };
        },
      };
    },
  };

  return createMicrosandboxProvider(
    { apiKey, baseUrl: fake.url, computeType: "standard", ...extra },
    async () => module,
  );
}

const run = async (
  p: ReturnType<typeof provider>,
  id: string,
  command: string,
  extra: { stdin?: string; timeoutMs?: number; signal?: AbortSignal } = {},
) => {
  const chunks: OutputChunk[] = [];

  const result = await p.exec(id, {
    command,
    cwd: "/workspace",
    env: { GREETING: "hi" },
    timeoutMs: extra.timeoutMs ?? 30_000,
    stdin: extra.stdin,
    signal: extra.signal,
    onChunk: (chunk) => chunks.push(chunk),
  });

  return { result, chunks };
};

const posts = (path: string) =>
  fake.requests.filter((r) => r.method === "POST" && r.path.startsWith(path));

/** A command handle a test drives by hand. */
class ScriptedHandle implements PeerExecHandle {
  readonly events: PeerExecEvent[] = [];
  private readonly waiting: ((event: PeerExecEvent | null) => void)[] = [];
  kills = 0;
  waits = 0;
  killFails = false;
  private exited: ((status: { code: number }) => void) | undefined;
  private readonly exit = new Promise<{ code: number }>((resolve) => (this.exited = resolve));

  emit(event: PeerExecEvent | null) {
    const next = this.waiting.shift();

    if (next) next(event);
    else if (event) this.events.push(event);
  }

  recv() {
    const event = this.events.shift();

    if (event) return Promise.resolve(event);

    return new Promise<PeerExecEvent | null>((resolve) => this.waiting.push(resolve));
  }

  wait() {
    this.waits++;

    return this.exit;
  }

  async kill() {
    this.kills++;

    if (this.killFails) throw new Error("kill failed");
    this.exited?.({ code: 137 });
  }
}

describe("peer gate (fail before allocate)", () => {
  test("a missing peer is unavailable, names the install, and sends nothing", async () => {
    const p = createMicrosandboxProvider({ apiKey, baseUrl: fake.url }, async () => {
      throw Object.assign(new Error("Cannot find package 'microsandbox' imported from x"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });

    await expect(p.create({ labels: {} })).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("Install microsandbox"),
    });
    expect(fake.requests).toEqual([]);
  });

  test("a peer whose native addon cannot load is unavailable, names the external fix, and sends nothing", async () => {
    const p = createMicrosandboxProvider({ apiKey, baseUrl: fake.url }, async () => ({
      RemoteContext: class {
        readonly sandboxes = {
          get: async (): Promise<PeerSandbox> => Promise.reject(new Error("x")),
        };

        constructor() {
          throw new Error("Cannot find native binding. msb_secret_in_path_123456");
        }
      },
    }));

    const error = await rejection(p.create({ labels: {} }));
    expect(error).toMatchObject({ code: "unavailable" });
    expect(String(error.message)).toContain("Keep microsandbox external");
    expect(JSON.stringify([String(error), error.cause])).not.toContain("msb_secret_in_path_123456");
    expect(fake.requests).toEqual([]);
  });

  test("a peer that throws while loading is unavailable naming the fix, and sends nothing", async () => {
    const p = createMicrosandboxProvider({ apiKey, baseUrl: fake.url }, async () => {
      throw new TypeError("The argument 'filename' must be a file URL object");
    });

    const error = await rejection(p.create({ labels: {} }));
    expect(error).toMatchObject({ code: "unavailable" });
    expect(error.message).toContain("Keep microsandbox external");
    expect(fake.requests).toEqual([]);
  });

  test("the RemoteContext gets this adapter's url, key, timeout and tier", async () => {
    const before = fake.contexts.length;
    const p = provider({ requestTimeoutMs: 12_345, computeType: "shared" });
    const box = await p.create({ labels: {} });
    expect(fake.contexts.slice(before)).toEqual([
      { url: fake.url, apiKey, requestTimeoutMs: 12_345, computeType: "shared" },
    ]);
    await p.destroy(box.id);
  });
});

describe("create: start, readiness and wire body", () => {
  test("a fresh create asks to start and wait, with an OCI spec, labels, marker and tier", async () => {
    const seen: Parameters<NonNullable<MicrosandboxHooks["create"]>>[0][] = [];
    let requestsAtHook = -1;

    const p = provider({
      hooks: {
        create: (attempt) => {
          seen.push(attempt);
          requestsAtHook = posts("/v1/sandboxes").length;
        },
      },
    });

    const box = await p.create({
      key: "k1",
      labels: { team: "a" },
      size: "medium",
      env: { A: "1" },
    });

    const [post] = posts("/v1/sandboxes");
    expect(post?.path).toBe("/v1/sandboxes?start=true&wait_for=running&wait_timeout=60");
    expect(requestsAtHook).toBe(0);
    expect(seen).toHaveLength(1);
    expect(post?.body).toMatchObject({
      compute: { type: "standard" },
      spec: {
        source: "oci",
        reference: "node:22-bookworm",
        name: seen[0]?.name,
        labels: { team: "a", "sandbox-sdk-key": "k1", "sandbox-sdk-alloc": seen[0]?.allocId },
        resources: { vcpus: 2, memory_mib: 4096 },
        env: [{ key: "A", value: "1" }],
        lifecycle: { ephemeral: false, max_duration_secs: 3600 },
        network: { enabled: true },
      },
    });
    expect(box).toMatchObject({ key: "k1", labels: { team: "a" }, state: "running" });
    await p.destroy(box.id);
  });

  test("a created sandbox is started, and a starting one polled, before /workspace setup", async () => {
    for (const status of ["created", "starting"] as const) {
      fake.faults.createStatus = status;
      fake.faults.startingReads = 2;
      const p = provider();
      const box = await p.create({ labels: {} });
      expect(fake.sandboxes.get(box.id)?.status).toBe("running");
      expect(posts(`/v1/sandboxes/${box.id}/start`)).toHaveLength(status === "created" ? 1 : 0);
      // Setup ran only once the sandbox was running.
      expect(fake.execs.at(-1)?.args).toEqual(["-c", "mkdir -p /workspace"]);
      await p.destroy(box.id);
      fake.requests.length = 0;
    }
  });

  test("a sandbox that fails while starting is deleted and the create throws", async () => {
    fake.faults.createStatus = "starting";
    fake.faults.startFails = true;
    const p = provider();
    await expect(p.create({ labels: { failing: "1" } })).rejects.toMatchObject({
      code: "provider",
    });
    expect([...fake.sandboxes.values()].filter((s) => s.labels.failing === "1")).toEqual([]);
  });

  test("a sandbox on the wrong tier is deleted and refused", async () => {
    fake.faults.compute = "shared";
    const p = provider({ computeType: "standard" });
    await expect(p.create({ labels: { tier: "wrong" } })).rejects.toMatchObject({
      code: "provider",
      message: expect.stringContaining("shared"),
    });
    expect([...fake.sandboxes.values()].filter((s) => s.labels.tier === "wrong")).toEqual([]);
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(true);
  });

  test("a 4xx refusal is final: no lookup by name", async () => {
    fake.faults.createRefuse = 400;
    const p = provider();
    await expect(p.create({ labels: {} })).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fake.requests.filter((r) => r.path.includes("/by-name/"))).toEqual([]);
  });

  test("a hook that aborts stops the create before anything is sent", async () => {
    const controller = new AbortController();
    const p = provider({ hooks: { create: () => controller.abort() } });
    await expect(p.create({ labels: {}, signal: controller.signal })).rejects.toMatchObject({
      code: "aborted",
    });
    expect(posts("/v1/sandboxes")).toEqual([]);
  });
});

describe("create reconciliation (spec.labels only, by name, fresh deadline)", () => {
  test("a dropped answer is found by name and returned", async () => {
    fake.faults.createAnswer = "drop";
    const p = provider();
    const box = await p.create({ labels: { lost: "drop" } });
    expect(fake.sandboxes.get(box.id)?.labels["sandbox-sdk-alloc"]).toBeDefined();
    expect(fake.requests.some((r) => r.path.startsWith("/v1/sandboxes/by-name/sbx-"))).toBe(true);
    await p.destroy(box.id);
  });

  test("a 503 is settled across transient 404s and unresolved specs", async () => {
    fake.faults.createAnswer = 503;
    fake.faults.byNameMissing = 3;
    fake.faults.specNull = 2;
    const p = provider();
    const box = await p.create({ labels: { lost: "503" } });
    const lookups = fake.requests.filter((r) => r.path.includes("/by-name/"));
    expect(lookups.length).toBeGreaterThanOrEqual(4);
    expect(posts("/v1/sandboxes?")).toHaveLength(1);
    await p.destroy(box.id);
  });

  test("an unreadable answer is settled by name", async () => {
    fake.faults.createAnswer = "unreadable";
    const p = provider();
    const box = await p.create({ labels: { lost: "unreadable" } });
    expect(fake.sandboxes.has(box.id)).toBe(true);
    await p.destroy(box.id);
  });

  test("a sandbox under the chosen name with another marker is left alone", async () => {
    fake.faults.foreignMarker = true;
    const p = provider();
    await expect(p.create({ labels: { foreign: "1" } })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    const left = [...fake.sandboxes.values()].filter((s) => s.labels.foreign === "1");
    expect(left).toHaveLength(1);
    expect(fake.requests.some((r) => r.method === "DELETE")).toBe(false);

    for (const sandbox of left) fake.sandboxes.delete(sandbox.id);
  });

  test(
    "a create that made nothing is outcome_unknown naming the sandbox, after the 404 grace",
    { timeout: 60_000 },
    async () => {
      fake.faults.createLost = 500;
      let chosen = "";
      const p = provider({ hooks: { create: ({ name }) => void (chosen = name) } });
      const error = await rejection(p.create({ labels: {} }));
      expect(error).toMatchObject({ code: "outcome_unknown" });
      expect(String(error.message)).toContain(chosen);
    },
  );
});

describe("restores", () => {
  test("a restore sends a managed disk_snapshot_ref and CPU and memory only", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    const { id: snapshotId } = await p.snapshot!(box.id);
    fake.requests.length = 0;

    const restored = await p.create({
      labels: {},
      from: snapshotId,
      size: { cpu: 2, memoryMb: 2048 },
    });

    const [post] = posts("/v1/sandboxes");
    expect(post?.path).toBe("/v1/sandboxes?start=true&wait_for=running&wait_timeout=60");
    expect(post?.body).toMatchObject({
      spec: { source: "disk_snapshot", disk_snapshot_ref: { type: "managed", id: snapshotId } },
    });
    expect(JSON.stringify(post?.body)).not.toContain("disk_size_mib");
    expect(JSON.stringify(post?.body)).toContain('"resources":{"vcpus":2,"memory_mib":2048}');
    await p.destroy(restored.id);
    await p.destroy(box.id);
    await p.deleteSnapshot!(snapshotId);
  });

  test("a restore with an explicit diskGb is unsupported before anything is sent", async () => {
    const p = provider();
    await expect(
      p.create({
        labels: {},
        from: crypto.randomUUID(),
        size: { cpu: 2, memoryMb: 2048, diskGb: 10 },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(fake.requests).toEqual([]);
  });

  test("a restore by snapshot name looks the managed ID up", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    const { id } = await p.snapshot!(box.id);
    const name = [...fake.snapshots.values()].find((s) => s.id === id)?.name ?? "";
    const restored = await p.create({ labels: {}, from: name });
    expect(fake.requests.some((r) => r.path === `/v1/snapshots/by-name/${name}`)).toBe(true);
    await p.destroy(restored.id);
    await p.destroy(box.id);
    await p.deleteSnapshot!(id);
  });

  test("an exact OCI size carries disk_size_mib", async () => {
    const p = provider();
    const box = await p.create({ labels: {}, size: { cpu: 4, memoryMb: 8192, diskGb: 64 } });
    expect(JSON.stringify(posts("/v1/sandboxes")[0]?.body)).toContain(
      '"resources":{"vcpus":4,"memory_mib":8192,"disk_size_mib":65536}',
    );
    await p.destroy(box.id);
  });
});

describe("tier-scoped list and find", () => {
  test("a standard adapter never sees a shared sandbox, and the reverse", async () => {
    const standard = provider({ computeType: "standard" });
    const shared = provider({ computeType: "shared" });
    const a = await standard.create({ key: "tier-key", labels: { scope: "tiers" } });
    const b = await shared.create({ key: "tier-key", labels: { scope: "tiers" } });
    expect((await standard.list({ scope: "tiers" })).map((s) => s.id)).toEqual([a.id]);
    expect((await shared.list({ scope: "tiers" })).map((s) => s.id)).toEqual([b.id]);
    expect((await standard.find("tier-key"))?.id).toBe(a.id);
    expect((await shared.find("tier-key"))?.id).toBe(b.id);
    expect(
      fake.requests.some((r) =>
        r.path.includes(`labels=${encodeURIComponent('{"scope":"tiers"}')}`),
      ),
    ).toBe(true);
    await standard.destroy(a.id);
    await shared.destroy(b.id);
  });
});

describe("exec (execStreamWith)", () => {
  test("launches sh -c with cwd, env, no tty and stdinNull; stdin goes as bytes", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    const plain = await run(p, box.id, "echo $GREETING; pwd");
    expect(plain.result).toEqual({ exitCode: 0, timedOut: false });
    expect(fake.execs.at(-1)).toMatchObject({
      cmd: "sh",
      args: ["-c", "echo $GREETING; pwd"],
      cwd: "/workspace",
      env: { GREETING: "hi" },
      tty: false,
      stdin: "null",
    });
    expect(plain.chunks.map((c) => c.text).join("")).toBe("hi\n/workspace\n");

    const piped = await run(p, box.id, "cat", { stdin: "é€ input" });
    const stdin = fake.execs.at(-1)?.stdin;
    expect(stdin).toBeInstanceOf(Uint8Array);
    expect(stdin instanceof Uint8Array ? new TextDecoder().decode(stdin) : stdin).toBe("é€ input");
    expect(piped.chunks.map((c) => c.text).join("")).toBe("é€ input");
    await p.destroy(box.id);
  });

  test("interleaved stdout and stderr each decode their own split UTF-8", async () => {
    const handle = new ScriptedHandle();
    const script: Scripted = {};
    const p = provider({}, script);
    const box = await p.create({ labels: {} });
    script.run = () => Promise.resolve(handle);
    const euro = [0xe2, 0x82, 0xac];
    handle.emit({ kind: "stdout", data: new Uint8Array([euro[0]!]) });
    handle.emit({ kind: "stderr", data: new Uint8Array([euro[0]!, euro[1]!]) });
    handle.emit({ kind: "stdout", data: new Uint8Array([euro[1]!, euro[2]!]) });
    handle.emit({ kind: "stderr", data: new Uint8Array([euro[2]!, 0x21]) });
    handle.emit({ kind: "exited", code: 3 });
    const { result, chunks } = await run(p, box.id, "split");
    expect(result).toEqual({ exitCode: 3, timedOut: false });
    expect(chunks).toEqual([
      { stream: "stdout", text: "€" },
      { stream: "stderr", text: "€!" },
    ]);
    expect(chunks.map((c) => c.text).join("")).not.toContain("�");
    script.run = undefined;
    await p.destroy(box.id);
  });

  for (const how of ["abort", "timeout"] as const)
    test(`a ${how} before the handle arrives is outcome_unknown, and the late handle is killed`, async () => {
      const late = new ScriptedHandle();
      let deliver: (handle: PeerExecHandle) => void = () => {};
      const script: Scripted = {};
      const p = provider({}, script);
      const box = await p.create({ labels: {} });
      script.run = () => new Promise<PeerExecHandle>((resolve) => (deliver = resolve));
      const controller = new AbortController();

      const pending = run(p, box.id, "sleep 100", {
        timeoutMs: how === "timeout" ? 50 : 30_000,
        signal: controller.signal,
      });

      if (how === "abort") setTimeout(() => controller.abort(), 20);
      await expect(pending).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(late.kills).toBe(0);
      deliver(late);
      await expect.poll(() => late.kills).toBe(1);
      await expect.poll(() => late.waits).toBe(1);
      script.run = undefined;
      await p.destroy(box.id);
    });

  test("a timeout after the handle kills, confirms the exit and reports timedOut", async () => {
    const handle = new ScriptedHandle();
    const script: Scripted = {};
    const p = provider({}, script);
    const box = await p.create({ labels: {} });
    script.run = () => Promise.resolve(handle);
    handle.emit({ kind: "stdout", data: new TextEncoder().encode("partial") });
    const { result, chunks } = await run(p, box.id, "sleep 100", { timeoutMs: 50 });
    expect(result).toEqual({ exitCode: null, timedOut: true });
    expect(chunks).toEqual([{ stream: "stdout", text: "partial" }]);
    expect(handle.kills).toBe(1);
    expect(handle.waits).toBe(1);
    script.run = undefined;
    await p.destroy(box.id);
  });

  test("an abort whose kill fails is outcome_unknown", async () => {
    const handle = new ScriptedHandle();
    handle.killFails = true;
    const script: Scripted = {};
    const p = provider({}, script);
    const box = await p.create({ labels: {} });
    script.run = () => Promise.resolve(handle);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(run(p, box.id, "sleep 100", { signal: controller.signal })).rejects.toMatchObject({
      code: "outcome_unknown",
    });
    script.run = undefined;
    await p.destroy(box.id);
  });

  test("a real command past its timeout dies with its process group", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });

    const { result } = await run(p, box.id, "(sleep 2; touch /workspace/late) & sleep 30", {
      timeoutMs: 200,
    });

    expect(result).toEqual({ exitCode: null, timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const check = await run(p, box.id, "test -e /workspace/late && echo yes || echo no");
    expect(check.chunks.map((c) => c.text).join("")).toBe("no\n");
    await p.destroy(box.id);
  });
});

describe("Services (previewUrl) and destroy", () => {
  test("a preview makes an owned slug, journals it first, and caches the URL", async () => {
    const seen: string[] = [];
    let postsAtHook = -1;

    const p = provider({
      hooks: {
        service: ({ slug }) => {
          seen.push(slug);
          postsAtHook = posts("/v1/services").length;
        },
      },
    });

    const box = await p.create({ labels: {} });
    const { url } = await p.previewUrl(box.id, 3000);
    const slug = `sbx-${box.id.replaceAll("-", "").slice(0, 16)}-p3000`;
    expect(seen).toEqual([slug]);
    expect(postsAtHook).toBe(0);
    expect(url).toBe(`${fake.url}/svc/${slug}`);
    // Microsandbox slugs: 3 to 63 lowercase letters, digits and single hyphens.
    expect(slug).toMatch(/^[a-z0-9](?:-?[a-z0-9]){2,62}$/);
    expect(isOwnedSlug(slug, box.id)).toBe(true);
    expect(posts("/v1/services")[0]?.body).toEqual({
      slug,
      target: { sandbox: fake.sandboxes.get(box.id)?.name, port: 3000 },
    });
    expect((await p.previewUrl(box.id, 3000)).url).toBe(url);
    expect(posts("/v1/services")).toHaveLength(1);
    await p.destroy(box.id);
    expect(fake.services.has(slug)).toBe(false);
  });

  test("a Service at the slug that routes elsewhere is never reused or deleted", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    const slug = `sbx-${box.id.replaceAll("-", "").slice(0, 16)}-p8080`;
    fake.services.set(slug, {
      slug,
      target: { sandbox: "someone-else", port: 8080 },
      status: "enabled",
    });
    const { url } = await p.previewUrl(box.id, 8080);
    expect(url).toMatch(new RegExp(`/svc/${slug}-[0-9a-f]{4}$`));
    await p.destroy(box.id);
    expect(fake.services.get(slug)?.target?.sandbox).toBe("someone-else");
    fake.services.delete(slug);
  });

  test("a slug another organization holds (409) is skipped for a suffixed one", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    const slug = `sbx-${box.id.replaceAll("-", "").slice(0, 16)}-p9000`;
    fake.faults.takenSlugs = new Set([slug]);
    const { url } = await p.previewUrl(box.id, 9000);
    expect(url).toMatch(new RegExp(`/svc/${slug}-[0-9a-f]{4}$`));
    expect(
      fake.requests.some((r) => r.method === "DELETE" && r.path === `/v1/services/${slug}`),
    ).toBe(false);
    await p.destroy(box.id);
  });

  test("a lost Service answer is read back", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    fake.faults.serviceDrop = true;
    const { url } = await p.previewUrl(box.id, 4000);
    expect(url).toContain("-p4000");
    await p.destroy(box.id);
    expect([...fake.services.keys()].some((s) => s.endsWith("-p4000"))).toBe(false);
  });

  test("destroy deletes the sandbox even when a Service cannot be removed, keeps the slug and reports it", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    await p.previewUrl(box.id, 5000);
    fake.faults.serviceDeleteFails = true;
    await expect(p.destroy(box.id)).rejects.toMatchObject({ code: "provider" });
    expect(fake.sandboxes.has(box.id)).toBe(false);
    const slug = `sbx-${box.id.replaceAll("-", "").slice(0, 16)}-p5000`;
    expect(fake.services.get(slug)?.status).toBe("detached");
    fake.faults.serviceDeleteFails = false;
    // The slug was kept in memory: a second destroy removes the detached Service.
    await p.destroy(box.id);
    expect(fake.services.has(slug)).toBe(false);
  });

  test("destroy finds owned Services by the sandbox filter after a fresh client", async () => {
    const first = provider();
    const box = await first.create({ labels: {} });
    await first.previewUrl(box.id, 6000);
    const second = provider();
    await second.destroy(box.id);
    expect([...fake.services.keys()].some((s) => s.endsWith("-p6000"))).toBe(false);
  });
});

describe("snapshots", () => {
  test("stops, captures a labeled disk snapshot, restarts, and returns the managed ID", async () => {
    const seen: string[] = [];
    let stopsAtHook = -1;

    const p = provider({
      hooks: {
        snapshot: ({ name }) => {
          seen.push(name);
          stopsAtHook = fake.requests.filter((r) => r.path.endsWith("/stop")).length;
        },
      },
    });

    const box = await p.create({ labels: {} });
    fake.faults.operationPendingReads = 2;
    const { id } = await p.snapshot!(box.id);
    expect(stopsAtHook).toBe(0);
    expect(posts("/v1/snapshots")[0]?.body).toEqual({
      kind: "disk",
      sandbox_id: box.id,
      name: seen[0],
      labels: { "sandbox-sdk-source": box.id },
    });
    expect(fake.snapshots.get(id)?.name).toBe(seen[0]);
    expect(fake.sandboxes.get(box.id)?.status).toBe("running");
    expect((await run(p, box.id, "echo back")).result.exitCode).toBe(0);
    expect(await p.deleteSnapshot!(id)).toBe(true);
    expect(await p.deleteSnapshot!(id)).toBe(false);
    await p.destroy(box.id);
  });

  test("a definite 422 refusal restarts the source and throws", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    fake.faults.snapshotRefuse = 422;
    await expect(p.snapshot!(box.id)).rejects.toMatchObject({ code: "invalid_argument" });
    expect(fake.sandboxes.get(box.id)?.status).toBe("running");
    expect(
      fake.operations.size === 0 ||
        [...fake.operations.values()].every((o) => o.sandboxId !== box.id),
    ).toBe(true);
    await p.destroy(box.id);
  });

  test("a lost 202 answer is settled through operations and by name", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    fake.faults.snapshotDrop = true;
    fake.faults.operationPendingReads = 1;
    const { id } = await p.snapshot!(box.id);
    expect(fake.snapshots.get(id)?.sandboxId).toBe(box.id);
    expect(fake.requests.some((r) => r.path.startsWith("/v1/snapshot-operations"))).toBe(true);
    expect(fake.sandboxes.get(box.id)?.status).toBe("running");
    await p.deleteSnapshot!(id);
    await p.destroy(box.id);
  });

  test("a failed capture operation restarts the source and throws", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    fake.faults.operationFails = true;
    await expect(p.snapshot!(box.id)).rejects.toMatchObject({ code: "provider" });
    expect(fake.sandboxes.get(box.id)?.status).toBe("running");
    await p.destroy(box.id);
  });

  test("a capture that names another source is never returned", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    fake.faults.snapshotForeignSource = crypto.randomUUID();
    await expect(p.snapshot!(box.id)).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fake.sandboxes.get(box.id)?.status).toBe("running");
    await p.destroy(box.id);
  });

  test("a failed restart after a confirmed capture keeps the snapshot ID in the error", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    fake.faults.startRefuse = true;
    const error = await rejection(p.snapshot!(box.id));
    expect(error).toMatchObject({ code: "provider" });
    const [snapshot] = [...fake.snapshots.values()].filter((s) => s.sandboxId === box.id);
    expect(snapshot).toBeDefined();
    expect(String(error.message)).toContain(snapshot!.id);
    fake.faults.startRefuse = false;
    await p.deleteSnapshot!(snapshot!.id);
    await p.destroy(box.id);
  });

  test("deleteSnapshot falls back to the name", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    const { id } = await p.snapshot!(box.id);
    const name = fake.snapshots.get(id)?.name ?? "";
    expect(await p.deleteSnapshot!(name)).toBe(true);
    expect(fake.snapshots.has(id)).toBe(false);
    await p.destroy(box.id);
  });
});

describe("redaction (msb_ and msb_pat_)", () => {
  test("the token pattern matches API keys and personal access tokens", () => {
    expect("a msb_abc123 b msb_pat_x-Y_9 c".match(tokenPattern)).toEqual([
      "msb_abc123",
      "msb_pat_x-Y_9",
    ]);
  });

  test("a token-shaped error code from the API never reaches the error", async () => {
    fake.faults.createRefuse = 400;
    fake.faults.refuseCode = "msb_pat_leakedtoken99";
    const p = provider();
    const error = await rejection(p.create({ labels: {} }));
    expect(JSON.stringify([String(error), error.cause, error.hint])).not.toContain(
      "msb_pat_leakedtoken99",
    );
  });

  test("peer error text is redacted in the cause and kept out of the message", () => {
    const redact = (text: string) => text.replace(tokenPattern, "[redacted]");

    const error = peerError(
      Object.assign(new Error("failed for msb_pat_secret123 at /x"), { code: "sandboxFsOps" }),
      "reading a file",
      { redact, files: true },
    );

    expect(error.message).not.toContain("msb_pat_secret123");
    expect(String(error.cause)).not.toContain("msb_pat_secret123");
  });

  test("the configured key is never echoed", async () => {
    const p = createMicrosandboxProvider(
      { apiKey: "msb_wrong_key_abcdef", baseUrl: fake.url },
      async () => fake.peer,
    );

    const error = await rejection(p.list({}));
    expect(error).toMatchObject({ code: "auth" });
    expect(JSON.stringify([String(error), error.cause])).not.toContain("msb_wrong_key_abcdef");
  });
});

describe("files through the peer", () => {
  test("a missing file reads as file_not_found", async () => {
    const p = provider();
    const box = await p.create({ labels: {} });
    await expect(p.files.read(box.id, "/workspace/nope.txt")).rejects.toMatchObject({
      code: "file_not_found",
    });
    await p.files.write(box.id, "/workspace/deep/nested/f.txt", new TextEncoder().encode("x"));
    expect(
      new TextDecoder().decode(await p.files.read(box.id, "/workspace/deep/nested/f.txt")),
    ).toBe("x");
    await p.destroy(box.id);
  });
});
