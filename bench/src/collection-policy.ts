import { attemptPolicySchema } from "./attempts.js";

/** Known capability and account restrictions only; add newly verified caps explicitly. */
export function collectionPolicy() {
  const boat = (["default", "same-spec"] as const).flatMap(track => [
    {provider: "boat", track, suite: "burst", scenario: "burst-25/*", reason: "25 simultaneous starts violate the verified 12-starts/minute plan limit"},
    ...["snapshot", "create-from-snapshot"].map(scenario => ({provider: "boat", track, suite: "snapshot", scenario, reason: "Boat adapter has no snapshot/restore capability"})),
  ]);
  return attemptPolicySchema.parse({replacements: [], notRun: boat});
}
