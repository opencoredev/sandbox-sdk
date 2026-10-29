// Bundles a consumer of the built dist with esbuild the way apps ship it, then loads every
// provider's optional peer through the SDK. Convex splits chunks (esm + splitting), which turns
// import() of a CommonJS peer into a namespace with only `default`; plain esm and cjs bundles
// are checked too. ESM bundles get the usual createRequire banner, without which no CommonJS
// dependency can require a Node builtin. Offline: each consumer blocks every TCP connection and counts the attempts,
// so a provider passes when its native client is constructed and tries to connect, and its
// failure is a SandboxError. A TypeError such as "m is not a constructor" fails the provider.
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
import pkg from "../package.json" with { type: "json" };

const sdkDir = resolve(import.meta.dir, "..");
// Fake credentials that get each adapter past its own checks to the native client. The network is blocked.
const fakes: Record<string, string> = {
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
const skipped: Record<string, string> = {
  local: "no optional peer; drives the Docker CLI",
  agentos: "embedded runtime with a native sidecar; no network call to observe",
};
const providers = Object.entries(pkg.exports).flatMap(([subpath, target]) =>
  typeof target !== "string" && target.default.startsWith("./dist/providers/") ? [subpath.slice(2)] : []);
const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(label);
}
const unknown = providers.filter(name => !(name in fakes) && !(name in skipped));
check("every provider subpath has a smoke config", unknown.length === 0, unknown.join(", "));

if (process.env.SKIP_BUILD !== "1") {
  const built = spawnSync("bun", ["run", "build"], { cwd: sdkDir, encoding: "utf8", timeout: 300_000 });
  if (built.status !== 0) { console.error(built.stdout, built.stderr); throw new Error("bun run build failed"); }
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
`;
const imports = [
  `import { listSandboxes, SandboxError } from "@opencoredev/sandbox-sdk";`,
  ...Object.keys(fakes).map(name => `import { ${name} } from "@opencoredev/sandbox-sdk/${name}";`),
].join("\n");
const probes = Object.entries(fakes).map(([name, options]) => `await probe(${JSON.stringify(name)}, () => ${name}(${options}));`);
const esm = [imports, blocker, ...probes].join("\n");
// cjs output has no top-level await, so the same probes run in an async IIFE.
const cjs = [imports, blocker, "(async () => {", ...probes, "})();"].join("\n");

const requireBanner = { js: `import { createRequire as __smokeRequire } from "node:module"; const require = __smokeRequire(import.meta.url);` };
const formats: { label: string; options: BuildOptions; source: string }[] = [
  { label: "esm + splitting (Convex)", options: { format: "esm", splitting: true, banner: requireBanner }, source: esm },
  { label: "esm", options: { format: "esm", banner: requireBanner }, source: esm },
  { label: "cjs", options: { format: "cjs" }, source: cjs },
];
type Row = { name: string; attempts: number; timedOut: boolean; sandboxError: boolean; code?: string; text: string };
function parseRow(line: string): Row | undefined {
  const row: unknown = JSON.parse(line);
  if (typeof row !== "object" || row === null || !("name" in row) || typeof row.name !== "string") return undefined;
  return {
    name: row.name,
    attempts: "attempts" in row && typeof row.attempts === "number" ? row.attempts : 0,
    timedOut: "timedOut" in row && row.timedOut === true,
    sandboxError: "sandboxError" in row && row.sandboxError === true,
    code: "code" in row && typeof row.code === "string" ? row.code : undefined,
    text: "text" in row && typeof row.text === "string" ? row.text : "",
  };
}
const bad = /is not a constructor|is not a function|Cannot read propert|Cannot destructure|undefined is not/;
const work = mkdtempSync(join(tmpdir(), "sandbox-sdk-bundle-smoke-"));
try {
  for (const { label, options, source } of formats) {
    const outdir = join(work, label.replace(/\W+/g, "-"));
    const extension = options.format === "cjs" ? ".cjs" : ".mjs";
    // The entry resolves from the package itself: the SDK through its own exports (dist), peers from node_modules.
    const result = await build({ stdin: { contents: source, resolveDir: sdkDir, sourcefile: `entry${extension}`, loader: "js" }, bundle: true, platform: "node", target: "node22", outdir, entryNames: "entry", outExtension: { ".js": extension }, logLevel: "silent", ...options });
    const warnings = [...new Set(result.warnings.map(warning => warning.text))];
    console.log(`\n${label}: ${readdirSync(outdir).length} output file(s)${warnings.length ? `, warnings: ${warnings.join("; ")}` : ""}`);
    const run = spawnSync("node", [join(outdir, `entry${extension}`)], { encoding: "utf8", timeout: 300_000 });
    const rows = run.stdout.split("\n").filter(line => line.startsWith("{")).map(parseRow).filter(row => row !== undefined);
    for (const row of rows) {
      const ok = row.attempts > 0 && !bad.test(row.text) && (row.sandboxError || row.timedOut);
      check(`${label} ${row.name}`, ok, `${row.attempts} connection attempt(s), ${row.timedOut ? "still retrying at 20s" : row.code ?? "no error"}${ok ? "" : ` | ${row.text}`}`);
    }
    for (const name of Object.keys(fakes)) if (!rows.some(row => row.name === name)) check(`${label} ${name}`, false, `no result; exit ${run.status ?? run.signal}\n${run.stderr.slice(-2000)}`);
  }
  for (const [name, why] of Object.entries(skipped)) console.log(`SKIP ${name}: ${why}`);

  const live = process.env.BUNDLE_SMOKE_LIVE;
  if (live) {
    if (!(live in fakes)) throw new Error(`BUNDLE_SMOKE_LIVE must name one of ${Object.keys(fakes).join(", ")}`);
    const source = `import { createSandbox } from "@opencoredev/sandbox-sdk";
import { ${live} } from "@opencoredev/sandbox-sdk/${live}";
const box = await createSandbox(${live}());
console.log(JSON.stringify({ created: box.id }));
try { const result = await box.run("echo ok"); console.log(JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout })); }
finally { await box.destroy(); console.log(JSON.stringify({ destroyed: box.id })); }`;
    const outdir = join(work, "live");
    await build({ stdin: { contents: source, resolveDir: sdkDir, sourcefile: "live.mjs", loader: "js" }, bundle: true, platform: "node", target: "node22", format: "esm", splitting: true, banner: requireBanner, outdir, entryNames: "entry", outExtension: { ".js": ".mjs" }, logLevel: "silent" });
    const run = spawnSync("node", [join(outdir, "entry.mjs")], { encoding: "utf8", timeout: 300_000 });
    const output = run.stdout.trim();
    check(`live ${live} from an esm + splitting bundle`, run.status === 0 && output.includes('"stdout":"ok\\n"') && output.includes('"destroyed"'), `${output}${run.status === 0 ? "" : `\n${run.stderr.slice(-2000)}`}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`\n${failures.length} bundle smoke check(s) failed`);
  process.exit(1);
}
console.log("\nBundle smoke passed");
