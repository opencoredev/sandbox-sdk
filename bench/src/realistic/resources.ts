/**
 * Two reads of the sandbox's own accounting, one after create and one before destroy: the size the
 * workload could use (CPU quota, usable memory) and the CPU time it used in between. Not a sampler,
 * so it adds two short commands, not polling.
 */
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import type { AttemptRecord } from "./record.js";

export type Resources = NonNullable<AttemptRecord["resources"]>;

export interface ResourceRead {
  readonly cpuQuota: number | null;
  readonly cpuQuotaSource: "cgroup" | "online-cpus" | null;
  readonly memoryGiB: number | null;
  readonly arch: string | null;
  /** CPU time used so far, from the cgroup when it exposes one, else /proc/stat. */
  readonly cpuSeconds: number | null;
  readonly source: "cgroup" | "proc-stat" | null;
}

const script = [
  "echo q=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)",
  "echo m=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)",
  "echo t=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)",
  "echo u=$(awk '/^usage_usec /{print $2}' /sys/fs/cgroup/cpu.stat 2>/dev/null)",
  // user nice system irq softirq steal, in clock ticks
  "echo p=$(awk '/^cpu /{print $2+$3+$4+$7+$8+$9}' /proc/stat 2>/dev/null)",
  "echo h=$(getconf CLK_TCK 2>/dev/null)",
  "echo n=$(nproc 2>/dev/null)",
  "echo a=$(uname -m 2>/dev/null)",
].join("; ");

const number = (text: string | undefined) => {
  const value = Number(text);

  return text !== undefined && text !== "" && Number.isFinite(value) ? value : null;
};

/** Parse the probe's `key=value` lines. Exported for tests. */
export function parseResourceRead(output: string): ResourceRead {
  const values = new Map<string, string>();

  for (const line of output.split("\n")) {
    const match = /^([a-z])=(.*)$/.exec(line.trim());

    if (match?.[1]) values.set(match[1], (match[2] ?? "").trim());
  }

  const online = number(values.get("n"));
  const [quota, period] = (values.get("q") ?? "").split(/\s+/);
  const quotaValue = number(quota);
  const periodValue = number(period);

  const fromCgroup = quotaValue !== null && periodValue !== null && periodValue > 0;
  const cpuQuota = fromCgroup ? quotaValue / periodValue : online;

  const limitBytes = number(values.get("m"));
  const totalKiB = number(values.get("t"));

  const candidates = [
    limitBytes === null ? null : limitBytes / 2 ** 30,
    totalKiB === null ? null : totalKiB / 2 ** 20,
  ].flatMap((value) => (value === null || value <= 0 ? [] : [value]));

  const usage = number(values.get("u"));
  const ticks = number(values.get("p"));
  const hertz = number(values.get("h"));

  const [cpuSeconds, source] =
    usage !== null
      ? [usage / 1e6, "cgroup" as const]
      : ticks !== null && hertz !== null && hertz > 0
        ? [ticks / hertz, "proc-stat" as const]
        : [null, null];

  return {
    cpuQuota: cpuQuota !== null && cpuQuota > 0 ? cpuQuota : null,
    cpuQuotaSource:
      cpuQuota !== null && cpuQuota > 0 ? (fromCgroup ? "cgroup" : "online-cpus") : null,
    memoryGiB: candidates.length ? Math.min(...candidates) : null,
    arch: values.get("a") || null,
    cpuSeconds,
    source,
  };
}

export async function readResources(
  box: Sandbox,
  signal: AbortSignal,
): Promise<ResourceRead | null> {
  try {
    const result = await box.run(script, { cwd: "/", timeoutMs: 30_000, signal });

    return result.exitCode === 0 ? parseResourceRead(result.stdout) : null;
  } catch {
    return null;
  }
}

/** The record's resources from the two reads; CPU time only when both used the same source. */
export function resourcesBetween(
  start: ResourceRead | null,
  end: ResourceRead | null,
): Resources | null {
  const first = start ?? end;

  if (!first) return null;

  const cpuSeconds =
    start?.cpuSeconds != null &&
    end?.cpuSeconds != null &&
    start.source === end.source &&
    end.cpuSeconds >= start.cpuSeconds
      ? end.cpuSeconds - start.cpuSeconds
      : null;

  return {
    cpuQuota: first.cpuQuota,
    cpuQuotaSource: first.cpuQuotaSource,
    memoryGiB: first.memoryGiB,
    arch: first.arch,
    cpuSeconds,
    source: cpuSeconds === null ? null : first.source,
  };
}
