import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import pkg from "../package.json" with { type: "json" };

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

// Optional peers (provider SDKs, agent frameworks) stay external, so adding a peer is the only step.
const external = Object.keys(pkg.peerDependencies).flatMap((name) => [name, `${name}/*`]);

const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  root: "src",
  target: "node",
  format: "esm",
  splitting: true,
  minify: true,
  external,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// Some Bun versions hoist a `require` shim, `createRequire(import.meta.url)`, to the top of a
// shared chunk. A CommonJS bundle of the SDK has no import.meta.url, so it throws on load.
const requireShim = /\bcreateRequire\b[^;]{0,40};\s*var\s+[\w$]+\s*=\s*[\w$]+\(import\.meta\.url\)/;

const shimmed = result.outputs.filter((output) =>
  requireShim.test(readFileSync(output.path, "utf8")),
);

if (shimmed.length > 0) {
  console.error(
    `Build emitted a top-level createRequire(import.meta.url), which breaks CommonJS bundles:\n${shimmed.map((output) => `  ${output.path}`).join("\n")}\nUse the Bun version in package.json's packageManager.`,
  );
  process.exit(1);
}
