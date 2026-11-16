/**
 * Changing the shared settled-charge audit file (audit-file.ts) without losing another writer's
 * change. Several agents add entries to one file, so an update holds a lock directory beside it
 * (`<file>.lock`) while it reads, merges and renames. Every automated writer must go through this
 * function: only writers that take the lock are safe from each other. Before the rename it reads
 * the file again and merges over if the bytes changed, which catches most writes that ignored the
 * lock (a hand edit), but one landing between that read and the rename is still lost. The rename
 * is atomic, so a reader never sees half a file. A crashed writer leaves the lock behind; later
 * callers fail after 30 s, and the lock may be removed only once its writer is known to be gone.
 */
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { auditFileSchema, type AuditFile } from "./audit-file.js";

const LOCK_WAIT_MS = 30_000;
const LOCK_POLL_MS = 100;
const MAX_MERGES = 5;

const lockTaken = z.object({ code: z.literal("EEXIST") });

async function lock(path: string): Promise<() => Promise<void>> {
  const dir = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      await mkdir(dir);

      return () => rmdir(dir);
    } catch (error) {
      if (!lockTaken.safeParse(error).success) throw error;

      if (Date.now() > deadline)
        throw new Error(`${dir} has been held for ${LOCK_WAIT_MS / 1000} s; remove it if stale`);
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

/**
 * Apply `update` to the audit file at `path` and write the result. `update` gets the file as it is
 * now and returns the whole new file; it may run more than once, so it must not have side effects.
 */
export async function updateAuditFile(
  path: string,
  update: (current: AuditFile) => AuditFile,
): Promise<AuditFile> {
  const release = await lock(path);

  try {
    for (let merge = 0; merge < MAX_MERGES; merge++) {
      const before = await readFile(path, "utf8");
      const next = auditFileSchema.parse(update(auditFileSchema.parse(JSON.parse(before))));
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${merge}.tmp`);

      await writeFile(tmp, JSON.stringify(next, null, 2) + "\n");

      if ((await readFile(path, "utf8")) !== before) {
        await unlink(tmp);
        continue;
      }

      await rename(tmp, path);

      return next;
    }

    throw new Error(`${path} kept changing during ${MAX_MERGES} merges; try again`);
  } finally {
    await release();
  }
}
