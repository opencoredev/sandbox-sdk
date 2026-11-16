/**
 * Vercel's settled sandbox charges for one charge day, from the team's FOCUS export
 * (`GET /api/v1/billing/charges?teamId=…&from=…&to=…`, one JSON object per line), checked to hold
 * only one run's sandboxes so its total can be set against our meters (`audit-file.ts`).
 *
 * The day is isolated only when every line that charges or consumes anything in the Sandbox
 * category is for exactly that day, is tagged with our project, and the day's Sandbox Creations
 * equal the run's sandbox count. A matching count does not rule out resources that already
 * existed (an older snapshot or drive still stored, a sandbox still running), which bill without a
 * creation, so the charge day before must have no Sandbox charge or consumption at all: then
 * everything billed in the day was created in it, and every creation is ours. Any other sandbox activity on the team, a line for another period
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

/**
 * What the browser recorded when it read an export: the request, the HTTP status, and the length
 * and SHA-256 of the body exactly as received. The saved file must hash to the same value, so a
 * row lost between Vercel and the file (a truncated download, a bad copy) is caught; which rows
 * Vercel itself includes is Vercel's to answer, not this check's.
 */
export const exportReceiptSchema = z.object({
  url: z.string().min(1),
  status: z.number().int(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fetchedAt: z.iso.datetime(),
});

export type ExportReceipt = z.infer<typeof exportReceiptSchema>;

/** Hours after a charge day closes before its export is read, so late usage has landed. */
export const SETTLE_HOURS = 2;

/** Why a saved export is not the complete, settled export of `period` for `teamId`, if it is not. */
export function receiptProblems(input: {
  readonly receipt: ExportReceipt;
  readonly body: { readonly bytes: number; readonly sha256: string };
  readonly teamId: string;
  readonly period: { readonly start: string; readonly end: string };
  readonly label: string;
}): string[] {
  const { receipt, body, period, label } = input;
  const problems: string[] = [];
  const url = new URL(receipt.url, "https://vercel.com");
  const at = (name: string) => Date.parse(url.searchParams.get(name) ?? "");

  if (receipt.status !== 200) problems.push(`${label} was read with HTTP ${receipt.status}`);

  if (
    url.pathname !== "/api/v1/billing/charges" ||
    url.searchParams.get("teamId") !== input.teamId ||
    at("from") !== Date.parse(period.start) ||
    at("to") !== Date.parse(period.end)
  )
    problems.push(`${label} was read from ${receipt.url}, not ${period.start} to ${period.end}`);

  if (body.bytes !== receipt.bytes || body.sha256 !== receipt.sha256)
    problems.push(
      `${label} on disk is not the body the browser received (length or SHA-256 differs)`,
    );

  if (Date.parse(receipt.fetchedAt) < Date.parse(period.end) + SETTLE_HOURS * 3600 * 1000)
    problems.push(
      `${label} was read at ${receipt.fetchedAt}, less than ${SETTLE_HOURS} hours after ${period.end}`,
    );

  return problems;
}

export interface ChargeDayInput {
  readonly lines: readonly ChargeLine[];
  readonly teamId: string;
  readonly project: { readonly id: string; readonly name: string };
  /** One whole charge day, as Vercel's periods are (08:00 to 08:00 UTC). */
  readonly period: { readonly start: string; readonly end: string };
  /** Distinct sandboxes the run created. */
  readonly sandboxes: number;
  /**
   * The same export for the charge day just before `period`, read after that day settled (the
   * caller checks when it was read).
   */
  readonly previousDay: readonly ChargeLine[];
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

  const previousStart = new Date(Date.parse(start) - 24 * 3600 * 1000).toISOString();

  const before = input.previousDay.filter(
    (line) => line.ServiceCategory === "Sandbox" || known.has(line.ServiceName),
  );

  // A quiet day still lists every Sandbox service in every region, with zeros. An export of the day
  // before that misses a service or region the day itself lists may be truncated, and a missing
  // line could hide a stored snapshot or drive, so it proves nothing.
  const key = (line: ChargeLine) => `${line.ServiceName} (${line.RegionId ?? "no region"})`;
  const listedBefore = new Set(before.map(key));

  for (const service of SANDBOX_SERVICES) {
    if (!sandbox.some((line) => line.ServiceName === service))
      reasons.push(`the day's export does not list ${service}, so it may be incomplete`);

    if (!before.some((line) => line.ServiceName === service))
      reasons.push(
        `the export for the day before does not list ${service}, so it may be incomplete`,
      );
  }

  const unlisted = [...new Set(sandbox.map(key))].filter((k) => !listedBefore.has(k));

  if (unlisted.length > 0)
    reasons.push(
      `the export for the day before does not list ${unlisted.join(", ")}, so it may be incomplete`,
    );

  for (const line of before) {
    const label = `${line.ServiceName} (${line.RegionId ?? "no region"}) on the day before`;

    if (
      !sameInstant(line.ChargePeriodStart, previousStart) ||
      !sameInstant(line.ChargePeriodEnd, start)
    )
      reasons.push(`${label} is for ${line.ChargePeriodStart} to ${line.ChargePeriodEnd}`);
    else if (line.SubAccountId !== input.teamId)
      reasons.push(`${label} is for team ${line.SubAccountId}`);
    else if (isActive(line) || line.ConsumedQuantity === null)
      reasons.push(
        `${label} charged ${line.BilledCost} USD for ${line.ConsumedQuantity ?? "?"} ${line.ConsumedUnit ?? ""}, so something may have carried into the day`,
      );
  }

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
    isolation: `Every Sandbox-category line of team ${input.teamId} that charges or consumes anything in ${start} to ${end} is tagged project ${input.project.name} (${input.project.id}), the day's Sandbox Creations (${creations}) equal the run's ${input.sandboxes} sandboxes, and the day before (${previousStart}) has no Sandbox charge or consumption, so nothing billed in the day existed before it`,
  };
}
