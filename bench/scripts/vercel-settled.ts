/**
 * Sets one Vercel realistic run against Vercel's settled sandbox charges for the charge day it ran
 * in, and writes the result into the settled-charge audit file the realistic summary reads
 * (`bun bench realistic summary --audit FILE`, src/cost/audit-file.ts).
 *
 *   bun scripts/vercel-settled.ts --charges <day.jsonl> --previous-charges <day-before.jsonl> \
 *     --run-dir <run --out> \
 *     --period-start 2026-11-16T08:00:00.000Z --fetched-at <ISO time the export was read> \
 *     --team <teamId> --project-id <prj_…> --project-name sandbox-bench-runner \
 *     --audit <audit.json> --report <reconciliation.json>
 *
 * `--charges` is the raw FOCUS export for exactly that day (src/cost/vercel-charges.ts). The day
 * must have closed at least two hours before `--fetched-at`, so late usage has landed.
 * `--previous-charges` is the export for the day before, which must show no Sandbox activity.
 *
 * Writes one entry per profile and track the run has. When the day holds only the run's sandboxes,
 * each is "reconciled" with window "mixed-profiles" (the day mixes all four groups; eligibility
 * accepts that only because Vercel's meter is per sandbox): `reportedUSD` is our metered total over
 * every attempt of the run, `settledUSD` the day's Sandbox charges. Whether they agree within 10%
 * is decided by the eligibility code, never here. Otherwise each is "not-reconciled" with the
 * reasons. Only this provider's entries for these groups are replaced, under the audit file's lock
 * and with a re-read before the rename (src/cost/audit-update.ts); every other entry is kept.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { vercelMeterSchema, VERCEL_TRANSFER_USD_PER_GB } from "../src/billing/providers.js";
import { attemptBillingSchema } from "../src/cost/attempt-input.js";
import type { AuditEntry } from "../src/cost/audit-file.js";
import { updateAuditFile } from "../src/cost/audit-update.js";
import { parseChargeLines, sandboxChargeDay } from "../src/cost/vercel-charges.js";
import { pricing } from "../src/pricing.js";
import { attemptRecordSchema } from "../src/realistic/record.js";

const DAY_MS = 24 * 3600 * 1000;
const SETTLE_MS = 2 * 3600 * 1000;

const { values } = parseArgs({
  options: {
    charges: { type: "string" },
    "previous-charges": { type: "string" },
    "run-dir": { type: "string" },
    "period-start": { type: "string" },
    "fetched-at": { type: "string" },
    team: { type: "string" },
    "project-id": { type: "string" },
    "project-name": { type: "string" },
    audit: { type: "string" },
    report: { type: "string" },
  },
});

const text = z.string().trim().min(1);

const args = z
  .object({
    charges: text,
    "previous-charges": text,
    "run-dir": text,
    "period-start": z.iso.datetime(),
    "fetched-at": z.iso.datetime(),
    team: text,
    "project-id": text,
    "project-name": text,
    audit: text,
    report: text,
  })
  .parse(values);

const chargesPath = resolve(args.charges);
const runDir = resolve(args["run-dir"]);
const start = args["period-start"];
const end = new Date(Date.parse(start) + DAY_MS).toISOString();
const fetchedAt = args["fetched-at"];
const teamId = args.team;
const project = { id: args["project-id"], name: args["project-name"] };
const auditPath = resolve(args.audit);
const reportPath = resolve(args.report);

if (Date.parse(fetchedAt) < Date.parse(end) + SETTLE_MS)
  throw new Error(`the export was read at ${fetchedAt}, before ${end} plus two hours`);

const lines = async <T>(path: string, schema: z.ZodType<T>) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => schema.parse(JSON.parse(l)));

const records = (await lines(join(runDir, "attempts.jsonl"), attemptRecordSchema)).filter(
  (r) => r.provider === "vercel",
);

const bills = new Map(
  (await lines(join(runDir, "billing.jsonl"), attemptBillingSchema)).map((b) => [b.attemptId, b]),
);

if (records.length === 0) throw new Error(`${runDir} has no Vercel attempts`);

const sandboxIds = [...new Set(records.flatMap((r) => r.sandboxIds))];
const periodStart = Date.parse(start);
const periodEnd = Date.parse(end);
const problems: string[] = [];
let reportedUSD = 0;

for (const record of records) {
  if (record.startedAt < periodStart || record.endedAt > periodEnd)
    problems.push(`attempt ${record.attemptId} is not inside ${start} to ${end}`);

  if (record.sandboxIds.length > 0 && !record.deletionConfirmed)
    problems.push(`attempt ${record.attemptId} has no confirmed deletion`);

  const charge = bills.get(record.attemptId)?.charge;

  // No sandbox and no billing entry: nothing was created, nothing to charge. A billing entry for an
  // attempt with no recorded sandbox (a lost create response) must still carry a final cost.
  if (charge === undefined && record.sandboxIds.length === 0) continue;

  if (charge?.kind !== "metered" || !charge.settled)
    problems.push(
      `attempt ${record.attemptId} has no final metered cost (${charge?.kind ?? "none"})`,
    );
  else reportedUSD += charge.usd;
}

const day = sandboxChargeDay({
  lines: parseChargeLines(await readFile(chargesPath, "utf8")),
  teamId,
  project,
  period: { start, end },
  sandboxes: sandboxIds.length,
  previousDay: parseChargeLines(await readFile(resolve(args["previous-charges"]), "utf8")),
});

// Our side per service, from the raw meters the run kept, so a miss can be traced to its part.
const rate = pricing.vercel;

if (!rate) throw new Error("Vercel rates missing");

const ours = { cpuHours: 0, memoryGBHours: 0, transferGB: 0, ingressGB: 0, egressGB: 0 };
const usageFile = z.object({ meter: vercelMeterSchema.optional() });

for (const record of records)
  for (const file of record.costEvidence.usageFiles) {
    const meter = usageFile.parse(JSON.parse(await readFile(file, "utf8"))).meter;

    if (meter === undefined) {
      problems.push(`usage file ${basename(file)} has no raw meter`);
      continue;
    }

    const wall = Math.max(
      rate.minimumSeconds,
      Math.ceil((meter.totalDurationMs ?? 0) / 1000 / rate.incrementSeconds) *
        rate.incrementSeconds,
    );

    ours.cpuHours += (meter.totalActiveCpuDurationMs ?? 0) / 3600_000;
    ours.memoryGBHours += ((meter.memory ?? 0) / 1024) * (wall / 3600);
    ours.ingressGB += (meter.totalIngressBytes ?? 0) / 1e9;
    ours.egressGB += (meter.totalEgressBytes ?? 0) / 1e9;
  }

ours.transferGB = ours.ingressGB + ours.egressGB;

const groups = [
  ...new Map(
    records
      .filter((r) => r.variant === "headline")
      .map((r) => [`${r.profile}|${r.track}`, { profile: r.profile, track: r.track }]),
  ).values(),
];

const checkedAt = fetchedAt.slice(0, 10);
const source = `Vercel FOCUS charges, GET https://vercel.com/api/v1/billing/charges?teamId=${teamId}&from=${start}&to=${end}, read ${fetchedAt}; raw export ${chargesPath}`;

const reasons = [...problems, ...(day.kind === "not-isolated" ? day.reasons : [])];

const entries: AuditEntry[] = groups.map(({ profile, track }) =>
  reasons.length === 0 && day.kind === "isolated"
    ? {
        kind: "reconciled",
        provider: "vercel",
        profile,
        track,
        window: "mixed-profiles",
        reportedUSD,
        settledUSD: day.settledUSD,
        source,
        period: { start, end },
        isolation: `${day.isolation}; the run's ${records.length} attempts all started and were confirmed deleted inside the day`,
        checkedAt,
      }
    : {
        kind: "not-reconciled",
        provider: "vercel",
        profile,
        track,
        reason: `The charge day ${start} to ${end} cannot be tied to run ${basename(runDir)}: ${reasons.join("; ")}`,
        source,
        blocked: "Rerun the plan inside a charge day with no other Vercel sandbox activity",
        checkedAt,
      },
);

const replaced = new Set(groups.map((g) => `${g.profile}|${g.track}`));

await updateAuditFile(auditPath, (current) => ({
  ...current,
  entries: [
    ...current.entries.filter(
      (e) =>
        !(e.provider === "vercel" && e.profile !== null && replaced.has(`${e.profile}|${e.track}`)),
    ),
    ...entries,
  ],
}));

const settled = day.kind === "isolated" ? day.settledUSD : null;

const report = {
  period: { start, end },
  fetchedAt,
  charges: chargesPath,
  runDir,
  attempts: records.length,
  sandboxes: sandboxIds.length,
  reportedUSD,
  settledUSD: settled,
  residual: settled === null || settled === 0 ? null : Math.abs(reportedUSD - settled) / settled,
  ours: { ...ours, transferUSDPerGB: VERCEL_TRANSFER_USD_PER_GB },
  day,
  problems,
  entries: entries.map((e) => `${e.kind} ${e.profile}/${e.track}`),
};

await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
