import type { ReportV2 } from "./v2-model.js";
import { pricedResources } from "./billed-resources.js";
import { estimateCost, pricing } from "./pricing.js";

/** Planning estimate only: extrapolates pilot durations, including failures, with no rate-limit prediction. */
export function projectCosts(report: Pick<ReportV2, "config" | "providers" | "samples">) {
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

      // Request-billed providers (Modal) are priced on the request, never on the guest's view,
      // at the run's configured region multiplier.
      const priced = pricedResources(
        p.name,
        fp,
        p.requestedSize ?? report.config.size[p.name] ?? null,
      );

      const allocation = priced?.resources ?? null;
      const region = p.configuredRegion;

      const measuredDuration = (name: string) => {
        const values = rows
          .filter((s) => s.scenario === name && ["sample", "failure"].includes(s.outcome.kind))
          .map((s) => s.durationMs);

        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      };

      // Early pilot revisions did not time a separate restored fingerprint. Keep raw data
      // intact and use the source fingerprint duration only for this planning estimate.
      const meanDuration = (name: string) =>
        measuredDuration(name) ??
        (name === "snapshot-total"
          ? measuredDuration("snapshot")
          : name === "preview-provisioning" &&
              !rows.some((s) => s.scenario === "preview-provisioning")
            ? 0
            : name === "restore-fingerprint" && measuredDuration("create-from-snapshot") !== null
              ? measuredDuration("fingerprint")
              : null);

      const costFor = (names: string[], runs: number) => {
        let total = 0;

        for (const name of names) {
          const ms = meanDuration(name);

          if (ms === null) {
            if (rows.some((s) => s.scenario === name && s.outcome.kind === "skipped")) continue;

            if (
              [
                "create-from-snapshot",
                "snapshot-cleanup",
                "restore-fingerprint",
                "restore-destroy",
              ].includes(name) &&
              rows.some(
                (s) =>
                  ["snapshot", "snapshot-setup"].includes(s.scenario) &&
                  s.outcome.kind === "skipped",
              )
            )
              continue;

            return null;
          }

          const cost = estimateCost(p.name, ms, allocation, region);

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
        (meanDuration("restore-fingerprint") ?? 0) +
        (meanDuration("restore-destroy") ?? 0);

      const overlap = estimateCost(p.name, overlapMs * 100, allocation, region);
      const burstLife = meanDuration("burst-3/sandbox-lifetime");

      const burst10 =
        burstLife === null
          ? null
          : estimateCost(
              p.name,
              burstLife * 10 * (report.config["burst-cohorts"] ?? 1),
              allocation,
              region,
            );

      const burst25 =
        burstLife === null
          ? null
          : estimateCost(
              p.name,
              burstLife * 25 * (report.config["burst-cohorts"] ?? 1),
              allocation,
              region,
            );

      // Stress suites, priced from the pilot's own rows and kept out of `total` above.
      const cohorts = report.config["burst-cohorts"] ?? 1;

      const meanMatching = (pattern: RegExp) => {
        const values = rows
          .filter((s) => pattern.test(s.scenario) && ["sample", "failure"].includes(s.outcome.kind))
          .map((s) => s.durationMs);

        return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      };

      // One member's mean lifetime at any observed K, times K members and the configured cohorts.
      const cohortCost = (kind: "cpu-burst" | "survival", k: number) => {
        const life = meanMatching(new RegExp(`^${kind}-\\d+/sandbox-lifetime$`));

        return life === null ? null : estimateCost(p.name, life * k * cohorts, allocation, region);
      };

      const sustained = ["cold", "fingerprint", "cpu-sustained", "destroy"].map(meanDuration);

      const cpuSustained30 = sustained.every((ms) => ms !== null)
        ? estimateCost(
            p.name,
            sustained.reduce<number>((a, b) => a + (b ?? 0), 0) * 30,
            allocation,
            region,
          )
        : null;

      const stressParts = {
        cpuSustained30,
        cpuBurst10: cohortCost("cpu-burst", 10),
        cpuBurst25: cohortCost("cpu-burst", 25),
        survival10: cohortCost("survival", 10),
        survival25: cohortCost("survival", 25),
      };

      const stressValues = Object.values(stressParts);

      return {
        provider: p.name,
        currency: pricing[p.name]?.currency ?? "USD",
        region,
        /** `lower`: a lower bound (Modal's default track), not an estimate of the bill. */
        bound: priced?.bound ?? null,
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
        /**
         * CPU sustained (30 dedicated iterations: create, fingerprint, probe, destroy) and the
         * cpu-burst and survival cohorts at K=10 and 25 with the configured cohort count. Null
         * where the pilot did not run that suite. Not included in `total`.
         */
        stress: {
          ...stressParts,
          total: stressValues.every((v) => v !== null)
            ? stressValues.reduce<number>((a, b) => a + (b ?? 0), 0)
            : null,
        },
        note: "Estimate from pilot duration (failures included), same observed/default allocation. Missing restored-fingerprint time uses source fingerprint duration for planning only. Larger-burst rate limits, fixed subscriptions, credits, transfer, retained storage excluded. Unsupported scenarios excluded; unobserved scenarios make estimate unknown. K=10/25 require account capacity; costs include configured burst-cohorts repeats.",
      };
    });
}
