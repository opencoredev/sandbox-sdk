import type { ExecInput, ExecResult } from "../../provider.js";
import { cachedPython, python } from "../../shared/guest.js";
import { pagedExecute, type PagedGuest } from "../../shared/paged-exec.js";
import { quote } from "../../shared/shell.js";
import { guestSpec } from "../../shared/wire.js";
import { supervisor } from "../superserve/execute.js";
import { failure } from "./errors.js";

// Superserve's paged supervisor: it takes its spec as a hex argument or on stdin, writes output
// records to a file and answers with the first page. Beam's exec has no stdin, so a spec too large
// for one argument is uploaded and redirected in.
const program = cachedPython(supervisor);

// Linux caps one argument at 128 KiB, and Beam runs the whole `sh -c` script as one.
const maxInline = 96 * 1024;

export interface BeamGuest extends PagedGuest {
  readonly id: string;
  /** Runs `sh -c script` to completion within `timeoutMs` and returns its stdout. */
  shell(script: string, timeoutMs: number, signal?: AbortSignal): Promise<string>;
  upload(path: string, bytes: Uint8Array): Promise<void>;
}

export async function execute(g: BeamGuest, input: ExecInput): Promise<ExecResult> {
  return pagedExecute({
    guest: g,
    input,
    fail: (message, code) => failure(message, code, g.id),
    launch: async (root, signal) => {
      const spec = guestSpec({
        command: input.command,
        cwd: input.cwd,
        env: input.env,
        stdin: input.stdin ?? "",
        timeoutMs: input.timeoutMs,
        activityPath: input.activityPath,
      }).toString("hex");

      const inline = `python3 -S -c ${quote(program)} ${quote(root)} ${spec}`;
      const budget = input.timeoutMs + 5000;

      if (Buffer.byteLength(inline) <= maxInline) return g.shell(inline, budget, signal);

      const path = `/tmp/.sandbox-sdk/spec-${crypto.randomUUID()}.hex`;
      await g.upload(path, new TextEncoder().encode(spec));

      return g.shell(
        `python3 -S -c ${quote(program)} ${quote(root)} <${quote(path)}; c=$?; rm -f -- ${quote(path)}; exit "$c"`,
        budget,
        signal,
      );
    },
  });
}

// Writes argv[3] bytes of argv[1] from offset argv[2] to stdout, base64 encoded.
const readRange =
  "import sys,base64; f=open(sys.argv[1],'rb'); f.seek(int(sys.argv[2])); sys.stdout.write(base64.b64encode(f.read(int(sys.argv[3]))).decode())";

/** The guest command that reads a byte range of a file as base64. */
export function rangeCommand(path: string, offset: number, length: number) {
  return python(readRange, path, String(offset), String(length));
}
