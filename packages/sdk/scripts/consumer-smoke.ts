// Packs the SDK, installs the tarball into a fresh npm project with only the e2b peer,
// and checks every package.json export at runtime and under four tsc configurations.
// Subpaths come from the exports map, so new entries are covered without edits here.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

type ExportTarget = (typeof pkg.exports)[keyof typeof pkg.exports];

/** Every export except `./package.json` maps conditions to files. */
function isConditionalExport(target: ExportTarget): target is Exclude<ExportTarget, string> {
  return typeof target !== "string";
}

const sdkDir = resolve(import.meta.dir, "..");
const packDir = process.env.PACK_DIR ?? "/tmp/sandbox-sdk-pack";
const consumerDir = process.env.CONSUMER_DIR ?? "/tmp/sandbox-sdk-smoke-consumer";
const installedPeers = ["e2b"];
const failures: string[] = [];

function sh(command: string, args: string[], options: { cwd: string; timeoutMs: number }) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    timedOut: result.error !== undefined,
  };
}

function must(command: string, args: string[], options: { cwd: string; timeoutMs: number }) {
  const result = sh(command, args, options);

  if (!result.ok) {
    console.error(result.output);
    throw new Error(`${command} ${args.join(" ")} failed${result.timedOut ? " (timed out)" : ""}`);
  }

  return result.output;
}

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);

  if (!ok) failures.push(label);
}

// Step 1: build and pack.
must("bun", ["run", "build"], { cwd: sdkDir, timeoutMs: 300_000 });

rmSync(packDir, { recursive: true, force: true });

mkdirSync(packDir, { recursive: true });

const packOutput = z.tuple(
  [z.object({ filename: z.string(), files: z.array(z.object({ path: z.string() })) })],
  z.unknown(),
);

// Step 1 already built, and the prepack build would print into the JSON output.
const packed = packOutput.safeParse(
  JSON.parse(
    must("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: sdkDir,
      timeoutMs: 120_000,
    }),
  ),
);

if (!packed.success) throw new Error("Unexpected npm pack --json output");

const [packEntry] = packed.data;
const tarball = join(packDir, packEntry.filename);
const tarFiles = new Set(packEntry.files.map((file) => file.path));

console.log(`Tarball: ${tarball} (${tarFiles.size} files)`);

const forbidden = [
  /(^|\/)tests?\//,
  /\.(test|spec)\.[cm]?[jt]s$/,
  /\.map$/,
  /(^|\/)\.env/,
  /(^|\/)\.npmrc$/,
  /^src\//,
  /\.tgz$/,
  /tsconfig/,
];

const leaked = [...tarFiles].filter((file) => forbidden.some((pattern) => pattern.test(file)));

check(
  "tarball has no tests, maps, sources, env or config files",
  leaked.length === 0,
  leaked.join(", "),
);

const subpaths = Object.entries(pkg.exports).flatMap(([subpath, target]) =>
  isConditionalExport(target) ? [{ subpath, types: target.types, js: target.default }] : [],
);

const missingTargets = subpaths
  .flatMap((entry) => [entry.types, entry.js])
  .filter((target) => !tarFiles.has(target.replace(/^\.\//, "")));

check(
  "every exports target ships in the tarball",
  missingTargets.length === 0,
  missingTargets.join(", "),
);

// Step 2: fresh consumer with only the e2b provider peer.
rmSync(consumerDir, { recursive: true, force: true });

mkdirSync(consumerDir, { recursive: true });

must("npm", ["init", "-y"], { cwd: consumerDir, timeoutMs: 30_000 });

must("npm", ["pkg", "set", "type=module"], { cwd: consumerDir, timeoutMs: 30_000 });

const peers: Record<string, string> = pkg.peerDependencies;

const installs = [
  tarball,
  ...installedPeers.map((name) => `${name}@${peers[name]}`),
  `vitest@${peers.vitest}`,
  "typescript@^6",
  "@types/node@^22",
];

must("npm", ["install", "--no-audit", "--no-fund", ...installs], {
  cwd: consumerDir,
  timeoutMs: 300_000,
});

const installedDir = join(consumerDir, "node_modules", pkg.name);

const isInstalled = (name: string) =>
  existsSync(join(consumerDir, "node_modules", name, "package.json"));

const absentPeers = Object.keys(peers).filter((name) => !isInstalled(name));

check(
  "npm skipped absent optional peers",
  absentPeers.length === Object.keys(peers).length - installedPeers.length - 1,
  `absent: ${absentPeers.join(", ")}`,
);

// Walk relative imports from each entry so a subpath's needs include its shared chunks and declaration files.
// Bare specifiers reached only through import() are lazy: the subpath loads without them.
const staticSpecifier = /(?:\bfrom\s*|\bimport\s*)["']([^"']+)["']/g;
const dynamicSpecifier = /\bimport\s*\(\s*["']([^"']+)["']/g;

const packageName = (spec: string) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

const isBuiltin = (spec: string) => spec.startsWith("node:") || builtinModules.includes(spec);

function externals(entry: string, declaration: boolean) {
  const seen = new Map<string, boolean>();
  const eager = new Set<string>();
  const lazy = new Set<string>();

  const queue: { file: string; lazy: boolean }[] = [
    { file: resolve(installedDir, entry), lazy: false },
  ];

  for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
    const { file } = item;

    if (seen.get(file) === false || (seen.has(file) && item.lazy)) continue;
    seen.set(file, item.lazy);
    const where = relative(installedDir, file);

    if (where.startsWith("..") || !existsSync(file)) {
      check(`relative import stays inside dist (${entry})`, false, where);
      continue;
    }

    const source = readFileSync(file, "utf8");

    // Type positions in declarations use import("x") too, and they always need x, so declarations have no lazy edges.
    const edges = [
      ...[...source.matchAll(staticSpecifier)].map((match) => ({
        spec: match[1],
        lazy: item.lazy,
      })),
      ...[...source.matchAll(dynamicSpecifier)].map((match) => ({
        spec: match[1],
        lazy: item.lazy || !declaration,
      })),
    ];

    for (const edge of edges) {
      if (edge.spec === undefined || isBuiltin(edge.spec)) continue;

      if (edge.spec.startsWith("."))
        queue.push({
          file: resolve(
            dirname(file),
            declaration ? edge.spec.replace(/\.js$/, ".d.ts") : edge.spec,
          ),
          lazy: edge.lazy,
        });
      else (edge.lazy ? lazy : eager).add(packageName(edge.spec));
    }
  }

  return { eager: [...eager].sort(), lazy: [...lazy].filter((name) => !eager.has(name)).sort() };
}

type Row = {
  subpath: string;
  spec: string;
  runtime: { eager: string[]; lazy: string[] };
  typePeers: string[];
};

const rows: Row[] = subpaths.map(({ subpath, types, js }) => ({
  subpath,
  spec: subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
  runtime: externals(js, false),
  typePeers: externals(types, true).eager,
}));

for (const row of rows) {
  const undeclared = [...row.runtime.eager, ...row.runtime.lazy, ...row.typePeers].filter(
    (name) => !(name in peers) && name !== "@types/node",
  );

  check(
    `${row.subpath} imports only declared peers`,
    undeclared.length === 0,
    undeclared.join(", "),
  );
}

// Step 3a: runtime import of every subpath. A missing eager peer must fail by naming the peer;
// a missing lazy peer must load, then fail on first use with the SDK's install hint.
for (const row of rows) {
  const missing = row.runtime.eager.filter((name) => !isInstalled(name));

  const result = sh(
    "node",
    ["--input-type=module", "-e", `await import(${JSON.stringify(row.spec)})`],
    { cwd: consumerDir, timeoutMs: 30_000 },
  );

  if (missing.length === 0)
    check(
      `runtime import ${row.spec}`,
      result.ok,
      result.ok ? "" : result.output.split("\n").find((line) => line.includes("Error")),
    );
  else
    check(
      `runtime import ${row.spec} fails clearly without ${missing.join(", ")}`,
      !result.ok && missing.some((name) => result.output.includes(`'${name}`)),
      result.ok ? "unexpectedly loaded" : "",
    );
  const lazyMissing = row.runtime.lazy.filter((name) => !isInstalled(name));
  const factory = row.subpath.slice(2);

  if (lazyMissing.length === 0 || missing.length > 0) continue;

  // Dummy credentials get each adapter past its config checks; the absent peer fails before any network call.
  const probe = `const m = await import(${JSON.stringify(row.spec)}); const { createSandbox } = await import(${JSON.stringify(pkg.name)});
if (typeof m[${JSON.stringify(factory)}] !== "function") { console.log("no factory"); process.exit(0); }
const dummy = { apiKey: "x", token: "x", teamId: "x", projectId: "x" };
try { await createSandbox(m[${JSON.stringify(factory)}](dummy)); console.log("created"); } catch (error) { console.log(error.code, error.message); }`;

  const used = sh("node", ["--input-type=module", "-e", probe], {
    cwd: consumerDir,
    timeoutMs: 30_000,
  });

  const named = lazyMissing.some((name) => used.output.includes(`Install ${name}`));
  check(
    `first use of ${row.spec} names missing ${lazyMissing.join(", ")}`,
    used.output.startsWith("no factory") ||
      (used.ok && named && used.output.startsWith("unavailable")),
    used.output.trim(),
  );
}

// Step 3b: an app that picks a provider by name and round-trips a command and a file.
const app = `import assert from "node:assert/strict";
import { createSandbox, SandboxError } from "${pkg.name}";
import type { Provider } from "${pkg.name}/provider";
import { memory } from "${pkg.name}/memory";
import { local } from "${pkg.name}/local";
import { e2b } from "${pkg.name}/e2b";
import { runConformance } from "${pkg.name}/testing";

assert.equal(typeof runConformance, "function");
const providers: Record<string, () => Provider> = { memory: () => memory(), local: () => local(), e2b: () => e2b() };
const name = process.env.SANDBOX_PROVIDER ?? "memory";
const factory = providers[name];
if (!factory) throw new SandboxError(\`Unknown provider \${name}\`, { code: "invalid_argument" });
const box = await createSandbox(factory(), { key: "consumer-smoke" });
try {
  await box.files.write("hello.txt", "hello from the tarball\\n");
  const result = await box.run("cat hello.txt");
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hello from the tarball\\n");
  assert.equal(await box.files.read("hello.txt"), "hello from the tarball\\n");
  console.log(\`consumer app ok on \${name}: \${result.stdout.trim()}\`);
} finally {
  await box.destroy();
}
`;

writeFileSync(join(consumerDir, "index.ts"), app);

// Same program with the one type-only line removed, so plain node runs the ESM build without a TS loader.
writeFileSync(
  join(consumerDir, "index.mjs"),
  app.replace(/^import type .*\n/m, "").replace(": Record<string, () => Provider>", ""),
);

const run = sh("node", ["index.mjs"], { cwd: consumerDir, timeoutMs: 60_000 });

check("node index.mjs (memory provider switch)", run.ok, run.output.trim());

// Step 3c: type checks. Subpaths whose type peers are installed must be clean in every mode.
const reexport = (list: Row[]) =>
  list.map((row, index) => `export * as entry${index} from "${row.spec}";\n`).join("");

const typeable = rows.filter((row) => row.typePeers.every(isInstalled));
const untypeable = rows.filter((row) => !row.typePeers.every(isInstalled));

writeFileSync(join(consumerDir, "entries.ts"), reexport(typeable));

writeFileSync(join(consumerDir, "absent-peers.ts"), reexport(untypeable));

const modes = [
  { name: "nodenext", module: "nodenext", moduleResolution: "nodenext" },
  { name: "bundler", module: "esnext", moduleResolution: "bundler" },
];

function tsc(files: string[], mode: (typeof modes)[number], skipLibCheck: boolean) {
  const config = `tsconfig.${mode.name}.${skipLibCheck ? "skip" : "full"}.json`;

  const compilerOptions = {
    target: "es2022",
    module: mode.module,
    moduleResolution: mode.moduleResolution,
    strict: true,
    skipLibCheck,
    noEmit: true,
    types: ["node"],
  };

  writeFileSync(join(consumerDir, config), JSON.stringify({ compilerOptions, files }, null, 2));

  return sh(join(consumerDir, "node_modules/.bin/tsc"), ["-p", config], {
    cwd: consumerDir,
    timeoutMs: 120_000,
  });
}

for (const mode of modes) {
  for (const skipLibCheck of [true, false]) {
    const result = tsc(["index.ts", "entries.ts"], mode, skipLibCheck);
    check(
      `tsc ${mode.name} skipLibCheck=${skipLibCheck} (${typeable.length} subpaths + app)`,
      result.ok,
      result.output.trim(),
    );
  }
}

// Subpaths whose peer is absent: skipLibCheck hides the gap, a full check must name only that subpath's own peer.
if (untypeable.length > 0) {
  for (const mode of modes) {
    const skipped = tsc(["absent-peers.ts"], mode, true);
    check(
      `tsc ${mode.name} skipLibCheck=true with absent peers compiles`,
      skipped.ok,
      skipped.output.trim(),
    );
    const full = tsc(["absent-peers.ts"], mode, false);
    const errors = full.output.split("\n").filter((line) => line.includes("error TS"));

    const stray = errors.filter((line) => {
      const match =
        /^node_modules\/(?:@[^/]+\/)?[^/]+\/dist\/(.+?)\(\d+,\d+\): error TS2307: Cannot find module '([^']+)'/.exec(
          line,
        );

      if (!match?.[1] || !match[2]) return true;
      const owner = untypeable.find((row) => row.typePeers.includes(packageName(match[2] ?? "")));

      return owner === undefined || isInstalled(packageName(match[2]));
    });

    const named = [
      ...new Set(
        errors
          .map((line) => /Cannot find module '([^']+)'/.exec(line)?.[1])
          .filter((name) => name !== undefined)
          .map(packageName),
      ),
    ].sort();

    check(
      `tsc ${mode.name} skipLibCheck=false with absent peers reports only missing peers`,
      errors.length > 0 && stray.length === 0,
      stray.length ? stray.join("\n") : `TS2307 for ${named.join(", ")}`,
    );
  }
}

console.log("\nSubpath needs (runtime | types):");

for (const row of rows)
  console.log(
    `  ${row.subpath.padEnd(14)} ${[...row.runtime.eager, ...row.runtime.lazy.map((name) => `${name} (lazy)`)].join(", ") || "-"} | ${row.typePeers.join(", ") || "-"}`,
  );

if (failures.length > 0) {
  console.error(`\n${failures.length} consumer smoke check(s) failed`);
  process.exit(1);
}

console.log("\nConsumer smoke passed");
