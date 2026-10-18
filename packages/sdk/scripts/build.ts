const result = await Bun.build({ entrypoints: ["src/index.ts", "src/provider.ts", "src/memory.ts", "src/testing.ts", "src/providers/e2b/index.ts"], outdir: "dist", target: "node", format: "esm", splitting: true, minify: true, external: ["vitest", "e2b"] });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
