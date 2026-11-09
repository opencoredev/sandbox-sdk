import { z } from "zod";
import type { PublicationReport } from "./merge.js";
import { allocationEvidence } from "./allocation.js";
import { isSizePreset } from "./v2-config.js";
import { estimateCost, pricing } from "./pricing.js";
import { pricedResources } from "./billed-resources.js";

const cost = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["billed", "metered"]),
    usd: z.number().finite().nonnegative(),
    scope: z.enum(["sandbox-lifetime", "window"]),
    complete: z.boolean(),
    confidence: z.enum(["high", "medium", "low"]),
  }),
  z.object({ kind: z.literal("unavailable") }),
]);

export const costBillingSchema = z.object({
  collectedAt: z.iso.datetime(),
  providers: z.array(
    z.object({
      provider: z.string(),
      source: z.string(),
      account: z
        .object({ window: z.object({ start: z.iso.datetime(), end: z.iso.datetime() }).optional() })
        .nullable()
        .optional(),
      sandboxes: z.array(z.object({ id: z.string(), source: z.string(), cost })),
    }),
  ),
});

export interface TaskCost {
  usd: number | null;
  kind: "billed" | "metered" | "estimate";
  source: string;
  confidence: "high" | "medium" | "low" | "none";
  n: number;
  settled: boolean;
  /**
   * For an estimate, how it relates to the bill: `lower` is a lower bound (Modal's default track
   * bills burst usage above its request). Null for billed and metered amounts.
   */
  bound: "exact" | "lower" | "observed" | null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const right = sorted[mid];

  return right === undefined
    ? null
    : sorted.length % 2
      ? right
      : ((sorted[mid - 1] ?? right) + right) / 2;
};

/** One isolated, completed replay per ID. Never allocate shared account charges to tasks. */
export function costPerTask(report: PublicationReport, provider: string): TaskCost {
  const rows = report.samples.filter((s) => s.provider === provider && s.suite === "cost");
  const lifetimes = rows.filter((s) => s.scenario === "sandbox-lifetime");
  const estimate = provider === "tenki" || provider === "freestyle";

  const empty: TaskCost = {
    usd: null,
    kind: estimate
      ? "estimate"
      : ["daytona", "upstash", "modal"].includes(provider)
        ? "billed"
        : "metered",
    source: estimate
      ? (pricing[provider]?.source ?? "Published list price")
      : "billing.json: per-sandbox evidence required",
    confidence: "none",
    n: 0,
    settled: false,
    bound: null,
  };

  const taskIds = new Set(rows.filter((s) => s.scenario === "cold").map((s) => s.sandboxId));

  if (
    !lifetimes.length ||
    taskIds.has(null) ||
    lifetimes.length !== taskIds.size ||
    lifetimes.some(
      (s) =>
        !s.sandboxId ||
        s.outcome.kind !== "sample" ||
        !rows.some(
          (r) =>
            r.sandboxId === s.sandboxId &&
            r.scenario === "tool-replay" &&
            r.outcome.kind === "sample",
        ) ||
        !rows.some(
          (r) =>
            r.sandboxId === s.sandboxId && r.scenario === "destroy" && r.outcome.kind === "sample",
        ),
    )
  )
    return empty;

  if (estimate) {
    const allocation = allocationEvidence(report.samples, provider);
    const resources = allocation.mismatches.length === 0 ? allocation.pricingAllocation : null;

    if (!resources)
      return { ...empty, source: `${empty.source}; matching verified allocation required` };

    const size = allocation.requested.size;

    const diskGiB =
      size !== null && !isSizePreset(size) && size.diskGb !== undefined
        ? size.diskGb
        : (allocation.provisioned?.diskGiB ?? (provider === "tenki" ? 5 : 32));

    const values = lifetimes.map((s) =>
      estimateCost(provider, s.durationMs, { ...resources, diskGiB }),
    );

    if (values.some((v) => v === null)) return empty;

    return {
      ...empty,
      usd: median(values.filter((v) => v !== null)),
      confidence: "low",
      n: values.length,
      settled: true,
      bound: allocation.pricingBound ?? "observed",
    };
  }

  const billed = billedPerTask(report, provider, lifetimes, empty);

  // Modal without per-App billing for every task: list price on the requested resources, at each
  // source run's region multiplier, labelled an estimate (and a lower bound by default). Billing
  // that has not settled is kept, with settled: false, as other providers' provisional bills are.
  if (provider === "modal" && billed.usd === null) {
    const fallback = modalEstimate(report, lifetimes);

    if (fallback) return fallback;
  }

  return billed;
}

type Lifetime = PublicationReport["samples"][number];

function modalEstimate(report: PublicationReport, lifetimes: readonly Lifetime[]): TaskCost | null {
  const allocation = allocationEvidence(report.samples, "modal");

  if (allocation.mismatches.length) return null;
  const priced = pricedResources("modal", null, allocation.requested.size);

  if (!priced) return null;

  const values = lifetimes.map((s) =>
    estimateCost(
      "modal",
      s.durationMs,
      priced.resources,
      report.sources
        .find((source) => source.runId === s.sourceRunId)
        ?.providers.find((p) => p.name === "modal")?.configuredRegion ?? null,
    ),
  );

  const known = values.filter((v) => v !== null);

  if (known.length !== values.length) return null;

  return {
    usd: median(known),
    kind: "estimate",
    source: `${pricing.modal?.source ?? "Modal list price"}: requested resources × sandbox lifetime × source-run region multiplier${priced.bound === "lower" ? "; lower bound (default-track burst usage is billed but not counted)" : ""}`,
    confidence: "low",
    n: known.length,
    settled: true,
    bound: priced.bound,
  };
}

function billedPerTask(
  report: PublicationReport,
  provider: string,
  lifetimes: readonly Lifetime[],
  empty: TaskCost,
): TaskCost {
  const evidence = lifetimes.map((s) => {
    const source = report.sources.find((r) => r.runId === s.sourceRunId);
    const billed = source?.costBilling?.providers.find((p) => p.provider === provider);
    const entry = billed?.sandboxes.find((row) => row.id === s.sandboxId);
    const window = billed?.account?.window;

    if (!entry || entry.cost.kind === "unavailable") return null;

    // Daytona/boxd provide per-ID window meters: require the window to cover the whole task.
    if (
      entry.cost.scope === "window" &&
      (!window ||
        Date.parse(window.start) > Date.parse(s.startedAt) ||
        Date.parse(window.end) < Date.parse(s.finishedAt))
    )
      return null;

    return entry;
  });

  if (evidence.some((e) => e === null)) return empty;
  const entries = evidence.filter((e) => e !== null);
  const kinds = new Set(entries.map((e) => e.cost.kind));

  if (kinds.size !== 1)
    return { ...empty, source: "Mixed billing kinds; no combined cost per task" };
  const first = entries[0];

  if (!first || first.cost.kind === "unavailable") return empty;
  const values = entries.flatMap((e) => (e.cost.kind === "unavailable" ? [] : [e.cost.usd]));

  const confidence = entries.some(
    (e) => e.cost.kind !== "unavailable" && e.cost.confidence === "low",
  )
    ? "low"
    : entries.every((e) => e.cost.kind !== "unavailable" && e.cost.confidence === "high")
      ? "high"
      : "medium";

  return {
    usd: median(values),
    kind: first.cost.kind,
    source: [...new Set(entries.map((e) => e.source))].join("; "),
    confidence,
    n: entries.length,
    settled: entries.every((e) => e.cost.kind !== "unavailable" && e.cost.complete),
    bound: null,
  };
}
