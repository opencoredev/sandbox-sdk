import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { resolveConfig as vercelConfig } from "@opencoredev/sandbox-sdk/vercel";
import { endpoint } from "../connections.js";
import type { Json } from "../json.js";
import { archilControlUrl, archilSandboxBody, archilUsageBody } from "../archil.js";
import { pricing } from "../pricing.js";
import { microsandboxTier } from "../providers.js";
import type { OwnedSandbox } from "./input.js";
import { collectModal, modalBillingSource, type ModalReport } from "./modal.js";

const money = z.number().finite().nonnegative();

export type Cost =
  | {
      kind: "billed" | "metered";
      usd: number;
      scope: "sandbox-lifetime" | "window";
      complete: boolean;
      confidence: "high" | "medium" | "low";
      note: string;
    }
  | { kind: "unavailable"; confidence: "none"; note: string };

export type SandboxCost = { id: string; source: string; cost: Cost };

export type ProviderCosts = {
  provider: string;
  source: string;
  granularity: string;
  delay: string;
  notes: string[];
  sandboxes: SandboxCost[];
  account: unknown;
};

export type Transport = (url: string, headers: Record<string, string>) => Promise<Json>;

export class BillingHttpError extends Error {
  constructor(readonly status: number) {
    super(`Billing HTTP ${status}`);
  }
}

export const http: Transport = async (url, headers) => {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });

    if (response.ok) return response.json();

    if (attempt >= 2 || ![429, 502, 503, 504].includes(response.status))
      throw new BillingHttpError(response.status);
    const retryAfter = response.headers.get("retry-after");
    const numeric = retryAfter === null ? NaN : Number(retryAfter);

    const requested = Number.isFinite(numeric)
      ? numeric * 1000
      : retryAfter
        ? Date.parse(retryAfter) - Date.now()
        : 20_000;

    const delay = Number.isFinite(requested) ? Math.max(0, requested) : 20_000;

    if (delay > 30_000) throw new BillingHttpError(response.status);
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
};

const unavailable = (note: string): Cost => ({ kind: "unavailable", confidence: "none", note });

type BillingSource = {
  source: string;
  granularity: string;
  delay: string;
  key: string;
  notes: string[];
};

export const archilUsageSource = "GET /api/sandboxes/{id}/usage (Archil control plane)";

export const microsandboxUsageSource =
  "https://api.microsandbox.dev/v1/billing/usage/sandbox and /v1/billing/usage (costs.workloads)";

/** Microsandbox's billing source for one tier; both tiers read the same account endpoints. */
function microsandboxBilling(tier: "Standard" | "Shared"): BillingSource {
  return {
    source: microsandboxUsageSource,
    granularity: "per sandbox per UTC day: vCPU-, memory MiB- and disk MiB-seconds of running time",
    delay: "unknown: no finalization signal, so always provisional",
    key: "MSB_API_KEY",
    notes: [
      `Metered, not invoice: Microsandbox's own per-sandbox daily usage rows, each priced at the published rates of the row's own compute_type (${tier} runs here; Standard $0.048/vCPU-hour, $0.003/GiB-hour, $0.0000625/GiB-hour of disk; Shared $0.007, $0.000375, $0.0000625; https://microsandbox.dev/pricing), cross-checked against costs.workloads when it names the sandbox. Plan fees, credits, volumes, snapshots and tax are excluded.`,
      "Always provisional (complete: false, low confidence): the rows meter running intervals only, so a stopped sandbox's retained disk is missing; deletion is asynchronous; and costs.incomplete only flags older events. A sandbox with no row and no workloads entry is unavailable, never $0.",
    ],
  };
}

const sources = new Map<string, BillingSource>(
  Object.entries({
    boat: {
      source: "https://boat.dev/api/v1/sandboxes/{id}/usage",
      granularity: "sandbox lifetime, billable seconds",
      delay: "final after stop",
      key: "BOAT_API_KEY",
      notes: [
        "Boat dollars is explicitly list-price usage, not invoice cost. $20/month plan minimum and credits are separate.",
      ],
    },
    upstash: {
      source: "https://us-east-1.box.upstash.com/v2/box/{id}",
      granularity: "sandbox lifetime CPU ns and compute USD",
      delay: "cumulative; final after deletion",
      key: "UPSTASH_BOX_API_KEY",
      notes: ["Compute charge only; excludes any separate storage, subscription, credits or tax."],
    },
    e2b: {
      source: "https://api.e2b.app/events/sandboxes/{id}",
      granularity: "execution segment milliseconds",
      delay: "lifecycle events; 7-day retention",
      key: "E2B_API_KEY",
      notes: [
        "Metered, not invoice. execution_time is milliseconds. Published USD/second: vCPU 0.000014, GiB RAM 0.0000045; https://docs.e2b.dev/billing. Rates checked 2026-10-22; no historical rate guarantee.",
      ],
    },
    boxd: {
      source: "boxd orgs.usage / orgs.billingActivityPage",
      granularity: "per-machine meter; org-wide 15-minute charges",
      delay: "meter up to ~25 minutes; charges every 15 minutes",
      key: "BOXD_API_KEY",
      notes: [
        "Machine cost is an estimate at current account rates, even when complete. Actual charges remain org-wide; no proportional allocation to tasks.",
      ],
    },
    superserve: {
      source: "https://api.superserve.ai/billing/usage-series (millisecond range) + /activity",
      granularity: "account charge over any [start,end) range; buckets are clipped at range edges",
      delay: "live; final once the sandbox is deleted",
      key: "SUPERSERVE_API_KEY",
      notes: [
        "billed_total_usd is gross CPU + memory charge before credits/tax; storage is tracked, not billed. The account charge is per team, so a sandbox's charge is the charge over its own create-to-delete range, used only when the audit log shows no other sandbox in the run and the per-sandbox ranges add up exactly to the whole run range with a 60 s margin.",
      ],
    },
    daytona: {
      source: "https://analytics.app.daytona.io/organization/{org}/usage/sandbox",
      granularity: "per-sandbox price in a fixed window",
      delay: "up to 48 hours",
      key: "DAYTONA_API_KEY",
      notes: [
        "Authenticated Analytics API verified; API-key organization discovered via /api-keys/current. Prices cover the requested window; pending until 48 hours after its end. Credits/tax are separate.",
      ],
    },
    vercel: {
      source:
        "@vercel/sandbox Sandbox.get: totalActiveCpuDurationMs, totalDurationMs, memory, totalIngressBytes, totalEgressBytes",
      granularity: "sandbox lifetime: active CPU ms and wall ms over all sessions",
      delay: "reported once a session stops; gone (404) after deletion",
      key: "VERCEL_OIDC_TOKEN",
      notes: [
        "Metered, not invoice: Vercel's own per-sandbox meters priced at the published Pro iad1 rates (https://vercel.com/docs/sandbox/pricing). Memory wall time is rounded up to whole minutes. Data transfer (ingress plus egress bytes) is priced at $0.15/GB, as the team's charges bill it; a meter without byte counters is understated and never final. Snapshot storage, the $20 monthly Pro credit and tax are excluded.",
      ],
    },
    tenki: {
      source: "No verified public billing endpoint",
      granularity: "not available",
      delay: "unknown",
      key: "TENKI_API_KEY",
      notes: ["No billing API found; no fabricated cost."],
    },
    modal: {
      source: modalBillingSource,
      granularity: "App per hour; a sandbox alone in its App (per-attempt Apps) is priced",
      delay:
        "minutes; full hours only; provisional until a confirmed stop, 30 minutes after its hour (this bench's heuristic, not Modal's) and a row for every hour",
      key: "MODAL_TOKEN_SECRET",
      notes: [
        "Modal's per-App charge before credits, reservations and the egress allowance (https://modal.com/docs/guide/billing). Sandbox tags are not in the report, so only a sandbox that is the one sandbox in its App, with no create of unknown outcome beside it, gets a cost; others stay unavailable, never zero.",
        "A sandbox's cost is compute only (CPU and memory); egress and the App total are kept in account.apps.",
      ],
    },
    baseten: {
      source: "No verified public billing endpoint",
      granularity: "not available",
      delay: "unknown",
      key: "BASETEN_API_KEY",
      notes: ["No billing API found; no fabricated cost."],
    },
    instabox: {
      source: "https://api.instabox.sh/v1/machines/{id}/usage",
      granularity: "machine running seconds, vCPU-seconds and memory GiB-seconds over a window",
      delay: "live; final once the machine is deleted (still readable by ID afterwards)",
      key: "INSTABOX_API_KEY",
      notes: [
        "Metered, not invoice: Instabox's own per-machine usage (running time only, not starting, paused or stopped) at the published rates, $0.004/vCPU-hour and $0.00225/GiB-hour (https://instabox.sh/docs/account/pricing.md). Disk is included in paid plans (Builder: 1 TiB across machines) and egress within the plan's allowance, so neither is priced. Plan fee, monthly credits and tax are excluded.",
      ],
    },
    maritime: {
      source:
        "https://api.maritime.sh/v1/sandboxes/{id}/info and https://api.maritime.sh/v1/usage?sandbox={id}",
      granularity: "per running interval of one sandbox, each with its cost in USD",
      delay:
        "live; final once the sandbox has ended and every running interval has an end (ended sandboxes stay readable for 7 days)",
      key: "MARITIME_API_KEY",
      notes: [
        "Metered, not invoice: Maritime's own cost of each running interval ($0.0055/vCPU-hour and $0.00275/GiB-hour per second, disk included while running; https://maritime.sh/docs/billing). A paused sandbox's disk ($0.08/GB-month) is not in these intervals and is not priced. Plan fee, its equal usage credit and tax are excluded.",
        "A sandbox with no usage interval counts as $0 only when Maritime's info says it ended with 0 running seconds and $0 so far; otherwise its cost is unavailable, never zero.",
      ],
    },
    microsandbox: microsandboxBilling("Standard"),
    "microsandbox-shared": microsandboxBilling("Shared"),
    styne: {
      source: "No per-sandbox billing endpoint (GET /v1/run/usage is daily account totals)",
      granularity: "not available per sandbox",
      delay: "unknown",
      key: "STYNE_API_KEY",
      notes: [
        "GET /v1/run/usage reports the account's running seconds and cost per day and product, not per sandbox, so no sandbox gets a cost from it. Estimates use the published per-size rates. No fabricated cost.",
      ],
    },
    beam: {
      source: "No verified public billing endpoint",
      granularity: "not available",
      delay: "unknown",
      key: "BEAM_TOKEN",
      notes: [
        "The dashboard's Usage page shows workspace totals; no per-sandbox billing API found. No fabricated cost.",
      ],
    },
    archil: {
      source: archilUsageSource,
      granularity: "sandbox lifetime: vCPU-hours, memory GiB-hours and cost, sampled each minute",
      delay: "about a minute; readable for 90 days, final once the sandbox is deleted",
      key: "ARCHIL_API_KEY",
      notes: [
        "Archil's own per-sandbox cost at its rates ($0.055/vCPU-hour, $0.020/GiB-hour; https://docs.archil.com/administration/billing.md), before included allowances and prepaid credit. Compute only: disk data storage, egress and the plan minimum are excluded.",
        "Free-plan sandboxes get deny-all egress; paid plans are unrestricted.",
      ],
    },
    freestyle: {
      source: "No verified public billing endpoint",
      granularity: "not available",
      delay: "unknown",
      key: "FREESTYLE_API_KEY",
      notes: ["No billing API found; no fabricated cost."],
    },
  }),
);

const boatSchema = z.object({
  sandboxId: z.string(),
  dollars: money,
  seconds: money,
  running: z.boolean(),
});

const upstashSchema = z.object({
  id: z.string(),
  status: z.string(),
  total_cpu_ns: money,
  total_compute_cost_usd: money,
});

const eventSchema = z.object({
  id: z.string(),
  type: z.string(),
  eventData: z
    .object({
      execution: z
        .object({ execution_time: money, memory_mb: money, vcpu_count: money })
        .optional(),
    })
    .optional(),
});

const machineSchema = z.object({ machineId: z.string(), costMicro: money, complete: z.boolean() });

const usageSchema = z.object({
  currency: z.string(),
  totalCostMicro: money,
  complete: z.boolean(),
  rates: z.record(z.string(), z.number()),
  period: z.object({
    start: z.coerce.date().transform((d) => d.toISOString()),
    end: z.coerce.date().transform((d) => d.toISOString()),
  }),
  machines: z.array(machineSchema),
});

export const activitySchema = z.object({
  currency: z.string(),
  entries: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      amountMicro: z.number().finite(),
      createdAt: z.coerce.date(),
    }),
  ),
  nextPageToken: z.string().nullish(),
});

export function decodeBoat(raw: Json, id: string): Cost {
  const value = boatSchema.parse(raw);

  if (value.sandboxId !== id) throw new Error("Billing ID mismatch");

  return {
    kind: "metered",
    usd: value.dollars,
    scope: "sandbox-lifetime",
    complete: !value.running,
    confidence: "medium",
    note: "Provider's list-price usage dollars; not invoice; plan minimum excluded",
  };
}

const instaboxUsageSchema = z.object({
  from: z.string(),
  to: z.string(),
  runningSeconds: money,
  vcpuSeconds: money,
  memGiBSeconds: money,
});

/**
 * One machine's usage from `GET /v1/machines/{id}/usage` at the published CPU and memory rates.
 * It covers the machine's whole life only when the window starts before the machine did
 * (`started`: its first sample's start is known) and the machine was already deleted when the
 * usage was read; otherwise it is a window amount and never final.
 */
export function decodeInstabox(raw: Json, state: { deleted: boolean; started: boolean }): Cost {
  const usage = instaboxUsageSchema.parse(raw);
  const rate = pricing.instabox;

  if (!rate) throw new Error("No Instabox price");
  const lifetime = state.deleted && state.started;

  return {
    kind: "metered",
    usd: usage.vcpuSeconds * rate.cpuSecond + usage.memGiBSeconds * rate.memoryGiBSecond,
    scope: lifetime ? "sandbox-lifetime" : "window",
    complete: lifetime,
    confidence: lifetime ? "medium" : "low",
    note: lifetime
      ? `Metered, not invoice: Instabox's per-machine usage (${usage.runningSeconds} running seconds) at published CPU and memory rates; disk included in the plan`
      : `Partial: Instabox's usage over ${usage.from} to ${usage.to} only, because ${state.started ? "the machine still existed" : "its start is unknown"}`,
  };
}

/** The usage window for one machine: from a day before its first sample to now. */
export function instaboxUsageQuery(row: Pick<OwnedSandbox, "startedAt">, now = Date.now()) {
  const query = new URLSearchParams({ to: new Date(now).toISOString() });
  const started = row.startedAt === null ? Number.NaN : Date.parse(row.startedAt);

  if (Number.isFinite(started)) query.set("from", new Date(started - 24 * 3_600_000).toISOString());

  return query;
}

/**
 * How long after a sandbox's session ended (Archil's own `finished_at`) a usage read must be made to
 * count as settled. `as_of` is when the usage was read, and the meter updates about once a minute, so
 * a read this long after the end has seen the final minute.
 */
export const archilSettleMs = 120_000;

/**
 * One sandbox's usage from Archil's `GET /api/sandboxes/{id}/usage`: Archil's own cost since the
 * sandbox was created. It is final only once the sandbox is deleted and the read (`as_of`, the read
 * time) is at least {@link archilSettleMs} after Archil's own end of its last session (`finished_at`);
 * without that end, or read sooner, it is provisional. The bench's last sample is not used: a sandbox
 * left for the final cleanup sweep can run on long after it.
 */
export function decodeArchil(
  raw: Json,
  state: { deleted: boolean; endedAt: string | undefined },
): Cost {
  const usage = archilUsageBody.parse(raw);
  const asOf = usage.as_of === undefined ? Number.NaN : Date.parse(usage.as_of);
  const ended = state.endedAt === undefined ? Number.NaN : Date.parse(state.endedAt);
  const settled = state.deleted && asOf >= ended + archilSettleMs;

  const why = !state.deleted
    ? "; the sandbox still existed"
    : settled
      ? ""
      : "; provisional: the meter may not have settled since the sandbox's last sample";

  return {
    kind: "billed",
    usd: usage.cost,
    scope: "sandbox-lifetime",
    complete: settled,
    confidence: settled ? "high" : "low",
    note: `Provider-reported cost (${usage.vcpu_hours} vCPU-hours, ${usage.memory_gib_hours} GiB-hours), before allowances and prepaid credit; storage and egress excluded${why}`,
  };
}

/** One `SandboxDailyUsage` row of `GET /v1/billing/usage/sandbox`. */
export const microsandboxUsageRowSchema = z.object({
  sandbox_id: z.string(),
  compute_type: z.enum(["standard", "shared"]),
  day: z.string(),
  vcpu_seconds: money,
  mem_mib_seconds: money,
  disk_mib_seconds: money,
});

export type MicrosandboxUsageRow = z.infer<typeof microsandboxUsageRowSchema>;

/** `UsageBreakdown`. */
export const microsandboxBreakdownSchema = z.object({
  rows: z.array(microsandboxUsageRowSchema),
});

/** `UsageSummary`, as far as the collector reads it: `costs` may be null. */
export const microsandboxSummarySchema = z.object({
  costs: z
    .object({
      workloads: z.record(z.string(), money),
      incomplete: z.boolean(),
    })
    .nullish(),
});

/** One usage row priced at its own compute type's published rates. */
export function rateMicrosandboxRow(row: MicrosandboxUsageRow): number {
  const price = pricing[row.compute_type === "shared" ? "microsandbox-shared" : "microsandbox"];

  if (!price) throw new Error("Microsandbox pricing is missing");

  return (
    row.vcpu_seconds * price.cpuSecond +
    (row.mem_mib_seconds / 1024) * price.memoryGiBSecond +
    (row.disk_mib_seconds / 1024) * price.diskGiBSecond
  );
}

/**
 * One sandbox's cost from Microsandbox's usage rows and, when it names the sandbox, `costs.workloads`.
 * Never $0 from absence: a sandbox with neither is unavailable. Always provisional: Microsandbox gives no
 * finalization signal, its rows meter running time only (a stopped sandbox's disk is missing), and its
 * delete is asynchronous. A workloads amount that disagrees with the rated rows is noted, not used.
 */
export function decodeMicrosandbox(input: {
  id: string;
  rows: readonly MicrosandboxUsageRow[];
  workloadUsd: number | undefined;
  /** Why `costs.workloads` could not be read, when it could not: the rows are rated without the cross-check. */
  crossCheckFailure?: string;
}): Cost {
  const own = input.rows.filter((row) => row.sandbox_id === input.id);

  if (own.length === 0 && input.workloadUsd === undefined)
    return unavailable(
      "Microsandbox lists no usage row and no workloads cost for this sandbox in the window; not counted as $0",
    );

  if (own.length === 0)
    return {
      kind: "metered",
      usd: input.workloadUsd ?? 0,
      scope: "window",
      complete: false,
      confidence: "low",
      note: "Provisional: only Microsandbox's costs.workloads names this sandbox (no usage rows yet)",
    };

  const usd = own.reduce((sum, row) => sum + rateMicrosandboxRow(row), 0);
  const tiers = [...new Set(own.map((row) => row.compute_type))].join("+");

  const disagrees =
    input.workloadUsd !== undefined && Math.abs(input.workloadUsd - usd) > 0.000002 + usd * 0.01;

  const unchecked =
    input.crossCheckFailure === undefined
      ? ""
      : `; not cross-checked, because /v1/billing/usage could not be read (${input.crossCheckFailure})`;

  return {
    kind: "metered",
    usd,
    scope: "window",
    complete: false,
    confidence: "low",
    note: `Provisional, metered not invoice: ${own.length} daily usage row(s) of this sandbox at ${tiers} rates; running time only, so a stopped sandbox's disk is excluded${disagrees ? `; Microsandbox's costs.workloads says $${input.workloadUsd?.toFixed(6)}, the rows rate to $${usd.toFixed(6)}` : ""}${unchecked}`,
  };
}

/** The fields of `GET /v1/sandboxes/{id}/info` the Maritime collector reads. It never resumes the sandbox. */
export const maritimeInfoSchema = z.object({
  id: z.string(),
  state: z.string(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
  runningSeconds: z.number().int().nonnegative(),
  costSoFarUsd: z.string().nullable(),
  storedBytes: z.number().int().nonnegative(),
});

export type MaritimeInfo = z.infer<typeof maritimeInfoSchema>;

/** One running interval of `GET /v1/usage`. */
export const maritimeUsageRecordSchema = z.object({
  sandboxId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  costUsd: z.string(),
});

export type MaritimeUsageRecord = z.infer<typeof maritimeUsageRecordSchema>;

export const maritimeUsagePageSchema = z.object({
  data: z.array(maritimeUsageRecordSchema),
  nextCursor: z.string().nullable(),
});

/** A decimal USD amount as Maritime writes it (`"0.000038"`), or null when it is not one. */
function usdOf(text: string | null): number | null {
  if (text === null || !/^\d+(?:\.\d+)?$/.test(text)) return null;

  const value = Number(text);

  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** How many usage pages (100 intervals each) the collector reads before it gives up. */
export const maritimeUsagePages = 100;

/**
 * The usage query for one sandbox: every interval overlapping its life, from an hour before Maritime's
 * own `createdAt` to five minutes after its `endedAt` (or now, while it lives).
 */
export function maritimeUsageQuery(info: MaritimeInfo, now = Date.now(), cursor?: string) {
  const created = Date.parse(info.createdAt);
  const ended = info.endedAt === null ? now : Date.parse(info.endedAt);

  if (!Number.isFinite(created) || !Number.isFinite(ended))
    throw new Error("Maritime info has unreadable timestamps");

  const query = new URLSearchParams({
    from: new Date(created - 3_600_000).toISOString(),
    to: new Date(ended + 5 * 60_000).toISOString(),
    sandbox: info.id,
    limit: "100",
  });

  if (cursor !== undefined) query.set("cursor", cursor);

  return query;
}

/**
 * One sandbox's cost from Maritime's info and every usage interval of it. Complete only when the sandbox
 * has ended and it has intervals, every one with an end. No interval at all is $0 only when the info
 * itself says the sandbox ended having run 0 seconds at $0; otherwise it is unavailable, since missing
 * usage is not zero. A disagreeing running total in the info is noted, not used.
 */
export function decodeMaritime(
  info: MaritimeInfo,
  records: MaritimeUsageRecord[],
  id: string,
): Cost {
  if (info.id !== id) throw new Error("Billing ID mismatch");

  const costs = records.map((record) => {
    if (record.sandboxId !== id) throw new Error("Billing ID mismatch");

    const usd = usdOf(record.costUsd);

    if (usd === null) throw new Error("Maritime usage cost is not a non-negative amount");

    return usd;
  });

  const soFar = usdOf(info.costSoFarUsd);
  const ended = info.state === "ended";
  const neverRan = ended && info.runningSeconds === 0 && soFar === 0;

  if (records.length === 0 && !neverRan)
    return unavailable(
      ended
        ? `Maritime lists no usage for a sandbox that ran ${info.runningSeconds} seconds; not counted as $0`
        : `Maritime lists no usage yet for a sandbox that is ${info.state}`,
    );

  const usd = costs.reduce((sum, cost) => sum + cost, 0);
  const closed = records.every((record) => record.endedAt !== null);
  // The plan's predicate: ended, every interval closed, and intervals listed (or the never-ran case above).
  // The info's running total is not part of it: `/info` can report `costSoFarUsd: null` once ended.
  const complete = ended && closed && (records.length > 0 || neverRan);
  // Reported, never used to decide completeness: the info's total, when it has one, disagrees with the
  // intervals beyond Maritime's precision (a millionth of a dollar).
  const disagrees = soFar !== null && Math.abs(soFar - usd) > 0.000002 + usd * 0.01;

  return {
    kind: "metered",
    usd,
    scope: "sandbox-lifetime",
    complete,
    confidence: complete ? "medium" : "low",
    note: complete
      ? `Metered, not invoice: Maritime's ${records.length} running interval(s) of this sandbox (${info.runningSeconds} running seconds); disk while paused excluded${disagrees ? `; Maritime's info says $${info.costSoFarUsd} so far, the intervals sum to $${usd.toFixed(6)}` : ""}`
      : !ended
        ? `Partial: the sandbox is ${info.state}, so its intervals are not final`
        : "Partial: an interval of this ended sandbox has no end yet",
  };
}

export function decodeUpstash(raw: Json, id: string): Cost {
  const value = upstashSchema.parse(raw);

  if (value.id !== id) throw new Error("Billing ID mismatch");

  return {
    kind: "billed",
    usd: value.total_compute_cost_usd,
    scope: "sandbox-lifetime",
    complete: value.status === "deleted",
    confidence: value.status === "deleted" ? "high" : "low",
    note: "Provider-reported cumulative compute charge; credits, storage and tax excluded",
  };
}

export function decodeBoxd(
  raw: Json,
  id: string,
  scope: "sandbox-lifetime" | "window" = "sandbox-lifetime",
): Cost {
  const value = machineSchema.extend({ currency: z.string() }).parse(raw);

  if (value.machineId !== id) throw new Error("Billing ID mismatch");

  if (value.currency.toLowerCase() !== "usd")
    return unavailable("Non-USD account; no currency conversion invented");

  return {
    kind: "metered",
    usd: value.costMicro / 1e6,
    scope,
    complete: value.complete,
    confidence: value.complete ? "medium" : "low",
    note: "Current account rates, not invoice; org activity recorded separately",
  };
}

export const vercelMeterSchema = z.object({
  name: z.string(),
  status: z.string(),
  totalActiveCpuDurationMs: money.optional(),
  totalDurationMs: money.optional(),
  memory: money.optional(),
  /** Cumulative bytes over all sessions; absent in meters saved before 2026-11-16. */
  totalIngressBytes: money.optional(),
  totalEgressBytes: money.optional(),
});

export type VercelMeter = z.infer<typeof vercelMeterSchema>;

/**
 * Sandbox Data Transfer, iad1, per GB (10^9 bytes). Vercel's pricing page lists it as "Included in
 * Flat Rate CDN" on Pro, but the team's FOCUS charges bill it: 2026-11-09 charged $1.7020669674
 * for 11.347113116 GB, exactly $0.15 per GB. The page says downloads are free, yet that day's
 * realistic sandboxes alone took 8.4 GB of SDK uploads, so ingress and egress are both priced (the
 * dearer reading, as for memory rounding); the settled charges decide.
 */
export const VERCEL_TRANSFER_USD_PER_GB = 0.15;

/** Vercel's per-sandbox meter at its published rates. The meter is final only once stopped. */
export function decodeVercel(meter: VercelMeter, id: string): Cost {
  const rate = pricing.vercel;

  if (meter.name !== id) throw new Error("Billing ID mismatch");

  if (!rate) throw new Error("Vercel rates missing");

  if (meter.status !== "stopped")
    return unavailable(
      `Vercel reports usage only after the session stops; the sandbox was ${meter.status}`,
    );

  const { totalActiveCpuDurationMs: cpuMs, totalDurationMs: wallMs, memory } = meter;

  if (cpuMs === undefined || wallMs === undefined || memory === undefined)
    return unavailable("Vercel meter fields missing");

  const seconds = Math.max(
    rate.minimumSeconds,
    Math.ceil(wallMs / 1000 / rate.incrementSeconds) * rate.incrementSeconds,
  );

  const compute =
    (cpuMs / 1000) * rate.cpuSecond +
    (memory / 1024) * seconds * rate.memoryGiBSecond +
    rate.perSandbox;

  const { totalIngressBytes: ingress, totalEgressBytes: egress } = meter;

  // Without the byte counters the total leaves out a charge Vercel bills, so it is never final.
  if (ingress === undefined || egress === undefined)
    return {
      kind: "metered",
      usd: compute,
      scope: "sandbox-lifetime",
      complete: false,
      confidence: "low",
      note: "Vercel's active-CPU and wall-time meters at published Pro iad1 rates; memory rounded up to whole minutes; data transfer not metered (no byte counters saved), so understated; not invoice",
    };

  return {
    kind: "metered",
    usd: compute + ((ingress + egress) / 1e9) * VERCEL_TRANSFER_USD_PER_GB,
    scope: "sandbox-lifetime",
    complete: true,
    confidence: "medium",
    note: "Vercel's active-CPU, wall-time and network byte meters at Pro iad1 rates; memory rounded up to whole minutes; ingress and egress at $0.15/GB; not invoice",
  };
}

type VercelModule = typeof import("@vercel/sandbox");

async function vercelSdk(): Promise<VercelModule> {
  const require = createRequire(resolve(import.meta.dirname, "../../../packages/sdk/package.json"));

  return import(pathToFileURL(require.resolve("@vercel/sandbox")).href);
}

/**
 * Reads and stops through the native SDK with the adapter's credentials and scope: an explicit
 * token's team and project, else OIDC. Tests replace it.
 */
export const vercelMeter = {
  async read(name: string): Promise<VercelMeter> {
    const { Sandbox } = await vercelSdk();
    const box = await Sandbox.get({ ...vercelConfig(), name, resume: false });

    return vercelMeterSchema.parse({
      name: box.name,
      status: box.status,
      totalActiveCpuDurationMs: box.totalActiveCpuDurationMs,
      totalDurationMs: box.totalDurationMs,
      memory: box.memory,
      totalIngressBytes: box.totalIngressBytes,
      totalEgressBytes: box.totalEgressBytes,
    });
  },
  async stop(name: string): Promise<void> {
    const { Sandbox } = await vercelSdk();
    await (await Sandbox.get({ ...vercelConfig(), name, resume: false })).stop();
  },
};

const vercelMissing = z.object({ response: z.object({ status: z.literal(404) }) });

const savedMeterSchema = z.object({ capturedAt: z.string(), meter: vercelMeterSchema });

const meterFile = (dir: string, id: string) => join(dir, `vercel-${encodeURIComponent(id)}.json`);

/**
 * Vercel reports a session's usage only once it stops, and forgets the sandbox when it is deleted.
 * Stop it, save the final meter for `bench billing`, and return the file. The caller deletes it.
 */
export async function captureVercelMeter(id: string, dir: string): Promise<string> {
  await vercelMeter.stop(id);
  const meter = await vercelMeter.read(id);
  await mkdir(dir, { recursive: true });
  const file = meterFile(dir, id);
  await writeFile(file, JSON.stringify({ capturedAt: new Date().toISOString(), meter }) + "\n");

  return file;
}

async function savedMeter(dir: string | undefined, id: string): Promise<VercelMeter | undefined> {
  if (dir === undefined) return undefined;

  try {
    return savedMeterSchema.parse(JSON.parse(await readFile(meterFile(dir, id), "utf8"))).meter;
  } catch {
    return undefined;
  }
}

async function vercelCost(id: string, dir: string | undefined): Promise<Cost> {
  const saved = await savedMeter(dir, id);

  if (saved !== undefined) return decodeVercel(saved, id);

  try {
    return decodeVercel(await vercelMeter.read(id), id);
  } catch (error) {
    if (vercelMissing.safeParse(error).success)
      return unavailable(
        "Sandbox deleted before its meter was saved; Vercel reports usage only between stop and delete",
      );
    throw error;
  }
}

export function decodeEvents(raw: Json): Cost {
  const events = z.array(eventSchema).parse(raw);

  if (
    !events.some((e) => e.type === "sandbox.lifecycle.created") ||
    !events.some((e) => e.type === "sandbox.lifecycle.killed")
  )
    return unavailable("Missing creation or killed event; active, expired or incomplete history");
  const unique = [...new Map(events.map((e) => [e.id, e])).values()];

  const segments = unique.filter(
    (e) => e.type === "sandbox.lifecycle.paused" || e.type === "sandbox.lifecycle.killed",
  );

  if (segments.some((e) => !e.eventData?.execution))
    return unavailable("Lifecycle segment has no execution meter");

  const usd = segments.reduce((sum, e) => {
    const execution = e.eventData?.execution;

    return (
      sum +
      (execution
        ? (execution.execution_time / 1000) *
          (execution.vcpu_count * 0.000014 + (execution.memory_mb / 1024) * 0.0000045)
        : 0)
    );
  }, 0);

  return {
    kind: "metered",
    usd,
    scope: "sandbox-lifetime",
    complete: true,
    confidence: "medium",
    note: "Metered, not invoice; all retained execution segments × published current rates",
  };
}

function errorNote(cause: unknown) {
  return cause instanceof BillingHttpError
    ? `Billing HTTP ${cause.status}; retry after settlement or check retention/permissions`
    : "Billing unavailable: network, optional SDK or response schema failed; retry later";
}

function windowFor(rows: OwnedSandbox[]) {
  const starts = rows.flatMap((r) => (r.startedAt ? [Date.parse(r.startedAt)] : [])),
    ends = rows.flatMap((r) => (r.finishedAt ? [Date.parse(r.finishedAt)] : []));

  if (!starts.length || !ends.length) return null;

  // Account sources aggregate on bucket boundaries. These windows include unrelated activity.
  return {
    start: new Date(Math.floor(Math.min(...starts) / 3_600_000) * 3_600_000).toISOString(),
    end: new Date(Math.ceil(Math.max(...ends) / 3_600_000) * 3_600_000).toISOString(),
  };
}

export type BoxdQuery = (
  method: "usage" | "billingActivityPage",
  params: { org?: string; since: Date; until: Date; pageSize?: number; pageToken?: string },
) => Promise<object>;

export async function boxdClient(env: NodeJS.ProcessEnv): Promise<BoxdQuery> {
  const require = createRequire(resolve(import.meta.dirname, "../../../packages/sdk/package.json"));

  const { Boxd }: typeof import("@boxd-sh/sdk") = await import(
    pathToFileURL(require.resolve("@boxd-sh/sdk")).href
  );

  const { orgs } = new Boxd({ apiKey: env.BOXD_API_KEY, timeout: 15_000, maxRetries: 0 });

  // Native SDK methods live on prototypes, so each call keeps `orgs` as the receiver.
  return (method, params) => orgs[method](params);
}

export async function readBoxdAccount(
  rows: OwnedSandbox[],
  env: NodeJS.ProcessEnv,
  query?: BoxdQuery,
) {
  query ??= await boxdClient(env);
  const window = windowFor(rows);

  if (!window) throw new Error("No time window for org reconciliation");
  const params = { org: env.BOXD_ORG, since: new Date(window.start), until: new Date(window.end) };
  const usage = usageSchema.parse(await query("usage", params));
  const entries: z.infer<typeof activitySchema>["entries"] = [];
  let pageToken: string | undefined;

  for (let page = 0; page < 100; page++) {
    const result = activitySchema.parse(
      await query("billingActivityPage", { ...params, pageSize: 1000, pageToken }),
    );

    if (result.currency !== usage.currency) throw new Error("Billing currency mismatch");
    entries.push(...result.entries);

    if (!result.nextPageToken) {
      pageToken = undefined;
      break;
    }

    pageToken = result.nextPageToken;
  }

  if (pageToken) throw new Error("Billing pagination limit reached");

  const charged = -entries
    .filter((e) => e.kind === "usage_charge")
    .reduce((s, e) => s + e.amountMicro, 0);

  return {
    usage,
    account: {
      window,
      currency: usage.currency,
      metered: usage.totalCostMicro / 1e6,
      charged: charged / 1e6,
      delta: (charged - usage.totalCostMicro) / 1e6,
      complete: usage.complete,
      rates: usage.rates,
      note: "Org-wide reconciliation only; posting timestamps differ from usage buckets. No per-task billed allocation.",
    },
  };
}

const superserveSeriesSchema = z.object({
  buckets: z.array(z.object({ start: z.string(), end: z.string(), billed_total_usd: money })),
});

const superserveActivitySchema = z.array(
  z.object({ sandbox_id: z.string().nullable(), action: z.string(), created_at: z.string() }),
);

const SUPERSERVE_MARGIN_MS = 60_000;

/** Float noise only: 1e-12 USD is a hundred-millionth of a cent. */
const SUPERSERVE_TOLERANCE_USD = 1e-12;

type SuperserveAccount = {
  window: { start: string; end: string };
  totalUSD: number;
  sumOfSandboxRangesUSD: number;
  foreignSandboxIds: string[];
};

type SuperserveCharges =
  | { isolated: true; byId: Map<string, number>; settled: boolean; account: SuperserveAccount }
  | { isolated: false; reason: string; account: SuperserveAccount | null };

/**
 * Superserve charges per team, but usage-series accepts any millisecond range and clips buckets
 * to it. A sandbox's charge is the team charge over its own range, valid only when nothing else
 * ran: the audit log names only our sandboxes and the ranges sum to the padded run range.
 */
export async function readSuperserveCharges(
  rows: OwnedSandbox[],
  get: (url: string) => Promise<Json>,
  now = Date.now(),
): Promise<SuperserveCharges> {
  const charge = async (start: number, end: number) => {
    const query = new URLSearchParams({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      timezone: "UTC",
      granularity: "hour",
    });

    const series = superserveSeriesSchema.parse(
      await get(`https://api.superserve.ai/billing/usage-series?${query}`),
    );

    return series.buckets.reduce((sum, b) => sum + b.billed_total_usd, 0);
  };

  const ranges = rows.flatMap((r) =>
    r.startedAt && r.finishedAt
      ? [{ id: r.id, start: Date.parse(r.startedAt), end: Date.parse(r.finishedAt) }]
      : [],
  );

  if (!ranges.length || ranges.length !== rows.length)
    return { isolated: false, reason: "a sandbox has no recorded time range", account: null };
  const start = Math.min(...ranges.map((r) => r.start)) - SUPERSERVE_MARGIN_MS;
  const end = Math.max(...ranges.map((r) => r.end)) + SUPERSERVE_MARGIN_MS;
  const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  const activity: z.infer<typeof superserveActivitySchema> = [];

  for (let offset = 0; ; offset += 200) {
    if (offset >= 10_000) throw new Error("Superserve activity pagination limit");

    const query = new URLSearchParams({
      category: "sandbox",
      start: window.start,
      end: window.end,
      limit: "200",
      offset: String(offset),
    });

    const page = superserveActivitySchema.parse(
      await get(`https://api.superserve.ai/activity?${query}`),
    );

    activity.push(...page);

    if (page.length < 200) break;
  }

  const ours = new Set(rows.map((r) => r.id));

  const foreign = [
    ...new Set(
      activity.flatMap((a) => (a.sandbox_id && !ours.has(a.sandbox_id) ? [a.sandbox_id] : [])),
    ),
  ];

  const byId = new Map<string, number>();

  for (const range of ranges) byId.set(range.id, await charge(range.start, range.end));
  const total = await charge(start, end);
  const sum = [...byId.values()].reduce((s, v) => s + v, 0);

  const account: SuperserveAccount = {
    window,
    totalUSD: total,
    sumOfSandboxRangesUSD: sum,
    foreignSandboxIds: foreign,
  };

  if (foreign.length)
    return {
      isolated: false,
      reason: `${foreign.length} other sandboxes in the run window`,
      account,
    };

  if (Math.abs(total - sum) > SUPERSERVE_TOLERANCE_USD)
    return { isolated: false, reason: "charges outside the sandbox ranges", account };

  const deleted = new Set(
    activity.flatMap((a) => (a.action === "deleted" && a.sandbox_id ? [a.sandbox_id] : [])),
  );

  // Usage is live; a deleted sandbox's range is closed. Wait a little for the delete to land.
  const settled = rows.every((r) => deleted.has(r.id)) && now - end >= 60_000;

  return { isolated: true, byId, settled, account };
}

const BOXD_BUCKET_MS = 15 * 60_000;

/**
 * Metering lags up to ~25 minutes but the charge posts ~10 minutes after a bucket closes, so a
 * late reading can move a micro-unit between buckets. 2 micro-USD per bucket allows that and
 * rejects costMicro's round-up (about 1.5 micro-USD per machine).
 */
const BOXD_TOLERANCE_MICRO = 2;

export const boxdBucketSchema = z.object({
  currency: z.string(),
  complete: z.boolean(),
  rates: z.object({
    vcpuHourMicro: money,
    ramGibHourMicro: money,
    diskGibHourMicro: money,
  }),
  machines: z.array(
    z.object({ machineId: z.string(), vcpuHours: money, ramGibHours: money, diskGibHours: money }),
  ),
});

export type BoxdCharges =
  | { kind: "charged"; microById: Map<string, number>; buckets: unknown[] }
  | { kind: "unreconciled"; reason: string; buckets: unknown[] };

/**
 * boxd charges the whole org once per 15-minute usage bucket, about 10 minutes after the
 * bucket closes. That charge equals each machine's vCPU, RAM and disk micro-amounts summed and
 * rounded up to the micro-unit, summed over every machine in the bucket (machine costMicro rounds
 * each part up instead). Of 53 buckets read on 2026-11-16 (from 2026-11-05 and 2026-11-16), that
 * rule matched the posted charge exactly in 40, each with 1 to 3 machines, where rounding each
 * part to the nearest micro-unit was short by 1 to 2 in most. One was 1 under; the other 12 had 3
 * to 9 machines and were charged 11 to 50 more, which no rounding explains. When each bucket the run touched has
 * exactly one posted charge equal to that sum, within BOXD_TOLERANCE_MICRO, the charge splits
 * exactly into per-machine amounts, so other machines in the org do not matter.
 */
export async function readBoxdCharges(
  rows: OwnedSandbox[],
  env: NodeJS.ProcessEnv,
  query?: BoxdQuery,
): Promise<BoxdCharges> {
  query ??= await boxdClient(env);
  const starts = rows.flatMap((r) => (r.startedAt ? [Date.parse(r.startedAt)] : []));
  const ends = rows.flatMap((r) => (r.finishedAt ? [Date.parse(r.finishedAt)] : []));

  if (!rows.length || starts.length !== rows.length || ends.length !== rows.length)
    return { kind: "unreconciled", reason: "a machine has no recorded time range", buckets: [] };
  const first = Math.floor(Math.min(...starts) / BOXD_BUCKET_MS) * BOXD_BUCKET_MS;
  // Machines are metered until deletion lands; include the bucket after the last delete.
  const last = Math.floor((Math.max(...ends) + 60_000) / BOXD_BUCKET_MS) * BOXD_BUCKET_MS;

  if ((last - first) / BOXD_BUCKET_MS > 16)
    return { kind: "unreconciled", reason: "run spans more than 4 hours", buckets: [] };
  const ours = new Set(rows.map((r) => r.id));
  const microById = new Map<string, number>();
  const buckets: unknown[] = [];

  const charges = activitySchema.parse(
    await query("billingActivityPage", {
      org: env.BOXD_ORG,
      since: new Date(first),
      until: new Date(last + 3 * BOXD_BUCKET_MS),
      pageSize: 1000,
    }),
  );

  if (charges.nextPageToken)
    return { kind: "unreconciled", reason: "billing activity spans pages", buckets };

  for (let start = first; start <= last; start += BOXD_BUCKET_MS) {
    const end = start + BOXD_BUCKET_MS;

    const usage = boxdBucketSchema.parse(
      await query("usage", { org: env.BOXD_ORG, since: new Date(start), until: new Date(end) }),
    );

    const { rates } = usage;

    const parts = usage.machines.map((m) => ({
      id: m.machineId,
      micro: Math.ceil(
        m.vcpuHours * rates.vcpuHourMicro +
          m.ramGibHours * rates.ramGibHourMicro +
          m.diskGibHours * rates.diskGibHourMicro,
      ),
    }));

    const posted = charges.entries.filter(
      (e) =>
        e.kind === "usage_charge" &&
        e.createdAt.getTime() >= end + 5 * 60_000 &&
        e.createdAt.getTime() < end + 20 * 60_000,
    );

    const expected = parts.reduce((sum, p) => sum + p.micro, 0);
    const charged = posted.length === 1 ? -(posted[0]?.amountMicro ?? 0) : null;
    const foreign = parts.filter((p) => !ours.has(p.id) && p.micro > 0).length;
    buckets.push({
      start: new Date(start).toISOString(),
      expectedMicro: expected,
      chargedMicro: charged,
      otherMachines: foreign,
      complete: usage.complete,
    });

    if (usage.currency.toLowerCase() !== "usd" || charges.currency.toLowerCase() !== "usd")
      return { kind: "unreconciled", reason: "non-USD account", buckets };

    if (!usage.complete) return { kind: "unreconciled", reason: "bucket still metering", buckets };

    // A bucket with no usage gets no charge entry.
    if (expected === 0 && posted.length === 0) continue;

    if (charged === null || Math.abs(charged - expected) > BOXD_TOLERANCE_MICRO)
      return { kind: "unreconciled", reason: "posted charge differs from usage", buckets };

    for (const p of parts) microById.set(p.id, (microById.get(p.id) ?? 0) + p.micro);
  }

  if (rows.some((r) => !microById.has(r.id)))
    return { kind: "unreconciled", reason: "a machine is absent from usage", buckets };

  return { kind: "charged", microById, buckets };
}

export async function collectProvider(
  provider: string,
  rows: OwnedSandbox[],
  env: NodeJS.ProcessEnv,
  transport: Transport = http,
  offline = false,
  waitMs = 0,
  extra: { modalReport?: ModalReport; now?: number; usageDir?: string } = {},
): Promise<ProviderCosts> {
  const spec = sources.get(provider) ?? {
    source: "No billing collector",
    granularity: "not available",
    delay: "unknown",
    key: "",
    notes: [],
  };

  const result: ProviderCosts = {
    provider,
    source: spec.source,
    granularity: spec.granularity,
    delay: spec.delay,
    notes: [...spec.notes],
    sandboxes: [],
    account: null,
  };

  // Vercel's SDK takes a project OIDC token or an access token.
  const key = (
    provider === "vercel" ? env.VERCEL_OIDC_TOKEN || env.VERCEL_TOKEN : env[spec.key]
  )?.trim();

  const supported = [
    "boat",
    "upstash",
    "e2b",
    "boxd",
    "superserve",
    "daytona",
    "modal",
    "vercel",
    "instabox",
    "archil",
    "maritime",
    "microsandbox",
    "microsandbox-shared",
  ].includes(provider);

  let blocked = offline
    ? "Offline mode: no billing calls made"
    : !supported
      ? "Not available: no verified billing endpoint"
      : !key
        ? `Missing ${spec.key}; no billing call made`
        : null;

  if (!blocked && provider === "modal") {
    const charges = await collectModal(rows, { report: extra.modalReport, now: extra.now });
    result.sandboxes.push(...charges.sandboxes);
    result.account = charges.account;

    return result;
  }

  if (!blocked && provider === "daytona") {
    try {
      const headers = { Authorization: `Bearer ${key}` };

      const organization =
        env.DAYTONA_ORGANIZATION_ID ??
        z
          .object({ organizationId: z.string().min(1) })
          .parse(await transport("https://app.daytona.io/api/api-keys/current", headers))
          .organizationId;

      const window = windowFor(rows);

      if (!window) throw new Error("Missing time window");
      const query = new URLSearchParams({ from: window.start, to: window.end });

      const usage = z
        .array(z.object({ sandboxId: z.string(), totalPrice: money }))
        .parse(
          await transport(
            `https://analytics.app.daytona.io/organization/${encodeURIComponent(organization)}/usage/sandbox?${query}`,
            headers,
          ),
        );

      const complete = Date.now() - Date.parse(window.end) >= 48 * 3_600_000;
      result.account = {
        window,
        note: "Per-sandbox usage prices in this window; settlement may lag 48 hours. Not a net invoice.",
      };

      for (const row of rows) {
        const item = usage.find((u) => u.sandboxId === row.id);
        result.sandboxes.push({
          id: row.id,
          source: spec.source,
          cost: item
            ? {
                kind: "billed",
                usd: item.totalPrice,
                scope: "window",
                complete,
                confidence: complete ? "medium" : "low",
                note: "Provider usage price in requested window; credits/tax excluded; 48-hour settlement guard",
              }
            : unavailable(
                "No sandbox usage returned in window; retention or billing delay, not zero",
              ),
        });
      }

      return result;
    } catch (error) {
      blocked = errorNote(error);
    }
  }

  if (!blocked && microsandboxTier(provider) !== undefined) {
    try {
      const headers = { Authorization: `Bearer ${key}` };
      const root = (env.MSB_API_URL?.trim() || "https://api.microsandbox.dev").replace(/\/+$/, "");
      const window = windowFor(rows);

      if (!window) {
        for (const row of rows)
          result.sandboxes.push({
            id: row.id,
            source: spec.source,
            cost: unavailable(
              "No run window: no sandbox in this run has a start and an end, so no usage was read; not zero",
            ),
          });

        return result;
      }

      const query = new URLSearchParams({ from: window.start, to: window.end });

      const breakdown = microsandboxBreakdownSchema.parse(
        await transport(`${root}/v1/billing/usage/sandbox?${query}`, headers),
      );

      // The invoice preview is an optional cross-check: when it cannot be read, the usage rows are
      // still rated, provisional as always, and say the cross-check did not happen.
      let summary: z.infer<typeof microsandboxSummarySchema> | undefined;
      let crossCheckFailure: string | undefined;

      try {
        summary = microsandboxSummarySchema.parse(
          await transport(`${root}/v1/billing/usage?${query}`, headers),
        );
      } catch (error) {
        crossCheckFailure = errorNote(error);
      }

      const unchecked =
        crossCheckFailure === undefined
          ? ""
          : ` The costs.workloads cross-check could not be read (${crossCheckFailure}).`;

      result.account = {
        window,
        incomplete: summary?.costs?.incomplete ?? null,
        note: `Account usage rows for the run window, read once; daily rows can include activity outside this run. Not a net invoice.${unchecked}`,
      };

      for (const row of rows)
        result.sandboxes.push({
          id: row.id,
          source: spec.source,
          cost: decodeMicrosandbox({
            id: row.id,
            rows: breakdown.rows,
            workloadUsd: summary?.costs?.workloads[row.id],
            crossCheckFailure,
          }),
        });

      return result;
    } catch (error) {
      blocked = errorNote(error);
    }
  }

  if (!blocked && provider === "boxd") {
    try {
      const deadline = Date.now() + waitMs;
      let snapshot = await readBoxdAccount(rows, env);

      while (
        !rows.every((row) =>
          snapshot.usage.machines.some((m) => m.machineId === row.id && m.complete),
        ) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(20_000, Math.max(0, deadline - Date.now()))),
        );
        snapshot = await readBoxdAccount(rows, env);
      }

      const { usage, account } = snapshot;
      const reconciled = await readBoxdCharges(rows, env);
      result.account = {
        ...account,
        reconciliation:
          reconciled.kind === "charged"
            ? { kind: "charged", buckets: reconciled.buckets }
            : reconciled,
      };

      if (reconciled.kind === "charged") {
        for (const row of rows)
          result.sandboxes.push({
            id: row.id,
            source: "boxd orgs.billingActivityPage usage_charge, reconciled per 15-minute bucket",
            cost: {
              kind: "billed",
              usd: (reconciled.microById.get(row.id) ?? Number.NaN) / 1e6,
              scope: "sandbox-lifetime",
              complete: true,
              confidence: "high",
              note: "Machine's share of boxd's posted 15-minute org charges: its vCPU, RAM and disk amounts rounded up together, which with the other machines' shares sum exactly to each charge",
            },
          });

        return result;
      }

      for (const row of rows) {
        const machine = usage.machines.find((m) => m.machineId === row.id);
        result.sandboxes.push({
          id: row.id,
          source: spec.source,
          cost: machine
            ? decodeBoxd({ ...machine, currency: usage.currency }, row.id, "window")
            : unavailable("Machine absent from org usage window"),
        });
      }

      return result;
    } catch (error) {
      blocked = errorNote(error);
    }
  }

  if (!blocked && provider === "superserve") {
    try {
      const headers = { "X-API-Key": key ?? "" };

      const summary = z
        .object({
          current_charges_usd: money,
          credits_applied_usd: money.nullable(),
          expected_invoice_amount_usd: money.nullable(),
          billing_period: z.object({
            start: z.coerce.date().transform((d) => d.toISOString()),
            end: z.coerce.date().transform((d) => d.toISOString()),
          }),
        })
        .parse(await transport("https://api.superserve.ai/billing/summary", headers));

      const pricing = z
        .object({
          currency: z.string(),
          rates: z.array(
            z.object({ resource_key: z.string(), price_usd: money, billable: z.boolean() }),
          ),
        })
        .parse(await transport("https://api.superserve.ai/billing/pricing", headers));

      const charges = await readSuperserveCharges(rows, (url) => transport(url, headers));
      result.account = { ...charges.account, summary, pricing };

      if (charges.isolated) {
        for (const row of rows) {
          const usd = charges.byId.get(row.id);
          result.sandboxes.push({
            id: row.id,
            source: spec.source,
            cost:
              usd === undefined
                ? unavailable("Sandbox has no recorded time range")
                : {
                    kind: "billed",
                    usd,
                    scope: "sandbox-lifetime",
                    complete: charges.settled,
                    confidence: charges.settled ? "high" : "low",
                    note: "Provider's account charge over this sandbox's own create-to-delete range, in a run proven isolated; before credits/tax",
                  },
          });
        }

        return result;
      }

      blocked = `Account charge not attributable: ${charges.reason}`;
    } catch (error) {
      blocked = errorNote(error);
    }
  }

  for (const row of rows) {
    if (blocked) {
      result.sandboxes.push({ id: row.id, source: spec.source, cost: unavailable(blocked) });
      continue;
    }

    try {
      const id = encodeURIComponent(row.id);
      let cost: Cost;

      if (provider === "boat")
        cost = decodeBoat(
          await transport(`https://boat.dev/api/v1/sandboxes/${id}/usage`, {
            Authorization: `Bearer ${key}`,
          }),
          row.id,
        );
      else if (provider === "upstash")
        cost = decodeUpstash(
          await transport(`https://us-east-1.box.upstash.com/v2/box/${id}`, {
            Authorization: `Bearer ${key}`,
          }),
          row.id,
        );
      else if (provider === "e2b") {
        const events: z.infer<typeof eventSchema>[] = [];
        let exhausted = false;

        for (let offset = 0; offset < 10_000; offset += 100) {
          const page = z
            .array(eventSchema)
            .parse(
              await transport(
                `https://api.e2b.app/events/sandboxes/${id}?limit=100&offset=${offset}`,
                { "X-API-Key": key ?? "" },
              ),
            );

          events.push(...page);

          if (page.length < 100) {
            exhausted = true;
            break;
          }
        }

        cost = exhausted
          ? decodeEvents(events)
          : unavailable("Event pagination limit; history incomplete");
      } else if (provider === "instabox") {
        const headers = { "X-API-Key": key ?? "" };
        // From the same environment as the key, without trailing slashes as the adapter joins it:
        // `//v1/machines/<id>` can answer 404 for a live machine, marking its accruing usage final.
        const base = endpoint(env.INSTABOX_API_URL ?? "https://api.instabox.sh");

        // Deletion first: a machine already gone (404) when its usage is read has a final meter.
        const deleted = await transport(`${base}/v1/machines/${id}`, headers).then(
          () => false,
          (cause: unknown) => {
            if (cause instanceof BillingHttpError && cause.status === 404) return true;
            throw cause;
          },
        );

        const usage = await transport(
          `${base}/v1/machines/${id}/usage?${instaboxUsageQuery(row, extra.now)}`,
          headers,
        );

        cost = decodeInstabox(usage, { deleted, started: row.startedAt !== null });
      } else if (provider === "archil") {
        const headers = { Authorization: `Bearer ${key ?? ""}` };
        const base = archilControlUrl(env.ARCHIL_REGION);

        // Deletion and Archil's own end of the last session first, so a usage read after them is
        // known to be final. A sandbox already dropped (404) has no end time left: provisional.
        const native = await transport(`${base}/api/sandboxes/${id}`, headers).then(
          (raw) => {
            const found = archilSandboxBody.parse(raw);

            return { deleted: found.status === "deleted", endedAt: found.finishedAt };
          },
          (cause: unknown) => {
            if (cause instanceof BillingHttpError && cause.status === 404)
              return { deleted: true, endedAt: undefined };
            throw cause;
          },
        );

        cost = decodeArchil(await transport(`${base}/api/sandboxes/${id}/usage`, headers), native);
      } else if (provider === "maritime") {
        const headers = { Authorization: `Bearer ${key}` };
        const root = (env.MARITIME_API_URL ?? "https://api.maritime.sh").replace(/\/+$/, "");

        const info = maritimeInfoSchema.parse(
          await transport(`${root}/v1/sandboxes/${id}/info`, headers),
        );

        const records: MaritimeUsageRecord[] = [];
        let cursor: string | undefined;
        let exhausted = false;

        for (let page = 0; page < maritimeUsagePages; page++) {
          const answer = maritimeUsagePageSchema.parse(
            await transport(
              `${root}/v1/usage?${maritimeUsageQuery(info, extra.now, cursor)}`,
              headers,
            ),
          );

          records.push(...answer.data);

          if (answer.nextCursor === null) {
            exhausted = true;
            break;
          }

          cursor = answer.nextCursor;
        }

        cost = exhausted
          ? decodeMaritime(info, records, row.id)
          : unavailable("Maritime usage pagination limit; history incomplete");
      } else if (provider === "vercel") cost = await vercelCost(row.id, extra.usageDir);
      else cost = unavailable("No supported per-sandbox billing source");
      result.sandboxes.push({ id: row.id, source: spec.source, cost });
    } catch (error) {
      const note = errorNote(error);
      result.sandboxes.push({ id: row.id, source: spec.source, cost: unavailable(note) });

      // Do not spend minutes retrying a dead network or unauthorized account for every ID.
      if (!(error instanceof BillingHttpError) || [401, 403, 429].includes(error.status))
        blocked = note;
    }
  }

  return result;
}
