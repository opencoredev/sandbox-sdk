import { attemptPolicySchema, mainTests, workloads } from "./attempts.js";

/** Known capability and account restrictions only; add newly verified caps explicitly. */
export function collectionPolicy() {
  const boat = (["default", "same-spec"] as const).flatMap(track => [
    {provider: "boat", track, suite: "burst", scenario: "burst-25/*", reason: "25 simultaneous starts violate the verified 12-starts/minute plan limit"},
    ...["snapshot", "create-from-snapshot"].map(scenario => ({provider: "boat", track, suite: "snapshot", scenario, reason: "Boat adapter has no snapshot/restore capability"})),
  ]);
  const reason = "Superserve same-spec excluded until a 4-vCPU template exists; account capped at 2 vCPU";
  const superserve = [
    ...[...mainTests, ...workloads].map(scenario => ({provider: "superserve", track: "same-spec", suite: "main", scenario, reason})),
    ...["snapshot", "create-from-snapshot"].map(scenario => ({provider: "superserve", track: "same-spec", suite: "snapshot", scenario, reason})),
    ...[10, 25].map(k => ({provider: "superserve", track: "same-spec", suite: "burst", scenario: `burst-${k}/*`, reason})),
  ];
  return attemptPolicySchema.parse({replacements: [], notRun: [...boat, ...superserve]});
}
