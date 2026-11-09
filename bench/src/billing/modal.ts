import { z } from "zod";
import { nativeModules } from "../existence.js";
import type { OwnedSandbox } from "./input.js";
import type { Cost, SandboxCost } from "./providers.js";

/**
 * Modal's billing report gives cost per App per hour, broken out by resource (CPU, Memory, Network
 * Egress), before credits, reservations and the egress allowance
 * (https://modal.com/docs/guide/billing). It has no per-sandbox rows and does not carry sandbox
 * tags, so a sandbox is priced only when it is the one sandbox in its App: the bench's per-attempt
 * Apps (`--app-per-attempt modal`, modal-apps.ts). The documented interface is the Python CLI
 * `modal billing report` (https://modal.com/docs/reference/cli/billing); this reads the same call
 * through the JS client.
 */
export const modalBillingSource =
  "Modal billing report (workspaceBillingReport, cost per App per hour by resource; the call behind `modal billing report`)";

const hourMs = 3_600_000;

/**
 * Modal publishes no settlement time. Its billing guide says data is usually available "within
 * minutes", with possible delays, and recommends "leaving a buffer after the end of the query
 * interval"; the CLI reference says "Data will be reported for full intervals only"
 * (https://modal.com/docs/guide/billing, https://modal.com/docs/reference/cli/billing, read
 * November 9, 2026). This 30-minute buffer after the end of the hour of the confirmed stop is the
 * bench's heuristic, not a settlement Modal states: before it, and whenever an hour the sandbox
 * ran in has no row, the charge stays provisional.
 */
export const modalSettleBufferMs = 30 * 60_000;

/** When the hourly interval holding `stoppedAt` has closed and the buffer has passed. */
export function modalSettledAt(stoppedAt: number): number {
  return Math.floor(stoppedAt / hourMs) * hourMs + hourMs + modalSettleBufferMs;
}

/**
 * The hours (interval starts, ms) a sandbox running from `start` to `stop` should have rows for:
 * every hour it overlaps at all. Modal does not say a short overlap has no charge, so a missing row
 * for any of them keeps the charge provisional rather than dropping part of it.
 */
export function expectedIntervals(start: number, stop: number): number[] {
  const hours: number[] = [];

  for (let hour = Math.floor(start / hourMs) * hourMs; hour < stop; hour += hourMs)
    hours.push(hour);

  return hours.length ? hours : [Math.floor(start / hourMs) * hourMs];
}

/** The report's items for a window: one per App and hourly interval. */
export type ModalReport = (window: { start: Date; end: Date }) => AsyncIterable<object>;

// Decimal USD as a string, such as "0.00596985".
const decimal = z.string().regex(/^\d+(\.\d+)?$/);

const reportItem = z.object({
  objectId: z.string(),
  description: z.string(),
  interval: z.date(),
  cost: decimal,
  // Measured November 9, 2026: "CPU", "Memory", "Network Egress".
  costByResource: z.record(z.string(), decimal).default({}),
});

/** Which part of the charge a report resource is: compute is what the site publishes as cost. */
function resourceKind(name: string): "compute" | "egress" | "other" {
  if (/^(cpu|memory)$/i.test(name) || /gpu/i.test(name)) return "compute";

  return /egress/i.test(name) ? "egress" : "other";
}

async function* nativeReport(window: { start: Date; end: Date }): AsyncIterable<object> {
  const { ModalClient } = await nativeModules.load("modal");
  const client = new ModalClient();

  try {
    yield* client.cpClient.workspaceBillingReport({
      startTimestamp: window.start,
      endTimestamp: window.end,
      resolution: "h",
      tagNames: [],
      environmentIds: [],
      appIds: [],
    });
  } finally {
    client.close();
  }
}

const unavailable = (note: string): Cost => ({ kind: "unavailable", confidence: "none", note });

/** One App's charge as the report gives it, split by resource. */
export interface ModalAppCharge {
  name: string;
  appId: string;
  sandboxes: readonly string[];
  /** Creates in the App whose outcome is unknown; any one may have run another sandbox. */
  ambiguous: number;
  /** CPU, memory and any GPU: the published compute cost. Null when the report has no row yet. */
  computeUSD: number | null;
  /** Network egress, which the site excludes from compute cost. */
  egressUSD: number | null;
  /** Resources the collector does not recognize, by name. */
  other: Record<string, number>;
  /** The App's whole charge: compute, egress and anything else. */
  totalUSD: number | null;
  intervals: string[];
  /** Hours the App's sandboxes ran in that have no row yet. */
  missingIntervals: string[];
  /** Whether the hourly rows are complete by the collector's rule (see `modalSettleBufferMs`). */
  settled: boolean;
}

export interface ModalCharges {
  sandboxes: SandboxCost[];
  account: {
    window: { start: string; end: string };
    apps: ModalAppCharge[];
    settleRule: string;
  } | null;
}

interface AppTotals {
  total: number;
  compute: number;
  egress: number;
  other: Map<string, number>;
  intervals: Set<string>;
  /** Rows with a nonzero cost and no per-resource breakdown. */
  unsplit: number;
}

/** The compute charge of each sandbox that is alone in its journaled App. Read-only. */
export async function collectModal(
  rows: readonly OwnedSandbox[],
  options: { report?: ModalReport; now?: number } = {},
): Promise<ModalCharges> {
  const now = options.now ?? Date.now();
  const priced = rows.filter((row) => row.app?.appId);

  const entry = (row: OwnedSandbox, cost: Cost): SandboxCost => ({
    id: row.id,
    source: modalBillingSource,
    cost,
  });

  const unpriced = (row: OwnedSandbox) =>
    entry(
      row,
      unavailable(
        row.app === null
          ? "Created in the shared default App, and Modal bills per App: run with --app-per-attempt modal"
          : `App ${row.app.name} has no journaled App ID`,
      ),
    );

  if (!priced.length) return { sandboxes: rows.map(unpriced), account: null };

  const starts = priced.map((row) => (row.startedAt ? Date.parse(row.startedAt) : Number.NaN));

  if (!starts.every(Number.isFinite))
    return {
      sandboxes: rows.map((row) => entry(row, unavailable("A sandbox has no recorded start"))),
      account: null,
    };

  // Whole hours from the hour of the first start; the end is exclusive.
  const start = new Date(Math.floor(Math.min(...starts) / hourMs) * hourMs);
  const end = new Date(now);
  const byApp = new Map<string, AppTotals>();

  try {
    for await (const raw of (options.report ?? nativeReport)({ start, end })) {
      const item = reportItem.parse(raw);

      if (item.interval < start) continue;

      const totals = byApp.get(item.objectId) ?? {
        total: 0,
        compute: 0,
        egress: 0,
        other: new Map(),
        intervals: new Set(),
        unsplit: 0,
      };

      const cost = Number(item.cost);
      const parts = Object.entries(item.costByResource);
      totals.total += cost;
      totals.intervals.add(item.interval.toISOString());

      if (!parts.length && cost > 0) totals.unsplit++;

      for (const [name, value] of parts) {
        const kind = resourceKind(name);

        if (kind === "compute") totals.compute += Number(value);
        else if (kind === "egress") totals.egress += Number(value);
        else totals.other.set(name, (totals.other.get(name) ?? 0) + Number(value));
      }

      byApp.set(item.objectId, totals);
    }
  } catch (error) {
    const code = z.object({ code: z.number().int() }).safeParse(error);

    const note = `Billing report failed${code.success ? ` (gRPC ${code.data.code})` : ""}; retry later`;

    return { sandboxes: rows.map((row) => entry(row, unavailable(note))), account: null };
  }

  const apps = new Map<string, ModalAppCharge>();
  const unsplitApps = new Set<string>();

  for (const row of priced) {
    const app = row.app;

    if (!app?.appId || apps.has(app.appId)) continue;
    const members = rows.filter((other) => other.app?.appId === app.appId);

    const stops = members.map((m) =>
      m.confirmedStopAt ? Date.parse(m.confirmedStopAt) : Number.NaN,
    );

    const totals = byApp.get(app.appId);
    const intervals = [...(totals?.intervals ?? [])].sort();

    // Hours any member ran in, from its start to its confirmed stop. Unknown without both.
    const expected = new Set(
      members.flatMap((m, index) => {
        const begun = m.startedAt ? Date.parse(m.startedAt) : Number.NaN;
        const stopped = stops[index] ?? Number.NaN;

        return Number.isFinite(begun) && Number.isFinite(stopped)
          ? expectedIntervals(begun, stopped).map((hour) => new Date(hour).toISOString())
          : [];
      }),
    );

    const missing = [...expected].filter((hour) => !intervals.includes(hour)).sort();

    // Complete only with every member's confirmed stop, the buffer passed and every hour reported.
    const settled =
      members.length === app.sandboxes.length &&
      stops.every(Number.isFinite) &&
      now >= modalSettledAt(Math.max(...stops)) &&
      missing.length === 0;

    if (totals?.unsplit) unsplitApps.add(app.appId);

    apps.set(app.appId, {
      name: app.name,
      appId: app.appId,
      sandboxes: app.sandboxes,
      ambiguous: app.ambiguous,
      computeUSD: totals ? totals.compute : null,
      egressUSD: totals ? totals.egress : null,
      other: Object.fromEntries(totals?.other ?? []),
      totalUSD: totals ? totals.total : null,
      intervals,
      missingIntervals: missing,
      settled,
    });
  }

  const sandboxes = rows.map((row): SandboxCost => {
    const appId = row.app?.appId;
    const app = appId ? apps.get(appId) : undefined;

    if (!row.app || !app) return unpriced(row);

    if (app.ambiguous)
      return entry(
        row,
        unavailable(
          `App ${app.name} has ${app.ambiguous} create(s) whose result is unknown (a lost response), so its charge may include another sandbox; the App's charge is in account.apps`,
        ),
      );

    if (app.sandboxes.length !== 1)
      return entry(
        row,
        unavailable(
          `App ${app.name} holds ${app.sandboxes.length} sandboxes and Modal reports cost per App only; the App's charge is in account.apps`,
        ),
      );

    if (app.computeUSD === null)
      return entry(
        row,
        unavailable(
          app.settled
            ? `No billing rows for App ${app.name} after settlement; not zero`
            : `No billing rows for App ${app.name} yet; Modal reports full hours only`,
        ),
      );

    if (unsplitApps.has(app.appId))
      return entry(
        row,
        unavailable(
          `App ${app.name} has billing rows without a per-resource breakdown, so compute cannot be told from egress`,
        ),
      );

    const unknown = Object.entries(app.other).filter(([, usd]) => usd > 0);

    if (unknown.length)
      return entry(
        row,
        unavailable(
          `App ${app.name} was billed for unrecognized resources (${unknown.map(([name]) => name).join(", ")}); compute alone is not known`,
        ),
      );

    const stopped = row.confirmedStopAt ? Date.parse(row.confirmedStopAt) : Number.NaN;

    const pending = [
      ...(Number.isFinite(stopped)
        ? now < modalSettledAt(stopped)
          ? [
              `within this collector's buffer until ${new Date(modalSettledAt(stopped)).toISOString()}`,
            ]
          : []
        : ["no confirmed stop was recorded, so it never completes"]),
      ...(app.missingIntervals.length ? [`no row yet for ${app.missingIntervals.join(", ")}`] : []),
    ].join("; ");

    const split = `compute (CPU and memory) only; egress $${(app.egressUSD ?? 0).toFixed(8)} and the App total are in account.apps`;

    return entry(row, {
      kind: "billed",
      usd: app.computeUSD,
      scope: "sandbox-lifetime",
      complete: app.settled,
      confidence: app.settled ? "medium" : "low",
      note: app.settled
        ? `Modal's charge for App ${app.name}, its only sandbox: ${split}; before credits, reservations and egress allowance`
        : `Provisional: Modal's charge for App ${app.name} so far, ${split}; ${pending || "not yet complete"}`,
    });
  });

  return {
    sandboxes,
    account: {
      window: { start: start.toISOString(), end: end.toISOString() },
      apps: [...apps.values()],
      settleRule:
        "Provisional until every sandbox in the App has a confirmed stop, 30 minutes have passed after the end of the hour of the last one, and every hour the App's sandboxes ran in has a row. The 30-minute buffer is this collector's heuristic: Modal reports full hours only, publishes no settlement time and recommends a buffer after the query interval (https://modal.com/docs/guide/billing).",
    },
  };
}
