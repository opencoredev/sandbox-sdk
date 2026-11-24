/**
 * disk-real: storage measured the same way on every provider, past the guest's page cache.
 *
 * In the sandbox's roomiest writable directory that is not memory-backed (tmpfs or ramfs; one is
 * used only when nothing else is writable), `sbx-native disk` writes a 2 GiB file 1 MiB at a time
 * with O_DIRECT where the filesystem takes it, then fdatasync; drops the file's cached pages
 * (POSIX_FADV_DONTNEED) and reads it back with O_DIRECT, checking every page; then does synced
 * 4 KiB random writes (pwrite + fdatasync each, each page rewritten with new content) and direct
 * 4 KiB random reads for 10 s each, the reads checking each page is the version last written. Only
 * the I/O syscalls are timed. The size is the same everywhere: a sandbox without room for it fails.
 *
 * The host checks the digests, that every phase ran and took time, and that the guest's timings fit
 * inside its own. A result is `comparable` only when the filesystem is not memory-backed and every
 * phase got O_DIRECT; the others are kept, with why, as diagnostics.
 */
import { randomInt } from "node:crypto";
import { z } from "zod";
import { CheckStop, type Box, type Check, type CheckContext } from "./framework.js";
import {
  clockToleranceS,
  diskOutputSchema,
  diskRandomReadDigest,
  diskStampDigest,
  installNative,
  maxRandomOps,
  parseNativeOutput,
  type DiskOutput,
} from "./native.js";

export interface DiskOptions {
  readonly randomSeconds: number;
  /** One size for every provider: the file plus 256 MiB must fit. */
  readonly sizeMiB: number;
}

export const defaultDiskOptions: DiskOptions = { randomSeconds: 10, sizeMiB: 2048 };

/** statfs magic numbers the checks name. */
export const fsTypes = new Map<number, string>([
  [0xef53, "ext4"],
  [0x58465342, "xfs"],
  [0x9123683e, "btrfs"],
  [0x794c7630, "overlay"],
  [0x01021994, "tmpfs"],
  [0x858458f6, "ramfs"],
  [0x01021997, "9p"],
  [0x65735546, "fuse"],
  [0x6969, "nfs"],
  [0x2fc12fc1, "zfs"],
  [0x73717368, "squashfs"],
  [0x6a656a63, "fakeowner"],
]);

export const fsTypeName = (magic: number) => fsTypes.get(magic) ?? `0x${magic.toString(16)}`;

/** Filesystems whose files live in memory, by their statfs name or `stat -f -c %T`'s. */
export const memoryBacked = new Set(["tmpfs", "ramfs"]);

/** Prints `dir=<path> avail=<KiB> fs=<type>` for each candidate the shell can write. */
export const candidatesCommand = [
  `for d in "$HOME" /workspace /root /home/user /tmp /var/tmp; do`,
  `  [ -d "$d" ] && [ -w "$d" ] || continue`,
  `  a=$(df -Pk "$d" 2>/dev/null | awk 'NR==2{print $4}')`,
  `  t=$(stat -f -c %T "$d" 2>/dev/null)`,
  `  echo "dir=$(cd "$d" && pwd -P) avail=\${a:-0} fs=\${t:-unknown}"`,
  `done`,
].join("\n");

export interface Candidate {
  readonly dir: string;
  readonly availKiB: number;
  readonly fs: string;
}

export function parseCandidates(stdout: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const match of stdout.matchAll(/^dir=(\S+) avail=(\d+)(?: fs=(\S+))?$/gm)) {
    const dir = match[1];

    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, availKiB: Number(match[2]), fs: match[3] ?? "unknown" });
  }

  return out;
}

/**
 * The roomiest candidate that is not memory-backed, else the roomiest of all (so a sandbox whose
 * only writable storage is memory still gets measured, and says so). Ties keep the earlier.
 */
export function chooseDirectory(candidates: readonly Candidate[]): Candidate | null {
  const roomiest = (list: readonly Candidate[]) => {
    let best: Candidate | null = null;

    for (const candidate of list)
      if (best === null || candidate.availKiB > best.availKiB) best = candidate;

    return best;
  };

  return roomiest(candidates.filter((c) => !memoryBacked.has(c.fs))) ?? roomiest(candidates);
}

export const fits = (availKiB: number, sizeMiB: number) => availKiB >= (sizeMiB + 256) * 1024;

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

export const diskResultSchema = z.object({
  directory: z.string(),
  fsType: z.string(),
  memoryBacked: z.boolean(),
  /** Not memory-backed and every phase got O_DIRECT: the figures are the disk's. */
  comparable: z.boolean(),
  notComparableWhy: z.string().nullable(),
  freeGiB: z.number(),
  sizeMiB: z.number().int().positive(),
  seqWriteMiBps: z.number().positive(),
  seqWriteDirect: z.boolean(),
  seqReadMiBps: z.number().positive(),
  seqReadDirect: z.boolean(),
  randWriteIops: z.number().positive(),
  randWriteP50Us: z.number(),
  randWriteP99Us: z.number(),
  randWriteDirect: z.boolean(),
  randReadIops: z.number().positive(),
  randReadP50Us: z.number(),
  randReadP99Us: z.number(),
  randReadDirect: z.boolean(),
  raw: diskOutputSchema,
});

export type DiskResult = z.infer<typeof diskResultSchema>;

export type DiskCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "invalid"; readonly reason: string };

type Latency = DiskOutput["randWriteLatency"];

const latencyOrdered = (l: Latency) => l.p50Ns <= l.p99Ns && l.p99Ns <= l.maxNs;

/** The host's checks on a disk run: counts, content, digests, and guest time within host time. */
export function verifyDisk(input: {
  readonly output: DiskOutput;
  readonly seed: number;
  readonly sizeMiB: number;
  readonly randomSeconds: number;
  readonly hostS: number;
}): DiskCheck {
  const { output, seed, sizeMiB, hostS } = input;
  const writes = output.randWriteLatency;
  const reads = output.randReadLatency;

  if (output.sizeMiB !== sizeMiB)
    return { kind: "invalid", reason: `Ran ${output.sizeMiB} MiB, asked ${sizeMiB}` };

  // Bounded before anything loops over them.
  if (writes.ops < 1 || reads.ops < 1 || writes.ops > maxRandomOps || reads.ops > maxRandomOps)
    return {
      kind: "invalid",
      reason: `Random operation counts ${writes.ops} and ${reads.ops} are outside 1 to ${maxRandomOps}`,
    };

  if (!latencyOrdered(writes) || !latencyOrdered(reads))
    return { kind: "invalid", reason: "Latency percentiles are out of order" };

  if (output.seqWrite.writeS <= 0 || output.seqRead.readS <= 0)
    return { kind: "invalid", reason: "A sequential phase reports no time" };

  // A random phase runs its full time unless it hit the operation cap.
  const short = (wallS: number, capped: boolean) =>
    !capped && wallS < input.randomSeconds - clockToleranceS;

  if (
    short(output.randWrite.wallS, output.randWrite.capped) ||
    short(output.randRead.wallS, output.randRead.capped)
  )
    return { kind: "invalid", reason: "A random phase stopped before its time" };

  if (output.seqRead.badPages > 0 || output.randRead.badPages > 0)
    return {
      kind: "invalid",
      reason: `Read back ${output.seqRead.badPages} sequential and ${output.randRead.badPages} random pages that did not match what was last written`,
    };

  if (output.seqRead.stampDigest !== diskStampDigest(seed, sizeMiB))
    return { kind: "invalid", reason: "Sequential read digest does not match the seed" };

  const expected = diskRandomReadDigest({
    seed,
    sizeMiB,
    writeOps: writes.ops,
    readOps: reads.ops,
  });

  if (output.randRead.digest !== expected)
    return { kind: "invalid", reason: "Random read digest does not match the seed and the writes" };

  const guestS =
    output.seqWrite.writeS +
    output.seqWrite.syncS +
    output.seqRead.readS +
    output.randWrite.wallS +
    output.randRead.wallS;

  if (guestS > hostS + clockToleranceS)
    return {
      kind: "invalid",
      reason: `Guest timed ${round(guestS, 3)}s of I/O inside a ${round(hostS, 3)}s exec`,
    };

  return { kind: "ok" };
}

export function summarizeDisk(input: {
  readonly output: DiskOutput;
  readonly directory: string;
}): DiskResult {
  const { output } = input;
  const fsType = fsTypeName(output.fsType);
  const inMemory = memoryBacked.has(fsType);

  const buffered = [
    output.seqWrite.direct ? null : "sequential write",
    output.seqRead.direct ? null : "sequential read",
    output.randWrite.direct ? null : "random write",
    output.randRead.direct ? null : "random read",
  ].filter((phase) => phase !== null);

  const why = [
    inMemory ? `${input.directory} is ${fsType}, so the file lived in memory` : null,
    buffered.length > 0
      ? `the filesystem refused direct I/O for the ${buffered.join(", ")}, which ran through the page cache`
      : null,
  ].filter((reason) => reason !== null);

  return {
    directory: input.directory,
    fsType,
    memoryBacked: inMemory,
    comparable: why.length === 0,
    notComparableWhy: why.length === 0 ? null : why.join("; "),
    freeGiB: round(output.freeBytes / 2 ** 30, 1),
    sizeMiB: output.sizeMiB,
    seqWriteMiBps: round(output.sizeMiB / (output.seqWrite.writeS + output.seqWrite.syncS), 1),
    seqWriteDirect: output.seqWrite.direct,
    seqReadMiBps: round(output.sizeMiB / output.seqRead.readS, 1),
    seqReadDirect: output.seqRead.direct,
    randWriteIops: Math.round(output.randWriteLatency.ops / output.randWrite.wallS),
    randWriteP50Us: round(output.randWriteLatency.p50Ns / 1000, 1),
    randWriteP99Us: round(output.randWriteLatency.p99Ns / 1000, 1),
    randWriteDirect: output.randWrite.direct,
    randReadIops: Math.round(output.randReadLatency.ops / output.randRead.wallS),
    randReadP50Us: round(output.randReadLatency.p50Ns / 1000, 1),
    randReadP99Us: round(output.randReadLatency.p99Ns / 1000, 1),
    randReadDirect: output.randRead.direct,
    raw: output,
  };
}

/** Finds the directory, as memory-honesty also does for its file. */
export async function diskTarget(context: CheckContext, box: Box) {
  const listed = await context.exec(box, candidatesCommand, 60_000);
  const chosen = chooseDirectory(parseCandidates(listed.stdout));

  if (chosen === null) throw new CheckStop(`No writable directory: ${listed.stderr.slice(0, 200)}`);

  return chosen;
}

export const diskRealCheck = (options: DiskOptions = defaultDiskOptions): Check<DiskResult> => ({
  id: "disk-real",
  boxes: 1,
  minBoxes: 1,
  lifetimeMs: 30 * 60_000,
  resultSchema: diskResultSchema,
  async run(context) {
    const box = context.boxes[0]?.box;

    if (!box) throw new CheckStop("No sandbox");
    const installed = await installNative(context, box);
    await context.note("installed", installed);
    const target = await diskTarget(context, box);
    const { sizeMiB } = options;

    if (!fits(target.availKiB, sizeMiB))
      throw new CheckStop(
        `${target.dir} has ${Math.round(target.availKiB / 1024)} MiB free, under the ${sizeMiB + 256} MiB a ${sizeMiB} MiB file needs`,
      );

    await context.note("target", { ...target, sizeMiB });
    context.say(`${target.dir} (${target.fs}): ${sizeMiB} MiB file`);
    const seed = randomInt(0, 0x1_0000_0000);
    const started = performance.now();

    const run = await context.exec(
      box,
      `'${installed.path}' disk '${target.dir}' ${seed} ${sizeMiB} ${options.randomSeconds * 1000}`,
      20 * 60_000,
    );

    const hostS = (performance.now() - started) / 1000;

    if (run.timedOut) throw new CheckStop("sbx-native disk timed out");
    const parsed = parseNativeOutput(run.stdout, diskOutputSchema);

    if (parsed.kind === "error")
      throw new CheckStop(
        `sbx-native disk: ${parsed.error.error} (errno ${parsed.error.errno ?? "?"})`,
      );

    if (parsed.kind === "invalid" || !run.ok)
      throw new CheckStop(
        `sbx-native disk exited ${run.exitCode}: ${parsed.kind === "invalid" ? parsed.reason : "non-zero exit"} ${run.stderr.slice(-200)}`,
      );

    const verdict = verifyDisk({
      output: parsed.value,
      seed,
      sizeMiB,
      randomSeconds: options.randomSeconds,
      hostS,
    });

    if (verdict.kind === "invalid") throw new CheckStop(verdict.reason);
    const result = summarizeDisk({ output: parsed.value, directory: target.dir });

    context.say(
      `${result.fsType}${result.comparable ? "" : " (not comparable)"}: write ${result.seqWriteMiBps} MiB/s, read ${result.seqReadMiBps} MiB/s, 4K sync write ${result.randWriteIops}/s, 4K read ${result.randReadIops}/s`,
    );

    return result;
  },
});

export const diskReal = diskRealCheck();
