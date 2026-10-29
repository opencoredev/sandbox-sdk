import { StringDecoder } from "node:string_decoder";
import type { Box, ExecSessionHandle } from "@upstash/box";
import { SandboxError } from "../../errors.js";
import { upstashError } from "./errors.js";
import { quote } from "../../shared/shell.js";
import type { ExecInput, ExecResult } from "../../provider.js";

/** Session signals target the whole process tree; wait acknowledges termination. */
export async function execute(
  box: Box,
  input: ExecInput,
  prepare?: string,
  prepared?: () => void,
): Promise<ExecResult> {
  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  let session: ExecSessionHandle | undefined;
  let timedOut = false;

  const cancel = () => {
    timedOut = true;
    session?.kill("KILL");
  };

  const timer = setTimeout(cancel, input.timeoutMs);
  input.signal?.addEventListener("abort", cancel, { once: true });
  const setupMarker = `sdk-prepared-${crypto.randomUUID()}\n`;
  let setupOutput = "";
  let setupPending = prepare !== undefined;
  const stdout = new StringDecoder("utf8");
  const stderr = new StringDecoder("utf8");

  try {
    session = await box.exec.session({
      argv: prepare
        ? [
            "sh",
            "-c",
            `${prepare} && printf '%s\n' '${setupMarker.trimEnd()}' && cd "$1" && exec sh -c "$2"`,
            "sh",
            input.cwd,
            input.command,
          ]
        : ["sh", "-c", input.command],
      cwd: prepare ? "/" : input.cwd,
      env: Object.entries(input.env).map(([key, value]) => `${key}=${value}`),
      onStdout: (data) => {
        let text = stdout.write(Buffer.from(data));

        if (setupPending) {
          setupOutput += text;
          const index = setupOutput.indexOf(setupMarker);

          if (index >= 0) {
            text = setupOutput.slice(0, index) + setupOutput.slice(index + setupMarker.length);
            setupOutput = "";
            setupPending = false;
            prepared?.();
          } else {
            const length = Math.max(0, setupOutput.length - setupMarker.length + 1);
            text = setupOutput.slice(0, length);
            setupOutput = setupOutput.slice(length);
          }
        }

        if (text) input.onChunk({ stream: "stdout", text });
      },
      onStderr: (data) => {
        const text = stderr.write(Buffer.from(data));

        if (text) input.onChunk({ stream: "stderr", text });
      },
    });

    if (timedOut || input.signal?.aborted) cancel();
    else {
      if (input.stdin !== undefined) session.write(input.stdin);
      session.endStdin();
    }

    const exitCode = await session.wait();

    if (exitCode < 0 && !timedOut)
      throw new SandboxError(
        "Command session disconnected. Upstash could not confirm an exit code. Inspect the box before retrying.",
        { code: "unavailable", provider: "upstash", sandboxId: box.id },
      );
    const out = setupOutput + stdout.end();

    if (out) input.onChunk({ stream: "stdout", text: out });
    const err = stderr.end();

    if (err) input.onChunk({ stream: "stderr", text: err });

    return { exitCode: timedOut ? null : exitCode, timedOut };
  } catch (error) {
    // Closing a failed transport kills its session-owned process tree.
    session?.close();
    throw error;
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", cancel);
    session?.close();
  }
}

/** Durable work uses command(), never a connection-owned live session. Core owns
 * process logs/specs; this private record only tracks the native wrapper's exit.
 * `halt` stops a launch whose PID never arrived; it receives the private run directory. */
export async function startProcess(
  box: Box,
  input: Omit<ExecInput, "timeoutMs">,
  halt: (dir: string) => Promise<unknown>,
  prepare?: string,
) {
  const dir = `/tmp/.sandbox-sdk/upstash-runs/${crypto.randomUUID()}`;
  const envPath = `${dir}/env`;
  // command() has no env option, unlike session(). Keep values in a private
  // file so the durable shell's command line contains only the bootstrap path.
  const wrapper = `${prepare ? `${prepare} && ` : ""}chmod 600 ${quote(envPath)} && . ${quote(envPath)} && /bin/rm -f -- ${quote(envPath)} || exit 1; echo $$ > ${quote(`${dir}/pid`)}; cd ${quote(input.cwd)} || exit 1; sh -c ${quote(input.command)}; code=$?; printf '%s' "$code" > ${quote(`${dir}/exit`)}; exit "$code"`;
  let pid: number | undefined;

  try {
    const prepared = await box.exec.command(
      `umask 077; mkdir -p /tmp/.sandbox-sdk/upstash-runs && mkdir ${quote(dir)} && : > ${quote(envPath)}`,
    );

    if (prepared.exitCode !== 0) throw new Error("Durable process environment setup failed");
    await box.files.write({
      path: envPath,
      content:
        Object.entries(input.env)
          .map(([key, value]) => `export ${quote(`${key}=${value}`)}`)
          .join("\n") + "\n",
    });

    const result = await box.exec.command(
      `nohup setsid sh -c ${quote(wrapper)} > /dev/null 2>&1 < /dev/null &`,
    );

    if (result.exitCode !== 0) throw new Error("Durable process launch failed");

    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        const candidate = Number(await box.files.read(`${dir}/pid`));

        if (Number.isSafeInteger(candidate) && candidate > 1) {
          pid = candidate;
          break;
        }
      } catch (error) {
        if (upstashError(error, box.id, true).code !== "file_not_found") throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    if (pid === undefined) throw new Error("Durable process PID missing");
  } catch (error) {
    await box.files.remove(envPath).catch(() => {});
    // Without a confirmed PID, stopping the box is the only safe cleanup.
    await halt(dir);
    throw error;
  }

  const group = pid;
  let detached = false;

  const wait = (async () => {
    while (true) {
      if (detached) await new Promise<void>(() => {});

      try {
        const code = Number(await box.files.read(`${dir}/exit`));

        if (!Number.isInteger(code) || code < 0 || code > 255)
          throw new Error("Invalid durable exit code");

        return { exitCode: code, signal: null };
      } catch (error) {
        const code = upstashError(error, box.id, true).code;

        if (
          code !== "file_not_found" &&
          code !== "unavailable" &&
          code !== "quota" &&
          code !== "timeout"
        )
          throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();

  void wait.catch(() => {});

  const signal = async (kind: "TERM" | "KILL") => {
    const result = await box.exec.command(
      `kill -${kind} -${group} 2>/dev/null || ! kill -0 -${group} 2>/dev/null`,
    );

    if (result.exitCode !== 0)
      throw new SandboxError(
        "Process termination is unconfirmed. The remote process group could not be signalled. Destroy the box before retrying.",
        { code: "outcome_unknown", provider: "upstash", sandboxId: box.id },
      );
  };

  let stopped = false;

  return {
    pid: group,
    wait: () => wait,
    detach() {
      detached = true;
    },
    async stop({ graceMs }: { graceMs: number }) {
      if (stopped) return;
      await signal("TERM");
      await new Promise((resolve) => setTimeout(resolve, graceMs));
      await signal("KILL");

      try {
        await box.files.read(`${dir}/exit`);
      } catch (error) {
        if (upstashError(error, box.id, true).code !== "file_not_found") throw error;
        await box.files.write({ path: `${dir}/exit`, content: "137" });
      }

      await wait;
      stopped = true;
    },
  };
}
