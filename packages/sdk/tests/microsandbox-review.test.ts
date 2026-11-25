// GPT-6.2 Sol's independent review of the Microsandbox adapter (2026-11-24): its reproductions of
// the adapter's own findings, kept verbatim as regressions. The bench's share is in
// bench/tests/microsandbox-review.test.ts.
import { createHook } from "node:async_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createSandbox, reapSandboxes } from "../src/index.js";
import { peerError } from "../src/providers/microsandbox/errors.js";
import {
  execute,
  type PeerExecEvent,
  type PeerExecHandle,
  type PeerSandbox,
} from "../src/providers/microsandbox/exec.js";
import { microsandbox, type MicrosandboxOptions } from "../src/providers/microsandbox/index.js";
import { microsandboxFake, type MicrosandboxFake } from "./microsandbox-fake.js";

const key = "msb_fake_key_0123456789";
let fake: MicrosandboxFake;
const realFetch = globalThis.fetch.bind(globalThis);

beforeEach(async () => {
  fake = await microsandboxFake();
  vi.stubEnv("MSB_API_KEY", key);
  vi.stubEnv("MSB_API_URL", fake.url);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fake.close();
});

function adapter(options: MicrosandboxOptions = {}) {
  return microsandbox({
    apiKey: key,
    baseUrl: fake.url,
    computeType: "standard",
    peer: async () => fake.peer,
    ...options,
  });
}

const labels = (tier = "standard") => ({
  "sandbox-bench-run": "independent-review",
  "sandbox-sdk": "1",
  "sandbox-bench-tier": tier,
});

test("R1 sandbox DELETE is dispatched when the Services request consumes its deadline", async () => {
  const p = adapter({
    fetch: async (url, init) => {
      if (new URL(url).pathname === "/v1/services") {
        cleanup.abort();
        throw new DOMException("cleanup deadline", "TimeoutError");
      }

      return realFetch(url, init);
    },
  });

  const { id: sandbox } = await p.create({ labels: labels() });
  const cleanup = new AbortController();
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout")
    .mockImplementationOnce(() => cleanup.signal)
    .mockImplementation(nativeTimeout);
  await p.destroy(sandbox).catch(() => {});
  expect(
    fake.requests.some((r) => r.method === "DELETE" && r.path === "/v1/sandboxes/" + sandbox),
  ).toBe(true);
  expect(fake.sandboxes.has(sandbox)).toBe(false);
});

test("R2 failed Service discovered by a fresh adapter remains available to the next destroy", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  const { url } = await p.previewUrl(sandbox, 3000);
  const slug = new URL(url).pathname.split("/").at(-1) ?? "";
  const fresh = adapter();
  fake.faults.serviceDeleteFails = true;
  await expect(fresh.destroy(sandbox)).rejects.toThrow(/Services/);
  expect(fake.sandboxes.has(sandbox)).toBe(false);
  expect(fake.services.get(slug)?.status).toBe("detached");
  fake.faults.serviceDeleteFails = false;
  await fresh.destroy(sandbox);
  expect(fake.services.has(slug)).toBe(false);
});

test("R11 peer error codes go through the same redactor as peer messages", () => {
  const marker = "msb_pat_dummy_review_marker";
  const clean = (s: string) => s.replace(/msb_(?:pat_)?[A-Za-z0-9_-]+/g, "[REDACTED]");

  const error = peerError(
    Object.assign(new Error("peer " + marker), { code: marker }),
    "finding the sandbox",
    { redact: clean },
  );

  expect(error.message.includes(marker)).toBe(false);
  expect(String(error.cause).includes(marker)).toBe(false);
});

test("R13 an OCI size with a CPU count outside the OpenAPI int32 range is rejected before dispatch", async () => {
  const p = adapter();

  // The repo's lint forbids an `unknown` parameter, so the rejection is asserted directly.
  await expect(
    p.create({ labels: labels(), size: { cpu: 2 ** 31, memoryMb: 512 } }),
  ).rejects.toMatchObject({ code: "invalid_argument" });

  expect(
    fake.requests.some((r) => r.method === "POST" && r.path.startsWith("/v1/sandboxes?")),
  ).toBe(false);
});

// Beyond the reproductions: the rest of the fixes' contracts.

test("memory and disk outside the OpenAPI int32 range are rejected before dispatch", async () => {
  const p = adapter();

  for (const size of [
    { cpu: 1, memoryMb: 2 ** 31 },
    { cpu: 1, memoryMb: 512, diskGb: 2 ** 31 / 1024 },
  ])
    await expect(p.create({ labels: labels(), size })).rejects.toMatchObject({
      code: "invalid_argument",
    });

  expect(fake.requests.some((r) => r.method === "POST")).toBe(false);
});

test("the Service hooks report a 409 as a conflict before the next slug is journaled", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  const slug = "sbx-" + sandbox.replaceAll("-", "").slice(0, 16) + "-p3000";
  const events: string[] = [];
  fake.faults.takenSlugs = new Set([slug]);
  p.setAttemptHooks({
    service: (attempt) => void events.push(`journal ${attempt.slug}`),
    serviceSettled: (settled) => void events.push(`${settled.outcome} ${settled.slug}`),
  });
  const { url } = await p.previewUrl(sandbox, 3000);
  const retry = new URL(url).pathname.split("/").at(-1) ?? "";

  expect(retry).not.toBe(slug);
  expect(events).toEqual([
    `journal ${slug}`,
    `conflict ${slug}`,
    `journal ${retry}`,
    `created ${retry}`,
  ]);
  await p.destroy(sandbox);
});

// The bot review of PR #88 (Greptile, Devin), 2026-11-25: each finding reproduced on the fake.

/** Runs `command` through the adapter and returns its stdout with the result. */
async function exec(
  p: ReturnType<typeof adapter>,
  id: string,
  command: string,
  extra: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  let stdout = "";

  const result = await p.exec(id, {
    command,
    cwd: "/",
    env: {},
    timeoutMs: extra.timeoutMs ?? 30_000,
    signal: extra.signal,
    onChunk: (chunk) => {
      if (chunk.stream === "stdout") stdout += chunk.text;
    },
  });

  return { ...result, stdout };
}

/** A process record without an exit and a run marker, as a stop leaves them. */
const staleRecord =
  "mkdir -p /tmp/.sandbox-sdk/procs/p1 /tmp/.sandbox-sdk/runs && echo '{}' > /tmp/.sandbox-sdk/procs/p1/spec.json && touch -d '1 hour ago' /tmp/.sandbox-sdk/procs/p1/spec.json /tmp/.sandbox-sdk/runs/r1";

/** The record's exit code, or `none`, then whether the run marker is still there. */
const recordState =
  "cat /tmp/.sandbox-sdk/procs/p1/exit 2>/dev/null || printf none; if [ -e /tmp/.sandbox-sdk/runs/r1 ]; then printf ' run'; else printf ' gone'; fi";

/** Marks a fake sandbox stopped, as its lifetime or idle timeout would. */
function expire(id: string) {
  const sandbox = fake.sandboxes.get(id);

  if (sandbox === undefined) throw new Error(`no fake sandbox ${id}`);
  sandbox.status = "stopped";
}

test("PR88-1 a long output stream adds no reaction per chunk to one shared promise", async () => {
  const events = 2000;
  let sent = 0;

  const handle: PeerExecHandle = {
    recv: async (): Promise<PeerExecEvent | null> => {
      if (sent >= events) return null;
      sent++;

      return { kind: "stdout", data: new Uint8Array([97]) };
    },
    wait: async () => ({ code: 0 }),
    kill: async () => {},
  };

  const sandbox: PeerSandbox = {
    execStreamWith: async () => handle,
    fs: () => {
      throw new Error("not used");
    },
  };

  let output = 0;
  // Counts the promises derived from each promise: every reaction Promise.race adds to one is one.
  const reactions = new Map<number, number>();

  const hook = createHook({
    init(_asyncId, type, triggerAsyncId) {
      if (type === "PROMISE")
        reactions.set(triggerAsyncId, (reactions.get(triggerAsyncId) ?? 0) + 1);
    },
  }).enable();

  const result = await execute({
    sandbox: Promise.resolve(sandbox),
    sandboxId: "stream",
    redact: (text) => text,
    exec: {
      command: "yes",
      cwd: "/",
      env: {},
      timeoutMs: 30_000,
      onChunk: (chunk) => {
        output += chunk.text.length;
      },
    },
  }).finally(() => hook.disable());

  expect({ result, output }).toEqual({ result: { exitCode: 0, timedOut: false }, output: events });
  expect(Math.max(...reactions.values())).toBeLessThan(50);
});

test("PR88-2 a failed Service listing fails the destroy, and the next destroy names the detached Service it cannot prove", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  const { url } = await p.previewUrl(sandbox, 3000);
  const slug = new URL(url).pathname.split("/").at(-1) ?? "";
  let listFails = true;

  const fresh = adapter({
    fetch: async (input, init) =>
      listFails && new URL(input).pathname === "/v1/services" && init.method === "GET"
        ? Response.json({ error: { code: "internal_error" } }, { status: 500 })
        : realFetch(input, init),
  });

  await expect(fresh.destroy(sandbox)).rejects.toThrow(/could not be listed/);
  expect(fake.sandboxes.has(sandbox)).toBe(false);
  expect(fake.services.get(slug)?.status).toBe("detached");

  // Nothing proves the detached slug was this sandbox's, so it is named and never deleted.
  listFails = false;
  await expect(fresh.destroy(sandbox)).rejects.toThrow(slug);
  expect(fake.services.get(slug)?.status).toBe("detached");

  fake.services.delete(slug);
  await fresh.destroy(sandbox);
});

test("PR88-2 a failed listing is remembered even when the sandbox DELETE's answer is lost", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  const { url } = await p.previewUrl(sandbox, 3000);
  const slug = new URL(url).pathname.split("/").at(-1) ?? "";
  let faulty = true;

  const fresh = adapter({
    fetch: async (input, init) => {
      const path = new URL(input).pathname;

      if (faulty && path === "/v1/services" && init.method === "GET")
        return Response.json({ error: { code: "internal_error" } }, { status: 500 });

      const response = await realFetch(input, init);

      return faulty && path === `/v1/sandboxes/${sandbox}` && init.method === "DELETE"
        ? Response.json({ error: { code: "internal_error" } }, { status: 500 })
        : response;
    },
  });

  await expect(fresh.destroy(sandbox)).rejects.toBeDefined();
  expect(fake.sandboxes.has(sandbox)).toBe(false);

  faulty = false;
  await expect(fresh.destroy(sandbox)).rejects.toThrow(slug);
});

test("PR88-2 an unreadable sandbox name fails the destroy instead of reporting its Services removed", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  await p.previewUrl(sandbox, 3000);
  let reads = 0;

  const fresh = adapter({
    fetch: async (input, init) =>
      new URL(input).pathname === `/v1/sandboxes/${sandbox}` &&
      init.method === "GET" &&
      reads++ === 0
        ? Response.json({ error: { code: "internal_error" } }, { status: 500 })
        : realFetch(input, init),
  });

  await expect(fresh.destroy(sandbox)).rejects.toThrow(/could not be listed/);
  expect(fake.sandboxes.has(sandbox)).toBe(false);
});

test("PR88-3 a failed create whose accepted DELETE never finishes stays outcome_unknown", async () => {
  fake.faults.compute = "shared";
  fake.faults.deleteLingerReads = Number.POSITIVE_INFINITY;
  const realNow = Date.now.bind(Date);
  let skew = 0;
  let deleted = false;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);

  // Every read after the DELETE moves the clock past the confirmation deadline.
  const p = adapter({
    fetch: async (input, init) => {
      const path = new URL(input).pathname;

      if (deleted && init.method === "GET" && path.startsWith("/v1/sandboxes/")) skew += 120_000;

      if (init.method === "DELETE" && path.startsWith("/v1/sandboxes/")) deleted = true;

      return realFetch(input, init);
    },
  });

  await expect(p.create({ labels: labels() })).rejects.toMatchObject({ code: "outcome_unknown" });
  expect(deleted).toBe(true);
});

test("PR88-4 a restore marks the processes its source's stop ended as exited", async () => {
  const p = adapter();
  const source = await p.create({ labels: labels() });
  expect((await exec(p, source.id, staleRecord)).exitCode).toBe(0);

  if (!p.snapshot) throw new Error("the adapter takes snapshots");
  const snapshot = await p.snapshot(source.id);
  const restored = await p.create({ labels: labels(), from: snapshot.id });

  expect({
    restored: (await exec(p, restored.id, recordState)).stdout,
    source: (await exec(p, source.id, recordState)).stdout,
  }).toEqual({ restored: "137 gone", source: "137 gone" });

  // Work started since the boot is never marked killed, by this client or the next one to connect.
  const current =
    "mkdir -p /tmp/.sandbox-sdk/procs/p2 /tmp/.sandbox-sdk/runs && echo '{}' > /tmp/.sandbox-sdk/procs/p2/spec.json && touch /tmp/.sandbox-sdk/runs/r2";

  expect((await exec(p, restored.id, current)).exitCode).toBe(0);

  expect(
    (
      await exec(
        adapter(),
        restored.id,
        "cat /tmp/.sandbox-sdk/procs/p2/exit 2>/dev/null || printf none; [ -e /tmp/.sandbox-sdk/runs/r2 ] && printf ' run'",
      )
    ).stdout,
  ).toBe("none run");
});

test("PR88-5 a guest agent lookup that never answers still ends at the command's timeout or abort", async () => {
  const { id: sandbox } = await adapter().create({ labels: labels() });

  const stuck = adapter({
    peer: async () => ({
      RemoteContext: class {
        readonly sandboxes = { get: () => new Promise<PeerSandbox>(() => {}) };
      },
    }),
  });

  expect(await exec(stuck, sandbox, "true", { timeoutMs: 200 })).toMatchObject({
    exitCode: null,
    timedOut: true,
  });

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);

  expect(
    await exec(stuck, sandbox, "true", { timeoutMs: 60_000, signal: controller.signal }),
  ).toMatchObject({ exitCode: null, timedOut: true });
}, 10_000);

test("PR88-5 a peer that stalls while loading is retried by the next command", async () => {
  const { id: sandbox } = await adapter().create({ labels: labels() });
  let loads = 0;

  const stalled = adapter({
    requestTimeoutMs: 300,
    peer: () => (loads++ === 0 ? new Promise(() => {}) : Promise.resolve(fake.peer)),
  });

  await expect(exec(stalled, sandbox, "true", { timeoutMs: 5000 })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(await exec(stalled, sandbox, "printf ok")).toMatchObject({ exitCode: 0, stdout: "ok" });
}, 10_000);

test("PR88-5 a lookup that times out is dropped, so the next command connects again", async () => {
  const { id: sandbox } = await adapter().create({ labels: labels() });
  let gets = 0;

  const flaky = adapter({
    requestTimeoutMs: 300,
    peer: async () => ({
      RemoteContext: class {
        private readonly inner = new fake.peer.RemoteContext({
          url: fake.url,
          apiKey: key,
          requestTimeoutMs: 300,
        });

        readonly sandboxes = {
          get: (name: string) =>
            gets++ === 0 ? new Promise<PeerSandbox>(() => {}) : this.inner.sandboxes.get(name),
        };
      },
    }),
  });

  await expect(exec(flaky, sandbox, "true", { timeoutMs: 5000 })).rejects.toMatchObject({
    code: "timeout",
  });
  expect(await exec(flaky, sandbox, "printf ok")).toMatchObject({ exitCode: 0, stdout: "ok" });
}, 10_000);

test("PR88-7 a key whose sandbox its lifetime stopped is started again, its dead processes exited", async () => {
  const p = adapter();
  const box = await createSandbox(p, { key: "project:7", labels: { app: "review" } });
  await box.run(staleRecord);
  expire(box.id);

  const again = await createSandbox(p, { key: "project:7", labels: { app: "review" } });

  expect({ id: again.id, state: (await again.run(recordState)).stdout }).toEqual({
    id: box.id,
    state: "137 gone",
  });
  await again.destroy();
});

test("PR88-7 a key lookup prefers a running sandbox over one still starting", async () => {
  fake.faults.startingReads = 1000;
  const p = adapter();
  const first = await p.create({ labels: labels(), key: "project:8" });
  const second = await p.create({ labels: labels(), key: "project:8" });
  const starting = fake.sandboxes.get(first.id);

  if (starting === undefined) throw new Error("no fake sandbox");
  starting.status = "starting";

  expect((await p.find("project:8"))?.id).toBe(second.id);
});

test("PR88-7 an abort while a key lookup waits out a saving sandbox ends it, without a start", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels(), key: "project:10" });
  const saving = fake.sandboxes.get(sandbox);

  if (saving === undefined) throw new Error("no fake sandbox");
  saving.status = "saving_state";
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);

  await expect(p.find("project:10", { signal: controller.signal })).rejects.toMatchObject({
    code: "aborted",
  });
  expect(fake.requests.some((r) => r.path.startsWith(`/v1/sandboxes/${sandbox}/start`))).toBe(
    false,
  );
}, 5000);

test("PR88-7 an aborted key lookup never starts a stopped sandbox", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels(), key: "project:9" });
  expire(sandbox);
  const controller = new AbortController();
  controller.abort();

  await expect(p.find("project:9", { signal: controller.signal })).rejects.toBeDefined();
  expect(fake.requests.some((r) => r.path.startsWith(`/v1/sandboxes/${sandbox}/start`))).toBe(
    false,
  );
});

test("PR88-8 destroy returns only once the sandbox is gone, so its key makes a new sandbox", async () => {
  fake.faults.deleteLingerReads = 2;
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels(), key: "project:42" });

  await p.destroy(sandbox);

  expect(fake.sandboxes.has(sandbox)).toBe(false);
  expect(await p.find("project:42")).toBeUndefined();
});

test("PR88-9 idle-only reaping deletes a sandbox its lifetime stopped without probing it", async () => {
  const p = adapter();
  const { id: sandbox } = await p.create({ labels: labels() });
  expire(sandbox);
  const execs = fake.execs.length;

  expect(
    await reapSandboxes(p, {
      idleOnly: true,
      labels: { "sandbox-bench-run": "independent-review" },
    }),
  ).toBe(1);
  expect({ gone: !fake.sandboxes.has(sandbox), probes: fake.execs.length - execs }).toEqual({
    gone: true,
    probes: 0,
  });
});

test("PR88-9 idle-only reaping skips a sandbox still saving its state and reaps the stopped one", async () => {
  const p = adapter();
  const { id: busy } = await p.create({ labels: labels() });
  const { id: stopped } = await p.create({ labels: labels() });
  const saving = fake.sandboxes.get(busy);

  if (saving === undefined) throw new Error("no fake sandbox");
  saving.status = "saving_state";
  expire(stopped);

  expect(
    await reapSandboxes(p, {
      idleOnly: true,
      labels: { "sandbox-bench-run": "independent-review" },
    }),
  ).toBe(1);
  expect({ busy: fake.sandboxes.has(busy), stopped: fake.sandboxes.has(stopped) }).toEqual({
    busy: true,
    stopped: false,
  });
});
