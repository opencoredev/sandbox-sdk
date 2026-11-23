import { posix } from "node:path";
import type { OutputChunk, Provider } from "./provider.js";
import { invalid, Redactor, type SandboxError } from "./errors.js";
import type { RunHandle, RunOptions, RunResult } from "./types.js";
import { quote } from "./shared/shell.js";
import { chunkRedactor } from "./chunk-redactor.js";

export { chunkRedactor };

// Providers built on run.ts helpers import quote from here.
export { quote };

/** Every SDK command carries this variable, and so does every descendant that keeps its environment. */
export const activityTag = "SANDBOX_SDK_RUN";

export const defaults = {
  CI: "1",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  DEBIAN_FRONTEND: "noninteractive",
  TERM: "dumb",
  NO_COLOR: "1",
  [activityTag]: "1",
};

export const pathOf = (path = ".") => posix.resolve("/workspace", path);
export const secretRecoveryCommand = `if [ -f /tmp/.sandbox-sdk/secret-names.json ]; then cat /tmp/.sandbox-sdk/secret-names.json || exit 1; printf '\\000'; env -0; fi`;

// Anonymous-pipe relays keep activity alive until inherited stdout/stderr close.
// Close the routing descriptors in the user shell: only its actual output pipes
// should keep the relays alive. Every child remains in the adapter's process group.
// The marker is a file whose last write is the exit status; mkdir runs only once per sandbox.
const activityScript = `[ -d "\${2%/*}" ] || (umask 077; mkdir -p "\${2%/*}") || exit 1
trap 'rm -f -- "$2"' EXIT
: > "$2" || exit 1
{ { "$3" -c "$1" 3>&- 4>&-; printf '%s\\n' "$?" > "$2"; } 2>&1 >&3 | cat >&4; } 3>&1 4>&2 | cat
read -r code < "$2"
exit "$code"`;

const activityCommand = (command: string, path: string, shell = "sh") =>
  `sh -c ${quote(activityScript)} sh ${quote(command)} ${quote(path)} ${quote(shell)}`;

// procActivity adapters: the tagged outer shell waits for the command's own shell, so a command that
// execs into a program that clears its environment (sudo, env -i) still has a tagged parent while it runs.
// Tagged cat relays carry stdout and stderr, so a background child that cleared its environment but
// holds the output keeps a tagged reader alive until it closes. The status returns on fd 6, not a file.
const taggedScript = `exec 7>&1
c=$({ { { "$2" -c "$1" 3>&- 4>&- 6>&- 7>&-; echo "$?" >&6; } 2>&1 >&3 | cat >&4; } 3>&1 4>&2 | cat >&7; } 6>&1)
exit "\${c:-1}"`;

const taggedCommand = (command: string, shell = "sh") =>
  `sh -c ${quote(taggedScript)} sh ${quote(command)} ${quote(shell)}`;

/**
 * Idle scan for procActivity adapters. Exit 0 only when every live process is readable and none carries
 * the tag; any other outcome means busy. Processes the exec user cannot read are re-read through
 * passwordless sudo (root reads root-owned processes); a process nobody can read keeps the sandbox busy.
 */
export const activityScanCommand = `t=${activityTag}=1
set -- /proc/[0-9]*/environ
[ -e "$1" ] || exit 2
grep -s -q -a -F -e "$t" -- "$@"; c=$?
[ "$c" = 0 ] && exit 10
[ "$c" = 1 ] && exit 0
[ "$c" = 2 ] || exit 2
u=
for f in "$@"; do
  grep -s -q -a -F -e "$t" -- "$f"; c=$?
  [ "$c" = 0 ] && exit 10
  [ "$c" = 2 ] && [ -d "\${f%/environ}" ] && u="$u $f"
done
[ -z "$u" ] && exit 0
[ "$(id -u)" = 0 ] && exit 11
sudo -n sh -c 'for f; do grep -s -q -a -F -e "$0" -- "$f"; c=$?; [ "$c" = 0 ] && exit 10; [ "$c" = 2 ] && [ -d "\${f%/environ}" ] && exit 11; done; exit 0' "$t" $u </dev/null 2>/dev/null`;

// Guest markers cover independent SDK clients after launch. This registry also
// covers transport setup/queueing before the guest can publish its marker.
const activeRuns = new Map<string, Map<string, number>>();

export const isRunActive = (provider: string, id: string) =>
  (activeRuns.get(provider)?.get(id) ?? 0) > 0;

function trackRun(provider: string, id: string) {
  let runs = activeRuns.get(provider);

  if (!runs) {
    runs = new Map();
    activeRuns.set(provider, runs);
  }

  const counts = runs;
  counts.set(id, (counts.get(id) ?? 0) + 1);

  return () => {
    const count = (counts.get(id) ?? 1) - 1;

    if (count) counts.set(id, count);
    else counts.delete(id);

    if (!counts.size) activeRuns.delete(provider);
  };
}

export class BufferCap {
  private headParts: Buffer[] = [];
  private headBytes = 0;
  private tailParts: (Buffer | undefined)[] = [];
  private tailHead = 0;
  private tailBytes = 0;
  total = 0;
  constructor(readonly limit: number) {}
  add(text: string) {
    const data = Buffer.from(text);
    this.total += data.length;
    const headSize = Math.ceil(this.limit / 2);
    const tailLimit = this.limit - headSize;
    const take = Math.min(data.length, headSize - this.headBytes);

    if (take > 0) {
      this.headParts.push(take === data.length ? data : Buffer.from(data.subarray(0, take)));
      this.headBytes += take;
    }

    const rest = take > 0 ? data.subarray(take) : data;

    if (rest.length > 0 && tailLimit > 0) {
      if (rest.length >= tailLimit) {
        this.tailParts = [Buffer.from(rest.subarray(rest.length - tailLimit))];
        this.tailHead = 0;
        this.tailBytes = tailLimit;
      } else {
        this.tailParts.push(take > 0 ? Buffer.from(rest) : rest);
        this.tailBytes += rest.length;

        while (this.tailBytes > tailLimit && this.tailHead < this.tailParts.length) {
          const front = this.tailParts[this.tailHead];

          if (!front) {
            this.tailHead += 1;
            continue;
          }

          const excess = this.tailBytes - tailLimit;

          if (front.length <= excess) {
            this.tailBytes -= front.length;
            this.tailParts[this.tailHead] = undefined;
            this.tailHead += 1;
          } else {
            this.tailParts[this.tailHead] = front.subarray(excess);
            this.tailBytes -= excess;
          }
        }

        if (this.tailHead >= this.tailParts.length) {
          this.tailParts.length = 0;
          this.tailHead = 0;
        } else if (this.tailHead > 1024 && this.tailHead * 2 >= this.tailParts.length) {
          this.tailParts = this.tailParts.slice(this.tailHead);
          this.tailHead = 0;
        }
      }
    }
  }
  get truncated() {
    return this.total > this.limit;
  }
  text() {
    const headBuf = this.headParts.length
      ? Buffer.concat(this.headParts, this.headBytes)
      : Buffer.alloc(0);

    const tailSlice: Buffer[] = [];

    for (let i = this.tailHead; i < this.tailParts.length; i++) {
      const part = this.tailParts[i];

      if (part) tailSlice.push(part);
    }

    const tailBuf = tailSlice.length ? Buffer.concat(tailSlice, this.tailBytes) : Buffer.alloc(0);

    if (!this.truncated) return Buffer.concat([headBuf, tailBuf]).toString();
    // Decode the head in streaming mode to discard an incomplete trailing code point.
    const head = new TextDecoder().decode(headBuf, { stream: true });
    let start = 0;

    while (start < tailBuf.length && ((tailBuf[start] ?? 0) & 0xc0) === 0x80) start++;
    const tail = tailBuf.subarray(start).toString();

    return (
      head +
      `\n[${this.total - Buffer.byteLength(head) - Buffer.byteLength(tail)} bytes cut]\n` +
      tail
    );
  }
}

/** Bounded independent subscriptions; slow consumers see the most recent 1 MB. */
export class OutputBus {
  private listeners = new Set<(chunk?: OutputChunk) => void>();
  private ended = false;
  private failure: SandboxError | undefined;
  emit(chunk: OutputChunk) {
    for (const listener of this.listeners) listener(chunk);
  }
  fail(error: SandboxError) {
    this.failure = error;
    this.end();
  }
  end() {
    this.ended = true;

    for (const listener of this.listeners) listener();
  }
  async *stream(): AsyncGenerator<OutputChunk> {
    const queue: (OutputChunk | undefined)[] = [];
    let head = 0;
    let bytes = 0;
    let wake = () => {};

    const dequeue = (): OutputChunk | undefined => {
      if (head >= queue.length) return undefined;
      const item = queue[head];
      queue[head++] = undefined;

      if (head >= queue.length) {
        queue.length = 0;
        head = 0;
      } else if (head >= 1024 && head * 2 >= queue.length) {
        queue.splice(0, head);
        head = 0;
      }

      return item;
    };

    const listener = (chunk?: OutputChunk) => {
      if (chunk) {
        let text = chunk.text;

        if (Buffer.byteLength(text) > 1_048_576) {
          const tail = Buffer.from(text).subarray(-1_048_576);
          let start = 0;

          while (start < tail.length && ((tail[start] ?? 0) & 0xc0) === 0x80) start++;
          text = tail.subarray(start).toString();
        }

        queue.push({ ...chunk, text });
        bytes += Buffer.byteLength(text);

        while (bytes > 1_048_576 && queue.length - head > 1)
          bytes -= Buffer.byteLength(dequeue()?.text ?? "");
      }

      wake();
    };

    this.listeners.add(listener);

    try {
      while (!this.ended || head < queue.length) {
        const next = dequeue();

        if (next) {
          bytes -= Buffer.byteLength(next.text);
          yield next;
        } else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }

      if (this.failure) throw this.failure;
    } finally {
      queue.length = 0;
      head = 0;
      bytes = 0;
      this.listeners.delete(listener);
    }
  }
}

/** `guard` runs before each command: it throws when the handle is closed and waits for secret recovery. baseEnv is read per command. */
export function makeRun(
  provider: Provider,
  id: string,
  redactor: Redactor,
  baseEnv: Record<string, string>,
  count: (bytes: number) => void,
  guard: () => void | Promise<void> = () => {},
) {
  return (command: string, initial: RunOptions = {}): RunHandle => {
    let options = { ...initial };
    let promise: Promise<RunResult> | undefined;
    const bus = new OutputBus();

    const begin = (streaming = false) =>
      (promise ??= execute(streaming).catch((error) => {
        const mapped = redactor.error(error, provider.name, id);
        bus.fail(mapped);
        throw mapped;
      }));

    async function execute(streaming: boolean): Promise<RunResult> {
      await guard();
      const timeoutMs = options.timeoutMs ?? 120_000;
      const max = options.maxOutputBytes ?? 1_048_576;

      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(max) || max < 1)
        invalid("timeoutMs and maxOutputBytes must be positive");
      const cwd = pathOf(options.cwd);
      const started = Date.now();

      const stdout = new BufferCap(max),
        stderr = new BufferCap(max),
        output = new BufferCap(max * 2);

      const controller = new AbortController();
      let timedOut = options.signal?.aborted ?? false;

      const abort = () => {
        timedOut = true;
        controller.abort();
      };

      options.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      const activePath = `/tmp/.sandbox-sdk/runs/${crypto.randomUUID()}`;
      let completed = false;
      const finish = trackRun(provider.name, id);

      const interleaved = chunkRedactor(
        redactor,
        (chunk) => {
          output.add(chunk.text);
          bus.emit(chunk);
        },
        true,
      );

      const filter = chunkRedactor(redactor, (chunk) => {
        (chunk.stream === "stdout" ? stdout : stderr).add(chunk.text);
        interleaved.push(chunk);
      });

      try {
        if (timedOut) controller.abort();

        const result = timedOut
          ? { exitCode: null, timedOut: true }
          : await provider.exec(id, {
              // Pass the exact command as an argument to a fresh shell. User exit,
              // exec, traps, comments and stdin cannot bypass the parent's cleanup.
              // Marker mode drains both pipes before removing activity: background descendants
              // can retain stdout/stderr after the command shell itself has exited. procActivity
              // adapters need no marker: idle scans find the tag in every live descendant.
              command: provider.inlineActivity
                ? command
                : provider.procActivity
                  ? taggedCommand(command, provider.commandShell)
                  : activityCommand(command, activePath, provider.commandShell),
              cwd,
              env: { ...baseEnv, ...options.env, ...defaults },
              stdin: options.stdin,
              timeoutMs,
              signal: controller.signal,
              streaming,
              envMode: options.env === undefined ? "sandbox" : undefined,
              activityPath: provider.inlineActivity ? activePath : undefined,
              onChunk: (chunk) => filter.push(chunk),
            });

        completed =
          result.exitCode !== null &&
          result.exitCode >= 0 &&
          result.exitCode < 128 &&
          !result.timedOut &&
          !controller.signal.aborted;
        timedOut ||= result.timedOut;
        filter.flush();
        interleaved.flush();
        count(stdout.total + stderr.total);

        return {
          ok: !timedOut && result.exitCode === 0,
          exitCode: timedOut ? null : result.exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          output: output.text(),
          durationMs: Date.now() - started,
          truncated:
            stdout.truncated ||
            stderr.truncated ||
            output.truncated ||
            filter.truncated ||
            interleaved.truncated,
          timedOut,
          cwd,
          command: redactor.text(command),
        };
      } catch (error) {
        filter.flush();
        interleaved.flush();
        const mapped = redactor.error(error, provider.name, id);
        bus.fail(mapped);
        throw mapped;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);

        // Backup for the guest's own EXIT trap, which a kill can skip. The run's result stands.
        if (!completed && !provider.inlineActivity && !provider.procActivity)
          await Promise.resolve()
            .then(() => provider.files.remove(id, activePath, { recursive: true }))
            .catch(() => {});
        finish();
        bus.end();
      }
    }

    const handle: RunHandle = {
      [Symbol.toStringTag]: "RunHandle",
      // oxlint-disable-next-line unicorn/no-thenable -- RunHandle is a lazy Promise in the public API.
      then(onfulfilled, onrejected) {
        return begin().then(onfulfilled, onrejected);
      },
      catch(onrejected) {
        return begin().catch(onrejected);
      },
      finally(onfinally) {
        return begin().finally(onfinally);
      },
      [Symbol.asyncIterator]() {
        const iterator = bus.stream();
        // Subscribe before synchronous provider chunks can arrive.
        const first = iterator.next();
        // The bus rethrows the failure to the iterator.
        void begin(true).catch(() => {});
        let initial = true;

        return {
          next: () => {
            if (initial) {
              initial = false;

              return first;
            }

            return iterator.next();
          },
          return: () => iterator.return(undefined),
        };
      },
      cwd(path) {
        if (promise) invalid("Run already started");
        options.cwd = path;

        return handle;
      },
      env(env) {
        if (promise) invalid("Run already started");
        options.env = { ...options.env, ...env };

        return handle;
      },
      timeout(timeoutMs) {
        if (promise) invalid("Run already started");
        options.timeoutMs = timeoutMs;

        return handle;
      },
    };

    return handle;
  };
}
