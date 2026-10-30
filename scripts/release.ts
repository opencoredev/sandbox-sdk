// Publishes @opencoredev/sandbox-sdk from the Release workflow, then tags it.
//
// changesets/action runs this after the version PR merges. In prerelease mode
// `changeset publish` forces the pre tag ("beta") as the npm dist-tag, but 1.0
// betas ship under "next" (publishConfig.tag), so this calls `npm publish`
// directly. `changeset git-tag` then records the tag in CHANGESETS_OUTPUT, which
// the action reads to push the tag and create the GitHub release.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { z } from "zod";

const packageDir = "packages/sdk";

if (process.env["SANDBOX_SDK_RELEASE_AUTHORIZED"] !== "true") {
  console.error(
    "Release blocked: set the SANDBOX_SDK_RELEASE_ENABLED repository variable to true to publish.",
  );
  process.exit(1);
}

const manifest = z
  .object({ name: z.string(), version: z.string() })
  .parse(JSON.parse(readFileSync(`${packageDir}/package.json`, "utf8")));

const spec = `${manifest.name}@${manifest.version}`;

function run(command: string, args: string[], cwd = ".") {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });

  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed with exit code ${result.status}.`);
    process.exit(result.status ?? 1);
  }
}

const existing = spawnSync("npm", ["view", spec, "version"], { encoding: "utf8" });

if (existing.status === 0 && existing.stdout.trim() === manifest.version) {
  console.log(`${spec} is already on npm. Skipping publish.`);
} else if (existing.status !== 0 && !existing.stderr.includes("E404")) {
  console.error(`Could not check npm for ${spec}:\n${existing.stderr}`);
  process.exit(1);
} else {
  // Trusted publishing: npm 11.5.1+ exchanges the workflow's OIDC token, so no npm token exists.
  run("npm", ["publish", "--provenance", "--access", "public"], packageDir);
}

run("bun", ["x", "changeset", "git-tag"]);
