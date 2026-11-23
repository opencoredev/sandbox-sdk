import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, test } from "vitest";
import { createSandbox, listSandboxes, reapSandboxes } from "../src/index.js";
import { archilError } from "../src/providers/archil/errors.js";
import {
  execute,
  type ArchilProcess,
  type ArchilProcessResult,
} from "../src/providers/archil/execute.js";
import { createArchilProvider } from "../src/providers/archil/provider.js";
import type { ExecInput } from "../src/provider.js";
import { runConformance } from "../src/testing.js";
import { addForeign, archilState, fakeDisk } from "./archil-mock.js";

const provider = () => createArchilProvider({ apiKey: "test-key" }, async () => fakeDisk);

// The fake's preview hostnames serve nothing; the live suite probes real ones.
runConformance(provider, { live: true, unsupported: { httpProbe: "mock previews do not serve" } });

function input(extra: Partial<ExecInput> = {}): ExecInput & { chunks: string[] } {
  const chunks: string[] = [];

  return {
    command: "true",
    cwd: "/workspace",
    env: {},
    timeoutMs: 30_000,
    onChunk: (chunk) => chunks.push(`${chunk.stream}:${chunk.text}`),
    chunks,
    ...extra,
  };
}

/** A process that ends when told to, recording kills. */
function scripted(
  options: { killConfirms?: boolean; result?: ArchilProcessResult; cursor?: number } = {},
) {
  let finish: (result: ArchilProcessResult) => void = () => {};
  const ended = new Promise<ArchilProcessResult>((resolve) => (finish = resolve));
  const inputs: Uint8Array[] = [];
  const calls = { kills: 0, inputs, closed: false };

  const process: ArchilProcess = {
    sendInput: async (data) => {
      calls.inputs.push(new Uint8Array(Buffer.from(data)));
    },
    closeStdin: async () => {
      calls.closed = true;
    },
    resize: async () => {},
    wait: () => ended,
    kill: async () => {
      calls.kills++;

      if (options.killConfirms !== false) finish({ status: "cancelled" });
    },
    disconnect: async () => {},
    cursor: options.cursor ?? 0,
  };

  if (options.result) finish(options.result);

  return { process, calls, finish };
}

describe("Archil exec", () => {
  test("a missing working directory is exit 1, as in a shell", async () => {
    const box = await createSandbox(provider());

    try {
      const result = await box.run("pwd", { cwd: "/nope" });
      expect(result).toMatchObject({ exitCode: 1, ok: false });
    } finally {
      await box.destroy();
    }
  });

  test("a timeout kills the command and waits for Archil to confirm", async () => {
    const { process, calls } = scripted();

    const result = await execute({
      runner: { run: async () => process },
      sandboxId: "box",
      input: input({ timeoutMs: 20 }),
    });

    expect(result).toEqual({ exitCode: null, timedOut: true });
    expect(calls.kills).toBe(1);
  });

  test("an unconfirmed kill is outcome_unknown", { timeout: 20_000 }, async () => {
    const { process } = scripted({ killConfirms: false });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    await expect(
      execute({
        runner: { run: async () => process },
        sandboxId: "box",
        input: input({ signal: controller.signal }),
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  test("a process connection that fails without an HTTP answer is outcome_unknown", async () => {
    await expect(
      execute({
        runner: {
          run: async () => {
            throw new Error("socket hang up");
          },
        },
        sandboxId: "box",
        input: input(),
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  test("stdin over a megabyte goes in pieces and is then closed", async () => {
    const { process, calls } = scripted({ result: { status: "completed", exitCode: 0 } });

    await execute({
      runner: { run: async () => process },
      sandboxId: "box",
      input: input({ stdin: "x".repeat(2_500_000) }),
    });

    expect(calls.inputs.map((piece) => piece.length)).toEqual([1_048_576, 1_048_576, 402_848]);
    expect(calls.closed).toBe(true);
  });

  test("a command cancelled by someone else is a provider failure, not an exit code", async () => {
    const { process } = scripted({ result: { status: "cancelled" } });

    await expect(
      execute({ runner: { run: async () => process }, sandboxId: "box", input: input() }),
    ).rejects.toMatchObject({ code: "provider" });
  });
});

describe("Archil exec deadlines", () => {
  test("a start still unanswered at the deadline is stopped once it lands", async () => {
    const { process, calls } = scripted();

    const result = await execute({
      runner: {
        run: () => new Promise((resolve) => setTimeout(() => resolve(process), 60)),
      },
      sandboxId: "box",
      input: input({ timeoutMs: 10 }),
    });

    expect(result).toEqual({ exitCode: null, timedOut: true });
    expect(calls.kills).toBe(1);
  });

  test(
    "a start that lands after the kill window is still stopped",
    { timeout: 30_000 },
    async () => {
      const { process, calls } = scripted();

      await expect(
        execute({
          runner: {
            run: () => new Promise((resolve) => setTimeout(() => resolve(process), 11_000)),
          },
          sandboxId: "box",
          input: input({ timeoutMs: 10 }),
        }),
      ).rejects.toMatchObject({ code: "outcome_unknown" });

      await expect.poll(() => calls.kills, { timeout: 5000 }).toBe(1);
    },
  );

  test(
    "a start that never lands is outcome_unknown, not a timeout",
    { timeout: 20_000 },
    async () => {
      await expect(
        execute({
          runner: { run: () => new Promise(() => {}) },
          sandboxId: "box",
          input: input({ timeoutMs: 10 }),
        }),
      ).rejects.toMatchObject({ code: "outcome_unknown" });
    },
  );
});

describe("Archil output gaps", () => {
  test("output missing after the last message is marked from the final cursor", async () => {
    const { process } = scripted({ result: { status: "completed", exitCode: 0 }, cursor: 10 });
    const run = input();

    await execute({ runner: { run: async () => process }, sandboxId: "box", input: run });

    expect(run.chunks.join("")).toContain("skipped the last 10 bytes");
  });

  test("a command whose output Archil skipped says so where the bytes went missing", async () => {
    const box = await createSandbox(provider());

    try {
      archilState.dropOutputAbove = 64 * 1024;
      const result = await box.run("head -c 1000000 /dev/zero | tr '\\0' y");
      expect(result.stdout).toContain("Archil's output stream skipped");
    } finally {
      archilState.dropOutputAbove = undefined;
      await box.destroy();
    }
  });

  test("a range read that lost bytes falls back to the paced download", async () => {
    const p = provider();
    const box = await createSandbox(p);

    try {
      const bytes = new Uint8Array(2_000_000).map((_, i) => i % 251);
      await box.files.write("big.bin", bytes);
      archilState.dropOutputAbove = 64 * 1024;

      const range = await p.files.readRange?.(box.id, "/workspace/big.bin", {
        offset: 10,
        length: 1_500_000,
      });

      expect(range).toEqual(bytes.subarray(10, 1_500_010));
    } finally {
      archilState.dropOutputAbove = undefined;
      await box.destroy();
    }
  });
});

describe("Archil errors", () => {
  const apiError = (status: number, code: string, message = "secret /workspace/path") =>
    Object.assign(new Error(message), { name: "ArchilApiError", status, code });

  test("keeps the status and Archil's code, never the message", () => {
    const error = archilError(apiError(409, "sandbox_name_conflict"));
    expect(error.code).toBe("provider");
    expect(String(error.cause)).toContain("HTTP 409 sandbox_name_conflict");
    expect(error.message).not.toContain("secret");
  });

  test("a feature the plan lacks is unsupported", () => {
    expect(archilError(apiError(403, "sandbox_network_plan_required")).code).toBe("unsupported");
  });

  test("a plan's sandbox cap is an account limit (quota), even on 403", () => {
    expect(archilError(apiError(403, "sandbox_limit_exceeded")).code).toBe("quota");
    expect(archilError(apiError(403, "concurrent_sandbox_quota")).code).toBe("quota");
    expect(archilError(apiError(429, "sandbox_limit_reached")).code).toBe("quota");
    // A 403 without a limit code is still a key problem, and a 400 keeps its meaning.
    expect(archilError(apiError(403, "forbidden")).code).toBe("auth");
    expect(archilError(apiError(400, "memory_limit_out_of_range")).code).toBe("invalid_argument");
  });

  test("statuses map to the shared codes", () => {
    expect(archilError(apiError(401, "unauthorized")).code).toBe("auth");
    expect(archilError(apiError(429, "rate_limited")).code).toBe("quota");
    expect(archilError(apiError(404, "not_found")).code).toBe("not_found");
    expect(archilError(new TypeError("fetch failed")).code).toBe("unavailable");
  });
});

describe("Archil create", () => {
  test("size presets and exact sizes map to vCPUs and MiB; disk size is unsupported", async () => {
    const p = provider();
    const box = await createSandbox(p, { size: "medium" });
    await box.destroy();
    expect(archilState.creates.at(-1)).toMatchObject({ vcpuCount: 2, memSizeMiB: 4096 });

    await expect(
      createSandbox(p, { size: { cpu: 1, memoryMb: 1024, diskGb: 10 } }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(createSandbox(p, { size: { cpu: 64, memoryMb: 1024 } })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("network policies map to egress rules", async () => {
    const box = await createSandbox(provider(), { network: { allow: ["registry.npmjs.org"] } });
    await box.destroy();
    expect(archilState.creates.at(-1)).toMatchObject({
      network: { egress: { default: "deny", allow: ["registry.npmjs.org"] } },
    });
  });

  test("lifetimes outside 60 s to 24 h are refused, not rounded", async () => {
    await expect(createSandbox(provider(), { timeoutMs: 10_000 })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("snapshot restore is refused", async () => {
    await expect(provider().create({ from: "snap", labels: {} })).rejects.toMatchObject({
      code: "unsupported",
    });
  });

  test("a create whose answer is lost is recovered by its unique name", async () => {
    archilState.dropNextCreateAnswer = true;
    const box = await createSandbox(provider(), { labels: { lost: "answer" } });

    try {
      expect(box.id).toBeTruthy();
      expect((await box.run("echo ok")).stdout).toBe("ok\n");
    } finally {
      await box.destroy();
    }
  });

  test("a paused sandbox wakes on its next command", async () => {
    const box = await createSandbox(provider());

    try {
      await archilState.sandboxes.get(box.id)?.pause();
      expect((await box.run("echo awake")).stdout).toBe("awake\n");
    } finally {
      await box.destroy();
    }
  });

  test("reaping never touches a paused sandbox whose name only resembles the SDK's", async () => {
    const p = provider();
    const foreign = await addForeign("sbxsdk-native-test", "paused");

    try {
      await reapSandboxes(p, { olderThanMs: 0 });
      expect(archilState.sandboxes.has(foreign.id)).toBe(true);
    } finally {
      archilState.sandboxes.delete(foreign.id);
      await foreign.guest.destroy();
    }
  });

  test("a 5xx create answer is outcome_unknown, never a refusal", async () => {
    archilState.refuseNextCreate = 503;
    await expect(createSandbox(provider())).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  test("a sandbox that fails after allocation is deleted, not leaked", async () => {
    archilState.settleTo = "failed";
    const before = archilState.sandboxes.size;

    try {
      await expect(createSandbox(provider())).rejects.toMatchObject({ code: "provider" });
      expect(archilState.sandboxes.size).toBe(before);
    } finally {
      archilState.settleTo = undefined;
    }
  });

  test("a keyed lookup during setup waits for the creator's marker", async () => {
    const key = `race-${crypto.randomUUID()}`;

    // Two clients race for one key; either may win the name. The other must wait for the winner's
    // setup and see its labels, never a half-made sandbox.
    const [a, b] = await Promise.all([
      createSandbox(provider(), { key, labels: { who: "a" } }),
      createSandbox(provider(), { key, labels: { who: "b" } }),
    ]);

    try {
      expect(b.id).toBe(a.id);
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
      const winner = a.created ? "a" : "b";
      expect(a.labels).toMatchObject({ who: winner });
      expect(b.labels).toMatchObject({ who: winner });
    } finally {
      await a.destroy();
    }
  });

  test("a second keyed client redacts the creator's secrets", async () => {
    const key = `secret-${crypto.randomUUID()}`;
    const secret = `s3cr3t-${crypto.randomUUID()}`;

    const [a, b] = await Promise.all([
      createSandbox(provider(), { key, secrets: { SMOKE_TOKEN: secret } }),
      createSandbox(provider(), { key, secrets: { SMOKE_TOKEN: secret } }),
    ]);

    try {
      const other = a.created ? b : a;
      // A third client passes no secrets: it can only learn them from the record setup wrote.
      const third = await createSandbox(provider(), { key });
      expect((await other.run('printf %s "$SMOKE_TOKEN"')).stdout).not.toContain(secret);
      expect((await third.run('printf %s "$SMOKE_TOKEN"')).stdout).not.toContain(secret);
    } finally {
      await a.destroy();
    }
  });

  test("the secret names are recorded before the marker that makes a sandbox findable", async () => {
    const p = provider();

    const info = await p.create({
      labels: {},
      secretNames: ["SMOKE_TOKEN"],
      env: { SMOKE_TOKEN: "x" },
    });

    try {
      const box = archilState.sandboxes.get(info.id);

      if (!box) throw new Error("fake sandbox missing");

      const record = await readFile(
        box.guest.rewrite("/tmp/.sandbox-sdk/secret-names.json"),
        "utf8",
      );

      expect(JSON.parse(record)).toEqual(["SMOKE_TOKEN"]);
    } finally {
      await p.destroy(info.id);
    }
  });

  test("a keyed name whose marker holds another key is not this key's sandbox", async () => {
    const key = `foreign-${crypto.randomUUID()}`;
    const name = `sbxsdk-k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const box = await addForeign(name, "paused");
    const marker = box.guest.rewrite("/var/lib/sandbox-sdk/metadata.json");
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ key: "someone-else", labels: {} }));

    try {
      expect(await provider().find(key)).toBeUndefined();
    } finally {
      archilState.sandboxes.delete(box.id);
      await box.guest.destroy();
    }
  });

  test("a keyed create whose lost answer finds a failed boot keeps it and names it", async () => {
    const key = `failed-${crypto.randomUUID()}`;
    archilState.dropNextCreateAnswer = true;
    archilState.settleTo = "failed";
    const before = archilState.sandboxes.size;

    try {
      // Its attempt ID can't be read from a guest that never ran, so it may be another client's.
      await expect(createSandbox(provider(), { key })).rejects.toBeInstanceOf(Error);
      expect(archilState.sandboxes.size).toBe(before + 1);
    } finally {
      archilState.settleTo = undefined;

      for (const [id, box] of archilState.sandboxes)
        if (box.status === "failed") {
          archilState.sandboxes.delete(id);
          await box.guest.destroy();
        }
    }
  });

  test("a keyed sandbox woken by a lookup and found foreign is put back to sleep", async () => {
    const key = `asleep-${crypto.randomUUID()}`;
    const name = `sbxsdk-k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const box = await addForeign(name, "paused");
    const marker = box.guest.rewrite("/var/lib/sandbox-sdk/metadata.json");
    await mkdir(dirname(marker), { recursive: true });
    await writeFile(marker, JSON.stringify({ key: "someone-else", labels: {} }));

    try {
      expect(await provider().find(key)).toBeUndefined();
      expect(box.status).toBe("paused");
    } finally {
      archilState.sandboxes.delete(box.id);
      await box.guest.destroy();
    }
  });

  test("secret recovery refuses a read whose output skipped bytes, and retries", async () => {
    const p = provider();

    const info = await p.create({
      labels: {},
      secretNames: ["SMOKE_TOKEN"],
      env: { SMOKE_TOKEN: "v" },
    });

    try {
      archilState.dropOutputAbove = 0;
      const found = await p.readSecretEnvironment?.(info.id);

      expect(found?.record).toBe('["SMOKE_TOKEN"]');
      expect(found?.environment.SMOKE_TOKEN).toBe("v");
    } finally {
      archilState.dropOutputAbove = undefined;
      await p.destroy(info.id);
    }
  });

  test("idle-only reaping leaves a sandbox that went to sleep after listing alone", async () => {
    const p = provider();
    const box = await createSandbox(p, { labels: { group: "sleeps-late" } });
    const list = p.list.bind(p);

    p.list = async (labels) => {
      const found = await list(labels);
      await archilState.sandboxes.get(box.id)?.pause();

      return found;
    };

    try {
      expect(
        await reapSandboxes(p, {
          labels: { group: "sleeps-late" },
          idleOnly: true,
          olderThanMs: 0,
        }),
      ).toBe(0);
      expect(archilState.sandboxes.get(box.id)?.status).toBe("paused");
    } finally {
      await box.destroy();
    }
  });

  test("closing a handle detaches its terminals", async () => {
    const p = provider();
    const box = await createSandbox(p, { key: `term-${crypto.randomUUID()}` });
    const id = box.id;

    if (!("terminal" in box)) throw new Error("terminal capability missing");
    const terminal = await box.terminal({ cols: 80, rows: 24 });
    let seen = "";
    terminal.onData((data) => (seen += data));
    await terminal.write("while true; do echo tick; sleep 0.05; done\n");
    await expect.poll(() => seen, { timeout: 5000 }).toContain("tick");
    await box.close();
    const before = seen;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toBe(before);
    await p.destroy(id);
  });

  test("reopening a paused keyed sandbox keeps its key and labels", async () => {
    const p = provider();
    const key = `reopen-${crypto.randomUUID()}`;
    const first = await createSandbox(p, { key, labels: { team: "a" } });

    try {
      await first.close();
      await archilState.sandboxes.get(first.id)?.pause();
      const again = await createSandbox(p, { key });

      expect(again.id).toBe(first.id);
      expect(again.created).toBe(false);
      expect(again.key).toBe(key);
      expect(again.labels).toMatchObject({ team: "a" });
    } finally {
      await first.destroy();
    }
  });

  test("a keyed lookup of a sandbox still pending waits for its marker", async () => {
    const key = `pending-${crypto.randomUUID()}`;
    const name = `sbxsdk-k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const box = await addForeign(name, "pending");

    setTimeout(async () => {
      const marker = box.guest.rewrite("/var/lib/sandbox-sdk/metadata.json");
      await mkdir(dirname(marker), { recursive: true });
      await writeFile(marker, JSON.stringify({ key, labels: { who: "creator" } }));
    }, 300);

    try {
      expect(await provider().find(key)).toMatchObject({
        id: box.id,
        state: "running",
        labels: { who: "creator" },
      });
    } finally {
      archilState.sandboxes.delete(box.id);
      await box.guest.destroy();
    }
  });

  test("a keyed lookup of a sandbox deleted during setup finds nothing", async () => {
    const key = `gone-${crypto.randomUUID()}`;
    const name = `sbxsdk-k${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
    const box = await addForeign(name, "pending");

    setTimeout(() => {
      box.status = "deleted";
      archilState.sandboxes.delete(box.id);
    }, 300);

    try {
      expect(await provider().find(key)).toBeUndefined();
    } finally {
      await box.guest.destroy();
    }
  });

  test("a paused sandbox, whose marker cannot be read, is never listed or reaped", async () => {
    const p = provider();
    const box = await createSandbox(p, { labels: { group: "paused-list" } });

    try {
      await archilState.sandboxes.get(box.id)?.pause();
      expect(await listSandboxes(p, { labels: { group: "paused-list" } })).toEqual([]);
      expect((await listSandboxes(p)).map((info) => info.id)).not.toContain(box.id);
      await reapSandboxes(p, { olderThanMs: 0 });
      expect(archilState.sandboxes.has(box.id)).toBe(true);
      // An explicit ID still connects, without waking it.
      expect((await p.connect(box.id)).state).toBe("paused");
      expect(archilState.sandboxes.get(box.id)?.status).toBe("paused");
    } finally {
      await box.destroy();
    }
  });

  test("a foreign paused sandbox in the SDK's exact name format is not reaped", async () => {
    const p = provider();
    const foreign = await addForeign(`sbxsdk-${crypto.randomUUID()}`, "paused");

    try {
      await reapSandboxes(p, { olderThanMs: 0 });
      expect(archilState.sandboxes.has(foreign.id)).toBe(true);
    } finally {
      archilState.sandboxes.delete(foreign.id);
      await foreign.guest.destroy();
    }
  });

  test("explicit resume waits for a pause still settling", async () => {
    const p = provider();
    const box = await createSandbox(p);

    try {
      const fake = archilState.sandboxes.get(box.id);

      if (!fake) throw new Error("fake sandbox missing");
      fake.status = "pausing";
      setTimeout(() => {
        fake.status = "paused";
      }, 300);
      await p.resume?.(box.id);
      expect(fake.status).toBe("running");
    } finally {
      await box.destroy();
    }
  });

  test("a keyed create whose answer is lost adopts only its own sandbox", async () => {
    const key = `lost-${crypto.randomUUID()}`;
    archilState.dropNextCreateAnswer = true;
    const box = await createSandbox(provider(), { key, labels: { who: "lost" } });

    try {
      expect(box.created).toBe(true);
      expect((await box.run("echo ok")).stdout).toBe("ok\n");
    } finally {
      await box.destroy();
    }
  });
});
