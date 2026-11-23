import { attemptPolicySchema } from "./attempts.js";

/** Known capability and account restrictions only; add newly verified caps explicitly. */
export function collectionPolicy() {
  const boat = (["default", "same-spec"] as const).flatMap((track) => [
    {
      provider: "boat",
      track,
      suite: "burst",
      scenario: "burst-25/*",
      reason: "25 simultaneous starts violate the verified 12-starts/minute plan limit",
    },
    ...["snapshot", "create-from-snapshot"].map((scenario) => ({
      provider: "boat",
      track,
      suite: "snapshot",
      scenario,
      reason: "Boat adapter has no snapshot/restore capability",
    })),
  ]);

  // Instabox blocks outbound 443 to public DNS resolvers, so the probe's 1.1.1.1:443 connect never
  // completes. Other 443 hosts, and 1.1.1.1 on 80 and 53, work (bench/README.md).
  const instabox = (["default", "same-spec"] as const).map((track) => ({
    provider: "instabox",
    track,
    suite: "main",
    scenario: "tcp-ms",
    reason:
      "Instabox blocks outbound 443 to public DNS resolvers, so the 1.1.1.1:443 TCP probe cannot connect",
  }));

  const archil = (["default", "same-spec"] as const).flatMap((track) =>
    ["snapshot", "create-from-snapshot"].map((scenario) => ({
      provider: "archil",
      track,
      suite: "snapshot",
      scenario,
      reason: "Archil adapter has no snapshot/restore capability",
    })),
  );

  return attemptPolicySchema.parse({ replacements: [], notRun: [...boat, ...instabox, ...archil] });
}
