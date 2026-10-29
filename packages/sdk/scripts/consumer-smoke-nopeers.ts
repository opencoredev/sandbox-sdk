// Packs the SDK and installs the tarball ALONE (no provider peers, no frameworks) in a temp directory outside
// the workspace, then proves that path works for real:
//   - Runtime: a consumer app starts a local HTTP server and drives createNativeApi against it (JSON calls,
//     placeholders, planes, retries, a streamed upload, a streamed response, redacted errors, sdk(load)),
//     on Node 22, the current Node and Bun. The same app bundled by esbuild as split ESM runs too, and the
//     bundle must contain no provider SDK.
//   - Types: a consumer file with positive and @ts-expect-error checks compiles under NodeNext and bundler
//     resolution, with skipLibCheck true and false.
//   - Provider subpaths in `noPeerProviders` (adapters that call their API directly) import and build a
//     provider without any peer installed. Builders add their provider here when they drop its peer.
//
//   bun scripts/consumer-smoke-nopeers.ts             build, pack and check
//   SKIP_BUILD=1 bun scripts/consumer-smoke-nopeers.ts reuse dist
//   NODE22="node" bun scripts/consumer-smoke-nopeers.ts use a local Node 22 instead of `npx -y node@22`
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { externalPackages } from "./externals.ts";

/** Provider subpaths that must work with no peer installed. Add a provider when its adapter stops loading its SDK. */
const noPeerProviders: string[] = ["daytona", "superserve"];

const sdkDir = resolve(import.meta.dir, "..");
const workDir = mkdtempSync(join(tmpdir(), "sandbox-sdk-nopeers-"));
const consumerDir = join(workDir, "app");
const failures: string[] = [];
function sh(command: string, args: string[], options: { cwd: string; timeoutMs: number }) {
  const result = spawnSync(command, args, { cwd: options.cwd, timeout: options.timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, timedOut: result.error !== undefined };
}
function must(command: string, args: string[], options: { cwd: string; timeoutMs: number }) {
  const result = sh(command, args, options);
  if (!result.ok) { console.error(result.output); throw new Error(`${command} ${args.join(" ")} failed${result.timedOut ? " (timed out)" : ""}`); }
  return result.output;
}
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

// Step 1: build and pack.
if (process.env.SKIP_BUILD !== "1") must("bun", ["run", "build"], { cwd: sdkDir, timeoutMs: 300_000 });
const packed: unknown = JSON.parse(must("npm", ["pack", "--json", "--pack-destination", workDir], { cwd: sdkDir, timeoutMs: 120_000 }));
if (!Array.isArray(packed) || typeof packed[0]?.filename !== "string") throw new Error("Unexpected npm pack --json output");
const tarball = join(workDir, packed[0].filename);
console.log(`Consumer: ${consumerDir}\nTarball: ${tarball}`);

// Step 2: install the tarball alone, plus the TypeScript compiler for the type checks.
mkdirSync(consumerDir);
must("npm", ["init", "-y"], { cwd: consumerDir, timeoutMs: 30_000 });
must("npm", ["pkg", "set", "type=module"], { cwd: consumerDir, timeoutMs: 30_000 });
must("npm", ["install", "--no-audit", "--no-fund", "--omit=peer", tarball, "typescript@^6", "@types/node@^22"], { cwd: consumerDir, timeoutMs: 300_000 });
check("the consumer is outside the workspace", !resolve(consumerDir).startsWith(resolve(sdkDir, "../..")), consumerDir);
const installed = (name: string) => existsSync(join(consumerDir, "node_modules", name, "package.json"));
const present = externalPackages.filter(installed);
check("no provider SDK, framework or peer is installed", present.length === 0, present.join(", "));

// Step 3: the bundled dist must not contain a provider SDK. Their package names appear only as import specifiers.
const distDir = join(consumerDir, "node_modules", pkg.name, "dist");
const distFiles = readdirSync(distDir, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".js"));
// The build's metafile check is the authority; this catches a tarball built some other way. Bundled packages
// leave module paths or the license banners minifiers keep.
const markers = [/node_modules\//, /@license\b/];
const suspicious = distFiles.filter((file) => markers.some((pattern) => pattern.test(readFileSync(join(distDir, file), "utf8"))));
check("dist contains no bundled dependency code", suspicious.length === 0, suspicious.join(", "));

// Step 4: the consumer app. Plain ESM JavaScript so every runtime runs the same file.
const app = String.raw`import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SandboxError } from "${pkg.name}";
import { createHttpClient, createNativeApi, sdkCall, sdkConstruct } from "${pkg.name}/provider";

const seen = [];
let flaky = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  seen.push({ method: request.method, url: request.url, auth: request.headers.authorization, token: request.headers["x-access-token"], bytes: body.length });
  const json = (status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (request.url === "/api/sandbox/sb-1") return json(200, { id: "sb-1", state: "started" });
  if (request.url === "/api/flaky") return ++flaky < 2 ? response.writeHead(503, { "retry-after": "0" }).end() : json(200, { attempts: flaky });
  if (request.url === "/api/upload") return json(201, { bytes: body.length, text: body.toString().slice(0, 12) });
  if (request.url === "/api/secret") return json(400, { code: "bad_request", message: "rejected key smoke-key-0123456789" });
  if (request.url === "/toolbox/sb-1/files?path=%2Fworkspace") return json(200, [{ name: "a.txt" }]);
  if (request.url === "/api/logs") {
    response.writeHead(200, { "content-type": "application/x-ndjson" });
    for (const line of ['{"n":1}\n', '{"n":2}\n', '{"n":3}\n']) { response.write(line); await new Promise(r => setTimeout(r, 10)); }
    return response.end();
  }
  json(404, { code: "not_found", message: "no route" });
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const base = "http://127.0.0.1:" + server.address().port;

try {
  const http = createHttpClient({
    provider: "smoke", label: "Smoke", defaultPlane: "api", backoffMs: 1, timeoutMs: 5000,
    secrets: () => ["smoke-key-0123456789"],
    planes: {
      api: { baseUrl: base + "/api", auth: () => ({ authorization: "Bearer smoke-key-0123456789" }) },
      toolbox: { baseUrl: ({ sandboxId }) => base + "/toolbox/" + sandboxId, auth: () => ({ "x-access-token": "toolbox-token" }) },
    },
  });
  class FakeSandbox { constructor(id) { this.id = id; } }
  class FakeClient { constructor(config) { this.config = config; } async get(id) { return new FakeSandbox(id); } }
  const binding = { package: "@smoke/sdk", async connect(module, id) { const client = sdkConstruct(module, "FakeClient", [{}], "@smoke/sdk"); return id === undefined ? client : sdkCall(client, "get", [id], "@smoke/sdk"); } };
  const native = createNativeApi({ http, placeholder: "sandboxId", sandboxId: "sb-1", sdk: binding });
  const api = createNativeApi({ http, placeholder: "sandboxId", sdk: binding });

  assert.deepEqual(await native.request("GET", "/sandbox/{sandboxId}"), { id: "sb-1", state: "started" });
  assert.equal(seen.at(-1).auth, "Bearer smoke-key-0123456789");

  const before = seen.length;
  await assert.rejects(api.request("GET", "/sandbox/{sandboxId}"), error => error instanceof SandboxError && error.code === "invalid_argument");
  assert.equal(seen.length, before, "a placeholder error sends nothing");

  assert.deepEqual(await native.request("GET", "/files", { plane: "toolbox", query: { path: "/workspace" } }), [{ name: "a.txt" }]);
  assert.equal(seen.at(-1).token, "toolbox-token");
  assert.equal(seen.at(-1).auth, undefined, "control-plane credentials stay on their plane");

  assert.deepEqual(await native.request("GET", "/flaky"), { attempts: 2 });

  const parts = ["stream-", "upload-", "x".repeat(200000)];
  const upload = new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); } });
  const uploaded = await native.request("PUT", "/upload", { body: upload });
  assert.equal(uploaded.bytes, parts.join("").length);
  assert.equal(uploaded.text, "stream-uploa");

  const response = await native.fetch("GET", "/logs");
  const lines = (await response.text()).trim().split("\n").map(line => JSON.parse(line).n);
  assert.deepEqual(lines, [1, 2, 3]);

  await assert.rejects(native.request("POST", "/secret", { body: {} }), error => error instanceof SandboxError && error.code === "invalid_argument" && error.message.includes("bad_request") && !JSON.stringify([error.message, error.hint, String(error.cause)]).includes("smoke-key-0123456789"));

  const sandbox = await native.sdk(async () => ({ FakeClient }));
  assert.ok(sandbox instanceof FakeSandbox && sandbox.id === "sb-1");
  assert.ok((await api.sdk(async () => ({ FakeClient }))) instanceof FakeClient);
  await assert.rejects(native.sdk(async () => ({ Other: FakeClient })), error => error instanceof SandboxError && error.code === "invalid_argument");

  // One literal import per provider, so a bundler can follow each one.
${noPeerProviders.map(subpath => `  assert.equal(typeof (await import("${pkg.name}/${subpath}")).${subpath}, "function", "${subpath} exports its factory");`).join("\n")}
  console.log("native api ok on " + (globalThis.Bun ? "bun " + Bun.version : "node " + process.version));
} finally {
  server.close();
}
`;
writeFileSync(join(consumerDir, "native.mjs"), app);
const env = { ...process.env };
function run(label: string, command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: consumerDir, timeout: 180_000, encoding: "utf8", env });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  check(label, result.status === 0 && output.includes("native api ok"), output.split("\n").slice(-3).join(" | "));
}
const node22 = process.env.NODE22 ? [process.env.NODE22] : ["npx", "-y", "node@22"];
run("Node 22 runs the consumer app", node22[0]!, [...node22.slice(1), "native.mjs"]);
run(`current Node (${process.versions.node ? spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim() : "?"}) runs the consumer app`, "node", ["native.mjs"]);
run(`Bun ${Bun.version} runs the consumer app`, "bun", ["native.mjs"]);

// Step 5: the same app bundled as split ESM, with the tarball as the only package in reach.
const { build } = await import("esbuild");
const bundleDir = join(workDir, "bundle");
await build({ entryPoints: [join(consumerDir, "native.mjs")], absWorkingDir: consumerDir, bundle: true, platform: "node", format: "esm", splitting: true, outdir: bundleDir, logLevel: "error", banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
writeFileSync(join(bundleDir, "package.json"), '{ "type": "module" }');
const bundled = spawnSync("node", ["native.js"], { cwd: bundleDir, timeout: 120_000, encoding: "utf8", env });
check("an esbuild split-ESM bundle runs the consumer app", bundled.status === 0 && bundled.stdout.includes("native api ok"), `${bundled.stdout}${bundled.stderr}`.trim().split("\n").slice(-3).join(" | "));

// Step 6: types, with positive and negative checks, in four configurations.
const types = `import { createSandbox, type NativeApi, type NativeRequestOptions, type HttpMethod, type ProviderSandbox } from "${pkg.name}";
import { createHttpClient, createNativeApi, type Provider } from "${pkg.name}/provider";
import { memory } from "${pkg.name}/memory";

type Module = { Client: new (config: { apiKey: string }) => { get(id: string): Promise<unknown> } };
type Sdk = <M extends Module>(load: () => Promise<M>) => Promise<Awaited<ReturnType<InstanceType<M["Client"]>["get"]>>>;
type Native = NativeApi<"api" | "toolbox", Sdk>;
class Sandbox { readonly kind = "sandbox" as const; }
class Client { constructor(readonly config: { apiKey: string }) {} async get(_id: string) { return new Sandbox(); } }

const http = createHttpClient({ provider: "p", label: "P", defaultPlane: "api", planes: { api: { baseUrl: "https://example.test" }, toolbox: { baseUrl: "https://toolbox.example.test" } } });
const native = (id: string): Native => createNativeApi<"api" | "toolbox", Sdk>({ http, placeholder: "sandboxId", sandboxId: id });
const provider: Provider<Native> = { ...memory(), native };
export async function usage() {
  const box: ProviderSandbox<typeof provider> = await createSandbox(provider);
  const method: HttpMethod = "PATCH";
  const options: NativeRequestOptions<"toolbox"> = { plane: "toolbox", params: { port: 3000 }, query: { a: true } };
  const typed: { id: string } = await box.native.request<{ id: string }>(method, "/x/{port}", options);
  const response: Response = await box.native.fetch("GET", "/logs", { timeoutMs: 1000 });
  const sandbox: Sandbox = await box.native.sdk(async () => ({ Client }));
  const any: NativeApi = box.native;
  // @ts-expect-error the module has no Client class
  await box.native.sdk(async () => ({ Other: Client }));
  // @ts-expect-error not an HTTP method
  await box.native.request("TRACE", "/x");
  // @ts-expect-error not a plane of this provider
  await box.native.request("GET", "/x", { plane: "data" });
  // @ts-expect-error unknown option
  await box.native.fetch("GET", "/x", { retry: true });
  // @ts-expect-error a plain NativeApi does not know its provider's module
  await any.sdk(async () => ({ Client }));
  return { typed, response, sandbox };
}
`;
writeFileSync(join(consumerDir, "native-types.ts"), types);
const modes = [{ name: "nodenext", module: "nodenext", moduleResolution: "nodenext" }, { name: "bundler", module: "esnext", moduleResolution: "bundler" }];
const providerFiles = noPeerProviders.map((subpath) => {
  const file = `provider-${subpath}.ts`;
  writeFileSync(join(consumerDir, file), `export * from "${pkg.name}/${subpath}";\n`);
  return file;
});
for (const mode of modes) {
  for (const skipLibCheck of [true, false]) {
    const config = `tsconfig.${mode.name}.${skipLibCheck ? "skip" : "full"}.json`;
    const compilerOptions = { target: "es2022", module: mode.module, moduleResolution: mode.moduleResolution, strict: true, skipLibCheck, noEmit: true, types: ["node"], lib: ["es2022"] };
    writeFileSync(join(consumerDir, config), JSON.stringify({ compilerOptions, files: ["native-types.ts", ...providerFiles] }, null, 2));
    const result = sh(join(consumerDir, "node_modules/.bin/tsc"), ["-p", config], { cwd: consumerDir, timeoutMs: 120_000 });
    check(`tsc ${mode.name} skipLibCheck=${skipLibCheck} with no peers`, result.ok, result.output.trim());
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} no-peer consumer check(s) failed (kept ${workDir} for inspection)`);
  process.exit(1);
}
rmSync(workDir, { recursive: true, force: true });
console.log("\nNo-peer consumer smoke passed");
