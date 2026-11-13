import type { ReportedCost } from "../cost/columns.js";

/**
 * A held-open row's cost status. Only a provider's billed charges can be settled: a metered cost
 * is the provider's usage meter at list rates, and nothing has reconciled it with what was charged,
 * so it stays provisional however complete the meter is.
 */
export type HeldStatus =
  | "settled"
  | "unsettled"
  | "estimate"
  | "metered, unreconciled (provisional)"
  | "unsettled; metered, unreconciled (provisional)";

export function heldStatus(costs: readonly ReportedCost[]): HeldStatus | null {
  if (!costs.length) return null;

  const unsettled = costs.some((c) => (c.kind === "billed" || c.kind === "metered") && !c.settled);

  const metered = costs.some((c) => c.kind === "metered");

  if (unsettled && metered) return "unsettled; metered, unreconciled (provisional)";

  if (unsettled) return "unsettled";

  if (costs.some((c) => c.kind === "estimate")) return "estimate";

  return metered ? "metered, unreconciled (provisional)" : "settled";
}
