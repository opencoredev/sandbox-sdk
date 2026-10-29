import { z } from "zod";

const missingFile = z.object({ code: z.literal("ENOENT") });

/** Whether a thrown filesystem error means the file does not exist. */
export function isMissingFile(cause: unknown) {
  return missingFile.safeParse(cause).success;
}
