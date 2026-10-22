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
export const trackSchema = z.enum(["default", "same-spec"]);
export const sizeSchema = z.union([
  z.enum(["small", "medium", "large"]),
  z.object({ cpu: z.number().positive().finite(), memoryMb: z.number().int().positive(), diskGb: z.number().positive().finite().optional() }),
]);
const assignments = (value: string[]): Record<string, string> => Object.fromEntries(value.map(entry => {
  const match = /^([a-z][a-z0-9-]*)=(.+)$/.exec(entry);
  if (!match) throw new Error("Expected provider=value");
  return z.tuple([z.string(), z.string()]).parse([match[1], match[2]]);
}));
const sizes = z.array(z.string()).default([]).transform(value => Object.fromEntries(
  Object.entries(assignments(value)).map(([name, raw]) => {
    if (!raw) throw new Error("Expected provider=size");
    const parts = raw.split(":");
    return [name, sizeSchema.parse(parts.length === 1 ? raw : parts.length <= 3
      ? { cpu: Number(parts[0]), memoryMb: Number(parts[1]), ...(parts[2] === undefined ? {} : { diskGb: Number(parts[2]) }) }
      : null)];
  }),
));
const schema = z.object({
  track: trackSchema.default("default"),
  size: sizes,
  template: z.array(z.string()).default([]).transform(assignments),
  providers: z
    .string()
    .default("local,e2b,daytona,upstash,boat,boxd,freestyle,tenki,superserve,railway,vercel")
    .transform((v) => [...new Set(v.split(","))])
    .pipe(z.array(z.string().regex(/^[a-z][a-z0-9-]*$/))),
  runs: integer.default(2),
  "workload-runs": integer.optional(),
  "cost-runs": integer.default(10),
  concurrency: integer.max(32).default(4),
  "provider-concurrency": integer.max(32).default(1),
  "timeout-ms": integer.max(900000).default(180000),
  // How long a resource this run created or admitted may take to appear in
  // provider.list with its labels; adapters can return before listings catch up.
  // boxd's list fails whole while any account machine is mid-destroy, so other
  // suites' churn can hide an owned box for tens of seconds.
  "ownership-visibility-ms": integer.max(300000).default(120000),
  seed: z.coerce.number().int().default(45),
  "max-sandboxes": integer.default(100),
  "max-dollars": z.coerce.number().positive().finite().default(5),
  "provider-max-sandboxes": overrides,
  "provider-max-dollars": overrides,
  "account-limits": overrides,
  "burst-cohorts": integer.max(100).default(3),
  bursts: z
    .string()
    .default("3")
    .transform((v) => (v ? v.split(",").map((n) => integer.max(50).parse(n)) : [])),
  "omit-network-download": z.enum(["true", "false"]).default("false").transform(v => v === "true"),
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
  const options: Record<string, { type: "string"; multiple?: boolean }> = Object.fromEntries(
    Object.keys(schema.shape).map((key) => [key, { type: "string", ...(["size", "template"].includes(key) ? { multiple: true } : {}) }]),
  );
  const config = schema.parse(parseArgs({ args, options, strict: true }).values);
  if (config.scenarios.includes("cost") && config.scenarios.length !== 1) throw new Error("The cost suite must run alone (--scenarios cost)");
  if (config.scenarios.includes("cost") && config.providers.includes("boat") && config["cost-runs"] > 10) throw new Error("Boat cost suite allows at most 10 tasks per quota window; split collections into scheduled windows");
  return config;
}
