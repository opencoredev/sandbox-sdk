/**
 * memory-honesty: whether the CPUs and memory a sandbox shows are the ones it can use.
 *
 * 1. Limits: `nproc`, /proc/cpuinfo's processors and the affinity list against the cgroup's CPU
 *    quota (v2 `cpu.max`, v1 `cfs_quota_us`/`cfs_period_us`); MemTotal against `memory.max` (v1
 *    `memory.limit_in_bytes`); swap, zram and zswap. Build tools size their worker pools from
 *    nproc, so 48 visible CPUs on a 4-CPU quota run 48 workers on 4 CPUs' time.
 * 2. Use: `sbx-native mem` dirties 6 GiB of anonymous memory with incompressible words, writes a
 *    2 GiB file in the disk test's directory with fdatasync while holding it, then reads every word
 *    back. The host checks the digest. A sandbox whose files live in memory needs 8 GiB for this
 *    and may be killed; hidden swap or compression shows as slow verification and VmSwap.
 */
import { randomInt } from "node:crypto";
import { z } from "zod";
import { CheckStop, type Check } from "./framework.js";
import { diskTarget } from "./disk-real.js";
import { installNative, memOutputSchema, memoryDigest, parseNativeOutput } from "./native.js";

export interface MemoryOptions {
  readonly memoryMiB: number;
  readonly fileMiB: number;
}

export const defaultMemoryOptions: MemoryOptions = { memoryMiB: 6144, fileMiB: 2048 };

export const limitsCommand = [
  `echo "nproc=$(nproc 2>/dev/null)"`,
  `echo "nprocAll=$(nproc --all 2>/dev/null)"`,
  `echo "cpuinfo=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"`,
  `echo "allowed=$(grep '^Cpus_allowed_list' /proc/self/status 2>/dev/null | cut -f2)"`,
  `echo "cpuMax=$(cat /sys/fs/cgroup/cpu.max 2>/dev/null)"`,
  `echo "cfsQuota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us 2>/dev/null | head -1)"`,
  `echo "cfsPeriod=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us 2>/dev/null | head -1)"`,
  `echo "memMax=$(cat /sys/fs/cgroup/memory.max 2>/dev/null)"`,
  `echo "memLimitV1=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"`,
  `echo "swapMax=$(cat /sys/fs/cgroup/memory.swap.max 2>/dev/null)"`,
  `echo "memTotalKiB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "swapTotalKiB=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "zram=$(ls /sys/block 2>/dev/null | grep -c '^zram')"`,
  `echo "zswap=$(cat /sys/module/zswap/parameters/enabled 2>/dev/null)"`,
  `echo "overcommit=$(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"`,
].join("\n");

const intOrNull = (text: string | undefined) => {
  if (text === undefined || !/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());

  return Number.isSafeInteger(value) ? value : null;
};

/** CPUs in a list like `0-3,8,10-11`, or null when it does not parse. */
export function countCpuList(list: string): number | null {
  const trimmed = list.trim();

  if (trimmed === "") return null;
  let count = 0;

  for (const part of trimmed.split(",")) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part.trim());

    if (!range) return null;
    const low = Number(range[1]);
    const high = range[2] === undefined ? low : Number(range[2]);

    if (high < low) return null;
    count += high - low + 1;
  }

  return count;
}

export const limitsSchema = z.object({
  nproc: z.number().int().nullable(),
  nprocAll: z.number().int().nullable(),
  cpuinfoProcessors: z.number().int().nullable(),
  affinityCpus: z.number().int().nullable(),
  /** CPUs of time the cgroup quota allows (quota / period), or null when unlimited or unreadable. */
  quotaCpus: z.number().nullable(),
  quotaSource: z.enum(["cgroup2", "cgroup1", "none"]),
  memTotalGiB: z.number().nullable(),
  /** The cgroup memory limit in GiB; null when unlimited or unreadable. */
  memLimitGiB: z.number().nullable(),
  swapTotalGiB: z.number().nullable(),
  swapLimit: z.string().nullable(),
  zramDevices: z.number().int().nullable(),
  zswap: z.string().nullable(),
  overcommit: z.number().int().nullable(),
});

export type Limits = z.infer<typeof limitsSchema>;

/** cgroup v1 and v2 use these values for "no limit". */
const v1Unlimited = 2 ** 53;

export function parseLimits(stdout: string): Limits {
  const values = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");

    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
  }

  const text = (key: string) => {
    const value = values.get(key);

    return value === undefined || value === "" ? null : value;
  };

  let quotaCpus: number | null = null;
  let quotaSource: Limits["quotaSource"] = "none";
  const cpuMax = text("cpuMax");

  if (cpuMax !== null) {
    const [quota, period] = cpuMax.split(/\s+/);
    quotaSource = "cgroup2";
    const p = intOrNull(period);
    const q = intOrNull(quota);

    if (quota !== "max" && q !== null && p !== null && p > 0) quotaCpus = round(q / p, 3);
  } else {
    const q = text("cfsQuota");
    const p = intOrNull(text("cfsPeriod") ?? undefined);

    if (q !== null) {
      quotaSource = "cgroup1";
      const quota = Number(q);

      if (Number.isFinite(quota) && quota > 0 && p !== null && p > 0)
        quotaCpus = round(quota / p, 3);
    }
  }

  const memMax = text("memMax");
  const v1 = intOrNull(text("memLimitV1") ?? undefined);

  const limitBytes =
    memMax !== null
      ? memMax === "max"
        ? null
        : intOrNull(memMax)
      : v1 !== null && v1 < v1Unlimited
        ? v1
        : null;

  const kib = (key: string) => intOrNull(text(key) ?? undefined);
  const memTotal = kib("memTotalKiB");
  const swapTotal = kib("swapTotalKiB");
  const allowed = text("allowed");

  return {
    nproc: intOrNull(text("nproc") ?? undefined),
    nprocAll: intOrNull(text("nprocAll") ?? undefined),
    cpuinfoProcessors: intOrNull(text("cpuinfo") ?? undefined),
    affinityCpus: allowed === null ? null : countCpuList(allowed),
    quotaCpus,
    quotaSource,
    memTotalGiB: memTotal === null ? null : round(memTotal / 2 ** 20, 2),
    memLimitGiB: limitBytes === null ? null : round(limitBytes / 2 ** 30, 2),
    swapTotalGiB: swapTotal === null ? null : round(swapTotal / 2 ** 20, 2),
    swapLimit: text("swapMax"),
    zramDevices: kib("zram"),
    zswap: text("zswap"),
    overcommit: kib("overcommit"),
  };
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

/**
 * CPUs the sandbox can use: the quota when there is one, else the CPUs it may run on. `visible`
 * is what nproc tells build tools.
 */
export function cpuView(limits: Limits) {
  const visible = limits.nproc ?? limits.cpuinfoProcessors;
  const placeable = limits.affinityCpus ?? limits.cpuinfoProcessors;
  const usable = limits.quotaCpus ?? placeable;

  return {
    visible,
    usable,
    /** nproc reports more CPUs than the quota gives time for. */
    overReported: visible !== null && usable !== null && visible > Math.ceil(usable),
  };
}

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    fillGiBps: z.number(),
    verifyGiBps: z.number(),
    fileMiBps: z.number().nullable(),
    fileError: z.number().int().nullable(),
    swapUsedKiB: z.number().int(),
    raw: memOutputSchema,
  }),
  z.object({
    kind: z.literal("killed"),
    exitCode: z.number().int().nullable(),
    /** The last `#phase` line the binary printed before it died. */
    lastPhase: z.string().nullable(),
    oomKills: z.number().int().nullable(),
    sandboxAlive: z.boolean(),
    detail: z.string(),
  }),
]);

export type Outcome = z.infer<typeof outcomeSchema>;

export const memoryResultSchema = z.object({
  limits: limitsSchema,
  visibleCpus: z.number().int().nullable(),
  usableCpus: z.number().nullable(),
  cpusOverReported: z.boolean(),
  memoryMiB: z.number().int(),
  fileMiB: z.number().int(),
  fileDirectory: z.string(),
  outcome: outcomeSchema,
});

export type MemoryResult = z.infer<typeof memoryResultSchema>;

export function lastPhase(stdout: string): string | null {
  const phases = [...stdout.matchAll(/^#phase (\S+)/gm)].map((m) => m[1] ?? "");

  return phases.at(-1) ?? null;
}

export function parseOomKills(stdout: string): number | null {
  return intOrNull(/^oom_kill (\d+)$/m.exec(stdout)?.[1]);
}

export const memoryHonestyCheck = (
  options: MemoryOptions = defaultMemoryOptions,
): Check<MemoryResult> => ({
  id: "memory-honesty",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 25 * 60_000,
  resultSchema: memoryResultSchema,
  async run(context) {
    const { memoryMiB, fileMiB } = options;
    const box = context.boxes[0]?.box;

    if (!box) throw new CheckStop("No sandbox");
    const probed = await context.exec(box, limitsCommand, 60_000);
    const limits = parseLimits(probed.stdout);
    const view = cpuView(limits);
    await context.note("limits", limits);
    context.say(
      `nproc ${limits.nproc ?? "?"}, quota ${limits.quotaCpus ?? "none"}, MemTotal ${limits.memTotalGiB ?? "?"} GiB, limit ${limits.memLimitGiB ?? "none"}`,
    );
    const installed = await installNative(context, box);
    const target = await diskTarget(context, box);
    const file = `${target.dir}/.sbx-mem-file.bin`;
    const seed = randomInt(0, 0x1_0000_0000);
    let outcome: Outcome;
    let stdout = "";
    let exitCode: number | null = null;
    let detail = "";

    try {
      const run = await context.exec(
        box,
        `'${installed.path}' mem ${seed} ${memoryMiB} '${file}' ${fileMiB}`,
        15 * 60_000,
      );

      stdout = run.stdout;
      exitCode = run.exitCode;
      detail = `exit ${run.exitCode}${run.timedOut ? " (timed out)" : ""} ${run.stderr.slice(-200)}`;
    } catch (cause) {
      detail = cause instanceof Error ? cause.message.slice(0, 300) : String(cause);
    }

    const parsed = parseNativeOutput(stdout, memOutputSchema);

    if (parsed.kind === "ok") {
      const raw = parsed.value;

      if (raw.badWords > 0 || raw.digest !== memoryDigest(seed, memoryMiB) || raw.mib !== memoryMiB)
        throw new CheckStop(`Memory read back wrong: ${raw.badWords} words, digest ${raw.digest}`);
      const gib = memoryMiB / 1024;

      outcome = {
        kind: "completed",
        fillGiBps: raw.fillS > 0 ? round(gib / raw.fillS, 2) : 0,
        verifyGiBps: raw.verifyS > 0 ? round(gib / raw.verifyS, 2) : 0,
        fileMiBps: raw.fileErrno === 0 && raw.fileS > 0 ? round(fileMiB / raw.fileS, 1) : null,
        fileError: raw.fileErrno === 0 ? null : raw.fileErrno,
        swapUsedKiB: Math.max(raw.swapFilledKiB, raw.swapAfterFileKiB, raw.end.vmSwapKiB, 0),
        raw,
      };
    } else {
      // Killed, or the sandbox went with it: see whether it still answers and what the cgroup says.
      let alive = false;
      let oomKills: number | null = null;

      try {
        const after = await context.exec(
          box,
          `cat /sys/fs/cgroup/memory.events 2>/dev/null; rm -f '${file}'`,
          60_000,
        );

        alive = after.ok || after.exitCode !== null;
        oomKills = parseOomKills(after.stdout);
      } catch {
        alive = false;
      }

      outcome = {
        kind: "killed",
        exitCode,
        lastPhase: lastPhase(stdout),
        oomKills,
        sandboxAlive: alive,
        detail: parsed.kind === "error" ? `${parsed.error.error}: ${detail}` : detail,
      };
    }

    context.say(`memory: ${outcome.kind}`);

    return {
      limits,
      visibleCpus: view.visible,
      usableCpus: view.usable,
      cpusOverReported: view.overReported,
      memoryMiB,
      fileMiB,
      fileDirectory: target.dir,
      outcome,
    };
  },
});

export const memoryHonesty = memoryHonestyCheck();
