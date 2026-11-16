/**
 * Vercel's settled sandbox charges for one charge day, from the team's FOCUS export
 * (`GET /api/v1/billing/charges?teamId=…&from=…&to=…`, one JSON object per line), checked to hold
 * only one run's sandboxes so its total can be set against our meters (`audit-file.ts`).
 *
 * The day is isolated only when every line that charges or consumes anything in the Sandbox
 * category is for exactly that day, is tagged with our project, and the day's Sandbox Creations
 * equal the run's sandbox count. Any other sandbox activity on the team, a line for another period
 * or a Sandbox service this file does not know makes the day unusable, never a partial total.
 */
import { z } from "zod";

/** Every Sandbox-category service Vercel bills (https://vercel.com/docs/sandbox/pricing). */
export const SANDBOX_SERVICES = [
  "Sandbox Active CPU",
  "Sandbox Provisioned Memory",
  "Sandbox Creations",
  "Sandbox Data Transfer",
  "Snapshot Storage",
  "Drive Storage",
  "Drive Reads",
  "Drive Writes",
] as const;

export type SandboxService = (typeof SANDBOX_SERVICES)[number];

const amount = z.number().finite();

/** The FOCUS fields this check reads; Vercel sends more, which are ignored. */
const chargeLineSchema = z.object({
  BilledCost: amount,
  EffectiveCost: amount,
  BillingCurrency: z.string(),
  ChargePeriodStart: z.iso.datetime(),
  ChargePeriodEnd: z.iso.datetime(),
  ServiceName: z.string(),
  ServiceCategory: z.string(),
  // Null on purchases (the Pro subscription line); a Sandbox line without them is refused below.
  ConsumedQuantity: amount.nullable(),
  ConsumedUnit: z.string().nullable(),
  RegionId: z.string().nullable().optional(),
  SubAccountId: z.string(),
  Tags: z.record(z.string(), z.string()),
});

export type ChargeLine = z.infer<typeof chargeLineSchema>;

export function parseChargeLines(jsonl: string): ChargeLine[] {
  return jsonl
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      const parsed = chargeLineSchema.safeParse(JSON.parse(line));

      if (!parsed.success) throw new Error(`charges line ${i + 1}: ${parsed.error.message}`);

      return parsed.data;
    });
}

export interface ChargeDayInput {
  readonly lines: readonly ChargeLine[];
  readonly teamId: string;
  readonly project: { readonly id: string; readonly name: string };
  /** One whole charge day, as Vercel's periods are (08:00 to 08:00 UTC). */
  readonly period: { readonly start: string; readonly end: string };
  /** Distinct sandboxes the run created. */
  readonly sandboxes: number;
}

export interface ServiceTotal {
  readonly service: SandboxService;
  readonly usd: number;
  readonly quantity: number;
  readonly unit: string;
}

export type ChargeDay =
  | {
      readonly kind: "isolated";
      /** Sum of BilledCost over every Sandbox-category line of the day. */
      readonly settledUSD: number;
      readonly services: readonly ServiceTotal[];
      readonly creations: number;
      readonly isolation: string;
    }
  | { readonly kind: "not-isolated"; readonly reasons: readonly [string, ...string[]] };

const isActive = (line: ChargeLine) =>
  line.BilledCost !== 0 || line.EffectiveCost !== 0 || (line.ConsumedQuantity ?? 0) !== 0;

/** The day's sandbox charges, or every reason they cannot be tied to the run alone. */
export function sandboxChargeDay(input: ChargeDayInput): ChargeDay {
  const reasons: string[] = [];
  const known = new Set<string>(SANDBOX_SERVICES);
  const { start, end } = input.period;
  const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

  if (Date.parse(end) - Date.parse(start) !== 24 * 3600 * 1000)
    reasons.push(`the period ${start} to ${end} is not one charge day`);

  const sandbox = input.lines.filter(
    (line) => line.ServiceCategory === "Sandbox" || known.has(line.ServiceName),
  );

  if (sandbox.length === 0) reasons.push("the export has no Sandbox lines at all");

  for (const line of sandbox) {
    const label = `${line.ServiceName} (${line.RegionId ?? "no region"})`;

    if (!known.has(line.ServiceName)) reasons.push(`unknown Sandbox service ${label}`);

    if (!sameInstant(line.ChargePeriodStart, start) || !sameInstant(line.ChargePeriodEnd, end))
      reasons.push(`${label} is for ${line.ChargePeriodStart} to ${line.ChargePeriodEnd}`);

    if (line.SubAccountId !== input.teamId)
      reasons.push(`${label} is for team ${line.SubAccountId}`);

    if (line.BillingCurrency !== "USD")
      reasons.push(`${label} is billed in ${line.BillingCurrency}`);

    if (line.ConsumedQuantity === null || line.ConsumedUnit === null)
      reasons.push(`${label} has no consumed quantity or unit`);

    if (!isActive(line)) continue;

    if (line.Tags.ProjectId !== input.project.id || line.Tags.ProjectName !== input.project.name)
      reasons.push(
        `${label} charges ${line.BilledCost} USD to project ${line.Tags.ProjectName ?? "(untagged)"}, not ${input.project.name}`,
      );
  }

  const services = SANDBOX_SERVICES.map((service): ServiceTotal => {
    const own = sandbox.filter((line) => line.ServiceName === service);
    const units = [...new Set(own.filter(isActive).map((line) => line.ConsumedUnit))];

    if (units.length > 1) reasons.push(`${service} mixes units ${units.join(", ")}`);

    return {
      service,
      usd: own.reduce((sum, line) => sum + line.BilledCost, 0),
      quantity: own.reduce((sum, line) => sum + (line.ConsumedQuantity ?? 0), 0),
      unit: units[0] ?? own[0]?.ConsumedUnit ?? "",
    };
  });

  const creations = services.find((s) => s.service === "Sandbox Creations")?.quantity ?? 0;

  if (creations !== input.sandboxes)
    reasons.push(
      `the day has ${creations} sandbox creations and the run created ${input.sandboxes} sandboxes`,
    );

  const [first, ...rest] = reasons;

  if (first !== undefined) return { kind: "not-isolated", reasons: [first, ...rest] };

  return {
    kind: "isolated",
    settledUSD: sandbox.reduce((sum, line) => sum + line.BilledCost, 0),
    services,
    creations,
    isolation: `Every Sandbox-category line of team ${input.teamId} that charges or consumes anything in ${start} to ${end} is tagged project ${input.project.name} (${input.project.id}), and the day's Sandbox Creations (${creations}) equal the run's ${input.sandboxes} sandboxes`,
  };
}
