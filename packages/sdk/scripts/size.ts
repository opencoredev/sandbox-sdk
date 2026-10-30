const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  target: "node",
  format: "esm",
  splitting: true,
  minify: true,
});

if (!result.success) throw new Error("Size build failed");

const entry = result.outputs.find((output) => output.kind === "entry-point");

if (!entry) throw new Error("Root entry missing");

console.log(
  `Root entry: ${entry.size} bytes minified (limit 8192); lazy feature chunks: ${result.outputs.length - 1}`,
);

if (entry.size >= 8192) process.exit(1);

const pkg = await Bun.file("package.json").json();

if (pkg.dependencies && Object.keys(pkg.dependencies).length)
  throw new Error("Core must have zero runtime dependencies");
