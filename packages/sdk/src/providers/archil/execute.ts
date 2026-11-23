import type { ExecInput, ExecResult } from "../../provider.js";
import { quote } from "../../shared/shell.js";
import { SandboxError } from "../../errors.js";
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
  /** Output bytes the process has produced so far, both streams; final once it has exited. */
  readonly cursor: number;
}

export interface ArchilRunOptions {
  env?: Record<string, string>;
  timeoutSeconds?: number;
  terminal?: { cols: number; rows: number };
  collectOutput?: boolean;
  onOutput?: (output: ArchilOutput) => void;
}

/** One output message. `offset` counts every output byte before `data`, stdout and stderr together. */
export interface ArchilOutput {
  stream: "stdout" | "stderr";
  offset: number;
  data: Uint8Array;
}

/**
 * Archil's output stream can skip bytes when a command writes faster than they are delivered
 * (measured 2026-11-21: a 10 MiB `cat` arrived 1.3 MiB short, with one jump in `offset`). This
 * follows the offset, which Archil counts across both streams, and reports how many bytes a
 * message skipped, so a loss is never silent.
 */
export class OutputGaps {
  #next = 0;
  lost = 0;

  /** Bytes skipped before this message, 0 when it follows on. */
  take({ offset, data }: ArchilOutput): number {
    const skipped = Math.max(0, offset - this.#next);
    this.#next = Math.max(this.#next, offset + data.length);
    this.lost += skipped;

    return skipped;
  }

  /** Bytes missing after the last delivered message, given the process's final cursor. */
  tail(cursor: number): number {
    const skipped = Math.max(0, cursor - this.#next);
    this.#next = Math.max(this.#next, cursor);
    this.lost += skipped;

    return skipped;
  }
}

/** The part of a `disk` `Sandbox` that starts processes. Each `run` opens one process connection. */
export interface ArchilRunner {
  run(command: string, options: ArchilRunOptions): Promise<ArchilProcess>;
}

const stopped: ExecResult = { exitCode: null, timedOut: true };

// Archil carries stdin as WebSocket messages; large inputs go in pieces.
const stdinPieceBytes = 1024 * 1024;

// A kill is confirmed when the process reports its end within this window. A start that is still
// unanswered when its command is stopped gets the same window to land, so it can be killed.
const killConfirmMs = 10_000;

// Closing a process connection never holds a caller longer than this.
const disconnectMs = 5000;

// Archil's own timeout, in whole seconds, backs up the client's timer when the client goes away.
// The client's timer fires first, so a command never runs past its deadline by more than this.
const nativeGraceSeconds = 5;

/**
 * Archil kills a process's group when its main process exits (measured 2026-11-21): a background
 * `nohup setsid ...` started just before the exit dies if `setsid()` has not run yet. So the
 * command runs in a subshell, and before exiting the shell waits, up to about a second, while any
 * process in its group is still `nohup` or `setsid` on its way to a session of its own. A group
 * member that is still a plain forked shell may be about to exec one, so when any other member
 * is left the scan runs once more after 10 ms. Ordinary background jobs cost that one rescan and
 * are never waited for; Archil ends them with the command, as before.
 */
const settle = `read -r l < /proc/$$/stat; set -- \${l##*) }; g=$3; i=0; r=; while [ "$i" -lt 100 ]; do w=; o=; for f in /proc/[0-9]*/stat; do [ "$f" = /proc/$$/stat ] && continue; { read -r l < "$f"; } 2>/dev/null || continue; case "$l" in *"(nohup) "*|*"(setsid) "*) set -- \${l##*) }; [ "$3" = "$g" ] && w=1;; *) set -- \${l##*) }; [ "$3" = "$g" ] && o=1;; esac; done; if [ -z "$w" ]; then { [ -z "$o" ] || [ -n "$r" ]; } && break; r=1; fi; sleep 0.01; i=$((i+1)); done`;

/** Runs `command` in `cwd` the way a fresh POSIX shell would: a missing directory is exit 1. */
export function inDirectory(cwd: string, command: string): string {
  return `cd -- ${quote(cwd)} || exit 1\n(\n${command}\n)\nc=$?\n${settle}\nexit "$c"`;
}

/** The promise, or "late" once `ms` pass first. */
export function bounded<T>(promise: Promise<T>, ms: number): Promise<T | "late"> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    promise,
    new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Kills a process and waits for Archil to report its end, the kill included, within one window. */
export async function terminate(process: ArchilProcess): Promise<boolean> {
  const ended = (async () => {
    await process.kill();
    await process.wait();
  })();

  try {
    return (await bounded(ended, killConfirmMs)) !== "late";
  } catch {
    return false;
  }
}

/** Closes a process connection, bounded; a connection that will not close is left to Archil. */
export async function disconnect(process: ArchilProcess): Promise<void> {
  await bounded(
    process.disconnect().catch(() => {}),
    disconnectMs,
  );
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
    // The adapter's own refusal (a sleeping sandbox) and Archil's answered refusals made nothing.
    if (error instanceof SandboxError || nativeStatus(error) !== undefined)
      throw archilError(error, sandboxId);
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
  const gaps = new OutputGaps();

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

  const unconfirmed = () =>
    failure("Process termination could not be confirmed", "outcome_unknown", sandboxId);

  try {
    const command = inDirectory(input.cwd, input.command);

    const options: ArchilRunOptions = {
      env: input.env,
      timeoutSeconds: Math.ceil(input.timeoutMs / 1000) + nativeGraceSeconds,
      collectOutput: false,
      onOutput: (output) => {
        const { stream, data } = output;
        const skipped = gaps.take(output);

        if (skipped > 0)
          emit(
            stream,
            `${decoders[stream].decode()}\n[sandbox-sdk: Archil's output stream skipped ${skipped} bytes here]\n`,
          );

        emit(stream, decoders[stream].decode(data, { stream: true }));
      },
    };

    const starting = (async () => {
      try {
        return { ok: true as const, process: await start(runner, sandboxId, command, options) };
      } catch (error) {
        return { ok: false as const, error: archilError(error, sandboxId) };
      }
    })();

    // The start waits on Archil's acknowledgment, so the deadline and the abort race it too.
    const first = await Promise.race([starting, halted]);

    if (first === "stop") {
      // The start may still land and run the command: give it the kill window, then stop it.
      const late = await bounded(starting, killConfirmMs);

      if (late === "late") {
        // The handle may still arrive after the caller hears outcome_unknown: stop it then.
        void starting.then(async (landed) => {
          if (!landed.ok) return;

          try {
            await terminate(landed.process);
          } finally {
            await disconnect(landed.process);
          }
        });

        throw unconfirmed();
      }

      // A refused start ran nothing; an unknown one stays unknown.
      if (!late.ok) {
        if (late.error.code !== "outcome_unknown") return stopped;
        throw late.error;
      }

      try {
        if (!(await terminate(late.process))) throw unconfirmed();
      } finally {
        await disconnect(late.process);
      }

      for (const stream of ["stdout", "stderr"] as const) emit(stream, decoders[stream].decode());
      const tail = gaps.tail(late.process.cursor);

      if (tail > 0)
        emit("stdout", `\n[sandbox-sdk: Archil's output stream skipped the last ${tail} bytes]\n`);

      return stopped;
    }

    if (!first.ok) throw first.error;
    const { process } = first;

    // Decoded text still held and bytes lost after the last delivered message, once the process is known ended.
    const flush = () => {
      for (const stream of ["stdout", "stderr"] as const) emit(stream, decoders[stream].decode());
      // The exit event carries the final cursor: bytes after the last delivered message were lost.
      const tail = gaps.tail(process.cursor);

      if (tail > 0)
        emit("stdout", `\n[sandbox-sdk: Archil's output stream skipped the last ${tail} bytes]\n`);
    };

    try {
      // A command that exits without reading its input refuses the rest; its result still stands.
      const stdin = input.stdin === undefined ? undefined : new TextEncoder().encode(input.stdin);

      const fed = bounded(
        writeStdin(process, stdin).catch(() => {}),
        input.timeoutMs + killConfirmMs,
      );

      const outcome = await Promise.race([
        process.wait().then((result) => ({ kind: "exit" as const, result })),
        halted.then(() => ({ kind: "stop" as const })),
      ]).catch(() => ({ kind: "broken" as const }));

      if (outcome.kind !== "exit") {
        // A broken stream leaves the command running; it settles only once the command is stopped.
        if (!(await terminate(process))) throw unconfirmed();
        flush();

        if (outcome.kind === "broken" && !cancelled)
          throw failure(
            "Archil process stream broke; the command was stopped and its outcome is unknown",
            "outcome_unknown",
            sandboxId,
          );

        return stopped;
      }

      await fed;
      flush();
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
      await disconnect(process);
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
  /** Output bytes Archil's stream skipped. Nonzero means stdout is incomplete. */
  lost: number;
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
  const gaps = new OutputGaps();

  const process = await start(runner, sandboxId, command, {
    env: options.env,
    timeoutSeconds: Math.ceil(timeoutMs / 1000) + nativeGraceSeconds,
    collectOutput: false,
    onOutput: (output) => {
      const { stream, data } = output;
      gaps.take(output);

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

    gaps.tail(process.cursor);
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
      lost: gaps.lost,
    };
  } catch (error) {
    throw archilError(error, sandboxId);
  } finally {
    await disconnect(process);
  }
}
