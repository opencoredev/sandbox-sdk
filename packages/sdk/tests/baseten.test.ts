import { describe, expect, test } from "vitest";
import { basetenError } from "../src/providers/baseten/errors.js";
import {
  FrameReader,
  execute,
  inlineSpecLimit,
  type BasetenProcesses,
} from "../src/providers/baseten/execute.js";
import type { ExecInput } from "../src/provider.js";

type StreamEvent =
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "exit"; process: { exitCode: number } };

/** A process API whose stream yields `events` and then optionally fails, recording every call. */
function fakeProcesses(events: StreamEvent[], options: { failAfter?: boolean } = {}) {
  const streams: Record<string, string>[] = [];
  const calls = { streams, kills: 0 };

  const processes: BasetenProcesses = {
    async *execStream(request) {
      calls.streams.push(request.env ?? {});

      for (const event of events) yield event;

      if (options.failAfter) throw new Error("process stream failed: secret-marker");
    },
    async exec() {
      calls.kills++;

      return { exitCode: 0, stdout: "confirmed\n" };
    },
  };

  return { processes, calls };
}

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

const frame = (tag: string, text = "") => `${tag}${Buffer.from(text).toString("base64")}.`;

describe("Baseten exec", () => {
  test("frames split across events and replayed without newlines decode in order", async () => {
    const out = frame("O", "a\n") + frame("E", "b") + frame("O", "c");

    const { processes } = fakeProcesses([
      { type: "output", stream: "stdout", text: out.slice(0, 5) },
      { type: "output", stream: "stdout", text: `${out.slice(5)}\n` },
      { type: "output", stream: "stdout", text: "X7." },
      { type: "exit", process: { exitCode: 0 } },
    ]);

    const run = input();

    const result = await execute({
      processes,
      sandboxId: "box",
      input: run,
      uploadSpec: async () => "/unused",
      removeSpec: async () => {},
    });

    expect(result).toEqual({ exitCode: 7, timedOut: false });
    expect(run.chunks).toEqual(["stdout:a\n", "stderr:b", "stdout:c"]);
  });

  test("a stream that breaks after launch stops the command before rejecting", async () => {
    const { processes, calls } = fakeProcesses(
      [{ type: "output", stream: "stdout", text: frame("O", "partial") }],
      { failAfter: true },
    );

    await expect(
      execute({
        processes,
        sandboxId: "box",
        input: input(),
        uploadSpec: async () => "/unused",
        removeSpec: async () => {},
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
    expect(calls.kills).toBe(1);
  });

  test("an abort while the spec uploads launches nothing and removes the spec", async () => {
    const { processes, calls } = fakeProcesses([]);
    const controller = new AbortController();
    const removed: string[] = [];

    const result = await execute({
      processes,
      sandboxId: "box",
      input: input({ stdin: "x".repeat(inlineSpecLimit), signal: controller.signal }),
      uploadSpec: async () => {
        controller.abort();

        return "/tmp/.sandbox-sdk/spec.json";
      },
      removeSpec: async (path) => {
        removed.push(path);
      },
    });

    expect(result).toEqual({ exitCode: null, timedOut: true });
    expect(calls.streams).toEqual([]);
    expect(removed).toEqual(["/tmp/.sandbox-sdk/spec.json"]);
  });

  test("the inline limit counts UTF-8 bytes, not characters", async () => {
    const { processes, calls } = fakeProcesses([
      { type: "output", stream: "stdout", text: "X0." },
      { type: "exit", process: { exitCode: 0 } },
    ]);

    await execute({
      processes,
      sandboxId: "box",
      // Under the limit in characters, three times over it in bytes.
      input: input({ stdin: "中".repeat(Math.floor(inlineSpecLimit / 2)) }),
      uploadSpec: async () => "/tmp/.sandbox-sdk/spec.json",
      removeSpec: async () => {},
    });

    expect(calls.streams).toEqual([{ SANDBOX_SDK_SPEC_FILE: "/tmp/.sandbox-sdk/spec.json" }]);
  });

  test("a malformed frame is a provider failure", () => {
    expect(() => new FrameReader().push("Zzz.")).toThrow(/malformed/);
  });
});

describe("Baseten errors", () => {
  test("native text from a stream failure never reaches the message or cause", () => {
    const error = basetenError(new Error("process stream failed: secret-marker /etc/passwd"));
    expect(error.message).not.toContain("secret-marker");
    expect(String(error.cause ?? "")).not.toContain("secret-marker");
  });

  test("HTTP statuses map to codes", () => {
    const notFound = Object.assign(new Error("gone"), { status: 404 });
    expect(basetenError(notFound).code).toBe("not_found");
    const limited = Object.assign(new Error("limit"), { status: 429 });
    expect(basetenError(limited).code).toBe("quota");
  });
});
