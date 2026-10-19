import type { ReportV2 } from "./v2-model.js";
import { resources } from "./fingerprint.js";
import { estimateCost, pricing } from "./pricing.js";
/** Planning estimate only: extrapolates pilot durations, including failures, with no rate-limit prediction. */
export function projectCosts(report: ReportV2) {
  const base = [
    "cold",
    "fingerprint",
    "perf",
    "command",
    "files-1kb",
    "files-10mb",
    "reconnect",
    "pause-resume",
    "snapshot-total",
    "create-from-snapshot",
    "snapshot-cleanup",
    "restore-fingerprint",
    "restore-destroy",
    "destroy",
  ];
  const workloads = [
    "git-clone",
    "npm-install",
    "preview-provisioning",
    "dev-server",
    "preview-first-byte",
    "edit-loop",
    "tool-replay",
    "pip-install",
  ];
  return report.providers
    .filter((p) => p.kind === "ready")
    .map((p) => {
      const rows = report.samples.filter((s) => s.provider === p.name);
      const fp = rows.find((s) => s.fingerprint)?.fingerprint ?? null;
      const allocation = fp ? resources(fp) : (pricing[p.name]?.fixed ?? null);
      const measuredDuration = (name: string) => {
        const values = rows
          .filter((s) => s.scenario === name && ["sample", "failure"].includes(s.outcome.kind))
          .map((s) => s.durationMs);
        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      };
      // Early pilot revisions did not time a separate restored fingerprint. Keep raw data
      // intact and use the source fingerprint duration only for this planning estimate.
      const meanDuration = (name: string) => measuredDuration(name) ??
        (name === "snapshot-total" ? measuredDuration("snapshot") : name === "preview-provisioning" && !rows.some((s) => s.scenario === "preview-provisioning") ? 0 : name === "restore-fingerprint" && measuredDuration("create-from-snapshot") !== null
          ? measuredDuration("fingerprint") : null);
      const costFor = (names: string[], runs: number) => {
        let total = 0;
        for (const name of names) {
          const ms = meanDuration(name);
          if (ms === null) {
            if (rows.some((s) => s.scenario === name && s.outcome.kind === "skipped")) continue;
            if (
              ["create-from-snapshot", "snapshot-cleanup", "restore-fingerprint", "restore-destroy"].includes(name) &&
              rows.some((s) => ["snapshot", "snapshot-setup"].includes(s.scenario) && s.outcome.kind === "skipped")
            )
              continue;
            return null;
          }
          const cost = estimateCost(p.name, ms, allocation);
          if (cost === null) return null;
          total += cost * runs;
        }
        return total;
      };
      const lifecycle = costFor(base, 100),
        workload = costFor(workloads, 30);
      // The restored machine overlaps with the source's measured wall time.
      const overlapMs =
        (meanDuration("create-from-snapshot") ?? 0) +
        (meanDuration("restore-fingerprint") ?? 0) + (meanDuration("restore-destroy") ?? 0);
      const overlap = estimateCost(p.name, overlapMs * 100, allocation);
      const burstLife = meanDuration("burst-3/sandbox-lifetime");
      const burst10 = burstLife === null ? null : estimateCost(p.name, burstLife * 10 * (report.config["burst-cohorts"] ?? 1), allocation);
      const burst25 = burstLife === null ? null : estimateCost(p.name, burstLife * 25 * (report.config["burst-cohorts"] ?? 1), allocation);
      return {
        provider: p.name,
        currency: pricing[p.name]?.currency ?? "USD",
        normal100: lifecycle === null || overlap === null ? null : lifecycle + overlap,
        eachWorkload30: workload,
        burst10,
        burst25,
        total:
          lifecycle === null ||
          workload === null ||
          overlap === null ||
          burst10 === null ||
          burst25 === null
            ? null
            : lifecycle + workload + overlap + burst10 + burst25,
        note: "Estimate from pilot duration (failures included), same observed/default allocation. Missing restored-fingerprint time uses source fingerprint duration for planning only. Larger-burst rate limits, fixed subscriptions, credits, transfer, retained storage excluded. Unsupported scenarios excluded; unobserved scenarios make estimate unknown. K=10/25 require account capacity; costs include configured burst-cohorts repeats.",
      };
    });
}
