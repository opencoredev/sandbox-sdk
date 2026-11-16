/**
 * Sets one E2B realistic run against the usage E2B's console charges the team for the UTC hours it
 * ran in, and writes the result into the settled-charge audit file the realistic summary reads
 * (`bun bench realistic summary --audit FILE`, src/cost/audit-file.ts).
 *
 *   E2B_API_KEY=… bun scripts/e2b-settled.ts --run-dir <run --out> \
 *     --usage <reading.json> --usage-recheck <later-reading.json> \
 *     --audit <audit.json> --report <reconciliation.json> --events <team-events.json>
 *
 * `--usage` and `--usage-recheck` are two readings, at least 30 minutes apart, of the console's own
 * call behind its Usage page, `GET https://console.e2b.dev/api/trpc/projects.getUsage` with grain
 * "hour", saved from the signed-in browser as `{ url, status, fetchedAt, bodySha256, body }` where
 * `body` is the response text exactly as received. The API key has no billing endpoint. The script
 * itself reads the team's whole lifecycle event list with the API key (`GET /events/sandboxes`)
 * and saves it to --events. src/cost/settled-windows.ts decides whether the team held only the
 * run's sandboxes.
 *
 * Writes one entry per headline profile and track of the run, as bench/scripts/boxd-settled.ts
 * does: "reconciled" with window "mixed-profiles" (E2B's meter is per sandbox) when isolated, else
 * "not-reconciled" with the reasons. Whether the totals agree within 10% is decided by the
 * eligibility code, never here.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { attemptBillingSchema } from "../src/cost/attempt-input.js";
import type { AuditEntry } from "../src/cost/audit-file.js";
import { updateAuditFile } from "../src/cost/audit-update.js";
import { e2bWindow, type E2bHour } from "../src/cost/settled-windows.js";
import { attemptRecordSchema } from "../src/realistic/record.js";

const { values } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    usage: { type: "string" },
    "usage-recheck": { type: "string" },
    audit: { type: "string" },
    report: { type: "string" },
    events: { type: "string" },
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
const eventsPath = need("events");
const key = process.env.E2B_API_KEY;

if (!key) throw new Error("E2B_API_KEY is required");

const lines = async <T>(path: string, schema: z.ZodType<T>) =>
  (await readFile(path, "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => schema.parse(JSON.parse(l)));

const records = (await lines(join(runDir, "attempts.jsonl"), attemptRecordSchema)).filter(
  (r) => r.provider === "e2b",
);

const bills = new Map(
  (await lines(join(runDir, "billing.jsonl"), attemptBillingSchema)).map((b) => [b.attemptId, b]),
);

if (!records.some((r) => r.sandboxIds.length > 0))
  throw new Error(`${runDir} has no E2B sandboxes`);

const problems: string[] = [];
let reportedUSD = 0;

for (const record of records) {
  const charge = bills.get(record.attemptId)?.charge;

  if (charge === undefined && record.sandboxIds.length === 0) continue;

  if ((charge?.kind !== "metered" && charge?.kind !== "billed") || !charge.settled)
    problems.push(`attempt ${record.attemptId} has no final cost (${charge?.kind ?? "none"})`);
  else reportedUSD += charge.usd;
}

const receiptSchema = z.object({
  url: z.string(),
  status: z.number(),
  fetchedAt: z.iso.datetime(),
  bodySha256: z.string(),
  body: z.string(),
});

const usageSchema = z.tuple([
  z.object({
    result: z.object({
      data: z.object({
        json: z.object({
          points: z.array(
            z.object({
              timestamp: z.number(),
              sandbox_count: z.number(),
              price_for_cpu: z.number().finite(),
              price_for_ram: z.number().finite(),
            }),
          ),
          storage: z.array(z.unknown()),
        }),
      }),
    }),
  }),
]);

async function reading(path: string) {
  const receipt = receiptSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const url = new URL(receipt.url);

  const input = z
    .object({
      "0": z.object({
        json: z.object({
          projectId: z.string(),
          periodStart: z.string(),
          grain: z.literal("hour"),
        }),
      }),
    })
    .parse(JSON.parse(url.searchParams.get("input") ?? "null"));

  if (url.origin !== "https://console.e2b.dev" || url.pathname !== "/api/trpc/projects.getUsage")
    problems.push(`${basename(path)} is not the console's projects.getUsage call`);

  if (receipt.status !== 200) problems.push(`${basename(path)} has HTTP ${receipt.status}`);

  if (createHash("sha256").update(receipt.body).digest("hex") !== receipt.bodySha256)
    problems.push(`${basename(path)} does not hash to what the browser received`);

  const [usage] = usageSchema.parse(JSON.parse(receipt.body));
  const { points, storage } = usage.result.data.json;

  if (storage.length > 0)
    problems.push(`${basename(path)} reports storage usage, which this script does not price`);

  const hours: E2bHour[] = points.map((p) => ({
    start: p.timestamp,
    sandboxCount: p.sandbox_count,
    usd: p.price_for_cpu + p.price_for_ram,
  }));

  return {
    receipt,
    projectId: input["0"].json.projectId,
    periodStart: input["0"].json.periodStart,
    hours,
  };
}

const first = await reading(need("usage"));
const later = await reading(need("usage-recheck"));

if (first.projectId !== later.projectId)
  problems.push("the two readings are of different projects");

const events: unknown[] = [];
let complete = false;

for (let offset = 0; offset < 50_000; offset += 100) {
  const response = await fetch(`https://api.e2b.app/events/sandboxes?limit=100&offset=${offset}`, {
    headers: { "X-API-Key": key },
  });

  if (!response.ok) throw new Error(`E2B events: HTTP ${response.status}`);
  const page = z.array(z.unknown()).parse(await response.json());

  events.push(...page);

  if (page.length < 100) {
    complete = true;
    break;
  }
}

const eventsReadAt = new Date().toISOString();

await writeFile(
  eventsPath,
  JSON.stringify({ readAt: eventsReadAt, complete, events }, null, 1) + "\n",
);

const eventSchema = z.object({
  sandboxId: z.string(),
  type: z.string(),
  timestamp: z.iso.datetime({ offset: true }),
});

const parsedEvents = events.map((e) => {
  const v = eventSchema.parse(e);

  return { sandboxId: v.sandboxId, type: v.type, timestamp: Date.parse(v.timestamp) };
});

const window = e2bWindow({
  attempts: records.map((r) => ({
    attemptId: r.attemptId,
    sandboxIds: r.sandboxIds,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    deletionConfirmed: r.deletionConfirmed,
  })),
  hours: first.hours,
  hoursRecheck: later.hours,
  recheckGapMs: Date.parse(later.receipt.fetchedAt) - Date.parse(first.receipt.fetchedAt),
  events: parsedEvents,
  eventsComplete: complete,
});

if (window.kind === "isolated") {
  const hourAfterEnds = Date.parse(window.period.end) + 3_600_000;

  if (Date.parse(first.periodStart) > Date.parse(window.period.start) - 3_600_000)
    problems.push("the console readings start after the hour before the run");

  if (
    Date.parse(first.receipt.fetchedAt) < hourAfterEnds ||
    Date.parse(eventsReadAt) < hourAfterEnds
  )
    problems.push("the console or the event list was read before the hour after the run ended");
}

const groups = [
  ...new Map(
    records
      .filter((r) => r.variant === "headline")
      .map((r) => [`${r.profile}|${r.track}`, { profile: r.profile, track: r.track }]),
  ).values(),
];

const checkedAt = later.receipt.fetchedAt.slice(0, 10);
const source = `E2B console usage, GET https://console.e2b.dev/api/trpc/projects.getUsage (project ${first.projectId}, grain hour), read ${first.receipt.fetchedAt} and again ${later.receipt.fetchedAt}; team events GET https://api.e2b.app/events/sandboxes read ${eventsReadAt}, saved ${eventsPath}`;
const reasons = [...problems, ...(window.kind === "not-isolated" ? window.reasons : [])];

const entries: AuditEntry[] = groups.map(({ profile, track }) =>
  reasons.length === 0 && window.kind === "isolated"
    ? {
        kind: "reconciled",
        provider: "e2b",
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
        provider: "e2b",
        profile,
        track,
        reason: `The console's usage cannot be tied to run ${basename(runDir)}: ${reasons.join("; ")}`,
        source,
        blocked:
          "Rerun the plan with no other sandbox on the E2B team from the hour before it to the hour after it",
        checkedAt,
      },
);

const replaced = new Set(groups.map((g) => `${g.profile}|${g.track}`));

await updateAuditFile(auditPath, (current) => ({
  ...current,
  entries: [
    ...current.entries.filter(
      (e) =>
        !(e.provider === "e2b" && e.profile !== null && replaced.has(`${e.profile}|${e.track}`)),
    ),
    ...entries,
  ],
}));

const settled = window.kind === "isolated" ? window.settledUSD : null;

const report = {
  runDir,
  readings: [first.receipt.fetchedAt, later.receipt.fetchedAt],
  projectId: first.projectId,
  attempts: records.length,
  sandboxes: new Set(records.flatMap((r) => r.sandboxIds)).size,
  reportedUSD,
  settledUSD: settled,
  residual: settled === null || settled === 0 ? null : Math.abs(reportedUSD - settled) / settled,
  window,
  problems,
  entries: entries.map((e) => `${e.kind} ${e.profile}/${e.track}`),
};

await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
