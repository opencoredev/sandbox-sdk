import { parseArgs } from "node:util";
import { z } from "zod";

const positive = z.coerce.number().int().min(1).max(1_000_000);
const schema = z.object({
  providers: z
    .string()
    .default("memory")
    .transform((value) => [...new Set(value.split(","))])
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1)),
  runs: positive.default(50),
  warmup: z.coerce.number().int().min(0).max(1000).default(2),
  concurrency: positive.max(32).default(1),
  "timeout-ms": positive.default(30_000),
  "max-sandboxes": z.coerce.number().int().min(0).max(1_000_000).default(100),
  yes: z.boolean().default(false),
  out: z.string().min(1).default("results"),
});
export type Config = z.infer<typeof schema>;
export function parseConfig(args: string[]): Config {
  const { values } = parseArgs({
    args,
    options: {
      providers: { type: "string" },
      runs: { type: "string" },
      warmup: { type: "string" },
      concurrency: { type: "string" },
      "timeout-ms": { type: "string" },
      "max-sandboxes": { type: "string" },
      yes: { type: "boolean" },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return schema.parse(values);
}
