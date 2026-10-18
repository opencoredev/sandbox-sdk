import pkg from "../package.json" with { type: "json" };

// Entry points come from package.json exports so each subpath only needs one entry there.
const entrypoints = Object.values(pkg.exports).map((target) =>
  target.import.replace("./dist/", "src/").replace(/\.js$/, ".ts"),
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
