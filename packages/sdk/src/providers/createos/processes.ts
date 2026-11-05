import { randomUUID } from "node:crypto";
import {
  SandboxError,
  createDeadline,
  sleep,
  type Deadline,
  type ExecInput,
  type NativeProcess,
  type OutputChunk,
  type Terminal,
  type TerminalOptions,
} from "../../provider.js";
import { ndjson, streamFault } from "../../streams.js";
import { httpStatus } from "../../http.js";
import { isString, isNumber } from "../../shared/narrow.js";
import { quote } from "../../shared/shell.js";
import { processRecord, record, type CreateosApi, type ProcessRecord } from "./api.js";
import { failure } from "./errors.js";

const root = "/v1/sandboxes/{sandboxId}/processes";
const path = `${root}/{processId}`;

/** Environment travels on stdin, never in process argv or the provider's command records. */
function environment(env: Record<string, string>) {
  return Object.entries(env)
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
        throw failure("Invalid command environment", "invalid_argument");

      return `export ${key}=${quote(value)}`;
    })
    .join("\n");
}

export function processes(api: CreateosApi) {
  const sessions = new Map<string, AbortController>();

  const session = (id: string) => {
    let controller = sessions.get(id);

    if (!controller) {
      controller = new AbortController();
      sessions.set(id, controller);
    }

    return controller.signal;
  };

  async function stopTree(id: string, processId: string, graceMs: number) {
    const deadline = createDeadline(10_000);
    let result: ProcessRecord;

    try {
      result = processRecord(
        await api.json({
          method: "DELETE",
          path,
          sandboxId: id,
          params: { sandboxId: id, processId },
          query: { grace_ms: graceMs },
          deadline,
        }),
      );
    } catch (cause) {
      if (cause instanceof SandboxError && cause.code === "not_found") return;
      throw cause;
    }

    while (!result.treeExited) {
      await sleep(100, deadline, "createos");
      result = await wait(id, processId, deadline);
    }

    return result;
  }

  async function terminate(id: string, processId: string, graceMs = 1000) {
    try {
      return await stopTree(id, processId, graceMs);
    } catch {
      // Cleanup failure must never be converted to a successful timedOut result.
      throw failure(
        "Could not confirm process-tree termination; inspect the sandbox before retrying",
        "provider",
        id,
      );
    }
  }

  async function wait(id: string, processId: string, deadline: Deadline) {
    try {
      return processRecord(
        await api.json({
          method: "GET",
          path: `${path}/wait`,
          sandboxId: id,
          params: { sandboxId: id, processId },
          query: { scope: "tree", timeout_ms: Math.min(1000, deadline.remaining()) },
          deadline,
        }),
      );
    } catch (cause) {
      // A server-side long-poll timeout means the process is still running.
      // Read its current state without resetting the caller's deadline.
      const status = httpStatus(cause);

      if (status?.status !== 408) throw cause;

      return processRecord(
        await api.json({
          method: "GET",
          path,
          sandboxId: id,
          params: { sandboxId: id, processId },
          deadline,
        }),
      );
    }
  }

  async function input(id: string, processId: string, data: Uint8Array, deadline?: Deadline) {
    // Bound each request, including large stdin passed to run().
    for (let offset = 0; offset < data.length; offset += 16_384)
      await api.json({
        method: "POST",
        path: `${path}/input`,
        sandboxId: id,
        params: { sandboxId: id, processId },
        deadline,
        body: {
          data_base64: Buffer.from(data.subarray(offset, offset + 16_384)).toString("base64"),
        },
      });
  }

  async function launch(
    id: string,
    command: Omit<ExecInput, "timeoutMs">,
    deadline?: Deadline,
    onLaunch?: (process: ProcessRecord) => void,
  ) {
    const env = Buffer.from(environment(command.env)).toString("base64");

    const script = `IFS= read -r sdk_env || exit 125
sdk_env=$(printf '%s' "$sdk_env" | base64 -d) || exit 125
eval "unset sdk_env; $sdk_env"
cd ${quote(command.cwd)} || exit 1
exec sh -c ${quote(command.command)}`;

    // Do not cancel this POST on the command deadline: a late process ID must be received and killed.
    // An uncertain transport failure remains outcome_unknown; never report a successful cancellation.
    const proc = processRecord(
      await api.json({
        method: "POST",
        path: root,
        sandboxId: id,
        params: { sandboxId: id },
        body: { cmd: "sh", args: ["-c", script], cwd: "/" },
      }),
    );

    try {
      if (deadline?.signal.aborted) throw failure("Command cancelled during launch", "aborted", id);
      onLaunch?.(proc);

      try {
        await input(id, proc.id, Buffer.from(env + "\n" + (command.stdin ?? "")), deadline);
        await api.json({
          method: "POST",
          path: `${path}/stdin/close`,
          sandboxId: id,
          params: { sandboxId: id, processId: proc.id },
          deadline,
        });
      } catch (cause) {
        // Fast commands can exit before stdin/close arrives. Only a confirmed exit makes that benign.
        if (
          httpStatus(cause)?.status !== 409 ||
          !(await wait(id, proc.id, deadline ?? createDeadline(10_000))).treeExited
        )
          throw cause;
      }

      return proc;
    } catch (cause) {
      await terminate(id, proc.id);

      if (deadline?.signal.aborted)
        throw failure("Command cancelled after process-tree termination", "aborted", id);
      throw cause;
    }
  }

  async function follow(
    id: string,
    processId: string,
    signal: AbortSignal,
    onChunk: (chunk: OutputChunk) => void,
    deadline?: Deadline,
  ) {
    let after = 0;
    let failures = 0;

    const decoders = {
      stdout: new TextDecoder(),
      stderr: new TextDecoder(),
      pty: new TextDecoder(),
    };

    try {
      for (;;) {
        try {
          const response = await api.http.stream({
            method: "GET",
            path: `${path}/connect`,
            sandboxId: id,
            params: { sandboxId: id, processId },
            query: { after },
            signal,
            deadline,
            idleTimeoutMs: 30_000,
          });

          if (!response.body)
            throw failure("CreateOS returned no process output stream", "provider", id);

          for await (const frame of ndjson(response.body, {
            provider: "createos",
            sandboxId: id,
            signal,
          })) {
            if (!record(frame)) throw failure("Invalid process frame", "provider", id);

            if (frame.type === "heartbeat") continue;

            if (frame.type === "exit") return;

            if (frame.type === "error")
              throw failure(
                "CreateOS cannot replay process output; retained output may have expired",
                "provider",
                id,
              );

            if (
              frame.type !== "data" ||
              !isNumber(frame.seq) ||
              !Number.isSafeInteger(frame.seq) ||
              frame.seq < 1 ||
              !isString(frame.data_base64) ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                frame.data_base64,
              ) ||
              (frame.stream !== "stdout" && frame.stream !== "stderr" && frame.stream !== "pty")
            )
              throw failure("Invalid process output frame", "provider", id);

            if (frame.seq <= after) continue;

            if (frame.seq !== after + 1)
              throw failure("CreateOS process output has a gap", "provider", id);

            const text = decoders[frame.stream].decode(Buffer.from(frame.data_base64, "base64"), {
              stream: true,
            });

            after = frame.seq;
            failures = 0;

            if (text) onChunk({ stream: frame.stream === "stderr" ? "stderr" : "stdout", text });
          }
        } catch (cause) {
          if (signal.aborted) throw cause;
          const fault = streamFault(cause);

          if (
            fault !== "disconnected" &&
            fault !== "truncated" &&
            !(cause instanceof SandboxError && ["unavailable", "timeout"].includes(cause.code))
          )
            throw cause;
        }

        if (++failures > 3)
          throw failure("CreateOS process stream ended without an exit", "unavailable", id);
        await sleep(100, deadline ?? createDeadline(1000, signal), "createos");
      }
    } finally {
      for (const [stream, decoder] of Object.entries(decoders)) {
        const text = decoder.decode();

        if (text) onChunk({ stream: stream === "stderr" ? "stderr" : "stdout", text });
      }
    }
  }

  async function execute(id: string, command: ExecInput) {
    const deadline = createDeadline(command.timeoutMs, command.signal);
    const controller = new AbortController();
    const signal = AbortSignal.any([deadline.signal, controller.signal]);
    let proc: ProcessRecord | undefined;
    let output: Promise<void> | undefined;

    if (deadline.signal.aborted) return { exitCode: null, timedOut: true };

    try {
      proc = await launch(id, command, deadline, (running) => {
        // Drain output while stdin is delivered: large bidirectional commands must not overflow replay.
        output = follow(id, running.id, signal, command.onChunk, deadline);
        void output.catch(() => {});
      });
      await output;
      let result = await wait(id, proc.id, deadline);

      while (!result.treeExited) {
        await sleep(50, deadline, "createos");
        result = await wait(id, proc.id, deadline);
      }

      if (result.exitCode === null && result.signal === null)
        throw failure("CreateOS did not report the command exit status", "outcome_unknown", id);

      return { exitCode: result.exitCode, timedOut: false };
    } catch (cause) {
      if (proc) await terminate(id, proc.id);

      // launch cleans up a known ID itself. Do not disguise unknown creation outcomes or cleanup failures.
      if (
        deadline.signal.aborted &&
        cause instanceof SandboxError &&
        ["timeout", "aborted"].includes(cause.code)
      )
        return { exitCode: null, timedOut: true };
      throw cause;
    } finally {
      controller.abort();
      await output?.catch(() => {});
    }
  }

  async function raw(id: string, command: string, stdin?: string, deadline?: Deadline) {
    const chunks: string[] = [];
    let bytes = 0;

    const result = await execute(id, {
      command,
      stdin,
      cwd: "/",
      env: {},
      timeoutMs: Math.max(1, deadline?.remaining() ?? 60_000),
      signal: deadline?.signal,
      onChunk(chunk) {
        if (chunk.stream !== "stdout") return;
        bytes += Buffer.byteLength(chunk.text);

        if (bytes > 16 * 1024 * 1024)
          throw failure("Guest helper output exceeded 16 MiB", "provider", id);
        chunks.push(chunk.text);
      },
    });

    if (result.timedOut || result.exitCode !== 0)
      throw failure("CreateOS guest helper failed", result.timedOut ? "timeout" : "provider", id);

    return chunks.join("");
  }

  async function start(id: string, command: Omit<ExecInput, "timeoutMs">): Promise<NativeProcess> {
    const signal = session(id);
    const proc = await launch(id, command, createDeadline(60_000, command.signal));

    return {
      pid: proc.pid,
      stop: async ({ graceMs }) => {
        await terminate(id, proc.id, graceMs);
      },
      async wait() {
        for (;;) {
          try {
            const result = await wait(id, proc.id, createDeadline(10_000, signal));

            if (result.treeExited) return { exitCode: result.exitCode, signal: result.signal };
            await sleep(250, createDeadline(1000, signal), "createos");
          } catch (cause) {
            // Detaching must not make core write a failed exit record for a still-running process.
            // No socket or timer remains; a new handle reads the durable guest records.
            if (signal.aborted) return new Promise<never>(() => {});
            throw cause;
          }
        }
      },
    };
  }

  async function terminal(id: string, options: TerminalOptions): Promise<Terminal> {
    const envPath = `/tmp/.sandbox-sdk-terminal-${randomUUID()}`;
    await raw(
      id,
      `umask 077; cat > ${quote(envPath)}`,
      environment({ ...options.env, TERM: "xterm-256color" }),
    );
    let proc: ProcessRecord;

    try {
      proc = processRecord(
        await api.json({
          method: "POST",
          path: root,
          sandboxId: id,
          params: { sandboxId: id },
          body: {
            cmd: "sh",
            args: [
              "-c",
              `. ${quote(envPath)}; rm -f ${quote(envPath)}; cd ${quote(options.cwd ?? "/workspace")} && exec sh`,
            ],
            cwd: "/",
            pty: { rows: options.rows, cols: options.cols },
          },
        }),
      );
    } catch (cause) {
      await raw(id, `rm -f ${quote(envPath)}`).catch(() => {});
      throw cause;
    }

    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, session(id)]);
    const listeners = new Set<(data: string) => void>();
    let backlog = "";
    let subscribed = false;
    let confirmedExit: { exitCode: number | null } | undefined;

    const done = follow(id, proc.id, signal, (chunk) => {
      if (!subscribed) backlog = (backlog + chunk.text).slice(-65_536);

      for (const listener of listeners) listener(chunk.text);
    })
      .catch((cause) => {
        if (!confirmedExit) throw cause;
      })
      .then(async () => {
        if (confirmedExit) return confirmedExit;
        const result = await wait(id, proc.id, createDeadline(10_000));

        return { exitCode: result.exitCode };
      });

    // Errors remain observable through wait(), even if callers only subscribe to onData().
    void done.catch(() => {});
    let closing: Promise<void> | undefined;

    return {
      write: (data) => input(id, proc.id, Buffer.from(data), createDeadline(10_000, signal)),
      resize: async (cols, rows) => {
        await api.json({
          method: "POST",
          path: `${path}/resize`,
          sandboxId: id,
          params: { sandboxId: id, processId: proc.id },
          body: { cols, rows },
          signal,
        });
      },
      onData(callback) {
        listeners.add(callback);
        subscribed = true;
        const pending = backlog;
        backlog = "";

        if (pending) callback(pending);

        return () => {
          listeners.delete(callback);
        };
      },
      wait: () => done,
      close: () =>
        (closing ??= (async () => {
          try {
            const result = await terminate(id, proc.id);
            confirmedExit = { exitCode: result?.exitCode ?? null };
          } finally {
            controller.abort();
          }
        })()),
    };
  }

  return {
    execute,
    raw,
    start,
    terminal,
    close(id: string) {
      sessions.get(id)?.abort();
      sessions.delete(id);
    },
  };
}
