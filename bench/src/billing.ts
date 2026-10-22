import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readRun, type OwnedSandbox } from "./billing/input.js";
import { collectProvider, type Cost, type Transport } from "./billing/providers.js";

function totals(costs: Cost[]) {
  const billed = costs.filter(
    (c) => c.kind === "billed" && c.complete && c.scope === "sandbox-lifetime",
  );
  const metered = costs.filter(
    (c) => c.kind === "metered" && c.complete && c.scope === "sandbox-lifetime",
  );
  const recoveredBilledUSD = billed.reduce((sum, c) => sum + (c.kind === "billed" ? c.usd : 0), 0);
  const recoveredMeteredUSD = metered.reduce(
    (sum, c) => sum + (c.kind === "metered" ? c.usd : 0),
    0,
  );
  const billedUSD = costs.length > 0 && billed.length === costs.length ? recoveredBilledUSD : null;
  const meteredUSD =
    costs.length > 0 && metered.length === costs.length ? recoveredMeteredUSD : null;
  return {
    sandboxCount: costs.length,
    settledWindowSandboxes: costs.filter(
      (c) => c.kind !== "unavailable" && c.complete && c.scope === "window",
    ).length,
    recoveredWindowBilledUSD: costs.reduce(
      (sum, c) => sum + (c.kind === "billed" && c.complete && c.scope === "window" ? c.usd : 0),
      0,
    ),
    recoveredWindowMeteredUSD: costs.reduce(
      (sum, c) => sum + (c.kind === "metered" && c.complete && c.scope === "window" ? c.usd : 0),
      0,
    ),
    billedSandboxes: billed.length,
    meteredSandboxes: metered.length,
    unavailableSandboxes: costs.filter((c) => c.kind === "unavailable").length,
    pendingSandboxes: costs.filter((c) => c.kind !== "unavailable" && !c.complete).length,
    recoveredBilledUSD,
    recoveredMeteredUSD,
    billedUSD,
    meteredUSD,
    confidence:
      billedUSD !== null
        ? billed.every((c) => c.confidence === "high")
          ? "high"
          : "medium"
        : meteredUSD !== null
          ? "medium"
          : "none",
  };
}
function ownerScenario(row: OwnedSandbox): string | null {
  const lifetime = [...row.scenarios].filter(
    (s) => s === "sandbox-lifetime" || s.endsWith("/sandbox-lifetime"),
  );
  if (lifetime.length === 1) return lifetime[0] ?? null;
  return row.scenarios.size === 1 ? ([...row.scenarios][0] ?? null) : null;
}
export async function collectBilling(options: {
  report: string;
  env?: NodeJS.ProcessEnv;
  transport?: Transport;
  offline?: boolean;
  waitMs?: number;
}) {
  const unidentified: { provider: string; scenario: string }[] = [];
  const owned = await readRun(options.report, (sample) =>
    unidentified.push({ provider: sample.provider, scenario: sample.scenario }),
  );
  const providers = [];
  for (const provider of [
    ...new Set([...owned.map((r) => r.provider), ...unidentified.map((r) => r.provider)]),
  ].sort()) {
    const rows = owned.filter((r) => r.provider === provider);
    const collected = await collectProvider(
      provider,
      rows,
      options.env ?? process.env,
      options.transport,
      options.offline,
      options.waitMs,
    );
    const byId = new Map(collected.sandboxes.map((r) => [r.id, r.cost]));
    const scenarios = [
      ...new Set([
        ...rows.flatMap((r) => [...r.scenarios]),
        ...unidentified.filter((r) => r.provider === provider).map((r) => r.scenario),
      ]),
    ]
      .sort()
      .map((scenario) => {
        const observed = rows.filter((r) => r.scenarios.has(scenario));
        const assigned = observed.filter((r) => ownerScenario(r) === scenario);
        const costs = assigned.flatMap((r) => {
          const cost = byId.get(r.id);
          return cost ? [cost] : [];
        });
        const known = totals(costs);
        const unidentifiedCount = unidentified.filter(
          (r) => r.provider === provider && r.scenario === scenario,
        ).length;
        const partial = assigned.length < observed.length || unidentifiedCount > 0;
        const summary = partial
          ? { ...known, billedUSD: null, meteredUSD: null, confidence: "none" }
          : known;
        return {
          scenario,
          samplesWithoutSandboxId: unidentified.filter(
            (r) => r.provider === provider && r.scenario === scenario,
          ).length,
          observedSandboxes: observed.length,
          attributedSandboxes: assigned.length,
          ...summary,
          billedCostPerTaskUSD:
            summary.billedUSD === null ? null : summary.billedUSD / assigned.length,
          meteredCostPerTaskUSD:
            summary.meteredUSD === null ? null : summary.meteredUSD / assigned.length,
          source: collected.source,
          note:
            assigned.length < observed.length
              ? "Shared sandbox: no per-operation bill exists. Whole sandbox cost belongs only to its lifetime scenario (or stays unallocated)."
              : "Task means one distinct sandbox lifetime; includes failures, setup and idle usage. Metered amounts are not invoices.",
        };
      });
    providers.push({
      ...collected,
      samplesWithoutSandboxId: unidentified.filter((r) => r.provider === provider).length,
      ...totals(collected.sandboxes.map((r) => r.cost)),
      scenarios,
      unallocatedSandboxIds: rows.filter((r) => ownerScenario(r) === null).map((r) => r.id),
    });
  }
  return {
    schemaVersion: 1,
    report: resolve(options.report),
    collectedAt: new Date().toISOString(),
    currency: "USD",
    notes: [
      "No median-time × list-price estimates. null is unknown, never zero.",
      "Billed means provider-reported usage charges, before credits/taxes unless stated; metered estimates remain separate. No invoice allocation or account minimum is invented.",
      "Amounts carry an explicit sandbox-lifetime or window scope. Window subtotals never become lifetime totals or cost per task; account buckets may include other runs.",
      "Scenario totals partition costs using distinct sandbox IDs, not sample counts. Shared operation costs remain unknown; do not sum observed counts across scenarios.",
      "Samples without sandbox IDs are counted separately and cannot be priced; totals cover identifiable resources only.",
      "samples.ndjson is streamed when present; otherwise results.json samples are streamed. Ownership journal adds otherwise missing sandboxes. Snapshot storage charges are not collected.",
    ],
    providers,
  };
}
export async function billingCommand(args: string[]) {
  let report: string | undefined,
    out: string | undefined,
    offline = false,
    waitMs = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help") {
      process.stdout.write(
        "bun bench billing --report results/<run> [--out results/<run>/billing.json] [--offline] [--wait-ms 1500000]\nUses environment credentials; Read-only billing queries; never creates sandboxes. Missing credentials/network produce null costs.\n",
      );
      return;
    }
    if (arg === "--offline") {
      offline = true;
      continue;
    }
    if (arg === "--wait-ms") {
      const value = args[++i];
      waitMs = Number(value);
      if (!value || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 1_500_000)
        throw new Error("--wait-ms must be an integer from 0 to 1500000");
      continue;
    }
    if (arg !== "--report" && arg !== "--out") throw new Error(`Unknown billing option: ${arg}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
    if (arg === "--report") report = resolve(value);
    else out = resolve(value);
  }
  if (!report) throw new Error("billing requires --report results/<run>");
  const target = out ?? join(report, "billing.json");
  if (
    ["results.json", "ownership.json", "samples.ndjson"].some(
      (name) => target === join(report, name),
    )
  )
    throw new Error("Billing output must not overwrite run inputs");
  const result = await collectBilling({ report, offline, waitMs });
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, target);
  process.stdout.write(`Billing: ${result.providers.length} providers; ${target}\n`);
}
