/**
 * A sandbox that is this machine: commands run in bash, files are written atomically (a running
 * copy of the binary keeps its inode, so parallel boxes never hit ETXTBSY). The fairness checks run
 * against it end to end with the real sbx-native binary.
 */
import { spawn } from "node:child_process";
import { chmod, rename, writeFile } from "node:fs/promises";
import type {
  Box,
  CommandResult,
  OpenSession,
  RunOptions,
  Session,
} from "../../src/fairness/framework.js";

let counter = 0;

export function hostBox(
  options: { readonly env?: NodeJS.ProcessEnv; readonly id?: string } = {},
): Box & {
  readonly destroyed: () => boolean;
} {
  let destroyed = false;
  const id = options.id ?? `host-${process.pid}-${++counter}`;

  return {
    id,
    destroyed: () => destroyed,
    run: (command: string, run: RunOptions) =>
      new Promise<CommandResult>((done, fail) => {
        const child = spawn("bash", ["-c", command], {
          cwd: "/",
          env: { ...process.env, ...options.env },
          signal: run.signal,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, run.timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", (error) => {
          clearTimeout(timer);
          fail(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          done({ ok: code === 0, exitCode: code, stdout, stderr, timedOut });
        });
      }),
    write: async (path, data) => {
      const temporary = `${path}.${process.pid}.${++counter}.tmp`;
      await writeFile(temporary, data);
      await chmod(temporary, 0o755);
      await rename(temporary, path);
    },
    destroy: async () => {
      destroyed = true;
    },
  };
}

/** A session whose creates make host boxes, recording them; `leftovers` lists none. */
export function hostSession(options: { readonly env?: NodeJS.ProcessEnv } = {}) {
  const boxes: ReturnType<typeof hostBox>[] = [];

  const session: Session = {
    create: async () => {
      const box = hostBox(options);
      boxes.push(box);

      return box;
    },
    leftovers: async () => [],
    destroyById: async () => {},
  };

  const open: OpenSession = async () => ({ kind: "ready", session });

  return { open, boxes };
}
