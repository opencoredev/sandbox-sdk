// Bundles a consumer of the built dist with esbuild the way apps ship it, then loads every
// provider's optional peer through the SDK. Convex splits chunks (esm + splitting), which turns
// import() of a CommonJS peer into a namespace with only `default`; plain esm and cjs bundles
// are checked too. ESM bundles get the usual createRequire banner, without which no CommonJS
// dependency can require a Node builtin. Offline: each consumer blocks every TCP connection and counts the attempts,
// so a provider passes when its native client is constructed and tries to connect, and its
// failure is a SandboxError. A TypeError such as "m is not a constructor" fails the provider.
// Each bundle runs from its own directory, with no node_modules in reach, like a deploy.
// Also checked: boxd file transfers in every format (they used to resolve a file through
// import.meta.url), the hint an ESM bundle without the banner gets, and that the error mappers
// still recognize native errors once a minifier has renamed every class.
//
//   bun scripts/bundle-smoke.ts                         build, then check every provider offline
//   SKIP_BUILD=1 bun scripts/bundle-smoke.ts            reuse dist
//   BUNDLE_SMOKE_LIVE=boat bun scripts/bundle-smoke.ts  also create, run `echo ok` in and destroy
//                                                       a real sandbox from an esm + splitting bundle
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build, type BuildOptions } from "esbuild";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

type ExportTarget = (typeof pkg.exports)[keyof typeof pkg.exports];

/** Every export except `./package.json` maps conditions to files. */
function isConditionalExport(target: ExportTarget): target is Exclude<ExportTarget, string> {
  return typeof target !== "string";
}

const sdkDir = resolve(import.meta.dir, "..");

// Fake credentials that get each adapter past its own checks to the native client. The network is blocked.
const fakes = {
  boat: `{ apiKey: "smoke-key", requestTimeoutMs: 5000 }`,
  sandboxer: `{ apiKey: "smoke-key", requestTimeoutMs: 5000 }`,
  e2b: `{ apiKey: "smoke-key" }`,
  vercel: `{ token: "smoke-token", teamId: "team_smoke", projectId: "prj_smoke" }`,
  daytona: `{ apiKey: "smoke-key", requestTimeoutMs: 5000 }`,
  upstash: `{ apiKey: "smoke-key" }`,
  railway: `{ token: "smoke-token", environmentId: "smoke-env" }`,
  tenki: `{ apiKey: "tk_smoke", requestTimeoutMs: 5000 }`,
  boxd: `{ apiKey: "smoke-key", requestTimeoutMs: 5000 }`,
  freestyle: `{ apiKey: "smoke-key", requestTimeoutMs: 5000 }`,
  superserve: `{ apiKey: "smoke-key", requestTimeoutMs: 5000 }`,
};

// Providers without an optional peer SDK, or whose peer never touches the network.
const skipped = {
  local: "no optional peer; drives the Docker CLI",
  agentos: "embedded runtime with a native sidecar; no network call to observe",
};

const providers = Object.entries(pkg.exports).flatMap(([subpath, target]) =>
  isConditionalExport(target) && target.default.startsWith("./dist/providers/")
    ? [subpath.slice(2)]
    : [],
);

const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);

  if (!ok) failures.push(label);
}

const unknown = providers.filter((name) => !(name in fakes) && !(name in skipped));

check("every provider subpath has a smoke config", unknown.length === 0, unknown.join(", "));

if (process.env.SKIP_BUILD !== "1") {
  const built = spawnSync("bun", ["run", "build"], {
    cwd: sdkDir,
    encoding: "utf8",
    timeout: 300_000,
  });

  if (built.status !== 0) {
    console.error(built.stdout, built.stderr);
    throw new Error("bun run build failed");
  }
}

// Runs inside the bundle. Every connection attempt is counted and fails like a refused port.
const blocker = `
import net from "node:net";
let attempts = 0;
net.Socket.prototype.connect = function () {
  attempts++;
  process.nextTick(() => this.destroy(Object.assign(new Error("connect ECONNREFUSED (bundle smoke blocks the network)"), { code: "ECONNREFUSED" })));
  return this;
};
const text = error => error instanceof Error ? \`\${error.name}: \${error.message} | cause: \${String(error.cause)}\` : String(error);
async function probe(name, factory) {
  attempts = 0;
  const timeout = new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 20_000).unref());
  const outcome = await Promise.race([listSandboxes(factory()).then(() => ({ ok: true }), error => ({ error })), timeout]);
  console.log(JSON.stringify({ name, attempts, timedOut: outcome.timedOut === true, sandboxError: outcome.error instanceof SandboxError, code: outcome.error?.code, text: outcome.error === undefined ? "" : text(outcome.error) }));
}
// boxd moves file bytes with its fetch client; reading through the adapter reaches it without a sandbox.
async function transferProbe(name, provider) {
  attempts = 0;
  const outcome = await provider.files.read("smoke-machine", "/workspace/smoke.txt").then(() => ({ ok: true }), error => ({ error }));
  console.log(JSON.stringify({ name, attempts, timedOut: false, sandboxError: outcome.error instanceof SandboxError, code: outcome.error?.code, text: outcome.error === undefined ? "" : text(outcome.error) }));
}
`;

const imports = [
  `import { listSandboxes, SandboxError } from "@opencoredev/sandbox-sdk";`,
  ...Object.keys(fakes).map(
    (name) => `import { ${name} } from "@opencoredev/sandbox-sdk/${name}";`,
  ),
].join("\n");

const probes = [
  ...Object.entries(fakes).map(
    ([name, options]) => `await probe(${JSON.stringify(name)}, () => ${name}(${options}));`,
  ),
  `await transferProbe("boxd files", boxd(${fakes.boxd}));`,
];

const rowNames = [...Object.keys(fakes), "boxd files"];
const esm = [imports, blocker, ...probes].join("\n");

// cjs output has no top-level await, so the same probes run in an async IIFE.
const cjs = [imports, blocker, "(async () => {", ...probes, "})();"].join("\n");

const requireBanner = {
  js: `import { createRequire as __smokeRequire } from "node:module"; const require = __smokeRequire(import.meta.url);`,
};

// Peers that load a Node builtin through require, which an ESM bundle without the banner cannot do.
// They must fail with a SandboxError that names the cause and the fix, not a generic provider error.
const needsRequire = ["e2b", "vercel", "daytona", "tenki", "boxd", "boxd files"];

const formats: { label: string; options: BuildOptions; source: string; noBanner?: true }[] = [
  {
    label: "esm + splitting (Convex)",
    options: { format: "esm", splitting: true, banner: requireBanner },
    source: esm,
  },
  { label: "esm", options: { format: "esm", banner: requireBanner }, source: esm },
  { label: "cjs", options: { format: "cjs" }, source: cjs },
  {
    label: "esm without the createRequire banner",
    options: { format: "esm" },
    source: esm,
    noBanner: true,
  },
];

// A probe row needs a name; every other field falls back when a consumer omits or garbles it.
const rowSchema = z.object({
  name: z.string(),
  attempts: z.number().catch(0),
  timedOut: z.boolean().catch(false),
  sandboxError: z.boolean().catch(false),
  code: z.string().optional().catch(undefined),
  text: z.string().catch(""),
});

type Row = z.infer<typeof rowSchema>;

// Error-mapping rows are printed as text; a missing field reads as an empty string.
const mappedText = z.unknown().transform((value) => (value === undefined ? "" : String(value)));

const mappedRowSchema = z.object({
  name: mappedText,
  className: mappedText,
  code: mappedText,
  expected: mappedText,
});

function parseRow(line: string): Row | undefined {
  const row = rowSchema.safeParse(JSON.parse(line));

  return row.success ? row.data : undefined;
}

const bad =
  /is not a constructor|is not a function|Cannot read propert|Cannot destructure|undefined is not/;

const work = mkdtempSync(join(tmpdir(), "sandbox-sdk-bundle-smoke-"));

try {
  for (const { label, options, source, noBanner } of formats) {
    const outdir = join(work, label.replace(/\W+/g, "-"));
    const extension = options.format === "cjs" ? ".cjs" : ".mjs";

    // The entry resolves from the package itself: the SDK through its own exports (dist), peers from node_modules.
    const result = await build({
      stdin: {
        contents: source,
        resolveDir: sdkDir,
        sourcefile: `entry${extension}`,
        loader: "js",
      },
      bundle: true,
      platform: "node",
      target: "node22",
      outdir,
      entryNames: "entry",
      outExtension: { ".js": extension },
      logLevel: "silent",
      ...options,
    });

    const warnings = [...new Set(result.warnings.map((warning) => warning.text))];
    console.log(
      `\n${label}: ${readdirSync(outdir).length} output file(s)${warnings.length ? `, warnings: ${warnings.join("; ")}` : ""}`,
    );

    const run = spawnSync("node", [join(outdir, `entry${extension}`)], {
      cwd: outdir,
      encoding: "utf8",
      timeout: 300_000,
    });

    const rows = run.stdout
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map(parseRow)
      .filter((row) => row !== undefined);

    for (const row of rows) {
      if (noBanner && needsRequire.includes(row.name)) {
        const ok =
          row.sandboxError &&
          row.code === "unavailable" &&
          /Dynamic require of "[^"]+" is not supported/.test(row.text) &&
          row.text.includes("createRequire banner");

        check(
          `${label} ${row.name} names the cause and the fix`,
          ok,
          ok ? `${row.code}: ${/Dynamic require of "[^"]+"/.exec(row.text)?.[0] ?? ""}` : row.text,
        );
        continue;
      }

      // A boxd transfer must reach the network: before, a CommonJS bundle failed to resolve its worker module first.
      const ok = row.attempts > 0 && !bad.test(row.text) && (row.sandboxError || row.timedOut);
      check(
        `${label} ${row.name}`,
        ok,
        `${row.attempts} connection attempt(s), ${row.timedOut ? "still retrying at 20s" : (row.code ?? "no error")}${ok && row.name !== "boxd files" ? "" : ` | ${row.text}`}`,
      );
    }

    for (const name of rowNames)
      if (!rows.some((row) => row.name === name))
        check(
          `${label} ${name}`,
          false,
          `no result; exit ${run.status ?? run.signal}\n${run.stderr.slice(-2000)}`,
        );
  }

  for (const [name, why] of Object.entries(skipped)) console.log(`SKIP ${name}: ${why}`);

  // Minifiers rename every class, and esbuild renames colliding ones (e2b's and Tenki's FileNotFoundError)
  // even without --minify. The mappers must still recognize the real native errors.
  const mapping = `
const { FileNotFoundError, SandboxNotFoundError } = require("e2b");
const { FileNotFoundError: TenkiFileNotFoundError } = require("@tenkicloud/sandbox");
const railway = require("railway");
const daytona = require("@daytonaio/sdk");
const { e2bError } = require("./src/providers/e2b/errors.ts");
const { tenkiError } = require("./src/providers/tenki/errors.ts");
const { railwayError } = require("./src/providers/railway/errors.ts");
const { daytonaError } = require("./src/providers/daytona/errors.ts");
const { loadPeer } = require("./src/peer.ts");
(async () => {
  await loadPeer("railway", "railway", async () => railway);
  await loadPeer("@daytonaio/sdk", "daytona", async () => daytona);
  const cases = [
    ["e2b FileNotFoundError", FileNotFoundError, e2bError(new FileNotFoundError("missing.txt"), "box").code, "file_not_found"],
    ["e2b SandboxNotFoundError", SandboxNotFoundError, e2bError(new SandboxNotFoundError("gone"), "box").code, "not_found"],
    ["tenki FileNotFoundError", TenkiFileNotFoundError, tenkiError(new TenkiFileNotFoundError("missing.txt"), "box", "files").code, "file_not_found"],
    ["railway SandboxFileNotFoundError", railway.SandboxFileNotFoundError, railwayError(new railway.SandboxFileNotFoundError({ operation: "read", path: "/x", message: "missing" }), "box").code, "file_not_found"],
    ["railway ExecNotStartedError", railway.ExecNotStartedError, railwayError(new railway.ExecNotStartedError({ message: "not started" }), "box").code, "unavailable"],
    ["daytona DaytonaConnectionError", daytona.DaytonaConnectionError, daytonaError(new daytona.DaytonaConnectionError("down"), "box").code, "unavailable"],
    ["daytona DaytonaTimeoutError", daytona.DaytonaTimeoutError, daytonaError(new daytona.DaytonaTimeoutError("slow"), "box").code, "timeout"],
  ];
  for (const [name, type, code, expected] of cases) console.log(JSON.stringify({ name, className: type.name, code, expected }));
})();
`;

  const mappingDir = join(work, "minified-mapping");
  await build({
    stdin: { contents: mapping, resolveDir: sdkDir, sourcefile: "mapping.cjs", loader: "js" },
    bundle: true,
    minify: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outdir: mappingDir,
    entryNames: "entry",
    outExtension: { ".js": ".cjs" },
    logLevel: "silent",
  });

  const mapped = spawnSync("node", [join(mappingDir, "entry.cjs")], {
    cwd: mappingDir,
    encoding: "utf8",
    timeout: 120_000,
  });

  console.log("\nminified multi-provider bundle, native error mapping:");

  const mappedRows = mapped.stdout
    .split("\n")
    .flatMap((line) => (line.startsWith("{") ? [mappedRowSchema.parse(JSON.parse(line))] : []));

  for (const row of mappedRows)
    check(
      `minified ${row.name}`,
      row.code === row.expected,
      `class renamed to ${JSON.stringify(row.className)}, mapped to ${row.code}`,
    );
  check(
    "minified mapping cases ran",
    mappedRows.length === 7,
    `${mappedRows.length} of 7${mapped.status === 0 ? "" : `\n${mapped.stderr.slice(-2000)}`}`,
  );

  const live = process.env.BUNDLE_SMOKE_LIVE;

  if (live) {
    if (!(live in fakes))
      throw new Error(`BUNDLE_SMOKE_LIVE must name one of ${Object.keys(fakes).join(", ")}`);

    const source = `import { createSandbox } from "@opencoredev/sandbox-sdk";
import { ${live} } from "@opencoredev/sandbox-sdk/${live}";
const box = await createSandbox(${live}());
console.log(JSON.stringify({ created: box.id }));
try { const result = await box.run("echo ok"); console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout })); }
finally { await box.destroy(); console.log(JSON.stringify({ destroyed: box.id })); }`;

    const outdir = join(work, "live");
    await build({
      stdin: { contents: source, resolveDir: sdkDir, sourcefile: "live.mjs", loader: "js" },
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      splitting: true,
      banner: requireBanner,
      outdir,
      entryNames: "entry",
      outExtension: { ".js": ".mjs" },
      logLevel: "silent",
    });

    const run = spawnSync("node", [join(outdir, "entry.mjs")], {
      encoding: "utf8",
      timeout: 300_000,
    });

    const output = run.stdout.trim();
    check(
      `live ${live} from an esm + splitting bundle`,
      run.status === 0 && output.includes('"stdout":"ok\\n"') && output.includes('"destroyed"'),
      `${output}${run.status === 0 ? "" : `\n${run.stderr.slice(-2000)}`}`,
    );
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} bundle smoke check(s) failed`);
  process.exit(1);
}

console.log("\nBundle smoke passed");
