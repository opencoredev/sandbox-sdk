import { appendFile, rename, writeFile } from "node:fs/promises";
import { z } from "zod";

const missingFile = z.object({ code: z.literal("ENOENT") });

/** Whether a thrown filesystem error means the file does not exist. */
export function isMissingFile(cause: unknown) {
  return missingFile.safeParse(cause).success;
}

/** The writes behind run journals. Tests replace one with `vi.spyOn` to delay or fail it. */
export const journalFiles = { appendFile, writeFile, rename };
