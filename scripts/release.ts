// Publishes @opencoredev/sandbox-sdk from the Release workflow.
//
// changesets/action runs this after the version PR merges. `changeset publish`
// skips versions already on npm, publishes with provenance through trusted
// publishing (no npm token), and records tags in CHANGESETS_OUTPUT so the action
// can push them and create the GitHub release. The variable check keeps a merge
// from publishing until the owner turns releases on.
import { spawnSync } from "node:child_process";

if (process.env["SANDBOX_SDK_RELEASE_AUTHORIZED"] !== "true") {
  console.error(
    "Release blocked: set the SANDBOX_SDK_RELEASE_ENABLED repository variable to true to publish.",
  );
  process.exit(1);
}

const result = spawnSync("bun", ["x", "changeset", "publish"], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
