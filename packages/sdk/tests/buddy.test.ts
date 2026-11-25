import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { connectSandbox, createSandbox, deleteSnapshot, SandboxError } from "../src/index.js";
import { keyedIdentifier, parseNote, preservedEndpoint } from "../src/providers/buddy/api.js";
import { FrameReader, stageCommands } from "../src/providers/buddy/exec.js";
import { buddy, type BuddyOptions } from "../src/providers/buddy/index.js";
import { guestPath, resourcesOf } from "../src/providers/buddy/provider.js";
import type { OutputChunk } from "../src/provider.js";
import { z } from "zod";
import { buddyFake, type BuddyFake } from "./buddy-fake.js";

let fake: BuddyFake;

beforeAll(async () => {
  fake = await buddyFake();
});

afterAll(async () => {
  await fake.close();
});

afterEach(() => {
  fake.rules.length = 0;
  fake.logLimit = undefined;
  fake.skipLogLine = undefined;
  fake.readyAfterMs = 30;
});

const provider = (options: BuddyOptions = {}) => buddy({ ...fake.options, ...options });

/** The JSON bodies the fake read, as far as these tests look at them. */
const sentBody = z.looseObject({
  identifier: z.string().optional(),
  note: z.string().optional(),
  os: z.string().optional(),
  tags: z.array(z.string()).optional(),
  timeout: z.number().optional(),
  snapshot_id: z.string().optional(),
  variables: z.array(z.looseObject({ key: z.string() })).optional(),
  endpoints: z
    .array(z.looseObject({ name: z.string(), http: z.looseObject({}).optional() }))
    .optional(),
});

const bodies = (method: string, path: RegExp) =>
  fake.requests.flatMap((r) =>
    r.method === method && path.test(r.path) ? [sentBody.parse(JSON.parse(r.body))] : [],
  );

/** Host processes whose command line holds `marker` (the fake runs commands on this machine). */
function alive(marker: string) {
  try {
    return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const recordedCommands = () => [...fake.execs.values()].map((e) => e.command).join("\n");

describe("Buddy create: ownership markers, keys, sizes", () => {
  test("a create sends its identifier, the SDK tag, a note with labels and secret names, and encrypted variables", async () => {
    const box = await createSandbox(provider(), {
      labels: { team: "a" },
      env: { PLAIN: "p" },
      secrets: { TOKEN: "s3cret-value" },
      idleTimeoutMs: 120_000,
    });

    try {
      const [sent] = bodies("POST", /\/sandboxes$/).slice(-1);

      expect(sent?.identifier).toMatch(/^sbx-a-[0-9a-f]{24}$/);
      expect(sent?.tags).toEqual(["sandbox-sdk"]);
      expect(sent?.timeout).toBe(120);
      expect(sent?.os).toBe("ubuntu:24.04");
      expect(sent?.variables).toEqual([
        { key: "PLAIN", value: "p", type: "VAR", encrypted: true },
        { key: "TOKEN", value: "s3cret-value", type: "VAR", encrypted: true },
      ]);

      const note = parseNote(sent?.note);

      expect(note).toMatchObject({
        labels: { team: "a", "sandbox-sdk": "1" },
        secrets: ["TOKEN"],
      });
      expect(box.labels).toEqual({ team: "a", "sandbox-sdk": "1" });
      expect((await box.run('echo "$PLAIN"')).stdout).toBe("p\n");
    } finally {
      await box.destroy();
    }
  });

  test("sizes map to Buddy's fixed tiers; anything else and a lifetime are refused before a create", async () => {
    expect(resourcesOf("small")).toBe("2x4");
    expect(resourcesOf("medium")).toBe("4x8");
    expect(resourcesOf("large")).toBe("8x16");
    expect(resourcesOf({ cpu: 4, memoryMb: 8192 })).toBe("4x8");
    expect(resourcesOf({ cpu: 3, memoryMb: 6000, diskGb: 50 })).toBe("3x6");
    expect(() => resourcesOf({ cpu: 2, memoryMb: 8192 })).toThrow(/2 GB of memory per vCPU/);
    expect(() => resourcesOf({ cpu: 13, memoryMb: 26624 })).toThrow(/1 to 12/);
    expect(() => resourcesOf({ cpu: 2, memoryMb: 4096, diskGb: 100 })).toThrow(/50 GB disk/);
    expect(() => resourcesOf({ cpu: 2, memoryMb: 4096, diskGb: 20 })).toThrow(/50 GB disk/);

    const before = fake.sandboxes.size;

    await expect(createSandbox(provider(), { timeoutMs: 60_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(
      createSandbox(provider(), { size: { cpu: 2, memoryMb: 1000 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(provider(), { network: "none" })).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(fake.sandboxes.size).toBe(before);
  });

  test("a key names one identifier per project", () => {
    expect(keyedIdentifier("k", undefined)).toMatch(/^sbx-k-[0-9a-f]{24}$/);
    expect(keyedIdentifier("k", undefined)).toBe(keyedIdentifier("k", undefined));
    expect(keyedIdentifier("k", "p1")).not.toBe(keyedIdentifier("k", "p2"));
    expect(keyedIdentifier("k", undefined)).not.toBe(keyedIdentifier("other", undefined));
  });

  test("a create that loses the key race throws, and the core attaches to the winner without owning it", async () => {
    const key = `race-${crypto.randomUUID()}`;
    const first = await createSandbox(provider(), { key });

    try {
      // The adapter alone: another call's sandbox holds the identifier, so this create is refused.
      await expect(
        provider().create({ key, labels: { "sandbox-sdk": "1" } }),
      ).rejects.toMatchObject({ code: "unavailable" });

      const [a, b] = await Promise.all([
        createSandbox(provider(), { key }),
        createSandbox(provider(), { key }),
      ]);

      expect([a.created, b.created]).toEqual([false, false]);
      expect(a.id).toBe(first.id);
      await a.destroy().catch(() => {});
    } finally {
      await first.destroy().catch(() => {});
    }

    const key2 = `race-${crypto.randomUUID()}`;

    const [a, b] = await Promise.all([
      createSandbox(provider(), { key: key2 }),
      createSandbox(provider(), { key: key2 }),
    ]);

    try {
      expect(a.id).toBe(b.id);
      expect([a.created, b.created].sort()).toEqual([false, true]);
      // The loser's `await using` closes, never destroys the winner's sandbox.
      await (a.created ? b : a)[Symbol.asyncDispose]();
      expect(fake.sandboxes.has(a.id)).toBe(true);
    } finally {
      await (a.created ? a : b).destroy();
    }
  });

  test("a lost create answer is reconciled by the identifier and this call's allocation marker", async () => {
    const before = fake.sandboxes.size;

    fake.rules.push({ method: "POST", path: /^\/sandboxes$/, fault: { kind: "lost" } });
    const box = await createSandbox(provider());

    try {
      expect(fake.sandboxes.size).toBe(before + 1);
      expect(fake.sandboxes.get(box.id)?.identifier).toMatch(/^sbx-a-/);
      expect((await box.run("echo ok")).stdout).toBe("ok\n");
    } finally {
      await box.destroy();
    }

    // An answer without the note is checked by a read, and still trusted only with the marker.
    fake.rules.push({ method: "POST", path: /^\/sandboxes$/, fault: { kind: "body", body: {} } });
    const second = await createSandbox(provider());

    await second.destroy();

    // A request lost before Buddy saw it leaves nothing to find: after reading the inventory for the
    // whole 30-second window, the outcome stays unknown.
    fake.rules.push({ method: "POST", path: /^\/sandboxes$/, fault: { kind: "dropped" } });
    await expect(createSandbox(provider())).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(fake.sandboxes.size).toBe(before);
  }, 60_000);

  test("a sandbox whose setup fails is deleted", async () => {
    const before = fake.sandboxes.size;

    fake.rules.push({
      method: "POST",
      path: /\/exec$/,
      fault: { kind: "status", status: 400, message: "Sandbox must be running" },
    });
    await expect(createSandbox(provider())).rejects.toBeInstanceOf(SandboxError);
    expect(fake.sandboxes.size).toBe(before);
  });

  test("find waits for a keyed sandbox another call is still starting, and deletes a failed one", async () => {
    const key = `find-${crypto.randomUUID()}`;
    const p = provider();

    fake.readyAfterMs = 400;
    const creating = createSandbox(provider(), { key });

    // Let the create reach Buddy, then find it while it starts.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const found = await p.find(key);

    expect(found).toMatchObject({ key, state: "running", labels: { "sandbox-sdk": "1" } });
    const box = await creating;

    expect(found?.id).toBe(box.id);
    await box.destroy();

    const failed = await createSandbox(provider(), { key });
    const sandbox = fake.sandboxes.get(failed.id);

    if (sandbox) sandbox.status = "FAILED";
    expect(await p.find(key)).toBeUndefined();
    expect(fake.sandboxes.has(failed.id)).toBe(false);
  });

  test("list returns only SDK sandboxes matching every label", async () => {
    const p = provider();
    const a = await createSandbox(p, { labels: { suite: "list", n: "1" } });
    const b = await createSandbox(p, { labels: { suite: "list", n: "2" } });

    // A sandbox made elsewhere, without the SDK's note, is never listed.
    const foreign = await fetch(`${fake.url}/workspaces/${fake.options.workspace}/sandboxes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${fake.options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "other", identifier: "sbx-a-foreign", os: "ubuntu:24.04" }),
    }).then(async (r) => z.object({ id: z.string() }).parse(await r.json()));

    try {
      expect((await p.list({ suite: "list" })).map((s) => s.id).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      expect((await p.list({ suite: "list", n: "2" })).map((s) => s.id)).toEqual([b.id]);
      expect((await p.connect(foreign.id)).labels).toEqual({});
    } finally {
      await Promise.all([a.destroy(), b.destroy(), p.destroy(foreign.id)]);
    }
  });
});

describe("Buddy exec: staging, framing, spool and cancellation", () => {
  test("env values, stdin and long commands never reach the recorded command", async () => {
    const box = await createSandbox(provider(), { secrets: { SECRET_ONE: "value-of-secret-1" } });

    try {
      const result = await box.run('printf "%s|%s|" "$SECRET_ONE" "$PER_RUN"; cat', {
        env: { PER_RUN: "per-run-value" },
        stdin: "stdin-value",
      });

      expect(result.stdout).toBe("[REDACTED]|per-run-value|stdin-value");
      const long = `: '${"y".repeat(6000)}'; echo long-marker-value`;

      expect((await box.run(long)).stdout).toBe("long-marker-value\n");

      const commands = recordedCommands();

      for (const hidden of [
        "value-of-secret-1",
        "per-run-value",
        "stdin-value",
        "long-marker-value",
      ])
        expect(commands).not.toContain(hidden);

      // Secret recovery reads the note and the environment over POST /exec, which Buddy never lists.
      const execs = fake.execs.size;
      const again = await connectSandbox(provider(), box.id);

      expect((await again.run('echo "$SECRET_ONE"')).stdout).toBe("[REDACTED]\n");
      expect(fake.execs.size).toBe(execs + 1);
      expect(recordedCommands()).not.toContain("value-of-secret-1");
    } finally {
      await box.destroy();
    }
  });

  test("output streams in order, split UTF-8 and missing newlines survive, exit codes are the command's", async () => {
    const box = await createSandbox(provider());

    try {
      const chunks: OutputChunk[] = [];

      for await (const chunk of box.run(
        "printf 'a\\r\\nb'; printf 'é' | head -c 1; printf 'é' | tail -c 1; echo err >&2; exit 3",
      ))
        chunks.push(chunk);

      expect(chunks.flatMap((c) => (c.stream === "stdout" ? [c.text] : [])).join("")).toBe(
        "a\r\nbé",
      );
      expect((await box.run("exit 42")).exitCode).toBe(42);
      expect((await box.run("kill -9 $$")).exitCode).toBe(137);
      expect((await box.run("true", { cwd: "/no/such/dir" })).exitCode).toBe(1);
    } finally {
      await box.destroy();
    }
  });

  test("a cut or gapped log is read from the spool from the first missing frame", async () => {
    const box = await createSandbox(provider());

    try {
      fake.logLimit = 2;
      const cut = await box.run("for i in $(seq 1 200); do echo line-$i; done");

      expect(cut.stdout.split("\n").filter(Boolean)).toHaveLength(200);
      expect(cut.stdout.endsWith("line-200\n")).toBe(true);
      fake.logLimit = undefined;

      fake.skipLogLine = 1;
      const gapped = await box.run("echo one; sleep 0.1; echo two; sleep 0.1; echo three");

      expect(gapped.stdout).toBe("one\ntwo\nthree\n");
      fake.skipLogLine = undefined;
    } finally {
      await box.destroy();
    }
  });

  test("a timeout or abort kills the whole process group before it settles", async () => {
    const box = await createSandbox(provider());
    const marker = `buddy-marker-${crypto.randomUUID()}`;

    try {
      const slow = await box.run(
        `python3 -c "import time; time.sleep(60)" ${marker} & python3 -c "import time; time.sleep(60)" ${marker}; echo late`,
        { timeoutMs: 800 },
      );

      expect(slow).toMatchObject({ timedOut: true, exitCode: null });
      expect(alive(marker)).toBe("");

      const partial = await box.run(`echo early; sleep 30 && echo ${marker}`, { timeoutMs: 800 });

      expect(partial.stdout).toBe("early\n");

      const controller = new AbortController();

      const reading = box.run(`cat >/dev/null; sleep 30 && echo ${marker}`, {
        stdin: "data",
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 300);
      expect(await reading).toMatchObject({ timedOut: true });
      expect(alive(marker)).toBe("");
    } finally {
      await box.destroy();
    }
  });

  test("a finished command's directory goes with the next launch, a cancelled one with its killer", async () => {
    const box = await createSandbox(provider());

    try {
      await box.run("true");
      const root = join(fake.sandboxes.get(box.id)?.root ?? "", "tmp/.sandbox-sdk/exec");
      const first = readdirSync(root);

      expect(first).toHaveLength(1);
      await box.run("true");
      const second = readdirSync(root);

      expect(second).toHaveLength(1);
      expect(second).not.toEqual(first);

      expect(await box.run("sleep 30", { timeoutMs: 1500 })).toMatchObject({ timedOut: true });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      await box.destroy();
    }
  });

  test("a cancel the guest cannot confirm is outcome_unknown", async () => {
    const box = await createSandbox(provider());

    try {
      await box.run("true");
      fake.rules.push({
        method: "POST",
        path: /\/exec$/,
        fault: { kind: "status", status: 400, message: "Sandbox must be running" },
        times: 4,
      });
      await expect(box.run("sleep 5", { timeoutMs: 300 })).rejects.toMatchObject({
        code: "outcome_unknown",
      });
    } finally {
      fake.rules.length = 0;
      await box.destroy();
    }
  });

  test("a lost start is found by its tag; one Buddy's history misses is stopped and stays unknown", async () => {
    const box = await createSandbox(provider());

    try {
      await box.run("true");
      fake.rules.push({ method: "POST", path: /\/execs$/, fault: { kind: "lost" } });
      expect((await box.run("echo found-it")).stdout).toBe("found-it\n");

      // A miss in the history does not prove nothing ran, so the call is never called safe to retry. The
      // cancel marker still stops a late start.
      fake.rules.push({ method: "POST", path: /\/execs$/, fault: { kind: "dropped" } });
      await expect(box.run("touch /workspace/never-ran")).rejects.toMatchObject({
        code: "outcome_unknown",
        retryable: false,
      });
      expect((await box.run("test -e /workspace/never-ran; echo $?")).stdout).toBe("1\n");
    } finally {
      await box.destroy();
    }
  });

  test("a 409 is a refusal before anything ran: sent again", async () => {
    const box = await createSandbox(provider());

    try {
      fake.rules.push({
        method: "POST",
        path: /\/execs$/,
        fault: { kind: "status", status: 409, message: "Another execution is running" },
        times: 2,
      });
      expect((await box.run("echo after-409")).stdout).toBe("after-409\n");
    } finally {
      await box.destroy();
    }
  });

  test("a bridge or env file the guest lost is put back, and the command runs once", async () => {
    const box = await createSandbox(provider());

    try {
      await box.run("true");
      const root = fake.sandboxes.get(box.id)?.root ?? "";

      rmSync(join(root, "tmp/.sandbox-sdk/bin"), { recursive: true, force: true });
      rmSync(join(root, "tmp/.sandbox-sdk/env"), { recursive: true, force: true });
      expect(
        (
          await box.run(
            "echo $(( $(cat /workspace/n 2>/dev/null || echo 0) + 1 )) > /workspace/n; cat /workspace/n",
          )
        ).stdout,
      ).toBe("1\n");
    } finally {
      await box.destroy();
    }
  });

  test("an execution cancelled outside this client is a provider error, and its group is killed", async () => {
    const box = await createSandbox(provider());
    const marker = `buddy-outside-${crypto.randomUUID()}`;

    try {
      // A run is lazy: catching it starts it.
      const running = box.run(`sleep 30 && echo ${marker}`).catch((cause: unknown) => cause);

      await expect.poll(() => alive(marker), { timeout: 5000 }).not.toBe("");

      const exec = [...fake.execs.values()].find(
        (e) => e.sandboxId === box.id && e.status === "INPROGRESS",
      );

      await fetch(
        `${fake.url}/workspaces/${fake.options.workspace}/sandboxes/${box.id}/execs/${exec?.id}`,
        { method: "DELETE", headers: { authorization: `Bearer ${fake.options.token}` } },
      );
      expect(await running).toMatchObject({ code: "provider" });
      expect(alive(marker)).toBe("");
    } finally {
      await box.destroy();
    }
  });

  test("the frame reader skips seen frames, reports gaps, and refuses a broken spool", () => {
    const chunks: OutputChunk[] = [];
    const reader = new FrameReader((c) => chunks.push(c), "sb");
    const b64 = (text: string) => Buffer.from(text).toString("base64");

    const frame = (seq: number, kind: "O" | "E" | "X", payload: string) =>
      `${seq}:${kind}:${payload.length}:${payload}.`;

    expect(reader.line("SANDBOX_SDK_NO_BRIDGE", "log")).toBe("ok");
    expect(reader.preface).toEqual(["SANDBOX_SDK_NO_BRIDGE"]);
    expect(reader.line(frame(0, "O", b64("a")), "log")).toBe("ok");
    expect(reader.line(frame(0, "O", b64("a")), "spool")).toBe("ok");
    expect(reader.line(frame(2, "O", b64("c")), "log")).toBe("gap");
    expect(reader.line(frame(1, "O", b64("b")), "spool")).toBe("ok");
    expect(reader.line("1:O:2:!!.", "log")).toBe("ok");
    expect(reader.line("buddy says hi", "log")).toBe("ok");
    expect(() => reader.line(frame(5, "O", b64("x")), "spool")).toThrow(/malformed/);
    expect(reader.line(frame(2, "X", "7"), "spool")).toBe("ok");
    expect(reader.exitCode).toBe(7);
    expect(chunks.map((c) => c.text).join("")).toBe("ab");
  });

  test("staging splits large files into chunks that fit POST /exec", () => {
    const commands = stageCommands(":", [
      { path: "/tmp/.sandbox-sdk/exec/t/stdin", bytes: new Uint8Array(200_000).fill(65) },
    ]);

    expect(commands.length).toBeGreaterThan(4);

    for (const command of commands) expect(command.length).toBeLessThan(45 * 1024);
    expect(commands.at(-1)).toContain("mv -f");
  });
});

describe("Buddy files", () => {
  test("downloads are checked by content type and Buddy's message, and paths are encoded", async () => {
    const box = await createSandbox(provider());

    try {
      const odd = "dir with space/ünï #?%.txt";

      await box.files.write(odd, "odd\n");
      expect(await box.files.read(odd)).toBe("odd\n");
      expect((await box.files.list("dir with space")).map((f) => f.path)).toEqual([
        `/workspace/${odd}`,
      ]);
      await expect(box.files.read("dir with space")).rejects.toMatchObject({
        code: "invalid_argument",
      });
      await expect(box.files.read("missing.txt")).rejects.toMatchObject({
        code: "file_not_found",
      });

      fake.rules.push({
        method: "GET",
        path: /\/download\//,
        fault: { kind: "status", status: 404, message: "Something else" },
      });
      await expect(box.files.read("missing.txt")).rejects.toMatchObject({ code: "provider" });
      fake.rules.push({
        method: "GET",
        path: /\/download\//,
        fault: { kind: "status", status: 404, message: "Sandbox not found" },
      });
      await expect(box.files.read("missing.txt")).rejects.toMatchObject({ code: "not_found" });

      expect(guestPath("a/b c")).toBe("workspace/a/b%20c");
      expect(guestPath("/etc/../tmp/x")).toBe("tmp/x");
      expect(() => guestPath("a\0b")).toThrow(/NUL/);
    } finally {
      await box.destroy();
    }
  });
});

describe("Buddy previews", () => {
  test("a private preview uses Basic auth, keeps other endpoints, reattaches without a change", async () => {
    const box = await createSandbox(provider());

    try {
      const first = await box.preview(3000);
      const auth = first.headers?.Authorization ?? "";
      const password = Buffer.from(auth.slice("Basic ".length), "base64").toString().split(":")[1];

      expect(auth).toMatch(/^Basic /);
      expect(fake.sandboxes.get(box.id)?.endpoints[0]).toMatchObject({
        name: "sbx-p3000",
        http: { auth_type: "BASIC", login: "sbx" },
        password,
      });

      const second = await box.preview(3001);

      expect(second.headers?.Authorization).not.toBe(auth);
      // The PATCH that added 3001 sent 3000 back without its password, which keeps it.
      const [patch] = bodies("PATCH", new RegExp(`/sandboxes/${box.id}$`)).slice(-1);
      const kept = patch?.endpoints?.find((e) => e.name === "sbx-p3000");

      expect(kept?.http).not.toHaveProperty("password");
      expect(
        fake.sandboxes.get(box.id)?.endpoints.find((e) => e.name === "sbx-p3000"),
      ).toMatchObject({
        password,
        broken: undefined,
      });

      const patches = bodies("PATCH", /./).length;
      const again = await (await connectSandbox(provider(), box.id)).preview(3000);

      expect(again.headers).toEqual(first.headers);
      expect(bodies("PATCH", /./).length).toBe(patches);

      const open = await (await connectSandbox(provider({ public: true }), box.id)).preview(3002);

      expect(open.headers).toBeUndefined();
      expect(fake.sandboxes.get(box.id)?.endpoints.map((e) => e.name)).toEqual([
        "sbx-p3000",
        "sbx-p3001",
        "sbx-p3002",
      ]);

      // A failed change never shows the password it was setting.
      fake.rules.push({
        method: "PATCH",
        path: /./,
        fault: { kind: "status", status: 400, message: "bad password" },
      });

      const error = await (
        await connectSandbox(provider(), box.id)
      )
        .preview(3003)
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(SandboxError);
    } finally {
      await box.destroy();
    }
  });

  test("an endpoint with custom TLS is never rewritten; an ambiguous new endpoint is checked by a read", async () => {
    expect(
      preservedEndpoint({ name: "x", endpoint: "1", type: "TLS", tls: { terminate_at: "AGENT" } }),
    ).toBeUndefined();
    expect(
      preservedEndpoint({
        name: "x",
        endpoint: "1",
        type: "HTTP",
        http: { auth_type: "BASIC", login: "u", tls_ca: "-----BEGIN" },
      }),
    ).toBeUndefined();
    expect(
      preservedEndpoint({
        name: "x",
        endpoint: "1",
        type: "HTTP",
        endpoint_url: "https://x",
        http: { auth_type: "BASIC", login: "u", password: "!encrypted abc" },
      }),
    ).toEqual({ name: "x", endpoint: "1", type: "HTTP", http: { auth_type: "BASIC", login: "u" } });

    const box = await createSandbox(provider());

    try {
      fake.rules.push({ method: "PATCH", path: /./, fault: { kind: "lost" } });
      const preview = await box.preview(4000);

      expect(preview.headers?.Authorization).toMatch(/^Basic /);

      const sandbox = fake.sandboxes.get(box.id);

      sandbox?.endpoints.push({
        name: "custom",
        endpoint: "443",
        type: "TLS",
        region: "US",
        timeout: 30,
        http: {},
        extra: { tls: { terminate_at: "AGENT" } },
      });
      const patches = bodies("PATCH", /./).length;

      await expect(box.preview(4001)).rejects.toMatchObject({ code: "provider" });
      expect(bodies("PATCH", /./).length).toBe(patches);
    } finally {
      await box.destroy();
    }
  });
});

describe("Buddy lifecycle", () => {
  test("pause, resume, snapshot, restore with markers, delete snapshot", async () => {
    const p = provider();
    const box = await createSandbox(p, { labels: { team: "snap" } });

    try {
      await box.files.write("state.txt", "kept\n");
      await box.pause();
      await box.pause();
      expect((await p.connect(box.id)).state).toBe("paused");
      await box.resume();
      expect(await box.files.read("state.txt")).toBe("kept\n");

      await expect(box.snapshot({ expiresInMs: 1000 })).rejects.toMatchObject({
        code: "unsupported",
      });
      const { id } = await box.snapshot();
      const restored = await createSandbox(p, { from: id, labels: { team: "restored" } });

      try {
        const [sent] = bodies("POST", /\/sandboxes$/).slice(-1);

        expect(sent).toMatchObject({ snapshot_id: id, tags: ["sandbox-sdk"] });
        expect(sent).not.toHaveProperty("os");
        expect(parseNote(sent?.note)?.labels).toMatchObject({
          team: "restored",
          "sandbox-sdk": "1",
        });
        expect((await p.connect(restored.id)).labels).toMatchObject({
          team: "restored",
          "sandbox-sdk": "1",
        });
        expect(await restored.files.read("state.txt")).toBe("kept\n");
      } finally {
        await restored.destroy();
      }

      expect(await deleteSnapshot(p, id)).toBe(true);
      expect(await deleteSnapshot(p, id)).toBe(false);
    } finally {
      await box.destroy();
    }

    await expect(p.connect(box.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(p.destroy(box.id)).resolves.toBeUndefined();
  });

  test("errors never show the token or Buddy's encrypted values", async () => {
    const p = provider();
    const box = await createSandbox(p);

    try {
      fake.rules.push({
        method: "GET",
        path: /./,
        fault: {
          kind: "status",
          status: 400,
          message: `bad ${fake.options.token} !encrypted c2VjcmV0LXZhbHVl==`,
        },
      });

      const error = await box.native
        .request("GET", "/sandboxes/{sandbox_id}")
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(SandboxError);
      expect(String(error)).not.toContain(fake.options.token);
      expect(String(error)).not.toContain("c2VjcmV0LXZhbHVl");
    } finally {
      await box.destroy();
    }

    await expect(buddy({ ...fake.options, token: "" }).list({})).rejects.toMatchObject({
      code: "auth",
    });
    expect(existsSync("/tmp/.sandbox-sdk/exec/never")).toBe(false);
  });
});
