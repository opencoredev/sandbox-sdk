import { rm } from "node:fs/promises";
import pkg from "../package.json" with { type: "json" };
import { externalPackages } from "./externals.ts";

type ExportTarget = (typeof pkg.exports)[keyof typeof pkg.exports];

/** Every export except `./package.json` maps conditions to files. */
function isConditionalExport(target: ExportTarget): target is Exclude<ExportTarget, string> {
  return typeof target !== "string";
}

// Chunk names are content hashes, so stale chunks from earlier builds would otherwise ship.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

// Entry points come from package.json exports so each subpath only needs one entry there.
const entrypoints = Object.values(pkg.exports).flatMap((target) =>
  isConditionalExport(target)
    ? [target.default.replace("./dist/", "src/").replace(/\.js$/, ".ts")]
    : [],
);

// Every peer must be on the explicit list. The list, not peerDependencies, decides what stays external, so
// dropping a provider SDK from the peers can never bundle the copy installed for development.
const unlisted = Object.keys(pkg.peerDependencies).filter(
  (name) => !externalPackages.includes(name),
);
if (unlisted.length) {
  console.error(`Add these peers to scripts/externals.ts: ${unlisted.join(", ")}`);
  process.exit(1);
}
const external = externalPackages.flatMap((name) => [name, `${name}/*`]);

const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  root: "src",
  target: "node",
  format: "esm",
  splitting: true,
  minify: true,
  external,
  metafile: true,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
// The SDK has zero runtime dependencies: nothing from node_modules may be bundled into dist.
const bundled = Object.keys(result.metafile?.inputs ?? {}).filter((input) =>
  input.includes("node_modules"),
);
if (!result.metafile || bundled.length) {
  console.error(
    result.metafile
      ? `dist bundles code from node_modules:\n  ${bundled.slice(0, 20).join("\n  ")}`
      : "Bun.build returned no metafile; cannot check for bundled dependencies",
  );
  process.exit(1);
}
