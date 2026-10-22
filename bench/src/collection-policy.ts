import { attemptPolicySchema, mainTests, workloads } from "./attempts.js";

/** Known capability and account restrictions only; add newly verified caps explicitly. */
export function collectionPolicy() {
  const boat = (["default", "same-spec"] as const).flatMap(track => [
    {provider: "boat", track, suite: "burst", scenario: "burst-25/*", reason: "25 simultaneous starts violate the verified 12-starts/minute plan limit"},
    ...["snapshot", "create-from-snapshot"].map(scenario => ({provider: "boat", track, suite: "snapshot", scenario, reason: "Boat adapter has no snapshot/restore capability"})),
  ]);
  const reason = "Superserve same-spec excluded until a 4-vCPU template exists; account capped at 2 vCPU";
  const superserve = [
    {provider: "superserve", track: "same-spec", suite: "cost", scenario: "tool-replay", reason},
    ...[...mainTests, ...workloads].map(scenario => ({provider: "superserve", track: "same-spec", suite: "main", scenario, reason})),
    ...["snapshot", "create-from-snapshot"].map(scenario => ({provider: "superserve", track: "same-spec", suite: "snapshot", scenario, reason})),
    ...[10, 25].map(k => ({provider: "superserve", track: "same-spec", suite: "burst", scenario: `burst-${k}/*`, reason})),
  ];
  const quota = "Daytona us/container account quota: CPU 10 vCPU / memory 10 GiB / disk 30 GiB";
  const daytona = [
    ...["snapshot", "create-from-snapshot"].map(scenario => ({provider: "daytona", track: "same-spec", suite: "snapshot", scenario,
      reason: `${quota}; one daytona-large uses 4 vCPU / 8 GiB / 10 GiB, but source + restore require 8 vCPU / 16 GiB / 20 GiB (memory exceeds quota)`})),
    ...[10, 25].map(k => ({provider: "daytona", track: "same-spec", suite: "burst", scenario: `burst-${k}/*`,
      reason: `${quota}; ${k} daytona-large machines require ${k * 4} vCPU / ${k * 8} GiB / ${k * 10} GiB (exceeds account quota)`})),
    {provider: "daytona", track: "default", suite: "burst", scenario: "burst-25/*",
      reason: `${quota}; 25 default machines require 25 vCPU / 25 GiB / 75 GiB (exceeds account quota); default K=10 uses 10 vCPU / 10 GiB / 30 GiB and remains enabled`},
  ];
  return attemptPolicySchema.parse({replacements: [], notRun: [...boat, ...superserve, ...daytona]});
}
