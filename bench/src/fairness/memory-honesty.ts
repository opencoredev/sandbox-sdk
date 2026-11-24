/**
 * memory-honesty: whether the CPUs and memory a sandbox shows are the ones it can use.
 *
 * 1. Limits: `nproc`, /proc/cpuinfo's processors and the affinity list against the CPU quota of the
 *    shell's own cgroup and every ancestor the sandbox can read (v2 `cpu.max`, the tightest wins;
 *    v1 `cfs_quota_us`/`cfs_period_us`); MemTotal against `memory.max` the same way (v1
 *    `memory.limit_in_bytes`); swap, zram and zswap. Build tools size their worker pools from
 *    nproc, so 48 visible CPUs on a 4-CPU quota run 48 workers on 4 CPUs' time.
 * 2. Use: `sbx-native mem` dirties 6 GiB of anonymous memory with incompressible words, writes a
 *    2 GiB file in the disk test's directory with fdatasync while holding it, then reads every word
 *    back. The host checks the digest. A sandbox whose files live in memory needs 8 GiB for this
 *    and may be killed; hidden swap or compression shows as slow verification and VmSwap.
 *
 * Outcomes are only what the evidence shows: `completed` needs exit 0, the file written in full
 * and a digest that checks out; `killed` needs exit 137 (SIGKILL) or a new OOM kill in the cgroup;
 * `refused` is the binary's own allocation error; `sandbox-lost` is an exec that failed and a
 * sandbox that no longer answers. A timeout, or an exec error on a sandbox that still answers,
 * fails the check rather than becoming a finding.
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

/**
 * The shell's own cgroup v2 directory: its path from /proc/self/cgroup, made relative to the
 * cgroup2 mount's root (from /proc/self/mountinfo), since a container may mount only its own
 * subtree. Falls back to the mount point itself. Sets `$d` and `$mnt`, and prints `cgroupDir=`.
 */
const ownCgroup = [
  `cg=$(awk -F: '$1=="0"{print $3}' /proc/self/cgroup 2>/dev/null)`,
  // The cgroup2 mount whose root is the longest prefix of $cg on a path-component boundary.
  `set -- $(awk -v cg="$cg" '{for(i=1;i<=NF;i++) if($i=="-"){ if($(i+1)=="cgroup2"){ r=$4; if(r=="/" || cg==r || index(cg, r "/")==1){ if(length(r)>best){best=length(r); out=r " " $5} } } break }} END{print out}' /proc/self/mountinfo 2>/dev/null)`,
  `d=""; mnt=""`,
  `if [ -n "$cg" ] && [ -n "\${2:-}" ]; then root="$1"; mnt="$2"; if [ "$root" = / ]; then rel="$cg"; else rel="\${cg#"$root"}"; fi; d="$mnt\${rel%/}"; [ -d "$d" ] || d=""; fi`,
  `echo "cgroupDir=$d"`,
].join("\n");

/** Walks from the shell's own cgroup v2 directory up to the root, printing each limit it can read. */
const cgroupWalk = [
  ownCgroup,
  `while [ -n "$d" ] && [ -d "$d" ]; do`,
  `  [ -r "$d/cpu.max" ] && echo "cpuMax=$(cat "$d/cpu.max")"`,
  `  [ -r "$d/memory.max" ] && echo "memMax=$(cat "$d/memory.max")"`,
  `  [ -r "$d/memory.swap.max" ] && echo "swapMax=$(cat "$d/memory.swap.max")"`,
  `  if [ "$d" = "$mnt" ] || [ "$d" = / ]; then break; fi`,
  `  d=$(dirname "$d")`,
  `done`,
].join("\n");

export const limitsCommand = [
  `echo "nproc=$(nproc 2>/dev/null)"`,
  `echo "nprocAll=$(nproc --all 2>/dev/null)"`,
  `echo "cpuinfo=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)"`,
  `echo "allowed=$(grep '^Cpus_allowed_list' /proc/self/status 2>/dev/null | cut -f2)"`,
  cgroupWalk,
  `echo "cfsQuota=$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us 2>/dev/null | head -1)"`,
  `echo "cfsPeriod=$(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us 2>/dev/null | head -1)"`,
  `echo "memLimitV1=$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null)"`,
  `echo "memTotalKiB=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "swapTotalKiB=$(awk '/^SwapTotal:/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "zram=$(ls /sys/block 2>/dev/null | grep -c '^zram')"`,
  `echo "zswap=$(cat /sys/module/zswap/parameters/enabled 2>/dev/null)"`,
  `echo "overcommit=$(cat /proc/sys/vm/overcommit_memory 2>/dev/null)"`,
].join("\n");

/** The OOM kill counter of the shell's own cgroup (v2 memory.events, else v1 memory.oom_control). */
export const oomCommand = [
  ownCgroup,
  `if [ -n "$d" ]; then f="$d/memory.events"; else f=/sys/fs/cgroup/memory/memory.oom_control; fi`,
  `echo "oomFile=$f $(stat -c %d:%i "$f" 2>/dev/null)"`,
  `grep '^oom_kill ' "$f" 2>/dev/null || echo "oom_kill unknown"`,
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
  /** CPUs of time the tightest quota allows (quota / period); null when unlimited or unreadable. */
  quotaCpus: z.number().nullable(),
  quotaSource: z.enum(["cgroup2", "cgroup1", "none"]),
  memTotalGiB: z.number().nullable(),
  /** The tightest cgroup memory limit in GiB; null when unlimited or unreadable. */
  memLimitGiB: z.number().nullable(),
  swapTotalGiB: z.number().nullable(),
  swapLimit: z.string().nullable(),
  zramDevices: z.number().int().nullable(),
  zswap: z.string().nullable(),
  overcommit: z.number().int().nullable(),
});

export type Limits = z.infer<typeof limitsSchema>;

/** cgroup v1 reports "no limit" as a number near 2^63. */
const v1Unlimited = 2 ** 53;

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

const minOrNull = (values: readonly number[]) => (values.length === 0 ? null : Math.min(...values));

/** The smallest numeric cgroup limit, else "max" when every level is unlimited, else null. */
function tightest(values: readonly string[]): string | null {
  const numbers = values.flatMap((v) => [intOrNull(v)].filter((n) => n !== null));

  if (numbers.length > 0) return String(Math.min(...numbers));

  return values.includes("max") ? "max" : null;
}

/** The cgroup directory a probe resolved, so OOM counts are compared only for the same one. */
export const cgroupDirOf = (stdout: string) =>
  /^cgroupDir=(.+)$/m.exec(stdout)?.[1]?.trim() || null;

/** The OOM counter file and its inode, so two readings are compared only when they are one file. */
export const oomFileOf = (stdout: string) => /^oomFile=(\S+ \d+:\d+)$/m.exec(stdout)?.[1] ?? null;

export function parseLimits(stdout: string): Limits {
  const values = new Map<string, string[]>();

  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");

    if (at > 0) {
      const key = line.slice(0, at);
      const value = line.slice(at + 1).trim();
      values.set(key, [...(values.get(key) ?? []), value]);
    }
  }

  const all = (key: string) => (values.get(key) ?? []).filter((v) => v !== "");
  const text = (key: string) => all(key)[0] ?? null;
  const int = (key: string) => intOrNull(text(key) ?? undefined);

  // cgroup v2: every level the walk read; the tightest quota is the one that binds.
  const cpuMaxes = all("cpuMax");
  let quotaCpus: number | null = null;
  let quotaSource: Limits["quotaSource"] = "none";

  if (cpuMaxes.length > 0) {
    quotaSource = "cgroup2";

    quotaCpus = minOrNull(
      cpuMaxes.flatMap((line) => {
        const [quota, period] = line.split(/\s+/);
        const q = intOrNull(quota);
        const p = intOrNull(period);

        return quota !== "max" && q !== null && p !== null && p > 0 ? [round(q / p, 3)] : [];
      }),
    );
  } else {
    const q = text("cfsQuota");
    const p = int("cfsPeriod");

    if (q !== null) {
      quotaSource = "cgroup1";
      const quota = Number(q);

      if (Number.isFinite(quota) && quota > 0 && p !== null && p > 0)
        quotaCpus = round(quota / p, 3);
    }
  }

  const memMaxes = all("memMax");

  const limitBytes =
    memMaxes.length > 0
      ? minOrNull(
          memMaxes.flatMap((v) => (v === "max" ? [] : [intOrNull(v)].filter((n) => n !== null))),
        )
      : (() => {
          const v1 = int("memLimitV1");

          return v1 !== null && v1 < v1Unlimited ? v1 : null;
        })();

  const memTotal = int("memTotalKiB");
  const swapTotal = int("swapTotalKiB");
  const allowed = text("allowed");

  return {
    nproc: int("nproc"),
    nprocAll: int("nprocAll"),
    cpuinfoProcessors: int("cpuinfo"),
    affinityCpus: allowed === null ? null : countCpuList(allowed),
    quotaCpus,
    quotaSource,
    memTotalGiB: memTotal === null ? null : round(memTotal / 2 ** 20, 2),
    memLimitGiB: limitBytes === null ? null : round(limitBytes / 2 ** 30, 2),
    swapTotalGiB: swapTotal === null ? null : round(swapTotal / 2 ** 20, 2),
    swapLimit: tightest(all("swapMax")),
    zramDevices: int("zram"),
    zswap: text("zswap"),
    overcommit: int("overcommit"),
  };
}

/**
 * CPUs the sandbox can use: the tighter of the quota and the CPUs it may run on (null when neither
 * is readable). `visible` is what nproc tells build tools. `overReported` is null when either side
 * is unknown, not false.
 */
export function cpuView(limits: Limits) {
  const visible = limits.nproc ?? limits.cpuinfoProcessors;
  const placeable = limits.affinityCpus ?? limits.cpuinfoProcessors;
  const bounds = [limits.quotaCpus, placeable].filter((v) => v !== null);
  const usable = minOrNull(bounds);

  return {
    visible,
    usable,
    overReported: visible === null || usable === null ? null : visible > Math.ceil(usable),
  };
}

const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("completed"),
    fillGiBps: z.number().positive(),
    verifyGiBps: z.number().positive(),
    fileMiBps: z.number().positive(),
    swapUsedKiB: z.number().int().nonnegative(),
    raw: memOutputSchema,
  }),
  z.object({
    kind: z.literal("killed"),
    exitCode: z.number().int().nullable(),
    /** The last `#phase` line the binary printed before it died. */
    lastPhase: z.string().nullable(),
    /** New OOM kills in the cgroup during the run; null when the counter is unreadable. */
    oomKills: z.number().int().nonnegative().nullable(),
  }),
  z.object({ kind: z.literal("refused"), error: z.string(), errno: z.number().int().nullable() }),
  /** Memory held and verified, but the file could not be written in full. */
  z.object({
    kind: z.literal("file-failed"),
    errno: z.number().int().nullable(),
    writtenMiB: z.number().int().nonnegative(),
    swapUsedKiB: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal("sandbox-lost"),
    lastPhase: z.string().nullable(),
    detail: z.string(),
  }),
]);

export type Outcome = z.infer<typeof outcomeSchema>;

export const memoryResultSchema = z.object({
  limits: limitsSchema,
  visibleCpus: z.number().int().nullable(),
  usableCpus: z.number().nullable(),
  cpusOverReported: z.boolean().nullable(),
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

/** What the mem exec gave back, before it is judged. */
export type MemRun =
  | {
      readonly kind: "returned";
      readonly exitCode: number | null;
      readonly timedOut: boolean;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "threw"; readonly detail: string };

/**
 * Judges the mem run. `oomDelta` is the cgroup's new OOM kills (null when unreadable);
 * `alive` whether the sandbox answered a command afterwards.
 */
export function judgeMemory(input: {
  readonly run: MemRun;
  readonly seed: number;
  readonly memoryMiB: number;
  readonly fileMiB: number;
  readonly oomDelta: number | null;
  readonly alive: boolean;
}): Outcome {
  const { run, seed, memoryMiB, fileMiB, oomDelta, alive } = input;

  if (run.kind === "threw") {
    if (alive)
      throw new CheckStop(`The mem exec failed but the sandbox still answers: ${run.detail}`);

    return { kind: "sandbox-lost", lastPhase: null, detail: run.detail };
  }

  if (run.timedOut) throw new CheckStop("sbx-native mem timed out");
  const parsed = parseNativeOutput(run.stdout, memOutputSchema);
  const phase = lastPhase(run.stdout);

  if (run.exitCode === 0 && parsed.kind === "ok") {
    const raw = parsed.value;

    if (raw.mib !== memoryMiB || raw.fileMiB !== fileMiB)
      throw new CheckStop(
        `mem ran ${raw.mib} MiB and a ${raw.fileMiB} MiB file, asked ${memoryMiB} and ${fileMiB}`,
      );

    if (raw.fillS <= 0 || raw.verifyS <= 0)
      throw new CheckStop("mem reports a phase that took no time");

    if (raw.badWords > 0 || raw.digest !== memoryDigest(seed, memoryMiB))
      throw new CheckStop(`Memory read back wrong: ${raw.badWords} words, digest ${raw.digest}`);
    const swapUsedKiB = Math.max(raw.swapFilledKiB, raw.swapAfterFileKiB, raw.end.vmSwapKiB, 0);

    // The file counts only when every MiB was written and synced, and that took time.
    if (raw.fileErrno !== 0 || raw.fileWrittenMiB !== fileMiB || raw.fileS <= 0)
      return {
        kind: "file-failed",
        errno: raw.fileErrno === 0 ? null : raw.fileErrno,
        writtenMiB: raw.fileWrittenMiB,
        swapUsedKiB,
      };

    const gib = memoryMiB / 1024;

    return {
      kind: "completed",
      fillGiBps: round(gib / raw.fillS, 2),
      verifyGiBps: round(gib / raw.verifyS, 2),
      fileMiBps: round(fileMiB / raw.fileS, 1),
      swapUsedKiB,
      raw,
    };
  }

  if (parsed.kind === "error" && parsed.error.error === "mmap")
    return { kind: "refused", error: "mmap", errno: parsed.error.errno ?? null };

  if (run.exitCode === 137 || (oomDelta !== null && oomDelta > 0))
    return { kind: "killed", exitCode: run.exitCode, lastPhase: phase, oomKills: oomDelta };

  if (!alive) return { kind: "sandbox-lost", lastPhase: phase, detail: `exit ${run.exitCode}` };

  throw new CheckStop(
    `sbx-native mem exited ${run.exitCode} with no kill evidence: ${parsed.kind === "invalid" ? parsed.reason : parsed.kind} ${run.stderr.slice(-200)}`,
  );
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
    const beforeRun = (await context.exec(box, oomCommand, 60_000)).stdout;
    const before = parseOomKills(beforeRun);
    const seed = randomInt(0, 0x1_0000_0000);
    let run: MemRun;

    try {
      const result = await context.exec(
        box,
        `'${installed.path}' mem ${seed} ${memoryMiB} '${file}' ${fileMiB}`,
        15 * 60_000,
      );

      run = { kind: "returned", ...result };
    } catch (cause) {
      run = {
        kind: "threw",
        detail: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
      };
    }

    // Whether the sandbox still answers, the OOM counter after, and the file gone either way.
    let alive = false;
    let after: number | null = null;
    let afterFile: string | null = null;

    try {
      const followUp = await context.exec(box, `${oomCommand}\nrm -f '${file}'`, 60_000);
      alive = followUp.exitCode !== null;
      after = parseOomKills(followUp.stdout);
      afterFile = oomFileOf(followUp.stdout);
    } catch {
      alive = false;
    }

    const sameCgroup = afterFile !== null && afterFile === oomFileOf(beforeRun);

    const oomDelta =
      before !== null && after !== null && sameCgroup ? Math.max(0, after - before) : null;

    const outcome = judgeMemory({ run, seed, memoryMiB, fileMiB, oomDelta, alive });
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
