// Regressions for the review of 76f32af: each test pins one of the reproduced findings.
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectSandbox, createSandbox, reapSandboxes, SandboxError } from "../src/index.js";
import { FrameError, LineSplitter } from "../src/providers/buddy/exec.js";
import { buddy, type BuddyOptions } from "../src/providers/buddy/index.js";
import type { Fetch } from "../src/http.js";
import { buddyFake, type BuddyFake, type FakeSandbox } from "./buddy-fake.js";

let fake: BuddyFake;

beforeEach(async () => {
  fake = await buddyFake();
});

afterEach(async () => {
  await fake.close();
});

const provider = (options: BuddyOptions = {}) => buddy({ ...fake.options, ...options });

async function waitUntil(ready: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await ready()) return;
    await delay(20);
  }

  throw new Error("the fake did not reach the expected state");
}

/** The error a promise rejects with, or `undefined` when it resolves. */
async function failure(promise: Promise<object | void>): Promise<Error | undefined> {
  try {
    await promise;

    return undefined;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
}

function sandboxOf(id: string): FakeSandbox {
  const sandbox = fake.sandboxes.get(id);

  if (!sandbox) throw new Error(`the fake has no sandbox ${id}`);

  return sandbox;
}

const isPost = (input: Parameters<Fetch>[0], init: Parameters<Fetch>[1], suffix: string) =>
  init?.method === "POST" && new URL(String(input)).pathname.endsWith(suffix);

test("an accepted launch answered with a malformed 200 is recovered by its execution tag", async () => {
  const box = await createSandbox(provider());

  fake.rules.push({ method: "POST", path: /\/execs$/, fault: { kind: "body", body: {} } });
  await expect(box.run("printf accepted")).resolves.toMatchObject({
    stdout: "accepted",
    exitCode: 0,
  });
  expect(fake.execs.size).toBe(1);
});

test("a lost launch that ran is outcome_unknown, never retryable, when Buddy's history misses it", async () => {
  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const response = await fetch(input, init);

        if (isPost(input, init, "/execs")) {
          await response.body?.cancel();
          await waitUntil(() =>
            [...fake.execs.values()].some((exec) => exec.status === "SUCCESSFUL"),
          );
          throw new TypeError("simulated lost start response");
        }

        return response;
      },
    }),
  );

  fake.rules.push({ method: "GET", path: /\/execs$/, fault: { kind: "body", body: [] } });
  const error = await failure(box.run("touch /workspace/already-ran"));

  expect(fake.execs.size).toBe(1);
  await expect(
    access(join(sandboxOf(box.id).root, "workspace/already-ran")),
  ).resolves.toBeUndefined();
  expect(error).toBeInstanceOf(SandboxError);
  expect(error).toMatchObject({ code: "outcome_unknown", retryable: false });
});

test("a lost launch is retryable only when the guest recorded that it refused to start", async () => {
  let tag: string | undefined;
  let root = "";

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const body = String(init?.body ?? "");

        if (isPost(input, init, "/execs"))
          tag = /\/tmp\/\.sandbox-sdk\/exec\/([0-9a-f-]{36})/.exec(body)?.[1];

        // The command's shell saw the cancel marker before the killer's read: what it leaves behind.
        if (isPost(input, init, "/exec") && tag && body.includes("keep=$2")) {
          await mkdir(join(root, "tmp/.sandbox-sdk/exec", tag), { recursive: true });
          await writeFile(join(root, "tmp/.sandbox-sdk/exec", tag, "refused"), "");
        }

        return fetch(input, init);
      },
    }),
  );

  root = sandboxOf(box.id).root;
  fake.rules.push({ method: "POST", path: /\/execs$/, fault: { kind: "dropped" } });
  await expect(box.run("touch /workspace/never-ran")).rejects.toMatchObject({
    code: "unavailable",
    retryable: true,
  });
  await expect(access(join(root, "workspace/never-ran"))).rejects.toThrow();
});

test("a lost create is reconciled after a transient inventory miss", async () => {
  fake.rules.push(
    { method: "POST", path: /^\/sandboxes$/, fault: { kind: "lost" } },
    { method: "GET", path: /^\/sandboxes$/, fault: { kind: "body", body: { sandboxes: [] } } },
  );
  const box = await createSandbox(provider());

  expect(fake.sandboxes.size).toBe(1);
  expect([...fake.sandboxes.keys()]).toEqual([box.id]);
});

test("an abort returns the output already written to the spool when Buddy's log was cut", async () => {
  const box = await createSandbox(provider());

  fake.logLimit = 0;
  const controller = new AbortController();

  // A run starts once something awaits it.
  const run = box
    .run("printf before-abort; sleep 20", { signal: controller.signal })
    .then((r) => r);

  await waitUntil(() => [...fake.execs.values()].some((exec) => exec.lines.length > 0));
  controller.abort();
  expect(await run).toMatchObject({ timedOut: true, exitCode: null, stdout: "before-abort" });
});

test("an abort kills the command even when the bridge dies between spawn and PID publication", async () => {
  let bridgePid = 0;
  let userPid = 0;
  const requests: string[] = [];

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;

        if (init?.method === "DELETE" && path.includes("/execs/")) {
          requests.push("delete");

          // What Buddy's DELETE does to the bridge, at the worst moment.
          if (bridgePid) process.kill(bridgePid, "SIGKILL");
        }

        if (isPost(input, init, "/exec") && String(init?.body).includes("keep"))
          requests.push("kill");

        return fetch(input, init);
      },
    }),
  );

  const sandbox = sandboxOf(box.id);
  const pidsPath = join(sandbox.root, "buddy", "racing-pids");

  // The bridge pauses right after the spawn, before anything of its own records the PID.
  await writeFile(
    join(sandbox.root, "buddy", "sitecustomize.py"),
    [
      "import os, subprocess, sys, time",
      "if 'buddy-bridge-' in sys.argv[0]:",
      "    spawn = subprocess.Popen",
      "    def interleaved_spawn(*args, **kwargs):",
      "        child = spawn(*args, **kwargs)",
      "        with open('racing-pids', 'w') as ready:",
      "            ready.write(f'{os.getpid()} {child.pid}')",
      "        time.sleep(5)",
      "        return child",
      "    subprocess.Popen = interleaved_spawn",
    ].join("\n"),
  );
  sandbox.variables.push({
    key: "PYTHONPATH",
    value: join(sandbox.root, "buddy"),
    encrypted: false,
    id: 1,
  });

  const controller = new AbortController();
  const run = box.run("sleep 20", { signal: controller.signal }).then((r) => r);

  try {
    await waitUntil(async () => {
      const [bridge = 0, user = 0] = (await readFile(pidsPath, "utf8").catch(() => ""))
        .trim()
        .split(" ")
        .map(Number);

      bridgePid = bridge;
      userPid = user;

      return Boolean(bridgePid && userPid);
    });
    controller.abort();
    expect(await run).toMatchObject({ timedOut: true });

    let running = false;

    try {
      process.kill(-userPid, 0);
      running = true;
    } catch {
      // The group is gone.
    }

    expect(running).toBe(false);
    // The guest killer confirmed the group gone before Buddy's DELETE ended the bridge.
    expect(requests.indexOf("kill")).toBeGreaterThanOrEqual(0);
    expect(requests.indexOf("kill")).toBeLessThan(requests.indexOf("delete"));
  } finally {
    if (userPid)
      try {
        process.kill(-userPid, "SIGKILL");
      } catch {
        // Already gone.
      }
  }
});

test("a TLS endpoint is kept even when its name is the requested preview's", async () => {
  const box = await createSandbox(provider());
  const sandbox = sandboxOf(box.id);

  sandbox.endpoints.push({
    name: "sbx-p4001",
    endpoint: "4001",
    type: "TLS",
    region: "US",
    timeout: 30,
    http: {},
    extra: { tls: { terminate_at: "AGENT" } },
  });

  await expect(box.preview(4001)).rejects.toMatchObject({ code: "provider" });
  expect(fake.requests.some((request) => request.method === "PATCH")).toBe(false);
  expect(sandbox.endpoints).toHaveLength(1);
  expect(sandbox.endpoints[0]).toMatchObject({
    type: "TLS",
    extra: { tls: { terminate_at: "AGENT" } },
  });
});

test("an HTTP endpoint under the preview's name on another port is never replaced", async () => {
  const box = await createSandbox(provider());
  const sandbox = sandboxOf(box.id);

  sandbox.endpoints.push({
    name: "sbx-p4002",
    endpoint: "9999",
    type: "HTTP",
    region: "US",
    timeout: 30,
    http: { auth_type: "NONE" },
    extra: {},
  });

  await expect(box.preview(4002)).rejects.toMatchObject({ code: "provider" });
  expect(fake.requests.some((request) => request.method === "PATCH")).toBe(false);
});

test("preview errors never echo credentials from Buddy's endpoint metadata", async () => {
  const box = await createSandbox(provider());

  sandboxOf(box.id).endpoints.push({
    name: fake.options.token,
    endpoint: "4000",
    type: "TLS",
    region: "US",
    timeout: 30,
    http: {},
    extra: { tls: { terminate_at: "AGENT" } },
  });

  const error = await failure(box.preview(4001));

  expect(error).toBeInstanceOf(SandboxError);
  expect(String(error)).not.toContain(fake.options.token);
  expect(JSON.stringify(error)).not.toContain(fake.options.token);
});

test("a download's generic Resource not found is a provider error, not a missing sandbox", async () => {
  const box = await createSandbox(provider());

  fake.rules.push({
    method: "GET",
    path: /\/download\//,
    fault: { kind: "status", status: 404, message: "Resource not found" },
  });
  await expect(box.files.read("unknown")).rejects.toMatchObject({ code: "provider" });

  fake.rules.push({
    method: "GET",
    path: /\/download\//,
    fault: { kind: "status", status: 404, message: "File not found" },
  });
  await expect(box.files.read("unknown")).rejects.toMatchObject({ code: "file_not_found" });

  fake.rules.push({
    method: "GET",
    path: /\/download\//,
    fault: { kind: "status", status: 404, message: "Sandbox not found" },
  });
  await expect(box.files.read("unknown")).rejects.toMatchObject({ code: "not_found" });
});

test("an abort after staging removes the private stdin and env and starts nothing", async () => {
  const controller = new AbortController();

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const response = await fetch(input, init);

        if (isPost(input, init, "/exec") && String(init?.body).includes("/stdin.part"))
          controller.abort();

        return response;
      },
    }),
  );

  const result = await box.run("cat", {
    stdin: "private input",
    env: { SAMPLE: "private value" },
    signal: controller.signal,
  });

  const root = join(sandboxOf(box.id).root, "tmp/.sandbox-sdk/exec");

  const files = (
    await Promise.all((await readdir(root)).map((dir) => readdir(join(root, dir))))
  ).flat();

  expect(result.timedOut).toBe(true);
  expect(fake.execs.size).toBe(0);
  expect(files).not.toContain("env.json");
  expect(files).not.toContain("stdin");
});

test("secret values stay out of Buddy's command history; printed output is redacted on the result only", async () => {
  const sample = "synthetic-secret-for-offline-review";
  const box = await createSandbox(provider(), { secrets: { SAMPLE: sample } });

  const result = await box.run('printf %s "$SAMPLE"');

  // The SDK redacts the value from what it returns.
  expect(result.stdout).not.toContain(sample);
  // The recorded command text never holds it: the variable is Buddy's encrypted one.
  expect([...fake.execs.values()].map((exec) => exec.command).join("\n")).not.toContain(sample);

  // What the command printed does reach Buddy's execution log, base64-framed, as the provider page
  // says: the SDK cannot scrub Buddy's own server-side log.
  const logged = [...fake.execs.values()]
    .flatMap((exec) => exec.lines)
    .flatMap((line) => {
      const payload = /^\d+:O:\d+:(.*)\.$/.exec(line)?.[1];

      return payload ? [Buffer.from(payload, "base64").toString("utf8")] : [];
    })
    .join("");

  expect(logged).toContain(sample);
});

test("accepted async launch with invalid JSON body reconciles by tag in Buddy history", async () => {
  let mangled = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const response = await fetch(input, init);

        if (!mangled && isPost(input, init, "/execs") && response.ok) {
          mangled = true;

          return new Response("not-valid-json{{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        return response;
      },
    }),
  );

  const result = await box.run("printf launched");

  expect(mangled).toBe(true);
  expect(fake.execs.size).toBe(1);
  expect(result).toMatchObject({ exitCode: 0, stdout: "launched", timedOut: false });
});

test("abort drains the guest spool even when Buddy's log returns empty without truncation", async () => {
  const controller = new AbortController();
  let postAbortLogReads = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (url.pathname.endsWith("/log")) {
          if (controller.signal.aborted) postAbortLogReads++;

          return Response.json({ lines: [], next_offset: 0, truncated: false });
        }

        return fetch(input, init);
      },
    }),
  );

  const ready = join(sandboxOf(box.id).root, "workspace", "spool-ready");

  const pending = box
    .run("printf before-abort; : > spool-ready; sleep 30", {
      signal: controller.signal,
    })
    .then((r) => r);

  await waitUntil(async () => (await readFile(ready, "utf8").catch(() => null)) !== null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  controller.abort();

  const result = await pending;

  expect(postAbortLogReads).toBeGreaterThan(0);
  expect(result).toMatchObject({ timedOut: true, exitCode: null, stdout: "before-abort" });
});

test("unkeyed create reconciles an allocation that becomes visible near the end of the 30s window", async () => {
  let dropped = false;
  let droppedAt = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (!dropped && isPost(input, init, "/sandboxes")) {
          await fetch(input, init);
          dropped = true;
          droppedAt = performance.now();
          throw new Error("socket closed after create");
        }

        if (dropped && (init?.method ?? "GET") === "GET" && url.pathname.endsWith("/sandboxes")) {
          if (performance.now() - droppedAt < 29_000) return Response.json({ sandboxes: [] });
        }

        return fetch(input, init);
      },
    }),
  );

  expect(box.id).toBeTruthy();
  await box.destroy();
}, 40_000);

test("a short pipe write leaving a valid base64 prefix does not silently drop stdout", async () => {
  let truncatedLog = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const url = new URL(input);

        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/log")) {
          // SAFETY: the local Buddy fake's GET /log endpoint always returns `{ lines?: string[]; next_offset?: number; truncated?: boolean }`.
          const body = (await response.json()) as {
            lines?: string[];
            next_offset?: number;
            truncated?: boolean;
          };

          if (body.lines?.some((line) => line.startsWith("0:O:"))) {
            truncatedLog = true;

            // Simulate a short non-blocking pipe write that cuts frame 0 at a 4-char base64 boundary.
            const cut = body.lines.map((line) => {
              if (!line.startsWith("0:O:")) return line;
              const prefixEnd = line.indexOf(":", 4) + 1;
              const payload = line.slice(prefixEnd, -1);

              return `${line.slice(0, prefixEnd)}${payload.slice(0, 4092)}`;
            });

            return Response.json({ ...body, lines: cut, truncated: false });
          }

          return Response.json(body);
        }

        return response;
      },
    }),
  );

  try {
    const result = await box.run("python3 -c 'import sys; sys.stdout.write(\"x\" * 4096)'");

    expect(truncatedLog).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.stdout.length).toBe(4096);
    expect(result.stdout).toBe("x".repeat(4096));
  } finally {
    await box.destroy();
  }
});

test("aborting during a stalled spool read kills the running command immediately", async () => {
  const controller = new AbortController();
  let stalledSpool = false;
  let spoolAborted = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/log")) {
          return Response.json({ lines: [], next_offset: 0, truncated: true });
        }

        if (
          !stalledSpool &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          String(init?.body ?? "").includes("/spool")
        ) {
          stalledSpool = true;

          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => {
              spoolAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            };

            if (init.signal?.aborted) onAbort();
            else init.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const marker = join(sandboxOf(box.id).root, "workspace", "after-cancel");

    const exec = box.run("sleep 0.6; : > after-cancel", { signal: controller.signal });

    const stream = (async () => {
      for await (const _ of exec) {
        // Consume streaming chunks so the adapter polls logs and enters readSpool().
      }
    })();

    const pending = exec.then((r) => r);

    await waitUntil(() => stalledSpool);
    controller.abort();

    const [result] = await Promise.all([pending, stream]);

    expect(spoolAborted).toBe(true);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });

    await delay(800);
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await box.destroy();
  }
});

test("a 140 KB staged command runs without hitting Linux's per-argument limit", async () => {
  const box = await createSandbox(provider());

  try {
    const padding = `# ${"a".repeat(145_000)}\n`;
    const result = await box.run(`${padding}printf 'ok:' && cat`, { stdin: "from-stdin" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok:from-stdin");
  } finally {
    await box.destroy();
  }
});

test("aborting while a launch response stalls immediately kills the accepted command by tag", async () => {
  const controller = new AbortController();
  let interceptedLaunch = false;
  let stalledLaunch = false;
  let launchAborted = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (
          !interceptedLaunch &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/execs")
        ) {
          interceptedLaunch = true;
          // Deliver the launch to the fake so the command starts, then hold the response.
          const delivered = await fetch(input, { ...init, signal: undefined });
          await delivered.body?.cancel();

          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => {
              launchAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            };

            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
            stalledLaunch = true;
          });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const marker = join(sandboxOf(box.id).root, "workspace", "after-stalled-launch");

    const pending = box
      .run("sleep 0.7; : > after-stalled-launch", { signal: controller.signal })
      .then((r) => r);

    await waitUntil(() => stalledLaunch);
    controller.abort();

    const result = await pending;

    expect(launchAborted).toBe(true);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });

    await delay(900);
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await box.destroy();
  }
});

test("command timeout cancels a stalled staging write instead of waiting 75 seconds", async () => {
  let stagingStalled = false;
  let stagingAborted = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (
          !stagingStalled &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          String(init?.body ?? "").includes("/stdin")
        ) {
          stagingStalled = true;

          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => {
              stagingAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            };

            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const started = performance.now();
    const result = await box.run("cat", { stdin: "hello", timeoutMs: 120 });
    const elapsedMs = performance.now() - started;

    expect(stagingStalled).toBe(true);
    expect(stagingAborted).toBe(true);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(elapsedMs).toBeLessThan(2000);
  } finally {
    await box.destroy();
  }
});

test("a 4096-byte apostrophe-heavy command is staged so the encoded launcher stays within 16 KiB", async () => {
  let maxAsyncCommandLen = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/execs")) {
          // SAFETY: our own adapter sends `{ command: string; runtime: string }` on POST /execs.
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
          const len = Buffer.byteLength(parsed.command ?? "");

          if (len > maxAsyncCommandLen) maxAsyncCommandLen = len;
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    // 4,096 bytes of comment containing apostrophes would expand past 16 KiB under POSIX single-quoting.
    const script = `# ${"'".repeat(4075)}\nprintf quoted-ok`;

    expect(Buffer.byteLength(script)).toBeLessThanOrEqual(4096);
    const result = await box.run(script);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("quoted-ok");
    expect(maxAsyncCommandLen).toBeLessThanOrEqual(16 * 1024);
  } finally {
    await box.destroy();
  }
});

test("aborting while launch history lookup stalls immediately kills the accepted command by tag", async () => {
  const controller = new AbortController();
  let mangledLaunch = false;
  let lookupStarted = false;
  let lookupAborted = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (
          !mangledLaunch &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/execs")
        ) {
          mangledLaunch = true;
          await fetch(input, init);

          return new Response("not-json{{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (
          mangledLaunch &&
          !lookupStarted &&
          (init?.method ?? "GET") === "GET" &&
          url.pathname.endsWith("/execs")
        ) {
          lookupStarted = true;

          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => {
              lookupAborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            };

            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const marker = join(sandboxOf(box.id).root, "workspace", "after-stalled-lookup");

    const pending = box
      .run("sleep 0.5; : > after-stalled-lookup", { signal: controller.signal })
      .then((r) => r);

    await waitUntil(() => lookupStarted);
    controller.abort();

    const result = await pending;

    expect(lookupAborted).toBe(true);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });

    await delay(700);
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await box.destroy();
  }
});

test("a late staging command cannot recreate private stdin after timeout cancellation", async () => {
  let heldStage: (() => Promise<Response>) | undefined;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (
          !heldStage &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          String(init?.body ?? "").includes("/stdin.part")
        ) {
          // Capture the server-side request to replay AFTER the client aborts and cancels staging.
          const capturedInit = { ...init, signal: undefined };

          heldStage = () => fetch(input, capturedInit);

          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException("Aborted", "AbortError"));

            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const result = await box.run("cat", { stdin: "secret-stdin-payload", timeoutMs: 120 });

    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(fake.execs.size).toBe(0);
    expect(heldStage).toBeDefined();

    // Now the late accepted staging command actually executes on the server.
    await heldStage?.();

    const root = join(sandboxOf(box.id).root, "tmp/.sandbox-sdk/exec");

    const files = (
      await Promise.all((await readdir(root)).map((dir) => readdir(join(root, dir))))
    ).flat();

    expect(files).not.toContain("stdin");
    expect(files).not.toContain("stdin.part");
  } finally {
    await box.destroy();
  }
});

test("a quote-heavy working directory with completed commands still stays within the 16 KiB launcher limit", async () => {
  let maxAsyncCommandLen = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/execs")) {
          // SAFETY: our own adapter sends `{ command: string; runtime: string }` on POST /execs.
          const parsed = JSON.parse(String(init?.body ?? "{}")) as { command?: string };
          const len = Buffer.byteLength(parsed.command ?? "");

          if (len > maxAsyncCommandLen) maxAsyncCommandLen = len;
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    // Accumulate finished command tags first.
    for (let i = 0; i < 12; i++) expect((await box.run("printf ok")).exitCode).toBe(0);

    // Build a valid nested directory under /workspace (< Linux PATH_MAX) whose POSIX-quoted
    // path plus completed-command IDs would exceed 16 KiB without dropping finished / staging meta.
    const segment = "'".repeat(204);
    const segments = Array.from({ length: 19 }, () => segment);
    const rel = segments.join("/");
    const hostDir = join(sandboxOf(box.id).root, "workspace", rel);

    await mkdir(hostDir, { recursive: true });

    const result = await box.run("printf meta-ok", { cwd: `/workspace/${rel}` });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("meta-ok");
    expect(maxAsyncCommandLen).toBeLessThanOrEqual(16 * 1024);
  } finally {
    await box.destroy();
  }
});

test("a transient 503 during staging cancellation retries and still blocks late private stdin writes", async () => {
  let heldStage: (() => Promise<Response>) | undefined;
  let injected503 = false;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);
        const body = String(init?.body ?? "");

        if (
          !heldStage &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          body.includes("/stdin.part")
        ) {
          const capturedInit = { ...init, signal: undefined };

          heldStage = () => fetch(input, capturedInit);

          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException("Aborted", "AbortError"));

            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        if (
          heldStage &&
          !injected503 &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          body.includes("/cancel")
        ) {
          injected503 = true;

          return Response.json(
            { errors: [{ message: "Temporary upstream failure" }] },
            { status: 503 },
          );
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const result = await box.run("cat", { stdin: "secret-after-503", timeoutMs: 120 });

    expect(injected503).toBe(true);
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
    expect(heldStage).toBeDefined();

    await heldStage?.();

    const root = join(sandboxOf(box.id).root, "tmp/.sandbox-sdk/exec");

    const files = (
      await Promise.all((await readdir(root)).map((dir) => readdir(join(root, dir))))
    ).flat();

    expect(files).not.toContain("stdin");
    expect(files).not.toContain("stdin.part");
  } finally {
    await box.destroy();
  }
});

test("a snapshot accepted with malformed 200 recovers past a stale listing or reports outcome_unknown with its name", async () => {
  let mangledPost = false;
  let staleLists = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (
          !mangledPost &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/snapshots")
        ) {
          mangledPost = true;
          // Deliver the snapshot save to the fake, then return a malformed 200 body.
          await fetch(input, init);

          return new Response("not-json{{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (
          mangledPost &&
          staleLists < 1 &&
          (init?.method ?? "GET") === "GET" &&
          url.pathname.endsWith("/snapshots")
        ) {
          staleLists++;

          return Response.json({ snapshots: [] });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const snap = await box.snapshot();

    expect(mangledPost).toBe(true);
    expect(staleLists).toBe(1);
    expect(snap.id).toBeTruthy();
  } finally {
    await box.destroy();
  }

  // If the listing never surfaces the snapshot, the error must be outcome_unknown and include the recovery name.
  const box2 = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/snapshots"))
          return new Response("not-json{{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          });

        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/snapshots"))
          return Response.json({ snapshots: [] });

        return fetch(input, init);
      },
    }),
  );

  try {
    await expect(box2.snapshot()).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringMatching(/sandbox-sdk-[0-9a-f-]{36}/),
    });
  } finally {
    await box2.destroy();
  }
}, 20_000);

test("abort arriving during failed staging cleanup throws outcome_unknown instead of timedOut", async () => {
  const controller = new AbortController();
  let failedStage = false;
  let cancelAttempts = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);
        const body = String(init?.body ?? "");

        if (
          !failedStage &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          body.includes("/stdin.part")
        ) {
          failedStage = true;

          return Response.json({ errors: [{ message: "Stage failed" }] }, { status: 400 });
        }

        if (
          failedStage &&
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          body.includes("/cancel")
        ) {
          cancelAttempts++;

          if (cancelAttempts === 1) controller.abort();

          return Response.json(
            { errors: [{ message: "Temporary upstream failure" }] },
            { status: 503 },
          );
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    await expect(
      box.run("cat", { stdin: "secret", signal: controller.signal }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(cancelAttempts).toBe(3);
  } finally {
    await box.destroy();
  }
});

test("a stalled snapshot recovery listing is bounded to the 10-second budget", async () => {
  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/snapshots"))
          return new Response("not-json{{{", {
            status: 200,
            headers: { "content-type": "application/json" },
          });

        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/snapshots")) {
          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException("Aborted", "AbortError"));

            if (init?.signal?.aborted) onAbort();
            else init?.signal?.addEventListener("abort", onAbort, { once: true });
          });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const started = performance.now();

    await expect(box.snapshot()).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringMatching(/sandbox-sdk-[0-9a-f-]{36}/),
    });

    const elapsedMs = performance.now() - started;

    expect(elapsedMs).toBeLessThan(12_000);
  } finally {
    await box.destroy();
  }
}, 20_000);

test("polling an accepted snapshot retries past a transient 404 and keeps the snapshot ID if polling fails", async () => {
  let pollMisses = 0;

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if (
          (init?.method ?? "GET") === "GET" &&
          /\/sandboxes\/[^/]+\/snapshots\/[^/]+$/.test(url.pathname) &&
          pollMisses < 1
        ) {
          pollMisses++;

          return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });
        }

        return fetch(input, init);
      },
    }),
  );

  try {
    const snap = await box.snapshot();

    expect(pollMisses).toBe(1);
    expect(snap.id).toBeTruthy();
  } finally {
    await box.destroy();
  }

  let acceptedId = "";

  const box2 = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "POST" && url.pathname.endsWith("/snapshots")) {
          const response = await fetch(input, init);
          // SAFETY: local fake POST /snapshots returns `{ id: string, status: string, ... }`.
          const body = (await response.json()) as { id: string };

          acceptedId = body.id;

          return Response.json(body);
        }

        if (
          (init?.method ?? "GET") === "GET" &&
          /\/sandboxes\/[^/]+\/snapshots\/[^/]+$/.test(url.pathname)
        )
          return Response.json({ errors: [{ message: "Resource not found" }] }, { status: 404 });

        return fetch(input, init);
      },
    }),
  );

  try {
    await expect(box2.snapshot()).rejects.toMatchObject({
      code: "outcome_unknown",
      message: expect.stringContaining(acceptedId),
    });
    expect(acceptedId).toBeTruthy();
  } finally {
    await box2.destroy();
  }
}, 20_000);

test("LineSplitter caps partial spool lines and rejects unbounded newline-free spool output", async () => {
  const splitter = new LineSplitter("sbx-cap");
  const chunk = new Uint8Array(2000).fill(97);

  expect(splitter.push(chunk)).toEqual([]);
  expect(splitter.push(chunk)).toEqual([]);
  expect(() => splitter.push(chunk)).toThrow(FrameError);
  expect(splitter.pending).toBe("");

  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/log"))
          return Response.json({ lines: [], next_offset: 0, truncated: true });

        return fetch(input, init);
      },
    }),
  );

  try {
    await expect(
      box.run(
        `python3 -c "import glob; p = glob.glob('/tmp/.sandbox-sdk/exec/*/spool')[0]; open(p, 'ab').write(b'A' * 32768)"`,
      ),
    ).rejects.toMatchObject({
      code: "provider",
      message: expect.stringContaining("output spool is malformed"),
    });
  } finally {
    await box.destroy();
  }
});

test("reapSandboxes with idleOnly reaps stopped Buddy sandboxes without guest probes and skips stopping ones", async () => {
  const guestProbes: string[] = [];

  const p = provider({
    fetch: async (input, init) => {
      const url = new URL(input);
      const match = /\/sandboxes\/([^/]+)\/execs?$/.exec(url.pathname);

      if (match && (init?.method ?? "GET") === "POST") guestProbes.push(match[1] ?? "");

      return fetch(input, init);
    },
  });

  const label = { suite: "buddy-idle-reap" };
  const stoppedBox = await createSandbox(p, { labels: label });
  const stoppingBox = await createSandbox(p, { labels: label });
  const runningBox = await createSandbox(p, { labels: label });

  try {
    await stoppedBox.pause();
    sandboxOf(stoppingBox.id).status = "STOPPING";
    guestProbes.length = 0;

    const reaped = await reapSandboxes(p, {
      labels: label,
      idleOnly: true,
      olderThanMs: 0,
    });

    expect(reaped).toBe(2);
    expect(guestProbes).not.toContain(stoppedBox.id);
    expect(guestProbes).not.toContain(stoppingBox.id);
    expect(fake.sandboxes.has(stoppedBox.id)).toBe(false);
    expect(fake.sandboxes.has(runningBox.id)).toBe(false);
    expect(fake.sandboxes.has(stoppingBox.id)).toBe(true);
  } finally {
    await stoppingBox.destroy().catch(() => {});
    await stoppedBox.destroy().catch(() => {});
    await runningBox.destroy().catch(() => {});
  }
});

test("custom PATH without sh, flock or mv still starts commands and preserves caller PATH", async () => {
  const box = await createSandbox(provider());

  try {
    const result = await box.run('printf "%s" "$PATH"', {
      env: { PATH: "/workspace/toolchain/bin" },
    });

    expect(result).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: "/workspace/toolchain/bin",
    });
  } finally {
    await box.destroy();
  }
});

test("destroyed sandboxes release their secrets and preview passwords from the provider redactor", async () => {
  let leakedText = "";
  let failReads = false;

  const p = provider({
    fetch: async (input, init) => {
      const url = new URL(input);

      if (
        failReads &&
        (init?.method ?? "GET") === "GET" &&
        /\/sandboxes\/[^/]+$/.test(url.pathname)
      )
        throw new TypeError(`echo ${leakedText}`);

      return fetch(input, init);
    },
  });

  const secretValue = "buddy-create-secret-unique-9911";
  const boxA = await createSandbox(p, { secrets: { MY_SECRET: secretValue } });
  const boxB = await createSandbox(p);

  try {
    const preview = await boxA.preview(3000);
    const authHeader = preview.headers?.Authorization ?? "";

    const password = Buffer.from(authHeader.slice("Basic ".length), "base64")
      .toString()
      .split(":")[1];

    expect(password).toBeTruthy();

    // While boxA is live, both its create-time secret and preview password are redacted on errors.
    leakedText = `${secretValue} ${password}`;
    failReads = true;
    const whileLive = await failure(p.connect(boxB.id));
    const liveDetail = `${whileLive?.message ?? ""} ${String(whileLive?.cause ?? "")}`;

    expect(whileLive).toBeInstanceOf(SandboxError);
    expect(liveDetail).not.toContain(secretValue);
    expect(liveDetail).not.toContain(password ?? "");

    // After boxA is destroyed, its credentials are released from the shared provider's redactor.
    failReads = false;
    await boxA.destroy();

    failReads = true;
    const afterDestroy = await failure(p.connect(boxB.id));
    const destroyedDetail = `${afterDestroy?.message ?? ""} ${String(afterDestroy?.cause ?? "")}`;

    expect(afterDestroy).toBeInstanceOf(SandboxError);
    expect(destroyedDetail).toContain(secretValue);
    expect(destroyedDetail).toContain(password ?? "");
  } finally {
    failReads = false;
    await boxA.destroy().catch(() => {});
    await boxB.destroy().catch(() => {});
  }
});

test("refused destroy keeps redaction active and reconnect re-arms persisted secrets", async () => {
  let refuseDelete = true;
  let leakedText = "";
  let failNative = false;

  const p = provider({
    fetch: async (input, init) => {
      const url = new URL(input);

      if (
        refuseDelete &&
        (init?.method ?? "GET") === "DELETE" &&
        /\/sandboxes\/[^/]+$/.test(url.pathname)
      )
        return Response.json({ errors: [{ message: "Forbidden" }] }, { status: 403 });

      if (failNative && (init?.method ?? "GET") === "GET" && url.pathname.endsWith("/execs"))
        throw new TypeError(`native boom ${leakedText}`);

      return fetch(input, init);
    },
  });

  const secretValue = "buddy-persisted-secret-7731";
  const box = await createSandbox(p, { secrets: { PERSISTED_SECRET: secretValue } });

  try {
    const preview = await box.preview(3000);
    const authHeader = preview.headers?.Authorization ?? "";

    const password = Buffer.from(authHeader.slice("Basic ".length), "base64")
      .toString()
      .split(":")[1];

    expect(password).toBeTruthy();
    leakedText = `${secretValue} ${password}`;

    // Refused DELETE leaves the sandbox live: native errors must still redact both secrets.
    await expect(box.destroy()).rejects.toBeInstanceOf(SandboxError);
    failNative = true;

    const afterRefusedDelete = await failure(
      p.native(box.id).request<void>("GET", "/sandboxes/{sandbox_id}/execs"),
    );

    const refusedDetail = `${afterRefusedDelete?.message ?? ""} ${String(afterRefusedDelete?.cause ?? "")}`;

    expect(afterRefusedDelete).toBeInstanceOf(SandboxError);
    expect(refusedDetail).not.toContain(secretValue);
    expect(refusedDetail).not.toContain(password ?? "");

    // Closing drops the handle, and reconnecting re-arms persisted secret redaction.
    failNative = false;
    await box.close();

    const reopened = await connectSandbox(p, box.id);

    try {
      // Recover persisted secrets and reattach preview credentials on the reopened handle.
      await reopened.run("true");
      await reopened.preview(3000);
      failNative = true;

      const afterReconnect = await failure(
        reopened.native.request<void>("GET", "/sandboxes/{sandbox_id}/execs"),
      );

      const reconnectDetail = `${afterReconnect?.message ?? ""} ${String(afterReconnect?.cause ?? "")}`;

      expect(afterReconnect).toBeInstanceOf(SandboxError);
      expect(reconnectDetail).not.toContain(secretValue);
      expect(reconnectDetail).not.toContain(password ?? "");
    } finally {
      failNative = false;
      await reopened.close();
    }
  } finally {
    failNative = false;
    refuseDelete = false;
    await p.destroy(box.id).catch(() => {});
  }
});

test("spool read 5xx kills the running command before rejecting", async () => {
  const box = await createSandbox(
    provider({
      fetch: async (input, init) => {
        const url = new URL(input);

        if ((init?.method ?? "GET") === "GET" && url.pathname.endsWith("/log"))
          return Response.json({ lines: [], next_offset: 0, truncated: true });

        if (
          (init?.method ?? "GET") === "POST" &&
          url.pathname.endsWith("/exec") &&
          String(init?.body ?? "").includes("/spool")
        )
          return Response.json({ errors: [{ message: "Internal error" }] }, { status: 500 });

        return fetch(input, init);
      },
    }),
  );

  try {
    const marker = join(sandboxOf(box.id).root, "workspace", "survived-spool-5xx");

    const exec = box.run("sleep 0.7; : > survived-spool-5xx");

    const stream = (async () => {
      for await (const _ of exec) {
        // Consume streaming chunks so the adapter polls logs and enters readSpool().
      }
    })();

    await expect(exec.then((r) => r)).rejects.toMatchObject({ code: "outcome_unknown" });
    await stream.catch(() => {});

    await delay(900);
    await expect(access(marker)).rejects.toThrow();
  } finally {
    await box.destroy();
  }
});

test("switching private preview to public and back reuses saved credentials cleanly", async () => {
  const privateProvider = provider({ public: false });
  const publicProvider = provider({ public: true });
  const box = await createSandbox(privateProvider);

  try {
    const first = await box.preview(3000);

    expect(first.headers?.Authorization).toMatch(/^Basic /);

    const pub = await publicProvider.previewUrl(box.id, 3000);

    expect(pub.headers).toBeUndefined();

    const freshPrivate = provider({ public: false });
    const restored = await freshPrivate.previewUrl(box.id, 3000);

    expect(restored.headers?.Authorization).toBe(first.headers?.Authorization);
  } finally {
    await box.destroy();
  }
});

test("files.readRange reads only the requested bytes without buffering the full download", async () => {
  const p = provider();
  const box = await createSandbox(p);

  try {
    await box.files.write("/workspace/ranged.txt", "0123456789abcdef");

    const slice = await p.files.readRange?.(box.id, "/workspace/ranged.txt", {
      offset: 4,
      length: 6,
    });

    expect(slice).toBeDefined();
    expect(Buffer.from(slice ?? new Uint8Array()).toString()).toBe("456789");
  } finally {
    await box.destroy();
  }
});
