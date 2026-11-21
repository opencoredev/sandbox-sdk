import { describe, expect, test } from "vitest";
import { createSandbox, listSandboxes } from "../src/index.js";
import { archilError } from "../src/providers/archil/errors.js";
import {
  execute,
  type ArchilProcess,
  type ArchilProcessResult,
} from "../src/providers/archil/execute.js";
import { createArchilProvider } from "../src/providers/archil/provider.js";
import type { ExecInput } from "../src/provider.js";
import { runConformance } from "../src/testing.js";
import { archilState, fakeDisk } from "./archil-mock.js";

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
function scripted(options: { killConfirms?: boolean; result?: ArchilProcessResult } = {}) {
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

  test("a paused sandbox lists only without a label filter", async () => {
    const p = provider();
    const box = await createSandbox(p, { labels: { group: "paused-list" } });

    try {
      await archilState.sandboxes.get(box.id)?.pause();
      expect(await listSandboxes(p, { labels: { group: "paused-list" } })).toEqual([]);
      expect((await listSandboxes(p)).map((info) => info.id)).toContain(box.id);
    } finally {
      await box.destroy();
    }
  });
});
