import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
      // An explicit ID still connects: the caller vouches for it.
      expect((await p.connect(box.id)).state).toBe("paused");
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
