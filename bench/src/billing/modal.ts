import { z } from "zod";
import { nativeModules } from "../existence.js";
import type { OwnedSandbox } from "./input.js";
import type { Cost, SandboxCost } from "./providers.js";

/**
 * Modal's billing report gives cost per App per hour (CPU, memory, egress), before credits,
 * reservations and the egress allowance (https://modal.com/docs/guide/billing). It has no
 * per-sandbox rows and does not carry sandbox tags, so a sandbox is priced only when it is the one
 * sandbox in its App: the bench's per-attempt Apps (`--app-per-attempt modal`, modal-apps.ts).
 * The documented interface is the Python CLI `modal billing report`
 * (https://modal.com/docs/reference/cli/billing); this reads the same call through the JS client.
 */
export const modalBillingSource =
  "Modal billing report (workspaceBillingReport, cost per App per hour; the call behind `modal billing report`)";

const hourMs = 3_600_000;

/**
 * Modal publishes no settlement time. Its billing guide says data is usually available "within
 * minutes", with possible delays, and recommends "leaving a buffer after the end of the query
 * interval"; the CLI reference says "Data will be reported for full intervals only"
 * (https://modal.com/docs/guide/billing, https://modal.com/docs/reference/cli/billing, read
 * November 9, 2026). This collector therefore treats an App's charge as provisional until this
 * long after the end of the hour in which its last sandbox stopped. The buffer is the bench's
 * rule, not Modal's.
 */
export const modalSettleBufferMs = 30 * 60_000;

/** When the hourly interval holding `finishedAt` has closed and the buffer has passed. */
export function modalSettledAt(finishedAt: number): number {
  return Math.floor(finishedAt / hourMs) * hourMs + hourMs + modalSettleBufferMs;
}

/** The report's items for a window: one per App and hourly interval. */
export type ModalReport = (window: { start: Date; end: Date }) => AsyncIterable<object>;

const reportItem = z.object({
  objectId: z.string(),
  description: z.string(),
  interval: z.date(),
  // Decimal USD as a string, such as "0.00596985".
  cost: z.string().regex(/^\d+(\.\d+)?$/),
});

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

/** One App's charge as the report gives it. */
export interface ModalAppCharge {
  name: string;
  appId: string;
  sandboxes: readonly string[];
  /** Null when the report has no row for the App yet. */
  usd: number | null;
  intervals: string[];
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

/** The charge of each sandbox that is alone in its journaled App. Read-only. */
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
  const byApp = new Map<string, { usd: number; intervals: string[] }>();

  try {
    for await (const raw of (options.report ?? nativeReport)({ start, end })) {
      const item = reportItem.parse(raw);

      if (item.interval < start) continue;
      const total = byApp.get(item.objectId) ?? { usd: 0, intervals: [] };
      total.usd += Number(item.cost);
      total.intervals.push(item.interval.toISOString());
      byApp.set(item.objectId, total);
    }
  } catch (error) {
    const code = z.object({ code: z.number().int() }).safeParse(error);

    const note = `Billing report failed${code.success ? ` (gRPC ${code.data.code})` : ""}; retry later`;

    return { sandboxes: rows.map((row) => entry(row, unavailable(note))), account: null };
  }

  const apps = new Map<string, ModalAppCharge>();

  for (const row of priced) {
    const app = row.app;

    if (!app?.appId || apps.has(app.appId)) continue;
    const members = rows.filter((other) => other.app?.appId === app.appId);
    const finishes = members.map((m) => (m.finishedAt ? Date.parse(m.finishedAt) : Number.NaN));

    const settled =
      members.length === app.sandboxes.length &&
      finishes.every(Number.isFinite) &&
      now >= modalSettledAt(Math.max(...finishes));

    const charge = byApp.get(app.appId);

    apps.set(app.appId, {
      name: app.name,
      appId: app.appId,
      sandboxes: app.sandboxes,
      usd: charge?.usd ?? null,
      intervals: charge?.intervals ?? [],
      settled,
    });
  }

  const sandboxes = rows.map((row): SandboxCost => {
    const appId = row.app?.appId;
    const app = appId ? apps.get(appId) : undefined;

    if (!row.app || !app) return unpriced(row);

    if (app.sandboxes.length !== 1)
      return entry(
        row,
        unavailable(
          `App ${app.name} holds ${app.sandboxes.length} sandboxes and Modal reports cost per App only; the App's charge is in account.apps`,
        ),
      );

    if (app.usd === null)
      return entry(
        row,
        unavailable(
          app.settled
            ? `No billing rows for App ${app.name} after settlement; not zero`
            : `No billing rows for App ${app.name} yet; Modal reports full hours only`,
        ),
      );

    const finished = row.finishedAt ? Date.parse(row.finishedAt) : Number.NaN;

    const settles = Number.isFinite(finished)
      ? `settles ${new Date(modalSettledAt(finished)).toISOString()} by this collector's rule`
      : "no recorded stop, so it never settles";

    return entry(row, {
      kind: "billed",
      usd: app.usd,
      scope: "sandbox-lifetime",
      complete: app.settled,
      confidence: app.settled ? "medium" : "low",
      note: app.settled
        ? `Modal's charge for App ${app.name}, its only sandbox; before credits, reservations and egress allowance`
        : `Provisional: Modal's charge for App ${app.name} so far; ${settles}`,
    });
  });

  return {
    sandboxes,
    account: {
      window: { start: start.toISOString(), end: end.toISOString() },
      apps: [...apps.values()],
      settleRule:
        "Provisional until 30 minutes after the end of the hour in which the App's last sandbox stopped. Modal reports full hours only and publishes no settlement time; it recommends a buffer after the query interval (https://modal.com/docs/guide/billing).",
    },
  };
}
