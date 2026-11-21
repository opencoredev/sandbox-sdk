/**
 * Archil's control plane as the bench reads it directly: the existence check and the per-sandbox
 * usage meter. The adapter goes through `disk`; these reads are plain GETs so they can never wake,
 * start or change a sandbox.
 */
import { z } from "zod";

/** Public regions and their control planes, as `disk` 1.12.1 maps them (src/regions.ts). */
const controlPlanes = new Map([
  ["aws-us-east-1", "https://control.green.us-east-1.aws.prod.archil.com"],
  ["aws-us-west-2", "https://control.green.us-west-2.aws.prod.archil.com"],
  ["aws-eu-west-1", "https://control.green.eu-west-1.aws.prod.archil.com"],
  ["gcp-us-central1", "https://control.blue.us-central1.gcp.prod.archil.com"],
]);

/** The adapter's default region when ARCHIL_REGION is unset. */
export const archilDefaultRegion = "aws-us-east-1";

/** The control plane for `ARCHIL_REGION` (keys are region-scoped), or an error naming the regions. */
export function archilControlUrl(env: NodeJS.ProcessEnv): string {
  const region = env.ARCHIL_REGION?.trim() || archilDefaultRegion;
  const url = controlPlanes.get(region);

  if (url === undefined)
    throw new Error(
      `Unknown ARCHIL_REGION "${region}"; use one of ${[...controlPlanes.keys()].join(", ")}`,
    );

  return url;
}

/** `GET /api/sandboxes/{id}`, the fields the existence and billing checks read. */
const sandbox = z.object({ id: z.string(), status: z.string() });

/**
 * `GET /api/sandboxes/{id}/usage` (https://docs.archil.com/administration/billing.md): usage since
 * creation, updated about once a minute, readable for 90 days, priced before included allowances
 * and prepaid credit.
 */
const usage = z.object({
  vcpu_hours: z.number().finite().nonnegative(),
  memory_gib_hours: z.number().finite().nonnegative(),
  rates: z.object({
    vcpu_hour: z.number().finite().nonnegative(),
    memory_gib_hour: z.number().finite().nonnegative(),
  }),
  cost: z.number().finite().nonnegative(),
});

// Archil wraps every answer as `{ success, data }`; a body without the wrapper is read as is.

/** A sandbox answer, unwrapped. */
export const archilSandboxBody = z.union([
  z.object({ success: z.literal(true), data: sandbox }).transform((body) => body.data),
  sandbox,
]);

/** A usage answer, unwrapped. */
export const archilUsageBody = z.union([
  z.object({ success: z.literal(true), data: usage }).transform((body) => body.data),
  usage,
]);

export type ArchilUsage = z.infer<typeof usage>;
