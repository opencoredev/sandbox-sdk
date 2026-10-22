/**
 * Measures what Sandbox SDK adds on top of each adapter and each provider's own SDK.
 *
 *   bun bench/scripts/sdk-overhead.ts --providers e2b,daytona --n 10 --out /tmp/overhead.json [--sdk <packages/sdk>]
 *
 * For each provider it creates `--sandboxes` sandboxes (default 2). Each create records the
 * handle cost: createSandbox() minus the adapter's provider.create() for the same sandbox.
 * The first sandbox also runs every op N times as the SDK call and as the leanest adapter
 * call, alternating which goes first. A second phase pairs the SDK call with the provider's
 * own SDK (the floor) for run and write. It runs after the adapter phase because some
 * adapters (Tenki) change caching state once native() is called.
 *
 * `--sdk` points at a built packages/sdk (default: this checkout's), so one script can compare
 * builds from different worktrees. Credentials come from the provider env vars.
 */
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Core from "@opencoredev/sandbox-sdk";
import type { CreateInput, Provider } from "@opencoredev/sandbox-sdk/provider";

type Sdk = typeof Core;
type Sandbox = Awaited<ReturnType<Sdk["createSandbox"]>>;
interface Floor { exec(): Promise<void>; write(path: string, data: Uint8Array): Promise<void> }
interface Loaded { provider: Provider; floor(id: string): Floor }

const { values } = parseArgs({
  options: {
    providers: { type: "string", default: "e2b,daytona,upstash,boxd,freestyle,tenki,superserve" },
    n: { type: "string", default: "10" },
    sandboxes: { type: "string", default: "2" },
    out: { type: "string" },
    sdk: { type: "string", default: fileURLToPath(new URL("../../packages/sdk", import.meta.url)) },
  },
});
const n = Number(values.n);
const sandboxCount = Number(values.sandboxes);
if (!Number.isInteger(n) || n < 1 || !Number.isInteger(sandboxCount) || sandboxCount < 1)
  throw new Error("--n and --sandboxes must be positive integers");
const sdkRoot = resolve(values.sdk);
const runId = `sdk-overhead-${Date.now().toString(36)}`;
const label = { "sdk-overhead-run": runId };
const moduleUrl = (path: string) => pathToFileURL(resolve(sdkRoot, "dist", path)).href;
const sdk: Sdk = await import(moduleUrl("index.js"));
const timeoutMs = 60_000;

// Each entry types native() through the adapter module's own Provider<Native>.
const providers: Record<string, () => Promise<Loaded>> = {
  async e2b() {
    const m: typeof import("@opencoredev/sandbox-sdk/e2b") = await import(moduleUrl("providers/e2b/index.js"));
    const provider = m.e2b();
    return { provider, floor: (id) => { const box = provider.native(id); return {
      exec: async () => { await box.commands.run("true", { user: "root" }); },
      write: async (path, data) => { await box.files.write(path, new Uint8Array(data).buffer, { user: "root" }); },
    }; } };
  },
  async daytona() {
    const m: typeof import("@opencoredev/sandbox-sdk/daytona") = await import(moduleUrl("providers/daytona/index.js"));
    const provider = m.daytona();
    return { provider, floor: (id) => { const box = provider.native(id); return {
      exec: async () => { const r = await box.process.executeCommand("true"); if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`); },
      write: (path, data) => box.fs.uploadFile(Buffer.from(data), path),
    }; } };
  },
  async upstash() {
    const m: typeof import("@opencoredev/sandbox-sdk/upstash") = await import(moduleUrl("providers/upstash/index.js"));
    const provider = m.upstash();
    return { provider, floor: (id) => { const box = provider.native(id); return {
      exec: async () => { await box.exec.command("true"); },
      write: async (path, data) => { await box.files.write({ path, content: Buffer.from(data).toString("base64"), encoding: "base64" }); },
    }; } };
  },
  async boxd() {
    const m: typeof import("@opencoredev/sandbox-sdk/boxd") = await import(moduleUrl("providers/boxd/index.js"));
    const provider = m.boxd();
    return { provider, floor: (id) => { const { client } = provider.native(id); return {
      exec: async () => { await client.machines.exec(id, { command: "true", timeout: timeoutMs }); },
      write: async (path, data) => { await client.machines.files.upload(id, path, data); },
    }; } };
  },
  async freestyle() {
    const m: typeof import("@opencoredev/sandbox-sdk/freestyle") = await import(moduleUrl("providers/freestyle/index.js"));
    const provider = m.freestyle();
    return { provider, floor: (id) => { const vm = provider.native(id); return {
      exec: async () => { const r = await vm.exec({ command: "true", linuxUser: "root", timeoutMs }); if (r.statusCode !== 0) throw new Error(`exit ${r.statusCode}`); },
      write: async (path, data) => { await vm.fs.writeFile(path, data); },
    }; } };
  },
  async tenki() {
    const m: typeof import("@opencoredev/sandbox-sdk/tenki") = await import(moduleUrl("providers/tenki/index.js"));
    const provider = m.tenki();
    return { provider, floor: (id) => { const session = provider.native(id); return {
      exec: async () => { const r = await session.run(["true"], { privileged: true, timeoutMs }); if (r.exitCode !== 0) throw new Error(`exit ${r.exitCode}`); },
      write: (path, data) => session.writeFile(path, data),
    }; } };
  },
  async superserve() {
    const m: typeof import("@opencoredev/sandbox-sdk/superserve") = await import(moduleUrl("providers/superserve/index.js"));
    const provider = m.superserve();
    return { provider, floor: (id) => { const box = provider.native(id); return {
      exec: async () => { await box.commands.run("true", { timeoutMs }); },
      write: async (path, data) => { await box.files.write(path, data, { timeoutMs }); },
    }; } };
  },
};

interface Stats { n: number; median: number; p90: number; min: number; max: number }
function stats(samples: readonly number[]): Stats | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? Number.NaN;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { n: sorted.length, median: round(rank(0.5)), p90: round(rank(0.9)), min: round(sorted[0] ?? 0), max: round(sorted.at(-1) ?? 0) };
}
const delta = (a: Stats | null, b: Stats | null) => (a && b ? Math.round((a.median - b.median) * 10) / 10 : null);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);
async function time(action: () => Promise<unknown>) { const start = performance.now(); await action(); return performance.now() - start; }

interface OpResult { sdk: number[]; baseline: number[]; error?: string }
interface Pair { sdk(): Promise<unknown>; baseline(): Promise<unknown> }
// One unrecorded warm-up pair, then N recorded pairs with the call order flipped every iteration.
async function measurePair(pair: Pair): Promise<OpResult> {
  const result: OpResult = { sdk: [], baseline: [] };
  try {
    await pair.sdk(); await pair.baseline();
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) { result.sdk.push(await time(pair.sdk)); result.baseline.push(await time(pair.baseline)); }
      else { result.baseline.push(await time(pair.baseline)); result.sdk.push(await time(pair.sdk)); }
    }
  } catch (error) { result.error = message(error); }
  return result;
}

const path = "/workspace/sdk-overhead.txt";
const text = `hello world alpha\n${"x".repeat(1024 - 19)}\n`;
const bytes = new TextEncoder().encode(text);
const checked = async (result: PromiseLike<{ ok: boolean; exitCode: number | null }>) => { const r = await result; if (!r.ok) throw new Error(`exit ${r.exitCode}`); };

async function adapterOps(box: Sandbox, provider: Provider) {
  const id = box.id;
  const exec = async (command: string) => {
    const r = await provider.exec(id, { command, cwd: "/workspace", env: {}, timeoutMs, streaming: false, onChunk() {} });
    if (r.exitCode !== 0 || r.timedOut) throw new Error(`exit ${r.exitCode}`);
  };
  let token = "alpha";
  const swap = () => { const from = token; token = from === "alpha" ? "beta" : "alpha"; return { find: from, replace: token }; };
  const ops: Record<string, Pair> = {
    run: { sdk: () => checked(box.run("true")), baseline: () => exec("true") },
    write: { sdk: () => box.files.write(path, text), baseline: () => provider.files.write(id, path, bytes) },
    read: { sdk: () => box.files.read(path), baseline: () => provider.files.read(id, path) },
    edit: {
      sdk: () => box.files.edit(path, swap()),
      baseline: async () => {
        const { find, replace } = swap();
        const current = new TextDecoder().decode(await provider.files.read(id, path));
        if (!current.includes(find)) throw new Error("edit target missing");
        await provider.files.write(id, path, new TextEncoder().encode(current.replace(find, replace)));
      },
    },
    list: { sdk: () => box.files.list("/workspace"), baseline: () => provider.files.list(id, "/workspace") },
    grep: { sdk: () => checked(box.run(`grep hello ${path}`)), baseline: () => exec(`grep hello ${path}`) },
  };
  const results: Record<string, OpResult> = {};
  for (const [name, pair] of Object.entries(ops)) {
    if (name === "edit") { await box.files.write(path, text); token = "alpha"; }
    results[name] = await measurePair(pair);
  }
  return results;
}

async function floorOps(box: Sandbox, floor: Floor) {
  return {
    run: await measurePair({ sdk: () => checked(box.run("true")), baseline: floor.exec }),
    write: await measurePair({ sdk: () => box.files.write(path, text), baseline: () => floor.write(path, bytes) }),
  };
}

interface HandleSample { totalMs: number; createMs: number; handleMs: number }
interface ProviderReport {
  name: string;
  error?: string;
  handle: { samples: HandleSample[]; total: Stats | null; create: Stats | null; handle: Stats | null };
  ops: Record<string, { sdk: Stats | null; adapter: Stats | null; floor: Stats | null; overVsAdapterMs: number | null; overVsFloorMs: number | null; errors: string[] }>;
  sandboxesCreated: number;
  leftover: number | null;
}

async function measureProvider(name: string): Promise<ProviderReport> {
  const report: ProviderReport = { name, handle: { samples: [], total: null, create: null, handle: null }, ops: {}, sandboxesCreated: 0, leftover: null };
  const load = providers[name];
  if (!load) { report.error = "Unknown provider"; return report; }
  let loaded: Loaded;
  try { loaded = await load(); } catch (error) { report.error = `load: ${message(error)}`; return report; }
  const { provider } = loaded;
  let createMs = 0;
  const tracked = new Proxy(provider, {
    get(target, key) {
      if (key === "create") return async (input: CreateInput) => {
        const start = performance.now();
        try { return await target.create(input); } finally { createMs = performance.now() - start; }
      };
      return Reflect.get(target, key, target);
    },
  });
  const adapter: Record<string, OpResult> = {};
  const floor: Record<string, OpResult> = {};
  try {
    for (let s = 0; s < sandboxCount; s++) {
      const start = performance.now();
      const box = await sdk.createSandbox(tracked, { labels: label });
      const totalMs = performance.now() - start;
      report.sandboxesCreated++;
      live.set(box.id, provider);
      report.handle.samples.push({ totalMs, createMs, handleMs: totalMs - createMs });
      try {
        if (s === 0) {
          Object.assign(adapter, await adapterOps(box, provider));
          Object.assign(floor, await floorOps(box, loaded.floor(box.id)));
        }
      } finally {
        await box.destroy();
        live.delete(box.id);
      }
    }
  } catch (error) { report.error = message(error); }
  report.leftover = await sweep(provider);
  const samples = report.handle.samples;
  report.handle.total = stats(samples.map((x) => x.totalMs));
  report.handle.create = stats(samples.map((x) => x.createMs));
  report.handle.handle = stats(samples.map((x) => x.handleMs));
  for (const op of ["run", "write", "read", "edit", "list", "grep"]) {
    const a = adapter[op]; const f = floor[op];
    if (!a) continue;
    // SDK-vs-floor uses the SDK samples paired with the floor phase.
    const sdkStats = stats(a.sdk); const adapterStats = stats(a.baseline); const floorStats = f ? stats(f.baseline) : null;
    report.ops[op] = {
      sdk: sdkStats, adapter: adapterStats, floor: floorStats,
      overVsAdapterMs: delta(sdkStats, adapterStats),
      overVsFloorMs: f ? delta(stats(f.sdk), floorStats) : null,
      errors: [a.error, f?.error].filter((x): x is string => x !== undefined),
    };
  }
  return report;
}

// Destroys anything still labelled with this run and returns how many remain afterwards.
async function sweep(provider: Provider): Promise<number | null> {
  try {
    for (const info of await sdk.listSandboxes(provider, { labels: label })) await provider.destroy(info.id).catch(() => {});
    return (await sdk.listSandboxes(provider, { labels: label })).filter((info) => info.state !== "stopped").length;
  } catch { return null; }
}
const live = new Map<string, Provider>();
process.once("SIGINT", () => {
  void Promise.allSettled([...live].map(([id, provider]) => provider.destroy(id))).finally(() => process.exit(130));
});

function sdkCommit() {
  try {
    const head = execFileSync("git", ["-C", sdkRoot, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["-C", sdkRoot, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim() !== "";
    return dirty ? `${head}-dirty` : head;
  } catch { return null; }
}

const fmt = (s: Stats | null) => (s ? `${s.median.toFixed(0)} / ${s.p90.toFixed(0)}` : "–");
const sign = (value: number | null) => (value === null ? "–" : `${value > 0 ? "+" : ""}${value.toFixed(0)}`);
function markdown(reports: ProviderReport[]) {
  const lines = [
    `SDK overhead, ${runId}, sdk ${sdkCommit() ?? "unknown"}, N=${n}. Times in ms, median / p90. Δ = SDK median − baseline median.`,
    "",
    "| Provider | Op | SDK | Adapter | Δ adapter | Provider SDK | Δ provider SDK |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of reports) {
    const h = r.handle;
    lines.push(`| ${r.name} | handle (create→handle) | ${fmt(h.total)} | ${fmt(h.create)} | ${sign(h.handle?.median ?? null)} | | |`);
    for (const [op, o] of Object.entries(r.ops))
      lines.push(`| ${r.name} | ${op}${o.errors.length ? " ⚠" : ""} | ${fmt(o.sdk)} | ${fmt(o.adapter)} | ${sign(o.overVsAdapterMs)} | ${fmt(o.floor)} | ${sign(o.overVsFloorMs)} |`);
    if (r.error) lines.push(`| ${r.name} | error | ${r.error.replaceAll("|", "/")} | | | | |`);
  }
  const notes = reports.flatMap((r) => Object.entries(r.ops).flatMap(([op, o]) => o.errors.map((e) => `- ${r.name} ${op}: ${e}`)));
  return [...lines, ...(notes.length ? ["", "Errors:", ...notes] : [])].join("\n");
}

const startedAt = new Date().toISOString();
const reports: ProviderReport[] = [];
for (const name of values.providers.split(",").map((x) => x.trim()).filter(Boolean)) {
  console.error(`[${name}] measuring`);
  reports.push(await measureProvider(name));
  const last = reports.at(-1);
  console.error(`[${name}] done${last?.error ? ` with error: ${last.error}` : ""}; leftover ${last?.leftover ?? "unknown"}`);
}
const output = { runId, sdkRoot, sdkCommit: sdkCommit(), startedAt, finishedAt: new Date().toISOString(), n, sandboxesPerProvider: sandboxCount, providers: reports };
if (values.out) await writeFile(values.out, `${JSON.stringify(output, null, 2)}\n`);
console.log(markdown(reports));
