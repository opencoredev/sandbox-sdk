import { parseArgs } from "node:util";
import { z } from "zod";
const integer = z.coerce.number().int().positive();
const overrides = z
  .string()
  .default("")
  .transform((value) =>
    Object.fromEntries(
      value
        .split(",")
        .filter(Boolean)
        .map((entry) => {
          const [name, raw] = entry.split("=");
          if (!name || !raw || !/^[a-z][a-z0-9-]*$/.test(name))
            throw new Error("Expected provider=number");
          return [name, z.coerce.number().nonnegative().finite().parse(raw)];
        }),
    ),
  );
const schema = z.object({
  providers: z
    .string()
    .default("local,e2b,daytona,upstash,boat,boxd,freestyle,tenki,railway,vercel")
    .transform((v) => [...new Set(v.split(","))])
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]*$/))),
  runs: integer.default(2),
  "workload-runs": integer.optional(),
  concurrency: integer.max(32).default(4),
  "provider-concurrency": integer.max(32).default(1),
  "timeout-ms": integer.max(900000).default(180000),
  seed: z.coerce.number().int().default(45),
  "max-sandboxes": integer.default(100),
  "max-dollars": z.coerce.number().positive().finite().default(5),
  "provider-max-sandboxes": overrides,
  "provider-max-dollars": overrides,
  "account-limits": overrides,
  bursts: z
    .string()
    .default("3")
    .transform((v) => (v ? v.split(",").map((n) => integer.max(50).parse(n)) : [])),
  scenarios: z
    .string()
    .default("all")
    .transform((v) => v.split(",")),
  out: z.string().default("results/v2"),
  run: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .default(`sbx45-${Date.now()}`),
});
export type ConfigV2 = z.infer<typeof schema>;
export function parseV2(args: string[]) {
  const options: Record<string, { type: "string" }> = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, { type: "string" }]),
  );
  return schema.parse(parseArgs({ args, options, strict: true }).values);
}
