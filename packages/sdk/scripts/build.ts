const result = await Bun.build({
  entrypoints: [
    "src/index.ts",
    "src/provider.ts",
    "src/memory.ts",
    "src/testing.ts",
    "src/tools.ts",
    "src/ai.ts",
    "src/mastra.ts",
    "src/openai.ts",
  ],
  outdir: "dist",
  target: "node",
  format: "esm",
  splitting: true,
  minify: true,
  external: ["vitest", "zod", "ai", "@mastra/core", "@mastra/core/*", "@openai/agents"],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
