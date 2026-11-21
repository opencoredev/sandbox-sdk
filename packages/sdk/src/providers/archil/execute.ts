import type { ExecInput, ExecResult } from "../../provider.js";
import { quote } from "../../shared/shell.js";
import { archilError, failure, nativeStatus } from "./errors.js";

/** How a `disk` process ended, as `SandboxProcess.wait()` reports it. */
export interface ArchilProcessResult {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  exitCode?: number;
}

/** The parts of a `disk` `SandboxProcess` the adapter uses. */
export interface ArchilProcess {
  sendInput(data: string | Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  resize(size: { cols: number; rows: number }): Promise<void>;
  wait(): Promise<ArchilProcessResult>;
  kill(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface ArchilRunOptions {
  env?: Record<string, string>;
  timeoutSeconds?: number;
  terminal?: { cols: number; rows: number };
  collectOutput?: boolean;
  onOutput?: (output: { stream: "stdout" | "stderr"; data: Uint8Array }) => void;
}

/** The part of a `disk` `Sandbox` that starts processes. Each `run` opens one process connection. */
export interface ArchilRunner {
  run(command: string, options: ArchilRunOptions): Promise<ArchilProcess>;
}

const stopped: ExecResult = { exitCode: null, timedOut: true };

// Archil carries stdin as WebSocket messages; large inputs go in pieces.
const stdinPieceBytes = 1024 * 1024;

// A kill is confirmed when the process reports its end within this window.
const killConfirmMs = 10_000;

// Archil's own timeout, in whole seconds, backs up the client's timer when the client goes away.
// The client's timer fires first, so a command never runs past its deadline by more than this.
const nativeGraceSeconds = 5;

/** Runs `command` in `cwd` the way a fresh POSIX shell would: a missing directory is exit 1. */
export function inDirectory(cwd: string, command: string): string {
  return `cd -- ${quote(cwd)} || exit 1\n${command}`;
}

function bounded<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Kills a process and waits for Archil to report its end. False when that never came. */
export async function terminate(process: ArchilProcess): Promise<boolean> {
  try {
    await process.kill();

    return (await bounded(process.wait(), killConfirmMs)) !== "late";
  } catch {
    return false;
  }
}

async function writeStdin(process: ArchilProcess, stdin: Uint8Array | undefined) {
  if (stdin !== undefined)
    for (let offset = 0; offset < stdin.length; offset += stdinPieceBytes)
      await process.sendInput(stdin.subarray(offset, offset + stdinPieceBytes));

  await process.closeStdin();
}

/**
 * Starts a process. A refusal Archil answered (an HTTP status) made nothing; any other failure may
 * follow a start that reached the sandbox, so the command's outcome is unknown.
 */
async function start(
  runner: ArchilRunner,
  sandboxId: string,
  command: string,
  options: ArchilRunOptions,
): Promise<ArchilProcess> {
  try {
    return await runner.run(command, options);
  } catch (error) {
    if (nativeStatus(error) !== undefined) throw archilError(error, sandboxId);
    throw failure(
      "Archil process connection failed; the command may have started",
      "outcome_unknown",
      sandboxId,
    );
  }
}

/** Runs one command, streaming its output in arrival order. Timeout and abort kill it first. */
export async function execute({
  runner,
  sandboxId,
  input,
}: {
  runner: ArchilRunner;
  sandboxId: string;
  input: ExecInput;
}): Promise<ExecResult> {
  if (input.signal?.aborted) return stopped;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  const emit = (stream: "stdout" | "stderr", text: string) => {
    if (text) input.onChunk({ stream, text });
  };

  let stop = () => {};
  let cancelled = false;

  const halted = new Promise<"stop">((resolve) => {
    stop = () => {
      cancelled = true;
      resolve("stop");
    };
  });

  const timer = setTimeout(() => stop(), input.timeoutMs);
  input.signal?.addEventListener("abort", stop, { once: true });

  try {
    const process = await start(runner, sandboxId, inDirectory(input.cwd, input.command), {
      env: input.env,
      timeoutSeconds: Math.ceil(input.timeoutMs / 1000) + nativeGraceSeconds,
      collectOutput: false,
      onOutput: ({ stream, data }) => emit(stream, decoders[stream].decode(data, { stream: true })),
    });

    try {
      // A command that exits without reading its input refuses the rest; its result still stands.
      const stdin = input.stdin === undefined ? undefined : new TextEncoder().encode(input.stdin);
      const fed = writeStdin(process, stdin).catch(() => {});

      const outcome = await Promise.race([
        process.wait().then((result) => ({ kind: "exit" as const, result })),
        halted.then(() => ({ kind: "stop" as const })),
      ]).catch(() => ({ kind: "broken" as const }));

      if (outcome.kind !== "exit") {
        // A broken stream leaves the command running; it settles only once the command is stopped.
        if (!(await terminate(process)))
          throw failure("Process termination could not be confirmed", "outcome_unknown", sandboxId);

        if (outcome.kind === "broken" && !cancelled)
          throw failure(
            "Archil process stream broke; the command was stopped and its outcome is unknown",
            "outcome_unknown",
            sandboxId,
          );

        return stopped;
      }

      await fed;

      for (const stream of ["stdout", "stderr"] as const) emit(stream, decoders[stream].decode());
      const { result } = outcome;

      if (result.status === "timed_out") return stopped;

      if (result.exitCode !== undefined && result.status !== "cancelled")
        return { exitCode: result.exitCode, timedOut: false };

      // Cancelled by someone else (a pause or stop of the sandbox), or failed to launch.
      throw failure(
        result.status === "cancelled"
          ? "Archil cancelled the command before it finished"
          : "Archil could not run the command",
        "provider",
        sandboxId,
      );
    } finally {
      await process.disconnect().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
  }
}

export interface CollectedRun {
  exitCode: number | undefined;
  stdout: Uint8Array;
  stderr: string;
}

/** Runs a short helper command to completion and collects its raw output. For guest file operations. */
export async function collect(
  runner: ArchilRunner,
  sandboxId: string,
  command: string,
  options: { env?: Record<string, string>; stdin?: Uint8Array; timeoutMs?: number } = {},
): Promise<CollectedRun> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const stdout: Uint8Array[] = [];
  const stderr = new TextDecoder();
  let errorText = "";

  const process = await start(runner, sandboxId, command, {
    env: options.env,
    timeoutSeconds: Math.ceil(timeoutMs / 1000) + nativeGraceSeconds,
    collectOutput: false,
    onOutput: ({ stream, data }) => {
      if (stream === "stdout") stdout.push(data.slice());
      else errorText += stderr.decode(data, { stream: true });
    },
  });

  try {
    await writeStdin(process, options.stdin);
    const result = await bounded(process.wait(), timeoutMs);

    if (result === "late") {
      await terminate(process);
      throw failure("Archil guest operation timed out", "timeout", sandboxId);
    }

    const size = stdout.reduce((total, part) => total + part.length, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;

    for (const part of stdout) {
      bytes.set(part, offset);
      offset += part.length;
    }

    return {
      exitCode: result.status === "completed" ? result.exitCode : undefined,
      stdout: bytes,
      stderr: errorText + stderr.decode(),
    };
  } catch (error) {
    throw archilError(error, sandboxId);
  } finally {
    await process.disconnect().catch(() => {});
  }
}
