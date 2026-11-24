/**
 * Commands through the `microsandbox` peer's guest agent: `sandbox.execStreamWith("sh", ...)` streams
 * stdout and stderr as bytes and reports the exit code. The adapter names its own view of the peer here,
 * structurally, so its published types never import `microsandbox`.
 */
import type { ExecInput, ExecResult } from "../../provider.js";
import { fail, peerCode, peerError } from "./errors.js";

/** `ExecOptionsBuilder` (microsandbox 0.8.1), as far as the adapter configures it. */
export interface PeerExecOptions {
  args(args: string[]): this;
  cwd(cwd: string): this;
  envs(vars: Record<string, string>): this;
  tty(enabled: boolean): this;
  stdinNull(): this;
  stdinBytes(data: Buffer): this;
}

/** `ExecEvent`. */
export type PeerExecEvent =
  | { kind: "started"; pid: number }
  | { kind: "stdout"; data: Uint8Array }
  | { kind: "stderr"; data: Uint8Array }
  | { kind: "exited"; code: number };

/** `ExecHandle`. */
export interface PeerExecHandle {
  recv(): Promise<PeerExecEvent | null>;
  wait(): Promise<{ readonly code: number }>;
  kill(): Promise<void>;
}

/** `SandboxFsOps`, as far as the adapter uses it. */
export interface PeerFs {
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
}

/** `Sandbox`, as far as the adapter uses it. */
export interface PeerSandbox {
  execStreamWith(
    cmd: string,
    configure: (builder: PeerExecOptions) => PeerExecOptions,
  ): Promise<PeerExecHandle>;
  fs(): PeerFs;
}

/** A `RemoteContext`: one destination's sandboxes. */
export interface PeerContext {
  readonly sandboxes: { get(name: string): Promise<PeerSandbox> };
}

/** The `RemoteContext` constructor options the adapter passes: explicit, never read from the environment. */
export interface PeerContextOptions {
  url: string;
  apiKey: string;
  requestTimeoutMs: number;
  computeType?: "standard" | "shared";
}

/** What the adapter needs from the `microsandbox` package. */
export interface MicrosandboxModule {
  RemoteContext: new (options: PeerContextOptions) => PeerContext;
}

/** How long a kill, and the wait that confirms it, may take after a timeout or abort, on its own deadline. */
export const killMs = 30_000;

/** Resolves to `"stop"` when `signal` fires, and never otherwise. */
function stopped(signal: AbortSignal): Promise<"stop"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("stop");
    else signal.addEventListener("abort", () => resolve("stop"), { once: true });
  });
}

/** `promise` within `ms`, else a rejection. The promise itself keeps running. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("deadline")), ms);
  });

  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

/**
 * Kills a command and confirms it exited, within one fresh {@link killMs} deadline. `false` when either
 * step failed or ran out of time: the command may still be running.
 */
export async function killConfirmed(handle: PeerExecHandle): Promise<boolean> {
  try {
    await within(
      (async () => {
        await handle.kill();
        await handle.wait();
      })(),
      killMs,
    );

    return true;
  } catch {
    return false;
  }
}

const timedOut: ExecResult = { exitCode: null, timedOut: true };

/**
 * One command through the peer. Never sent twice. A timeout or abort before the peer hands back the
 * command's handle leaves its start unknown: the late handle is killed when it arrives, and the call
 * reports `outcome_unknown`. After the handle, a timeout or abort kills the command and waits for its
 * exit on a fresh deadline; only a confirmed exit reports `timedOut`.
 */
export async function execute(input: {
  sandbox: PeerSandbox;
  exec: ExecInput;
  sandboxId: string;
  redact: (text: string) => string;
}): Promise<ExecResult> {
  const { sandbox, exec, sandboxId, redact } = input;

  if (exec.signal?.aborted) return timedOut;

  // Ends the wait on the timeout or the caller's abort. Node fires a timer longer than 2^31 - 1 ms at once.
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), Math.min(exec.timeoutMs, 2 ** 31 - 1));
  const abort = () => stop.abort();
  exec.signal?.addEventListener("abort", abort, { once: true });
  const halted = stopped(stop.signal);

  const unknown = (message: string, cause?: unknown) =>
    fail(message, "outcome_unknown", {
      sandboxId,
      cause: cause instanceof Error ? redact(cause.message) : undefined,
    });

  try {
    const launching = sandbox.execStreamWith("sh", (builder) => {
      const configured = builder.args(["-c", exec.command]).cwd(exec.cwd).envs(exec.env).tty(false);

      // Explicit stdin: the command reads exactly the caller's bytes, or end of file at once.
      return exec.stdin === undefined
        ? configured.stdinNull()
        : configured.stdinBytes(Buffer.from(exec.stdin, "utf8"));
    });

    let handle: PeerExecHandle | "stop";

    try {
      handle = await Promise.race([launching, halted]);
    } catch (error) {
      // The peer refused or failed before handing back a handle. Whether the command started is unknown
      // unless the peer says the sandbox was not there to run it.
      const mapped = peerError(error, "starting the command", { sandboxId, redact });

      if (
        mapped.code === "not_found" ||
        mapped.code === "invalid_argument" ||
        peerCode(error) === "sandboxNotRunning"
      )
        throw mapped;
      throw unknown("the command may have started, but the guest agent did not confirm it", error);
    }

    if (handle === "stop") {
      // The command may start after this returns: kill it as soon as its handle arrives.
      launching.then(
        (late) =>
          late
            .kill()
            .then(() => late.wait())
            .catch(() => {}),
        () => {},
      );
      throw unknown(
        "the command timed out or was aborted before the guest agent confirmed it started; it may still run. Destroy the sandbox before retrying",
      );
    }

    const running = handle;

    // One decoder per stream, so a multi-byte character split across chunks of one stream never mixes
    // with bytes of the other.
    const decoders = {
      stdout: new TextDecoder("utf-8", { fatal: false }),
      stderr: new TextDecoder("utf-8", { fatal: false }),
    };

    const flush = () => {
      for (const stream of ["stdout", "stderr"] as const) {
        const text = decoders[stream].decode();

        if (text) exec.onChunk({ stream, text });
      }
    };

    const cancel = async (): Promise<ExecResult> => {
      flush();

      if (await killConfirmed(running)) return timedOut;
      throw unknown(
        "the command was cancelled, but its exit could not be confirmed. It may still be running; destroy the sandbox before retrying",
      );
    };

    for (;;) {
      let event: PeerExecEvent | null | "stop";

      try {
        event = await Promise.race([running.recv(), halted]);
      } catch (error) {
        if (stop.signal.aborted) return await cancel();
        await killConfirmed(running);
        throw unknown("the command stream broke before the command finished", error);
      }

      if (event === "stop") return await cancel();

      if (event === null) {
        // The stream ended; the exit code is the one `wait` already observed.
        flush();
        let status: { readonly code: number };

        try {
          status = await Promise.race([
            running.wait(),
            halted.then(() => {
              throw new Error("stopped");
            }),
          ]);
        } catch (error) {
          if (stop.signal.aborted) return await cancel();
          throw unknown("the command stream ended without an exit code", error);
        }

        return exitOf(status.code, unknown);
      }

      switch (event.kind) {
        case "started":
          break;
        case "stdout":
        case "stderr": {
          const text = decoders[event.kind].decode(event.data, { stream: true });

          if (text) exec.onChunk({ stream: event.kind, text });
          break;
        }

        case "exited":
          flush();

          return exitOf(event.code, unknown);
        default: {
          const exhaustive: never = event;

          return exhaustive;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    exec.signal?.removeEventListener("abort", abort);
  }
}

/** An exit code the guest reported: a whole number, else the outcome is unknown. */
function exitOf(code: number, unknown: (message: string) => Error): ExecResult {
  if (!Number.isSafeInteger(code))
    throw unknown("the guest agent reported an exit code that is not a whole number");

  return { exitCode: code, timedOut: false };
}
