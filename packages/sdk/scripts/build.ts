const result = await Bun.build({ entrypoints: ["src/index.ts", "src/provider.ts", "src/memory.ts", "src/testing.ts", "src/providers/daytona/index.ts"], outdir: "dist", target: "node", format: "esm", splitting: true, minify: true, external: ["vitest", "@daytonaio/sdk"] });
if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
