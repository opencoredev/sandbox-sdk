import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { OwnedSandbox } from "./input.js";

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
export type Transport = (url: string, headers: Record<string, string>) => Promise<unknown>;
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
export const sources: Record<
  string,
  { source: string; granularity: string; delay: string; key: string; notes: string[] }
> = {
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
    source: "https://api.superserve.ai/billing/{pricing,summary,usage-series}",
    granularity: "account hourly buckets",
    delay: "hourly aggregation; invoice settlement separate",
    key: "SUPERSERVE_API_KEY",
    notes: [
      "Account charges cannot identify a sandbox or scenario. Requires a proven isolated window; no proportional allocation. Credits and expected invoice are separate.",
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
  tenki: {
    source: "No verified public billing endpoint",
    granularity: "not available",
    delay: "unknown",
    key: "TENKI_API_KEY",
    notes: ["No billing API found; no fabricated cost."],
  },
  freestyle: {
    source: "No verified public billing endpoint",
    granularity: "not available",
    delay: "unknown",
    key: "FREESTYLE_API_KEY",
    notes: ["No billing API found; no fabricated cost."],
  },
};
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
const activitySchema = z.object({
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

export function decodeBoat(raw: unknown, id: string): Cost {
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
export function decodeUpstash(raw: unknown, id: string): Cost {
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
  raw: unknown,
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
export function decodeEvents(raw: unknown): Cost {
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
function errorNote(error: unknown) {
  return error instanceof BillingHttpError
    ? `Billing HTTP ${error.status}; retry after settlement or check retention/permissions`
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
async function invoke(receiver: unknown, name: string, ...args: unknown[]): Promise<unknown> {
  // Native SDK methods live on prototypes, not in the parsed record.
  if (typeof receiver !== "object" || receiver === null) throw new Error("Invalid billing SDK");
  const method: unknown = Reflect.get(receiver, name);
  if (typeof method !== "function") throw new Error("Missing billing SDK method");
  return Reflect.apply(method, receiver, args);
}
type BoxdQuery = (
  method: "usage" | "billingActivityPage",
  params: { org?: string; since: Date; until: Date; pageSize?: number; pageToken?: string },
) => Promise<unknown>;
export async function readBoxdAccount(
  rows: OwnedSandbox[],
  env: NodeJS.ProcessEnv,
  query?: BoxdQuery,
) {
  if (!query) {
    const require = createRequire(
      resolve(import.meta.dirname, "../../../packages/sdk/package.json"),
    );
    const module: unknown = await import(pathToFileURL(require.resolve("@boxd-sh/sdk")).href);
    const exports = z.record(z.string(), z.unknown()).parse(module);
    if (typeof exports.Boxd !== "function") throw new Error("Missing Boxd SDK");
    const client: unknown = Reflect.construct(exports.Boxd, [
      { apiKey: env.BOXD_API_KEY, timeout: 15_000, maxRetries: 0 },
    ]);
    const api = z.object({ orgs: z.unknown() }).parse(client);
    query = (method, params) => invoke(api.orgs, method, params);
  }
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
export async function collectProvider(
  provider: string,
  rows: OwnedSandbox[],
  env: NodeJS.ProcessEnv,
  transport: Transport = http,
  offline = false,
  waitMs = 0,
): Promise<ProviderCosts> {
  const spec = sources[provider] ?? {
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
  const key = env[spec.key]?.trim();
  const supported = ["boat", "upstash", "e2b", "boxd", "superserve", "daytona"].includes(provider);
  let blocked = offline
    ? "Offline mode: no billing calls made"
    : !supported
      ? "Not available: no verified billing endpoint"
      : !key
        ? `Missing ${spec.key}; no billing call made`
        : null;
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
      result.account = account;
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
          credits_applied_usd: money,
          expected_invoice_amount_usd: money,
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
      const window = windowFor(rows);
      if (!window) throw new Error("Missing time window");
      const query = new URLSearchParams({
        start: window.start,
        end: window.end,
        timezone: "UTC",
        granularity: "hour",
      });
      const series = z
        .object({
          buckets: z.array(
            z.object({ start: z.string(), end: z.string(), billed_total_usd: money }),
          ),
        })
        .parse(await transport(`https://api.superserve.ai/billing/usage-series?${query}`, headers));
      result.account = {
        window,
        summary,
        pricing,
        buckets: series.buckets,
        note: "Account-wide, unverified isolation. Billed bucket totals are not assigned to benchmark sandboxes or scenarios.",
      };
      blocked = "Only account hourly charges available; isolated window not proven";
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
      } else cost = unavailable("No supported per-sandbox billing source");
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
