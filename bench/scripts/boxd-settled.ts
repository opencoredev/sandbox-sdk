/**
 * Sets one boxd realistic run against the charges boxd posted to the org for the 15-minute buckets
 * it ran in, and writes the result into the settled-charge audit file the realistic summary reads
 * (`bun bench realistic summary --audit FILE`, src/cost/audit-file.ts).
 *
 *   BOXD_API_KEY=… BOXD_ORG=… bun scripts/boxd-settled.ts --run-dir <run --out> \
 *     --audit <audit.json> --report <reconciliation.json> --evidence <boxd-org.json>
 *
 * Reads boxd orgs.usage for every bucket from the one before the run to the one after it, and the
 * org's billing activity through the last bucket's posting time, and saves both raw, as read, to
 * --evidence. src/cost/settled-windows.ts decides whether the org held only the run's machines.
 *
 * Writes one entry per headline profile and track of the run. When the window is isolated each is
 * "reconciled" with window "mixed-profiles" (the run interleaves all four groups; eligibility
 * accepts that only because boxd's meter is per machine): `reportedUSD` is our total over every
 * attempt of the run, `settledUSD` the org's posted usage charges for the period. Whether they
 * agree within 10% is decided by the eligibility code, never here. Otherwise each is
 * "not-reconciled" with the reasons. Only this provider's entries for these groups are replaced,
 * under the audit file's lock (src/cost/audit-update.ts); every other entry is kept.
 */
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  activitySchema,
  boxdBucketSchema,
  boxdClient,
  type BoxdQuery,
} from "../src/billing/providers.js";
import { attemptBillingSchema } from "../src/cost/attempt-input.js";
import type { AuditEntry } from "../src/cost/audit-file.js";
import { updateAuditFile } from "../src/cost/audit-update.js";
import { BOXD_BUCKET_MS, boxdPeriod, boxdWindow } from "../src/cost/settled-windows.js";
import { attemptRecordSchema } from "../src/realistic/record.js";

const { values } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    audit: { type: "string" },
    report: { type: "string" },
    evidence: { type: "string" },
  },
});

const need = (name: keyof typeof values) => {
  const value = values[name];

  if (!value) throw new Error(`--${name} is required`);

  return resolve(value);
};

const runDir = need("run-dir");
const auditPath = need("audit");
const reportPath = need("report");
const evidencePath = need("evidence");
const org = process.env.BOXD_ORG;

if (!org || !process.env.BOXD_API_KEY) throw new Error("BOXD_API_KEY and BOXD_ORG are required");

const lines = async <T>(path: string, schema: z.ZodType<T>) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => schema.parse(JSON.parse(l)));

const records = (await lines(join(runDir, "attempts.jsonl"), attemptRecordSchema)).filter(
  (r) => r.provider === "boxd",
);

const bills = new Map(
  (await lines(join(runDir, "billing.jsonl"), attemptBillingSchema)).map((b) => [b.attemptId, b]),
);

if (!records.some((r) => r.sandboxIds.length > 0))
  throw new Error(`${runDir} has no boxd machines`);

const problems: string[] = [];
let reportedUSD = 0;

for (const record of records) {
  const charge = bills.get(record.attemptId)?.charge;

  // No machine and no billing entry: nothing was created, nothing to charge.
  if (charge === undefined && record.sandboxIds.length === 0) continue;

  if ((charge?.kind !== "metered" && charge?.kind !== "billed") || !charge.settled)
    problems.push(`attempt ${record.attemptId} has no final cost (${charge?.kind ?? "none"})`);
  else reportedUSD += charge.usd;
}

const query = await boxdClient(process.env);
const { start, end } = boxdPeriod(records);
const before = start - BOXD_BUCKET_MS;
const after = end;
const usageRaw: { start: string; response: unknown }[] = [];

for (let at = before; at <= after; at += BOXD_BUCKET_MS)
  usageRaw.push({
    start: new Date(at).toISOString(),
    response: await query("usage", {
      org,
      since: new Date(at),
      until: new Date(at + BOXD_BUCKET_MS),
    }),
  });

const ledgerRaw: unknown[] = [];
let pageToken: string | undefined;

for (let page = 0; page < 50; page++) {
  const params: Parameters<BoxdQuery>[1] = {
    org,
    since: new Date(before),
    until: new Date(after + 3 * BOXD_BUCKET_MS),
    pageSize: 1000,
  };

  if (pageToken) params.pageToken = pageToken;
  const response = await query("billingActivityPage", params);

  ledgerRaw.push(response);
  pageToken = activitySchema.parse(response).nextPageToken ?? undefined;

  if (!pageToken) break;
}

if (pageToken) problems.push("billing activity has more than 50 pages");

const readAt = Date.now();

await writeFile(
  evidencePath,
  JSON.stringify(
    { readAt: new Date(readAt).toISOString(), org, usage: usageRaw, ledger: ledgerRaw },
    null,
    1,
  ) + "\n",
);

// The shared schema plus each machine's state, which says when boxd has deleted it.
const bucketSchema = boxdBucketSchema.extend({
  machines: z.array(boxdBucketSchema.shape.machines.element.extend({ status: z.string() })),
});

const buckets = usageRaw.map(({ start: s, response }) => {
  const usage = bucketSchema.parse(response);

  if (usage.currency.toLowerCase() !== "usd") problems.push(`bucket ${s} is not in USD`);

  return {
    start: Date.parse(s),
    complete: usage.complete,
    // A machine's share of the bucket's charge: its amounts rounded up together (readBoxdCharges).
    machines: usage.machines.map((m) => ({
      machineId: m.machineId,
      status: m.status,
      micro: Math.ceil(
        m.vcpuHours * usage.rates.vcpuHourMicro +
          m.ramGibHours * usage.rates.ramGibHourMicro +
          m.diskGibHours * usage.rates.diskGibHourMicro,
      ),
    })),
  };
});

const ledger = ledgerRaw.flatMap((response) => {
  const page = activitySchema.parse(response);

  if (page.currency.toLowerCase() !== "usd") problems.push("billing activity is not in USD");

  return page.entries.map((e) => ({
    kind: e.kind,
    amountMicro: e.amountMicro,
    createdAt: e.createdAt.getTime(),
  }));
});

const window = boxdWindow({
  attempts: records.map((r) => ({
    attemptId: r.attemptId,
    sandboxIds: r.sandboxIds,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    deletionConfirmed: r.deletionConfirmed,
  })),
  buckets,
  ledger,
  readAt,
});

const groups = [
  ...new Map(
    records
      .filter((r) => r.variant === "headline")
      .map((r) => [`${r.profile}|${r.track}`, { profile: r.profile, track: r.track }]),
  ).values(),
];

const checkedAt = new Date(readAt).toISOString().slice(0, 10);
const source = `boxd orgs.usage per 15-minute bucket and orgs.billingActivityPage usage_charge entries for org ${org}, read ${new Date(readAt).toISOString()}; raw responses ${evidencePath}`;
const reasons = [...problems, ...(window.kind === "not-isolated" ? window.reasons : [])];

const entries: AuditEntry[] = groups.map(({ profile, track }) =>
  reasons.length === 0 && window.kind === "isolated"
    ? {
        kind: "reconciled",
        provider: "boxd",
        profile,
        track,
        window: "mixed-profiles",
        reportedUSD,
        settledUSD: window.settledUSD,
        source,
        period: window.period,
        isolation: `${window.isolation}; the run's ${records.length} attempts all ran and were confirmed deleted inside the period`,
        checkedAt,
      }
    : {
        kind: "not-reconciled",
        provider: "boxd",
        profile,
        track,
        reason: `The org's charges for ${new Date(start).toISOString()} to ${new Date(end).toISOString()} cannot be tied to run ${basename(runDir)}: ${reasons.join("; ")}`,
        source,
        blocked:
          "Rerun the plan with nothing else on the boxd org from the bucket before it to the bucket after it",
        checkedAt,
      },
);

const replaced = new Set(groups.map((g) => `${g.profile}|${g.track}`));

await updateAuditFile(auditPath, (current) => ({
  ...current,
  entries: [
    ...current.entries.filter(
      (e) =>
        !(e.provider === "boxd" && e.profile !== null && replaced.has(`${e.profile}|${e.track}`)),
    ),
    ...entries,
  ],
}));

const settled = window.kind === "isolated" ? window.settledUSD : null;

const report = {
  runDir,
  period: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
  readAt: new Date(readAt).toISOString(),
  attempts: records.length,
  machines: new Set(records.flatMap((r) => r.sandboxIds)).size,
  reportedUSD,
  settledUSD: settled,
  residual: settled === null || settled === 0 ? null : Math.abs(reportedUSD - settled) / settled,
  window,
  problems,
  entries: entries.map((e) => `${e.kind} ${e.profile}/${e.track}`),
};

await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
