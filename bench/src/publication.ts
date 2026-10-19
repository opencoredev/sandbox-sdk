import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { HostSample } from "./v2-model.js";
const exec = promisify(execFile);
const root = new URL("../../", import.meta.url);
const locationSchema = z.object({ ip: z.string(), city: z.string().optional(), region: z.string().optional(), country: z.string().optional(), org: z.string().optional() });
export async function collectMetadata(lookupLocation = false) {
  const git = async (args: string[]) => exec("git", args, { cwd: root }).then((r) => r.stdout.trim()).catch(() => null);
  const [repositoryCommit, harnessCommit, sdkCommit, dirty, pkg, clientLocation] = await Promise.all([
    git(["rev-parse", "HEAD"]), git(["log", "-1", "--format=%H", "--", "bench"]),
    git(["log", "-1", "--format=%H", "--", "packages/sdk"]), git(["status", "--porcelain", "--", "bench", "packages/sdk"]),
    readFile(new URL("packages/sdk/package.json", root), "utf8").then((s) => z.object({ version: z.string() }).parse(JSON.parse(s))).catch(() => null),
    lookupLocation ? fetch("https://ipinfo.io/json", { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).then((v: unknown) => locationSchema.parse(v)).catch(() => null) : null,
  ]);
  return { repositoryCommit, harnessCommit, sdkCommit, dirty: dirty === null ? null : !!dirty,
    sdkVersion: pkg?.version ?? null, runtimes: { node: process.version, bun: process.versions.bun ?? null },
    clientLocation, clientLocationNote: lookupLocation ? "Public egress lookup; null means lookup failed" : "Lookup not requested (offline consumer)" };
}
function networkBytes(text: string) {
  const values = text.split("\n").flatMap((line) => {
    const [name, rest] = line.split(":");
    if (!rest || name?.trim() === "lo") return [];
    const fields = rest.trim().split(/\s+/).map(Number);
    return fields.length >= 9 ? [{ rx: fields[0] ?? 0, tx: fields[8] ?? 0 }] : [];
  });
  return values.length ? values.reduce((a, b) => ({ rx: a.rx + b.rx, tx: a.tx + b.tx }), { rx: 0, tx: 0 }) : null;
}
export function headroom(before: HostSample, after: HostSample) {
  const delta = after.cpuTicks.flatMap((ticks, i) => ticks.map((v, j) => Math.max(0, v - (before.cpuTicks[i]?.[j] ?? v))));
  const total = delta.reduce((a, b) => a + b, 0);
  const idle = after.cpuTicks.reduce((sum, ticks, i) => sum + Math.max(0, (ticks[3] ?? 0) - (before.cpuTicks[i]?.[3] ?? ticks[3] ?? 0)), 0);
  const busy = total > 0 ? 1 - idle / total : null;
  const normalizedLoad = Math.max(before.load[0] ?? 0, after.load[0] ?? 0) / Math.max(1, before.cpuTicks.length);
  const first = networkBytes(before.network), last = networkBytes(after.network);
  const seconds = (Date.parse(after.timestamp) - Date.parse(before.timestamp)) / 1000;
  return { normalizedLoad, hostCpuBusy: busy, highLoad: normalizedLoad >= 1 || (busy !== null && busy >= 0.9),
    processCpuMs: (after.cpu.user + after.cpu.system - before.cpu.user - before.cpu.system) / 1000,
    rxBytesPerSecond: first && last && seconds > 0 ? Math.max(0, last.rx - first.rx) / seconds : null,
    txBytesPerSecond: first && last && seconds > 0 ? Math.max(0, last.tx - first.tx) / seconds : null };
}
