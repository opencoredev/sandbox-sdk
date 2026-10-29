import type { ExecInput, ExecResult } from "../provider.js";
import { SandboxError, type ErrorCode } from "../errors.js";
import { python } from "./guest.js";
import { quote } from "./shell.js";

/** A guest that runs paged supervisors: Freestyle and Superserve. */
export interface PagedGuest {
  raw(command: string): Promise<string>;
  read(
    path: string,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
}

export interface PagedExecution {
  guest: PagedGuest;
  input: ExecInput;
  /** Runs the provider's supervisor for `root` and returns its first response page. */
  launch: (root: string, signal: AbortSignal) => Promise<string>;
  /** Builds the provider's own error, so messages keep its name and advice. */
  fail: (message: string, code?: ErrorCode) => SandboxError;
}

type Decoders = { stdout: TextDecoder; stderr: TextDecoder };

const cancelProgram = `import os,sys,fcntl,signal,shutil,time,json
root=sys.argv[1]
os.makedirs(root,mode=0o700,exist_ok=True)
with open(root+'/lock','w') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX)
 with open(root+'/cancelled','w') as f: f.write('1')
 try:
  with open(root+'/pid') as f: pid=int(f.read())
 except FileNotFoundError: pid=None
 if pid and not os.path.exists(root+'/exit'):
  try: os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError: pass
# Wait for reaping and pipe drainage before recovering the bounded output tail.
end=time.monotonic()+2
while pid and not os.path.exists(root+'/exit') and time.monotonic()<end: time.sleep(.01)
if pid and not os.path.exists(root+'/exit'): sys.exit(1)
chunks=[]
start=int(sys.argv[2])
try:
 with open(root+'/out','rb') as f:
  size=os.fstat(f.fileno()).st_size
  delivered=int(sys.argv[2])
  start=max(delivered,size-65536); f.seek(start)
  if start>delivered: f.readline(); start=f.tell()
  chunks=[json.loads(line) for line in f]
except FileNotFoundError: pass
print(json.dumps(dict(chunks=chunks,offset=start)))
# Retain a tombstone if a delayed supervisor can still arrive.
if pid: shutil.rmtree(root,ignore_errors=True)`;

/** Runs a command through a supervisor that answers with its first output page,
 * then reads the rest of its output with bounded ranged reads.
 */
export async function pagedExecute(execution: PagedExecution): Promise<ExecResult> {
  const { guest: g, input, launch, fail } = execution;

  if (input.signal?.aborted) return { exitCode: null, timedOut: true };
  const root = `/tmp/.sandbox-sdk/run-${crypto.randomUUID()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  const signal = input.signal
    ? AbortSignal.any([input.signal, controller.signal])
    : controller.signal;

  let delivered = 0;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };

  async function cancel() {
    // The lock makes cancellation safe even if the exec has not started yet.
    // No PID means no process to kill, not permission to delete the whole VM.
    const text = await g.raw(python(cancelProgram, root, String(delivered)));
    const recovery: unknown = JSON.parse(text);

    if (
      !recovery ||
      typeof recovery !== "object" ||
      !("chunks" in recovery) ||
      !Array.isArray(recovery.chunks) ||
      recovery.chunks.length > 65536 ||
      !("offset" in recovery) ||
      typeof recovery.offset !== "number" ||
      !Number.isSafeInteger(recovery.offset) ||
      recovery.offset < delivered
    )
      throw fail("Invalid cancellation output");

    // A contiguous recovery must retain partial UTF-8 bytes. If the bounded
    // tail skipped records, flush them before starting a new decoding segment.
    if (recovery.offset !== delivered) flush(decoders, input);

    for (const chunk of recovery.chunks) emitRecord(chunk, decoders, input, fail);
    flush(decoders, input);
  }

  let paged = false;

  async function recoverCancellation(): Promise<ExecResult> {
    try {
      await cancel();
    } catch {
      throw fail("Process cancellation could not be confirmed", "outcome_unknown");
    }

    paged = false;

    return { exitCode: null, timedOut: true };
  }

  try {
    let text: string;

    try {
      text = await launch(root, signal);
    } catch (error) {
      // A rejected bootstrap (such as a template without Python) runs nothing,
      // so there is no process to cancel and the actionable error must surface.
      if (error instanceof SandboxError && error.code === "unsupported") throw error;

      try {
        await cancel();
      } catch {
        throw fail("Process cancellation could not be confirmed", "outcome_unknown");
      }

      if (signal.aborted) return { exitCode: null, timedOut: true };
      throw error;
    }

    const page: unknown = JSON.parse(text);

    if (
      !page ||
      typeof page !== "object" ||
      !("result" in page) ||
      !page.result ||
      typeof page.result !== "object" ||
      !("exitCode" in page.result) ||
      (page.result.exitCode !== null && typeof page.result.exitCode !== "number") ||
      !("timedOut" in page.result) ||
      typeof page.result.timedOut !== "boolean" ||
      !("chunks" in page) ||
      !Array.isArray(page.chunks) ||
      page.chunks.length > 3 ||
      !("offset" in page) ||
      typeof page.offset !== "number" ||
      !Number.isSafeInteger(page.offset) ||
      page.offset < 0 ||
      !("size" in page) ||
      typeof page.size !== "number" ||
      !Number.isSafeInteger(page.size) ||
      page.size < page.offset
    )
      throw fail("Invalid command response");
    const emit = (value: unknown) => emitRecord(value, decoders, input, fail);
    paged = page.offset < page.size || page.result.timedOut;

    if (signal.aborted) return await recoverCancellation();
    page.chunks.forEach(emit);
    delivered = page.offset;
    let offset = page.offset;
    let pending = "";

    while (offset < page.size) {
      if (signal.aborted) return await recoverCancellation();
      let data: Uint8Array;

      try {
        data = await g.read(
          root + "/out",
          { offset, length: Math.min(65536, page.size - offset) },
          signal,
        );
      } catch (error) {
        if (signal.aborted) return await recoverCancellation();
        throw error;
      }

      if (signal.aborted) return await recoverCancellation();

      if (!data.length) throw fail("Incomplete output read");
      offset += data.length;
      pending += new TextDecoder().decode(data);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach((line) => {
        emit(JSON.parse(line));
        delivered += Buffer.byteLength(line) + 1;
      });
    }

    if (pending) throw fail("Incomplete output record");
    flush(decoders, input);

    return { exitCode: page.result.exitCode, timedOut: page.result.timedOut };
  } finally {
    clearTimeout(timer);

    if (paged) await g.raw(`rm -rf -- ${quote(root)}`).catch(() => {});
  }
}

function emitRecord(
  value: unknown,
  decoders: Decoders,
  input: ExecInput,
  fail: PagedExecution["fail"],
) {
  if (
    !Array.isArray(value) ||
    (value[0] !== "stdout" && value[0] !== "stderr") ||
    typeof value[1] !== "string" ||
    value[1].length > 21848
  )
    throw fail("Invalid output record");
  const stream = value[0] === "stdout" ? "stdout" : "stderr";
  const text = decoders[stream].decode(Buffer.from(value[1], "hex"), { stream: true });

  if (text) input.onChunk({ stream, text });
}

function flush(decoders: Decoders, input: ExecInput) {
  for (const stream of ["stdout", "stderr"] satisfies ("stdout" | "stderr")[]) {
    const text = decoders[stream].decode();

    if (text) input.onChunk({ stream, text });
  }
}
