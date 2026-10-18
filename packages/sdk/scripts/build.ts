import pkg from "../package.json" with { type: "json" };

// Entry points come from package.json exports so each subpath only needs one entry there.
const entrypoints = Object.values(pkg.exports).map((target) =>
  target.import.replace("./dist/", "src/").replace(/\.js$/, ".ts"),
);

const result = await Bun.build({
  entrypoints,
  outdir: "dist",
  root: "src",
  target: "node",
  format: "esm",
  splitting: true,
  minify: true,
  external: ["@mastra/core", "@mastra/core/*", "@openai/agents", "@openai/agents/*", "ai", "ai/*", "e2b", "e2b/*", "vitest", "vitest/*", "zod", "zod/*"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
