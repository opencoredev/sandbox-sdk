import { open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** Replace the journal only after its complete contents have reached disk. */
export async function writeOwnership(path: string, data: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); }
    finally { await directory.close(); }
  } finally { await rm(temporary, { force: true }); }
}
