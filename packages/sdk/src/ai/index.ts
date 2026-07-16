import { jsonSchema, tool } from "ai";
import type { Experimental_SandboxProcess, Experimental_SandboxSession, Tool, ToolSet } from "ai";
import { isSandboxError, normalizeError, SandboxError } from "../core/errors";
import type { Sandbox, SandboxProcess } from "../core/types";

export interface AISandboxSessionOptions {
  description?: string;
}

export type SandboxToolApproval = "mutations" | "always" | "never";

export type SandboxToolApprovalConfiguration = Readonly<{
  bash: "user-approval" | "not-applicable";
  read_file: "user-approval" | "not-applicable";
  write_file: "user-approval" | "not-applicable";
}>;

/**
 * Adapt a sandbox-sdk sandbox to AI SDK 7's experimental sandbox contract.
 * The caller continues to own the original sandbox and must stop it.
 */
export function toAISandboxSession(
  sandbox: Sandbox,
  options: AISandboxSessionOptions = {},
): Experimental_SandboxSession {
  const read = async (path: string, abortSignal?: AbortSignal): Promise<Uint8Array | null> => {
    throwIfAborted(abortSignal);
    try {
      const bytes = await sandbox.files.read(path);
      throwIfAborted(abortSignal);
      return bytes;
    } catch (error) {
      if (isSandboxError(error) && error.code === "not_found") return null;
      throw normalizeError(sandbox.provider, "ai.readFile", error);
    }
  };

  return {
    description:
      options.description ??
      `${sandbox.provider} sandbox ${sandbox.id}; default working directory: ${sandbox.cwd}`,
    async readFile({ path, abortSignal }) {
      const bytes = await read(path, abortSignal);
      return bytes === null ? null : bytesToStream(bytes);
    },
    readBinaryFile: ({ path, abortSignal }) => read(path, abortSignal),
    async readTextFile({ path, encoding = "utf-8", startLine, endLine, abortSignal }) {
      const bytes = await read(path, abortSignal);
      if (bytes === null) return null;
      const content = decode(bytes, encoding);
      if (startLine === undefined && endLine === undefined) return content;
      validateLineRange(startLine, endLine);
      return content
        .split("\n")
        .slice((startLine ?? 1) - 1, endLine)
        .join("\n");
    },
    async writeFile({ path, content, abortSignal }) {
      throwIfAborted(abortSignal);
      await sandbox.files.write(path, abortableStream(content, abortSignal));
      throwIfAborted(abortSignal);
    },
    async writeBinaryFile({ path, content, abortSignal }) {
      throwIfAborted(abortSignal);
      await sandbox.files.write(path, content);
      throwIfAborted(abortSignal);
    },
    async writeTextFile({ path, content, encoding = "utf-8", abortSignal }) {
      throwIfAborted(abortSignal);
      await sandbox.files.write(path, encode(content, encoding));
      throwIfAborted(abortSignal);
    },
    async run({ command, workingDirectory, env, abortSignal }) {
      const result = await sandbox.run(command, {
        cwd: workingDirectory,
        env,
        signal: abortSignal,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
    async spawn({ command, workingDirectory, env, abortSignal }) {
      const process = await sandbox.processes.start(command, {
        cwd: workingDirectory,
        env,
        signal: abortSignal,
      });
      return toAIProcess(process, abortSignal);
    },
  };
}

type BashInput = { command: string; workingDirectory?: string; env?: Record<string, string> };
type ReadFileInput = { path: string; encoding?: string; startLine?: number; endLine?: number };
type WriteFileInput = { path: string; content: string; encoding?: string };

export type SandboxTools = ToolSet & {
  bash: Tool<BashInput, { exitCode: number; stdout: string; stderr: string }>;
  read_file: Tool<ReadFileInput, { content: string | null }>;
  write_file: Tool<WriteFileInput, { written: true }>;
};

/** Ready-made AI SDK tools that execute only through `experimental_sandbox`. */
export function createSandboxTools(): SandboxTools {
  return {
    bash: tool({
      description: "Run a shell command in the sandbox.",
      inputSchema: jsonSchema<BashInput>({
        type: "object",
        properties: {
          command: { type: "string" },
          workingDirectory: { type: "string" },
          env: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["command"],
        additionalProperties: false,
      }),
      async execute(input, context) {
        const sandbox = requireSandbox(context.experimental_sandbox);
        return sandbox.run({
          command: input.command,
          workingDirectory: input.workingDirectory,
          env: input.env,
          abortSignal: context.abortSignal,
        });
      },
    }),
    read_file: tool({
      description: "Read a text file from the sandbox. Missing files return null.",
      inputSchema: jsonSchema<ReadFileInput>({
        type: "object",
        properties: {
          path: { type: "string" },
          encoding: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      async execute(input, context) {
        const sandbox = requireSandbox(context.experimental_sandbox);
        return {
          content: await sandbox.readTextFile({
            ...input,
            abortSignal: context.abortSignal,
          }),
        };
      },
    }),
    write_file: tool({
      description: "Write a text file in the sandbox, creating parent directories.",
      inputSchema: jsonSchema<WriteFileInput>({
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          encoding: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      }),
      async execute(input, context) {
        const sandbox = requireSandbox(context.experimental_sandbox);
        await sandbox.writeTextFile({ ...input, abortSignal: context.abortSignal });
        return { written: true as const };
      },
    }),
  };
}

/** Create the AI SDK 7 `toolApproval` policy for the ready-made sandbox tools. */
export function createSandboxToolApproval(
  approval: SandboxToolApproval = "mutations",
): SandboxToolApprovalConfiguration {
  const status = (mutation: boolean) =>
    approval === "always" || (approval === "mutations" && mutation)
      ? ("user-approval" as const)
      : ("not-applicable" as const);

  return {
    bash: status(true),
    read_file: status(false),
    write_file: status(true),
  };
}

function requireSandbox(
  value: Experimental_SandboxSession | undefined,
): Experimental_SandboxSession {
  if (!value) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "ai",
      operation: "tool.execute",
      message: "experimental_sandbox is required to execute sandbox tools",
    });
  }
  return value;
}

function toAIProcess(
  process: SandboxProcess,
  abortSignal?: AbortSignal,
): Experimental_SandboxProcess {
  let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  let stderrController!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({
    start: (controller) => (stdoutController = controller),
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (controller) => (stderrController = controller),
  });
  const pump = (async () => {
    try {
      for await (const event of process.output()) {
        const bytes =
          typeof event.data === "string" ? new TextEncoder().encode(event.data) : event.data;
        (event.stream === "stdout" ? stdoutController : stderrController).enqueue(bytes);
      }
      stdoutController.close();
      stderrController.close();
    } catch (error) {
      stdoutController.error(error);
      stderrController.error(error);
    }
  })();
  const abort = () => void process.kill();
  abortSignal?.addEventListener("abort", abort, { once: true });
  return {
    pid: Number.isFinite(Number(process.id)) ? Number(process.id) : undefined,
    stdout,
    stderr,
    async wait() {
      try {
        const result = await process.wait();
        await pump;
        if (abortSignal?.aborted) throw abortSignal.reason;
        return result;
      } finally {
        abortSignal?.removeEventListener("abort", abort);
      }
    },
    kill: () => process.kill(),
  };
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function abortableStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  if (!signal) return stream;
  return stream.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        throwIfAborted(signal);
        controller.enqueue(chunk);
      },
    }),
    { signal },
  );
}

function validateLineRange(startLine?: number, endLine?: number): void {
  if (
    (startLine !== undefined && (!Number.isInteger(startLine) || startLine < 1)) ||
    (endLine !== undefined && (!Number.isInteger(endLine) || endLine < 1)) ||
    (startLine !== undefined && endLine !== undefined && endLine < startLine)
  ) {
    throw new SandboxError({
      code: "invalid_input",
      provider: "ai",
      operation: "readTextFile",
      message: "Line ranges must be positive, 1-based, inclusive, and ordered",
    });
  }
}

function decode(bytes: Uint8Array, encoding: string): string {
  try {
    return encoding.toLowerCase() === "utf-8" || encoding.toLowerCase() === "utf8"
      ? new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      : Buffer.from(bytes).toString(encoding as BufferEncoding);
  } catch (error) {
    throw normalizeError("ai", "files.decode", error, "invalid_input");
  }
}

function encode(value: string, encoding: string): Uint8Array {
  try {
    return encoding.toLowerCase() === "utf-8" || encoding.toLowerCase() === "utf8"
      ? new TextEncoder().encode(value)
      : new Uint8Array(Buffer.from(value, encoding as BufferEncoding));
  } catch (error) {
    throw normalizeError("ai", "files.encode", error, "invalid_input");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}
