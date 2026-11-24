/**
 * disk-real: storage measured the same way on every provider, past the guest's page cache.
 *
 * In the sandbox's largest writable directory, `sbx-native disk` writes a 2 GiB file 1 MiB at a
 * time with O_DIRECT where the filesystem takes it, then fdatasync; drops the file's cached pages
 * (POSIX_FADV_DONTNEED) and reads it back with O_DIRECT, checking every page; then does synced
 * 4 KiB random writes (pwrite + fdatasync each) and direct 4 KiB random reads for 10 s each. Only
 * the I/O syscalls are timed. The filesystem type (statfs) and whether each phase got O_DIRECT are
 * recorded, so a memory-backed directory (tmpfs) or a buffered fallback shows beside its numbers.
 * The host checks the page digests and that the guest's timings fit inside its own.
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
  parseNativeOutput,
  type DiskOutput,
} from "./native.js";

export interface DiskOptions {
  readonly randomSeconds: number;
  /** File sizes tried, largest first, by free space: the file plus 256 MiB must fit. */
  readonly sizesMiB: readonly number[];
}

export const defaultDiskOptions: DiskOptions = { randomSeconds: 10, sizesMiB: [2048, 1024, 512] };

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

/** Filesystems whose files live in memory. */
export const memoryBacked = new Set(["tmpfs", "ramfs"]);

/** Prints `dir=<path> avail=<KiB>` for each candidate the shell can write. */
export const candidatesCommand = [
  `for d in "$HOME" /workspace /root /home/user /tmp /var/tmp; do`,
  `  [ -d "$d" ] && [ -w "$d" ] || continue`,
  `  a=$(df -Pk "$d" 2>/dev/null | awk 'NR==2{print $4}')`,
  `  echo "dir=$(cd "$d" && pwd -P) avail=\${a:-0}"`,
  `done`,
].join("\n");

export interface Candidate {
  readonly dir: string;
  readonly availKiB: number;
}

export function parseCandidates(stdout: string): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];

  for (const match of stdout.matchAll(/^dir=(\S+) avail=(\d+)$/gm)) {
    const dir = match[1];
    const avail = Number(match[2]);

    if (dir === undefined || seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, availKiB: avail });
  }

  return out;
}

/** The candidate with the most free space; ties keep the earlier ($HOME first). */
export function chooseDirectory(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;

  for (const candidate of candidates)
    if (best === null || candidate.availKiB > best.availKiB) best = candidate;

  return best;
}

export function sizeFor(availKiB: number, sizesMiB: readonly number[]): number | null {
  return sizesMiB.find((size) => availKiB >= (size + 256) * 1024) ?? null;
}

const mibPerS = (mib: number, s: number) => (s > 0 ? round(mib / s, 1) : null);
const perS = (ops: number, s: number) => (s > 0 ? Math.round(ops / s) : null);
const micros = (ns: number) => round(ns / 1000, 1);

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

export const diskResultSchema = z.object({
  directory: z.string(),
  fsType: z.string(),
  memoryBacked: z.boolean(),
  freeGiB: z.number(),
  sizeMiB: z.number().int().positive(),
  seqWriteMiBps: z.number().nullable(),
  seqWriteDirect: z.boolean(),
  seqReadMiBps: z.number().nullable(),
  seqReadDirect: z.boolean(),
  randWriteIops: z.number().nullable(),
  randWriteP50Us: z.number(),
  randWriteP99Us: z.number(),
  randWriteDirect: z.boolean(),
  randReadIops: z.number().nullable(),
  randReadP50Us: z.number(),
  randReadP99Us: z.number(),
  randReadDirect: z.boolean(),
  raw: diskOutputSchema,
});

export type DiskResult = z.infer<typeof diskResultSchema>;

export type DiskCheck =
  | { readonly kind: "ok" }
  | { readonly kind: "invalid"; readonly reason: string };

/** The host's checks on a disk run: content, digests, and guest time within host time. */
export function verifyDisk(input: {
  readonly output: DiskOutput;
  readonly seed: number;
  readonly sizeMiB: number;
  readonly hostS: number;
}): DiskCheck {
  const { output, seed, sizeMiB, hostS } = input;

  if (output.sizeMiB !== sizeMiB)
    return { kind: "invalid", reason: `Ran ${output.sizeMiB} MiB, asked ${sizeMiB}` };

  if (output.seqRead.badPages > 0 || output.randRead.badPages > 0)
    return {
      kind: "invalid",
      reason: `Read back ${output.seqRead.badPages} sequential and ${output.randRead.badPages} random pages that did not match what was written`,
    };

  if (output.seqRead.stampDigest !== diskStampDigest(seed, sizeMiB))
    return { kind: "invalid", reason: "Sequential read digest does not match the seed" };

  if (output.randRead.digest !== diskRandomReadDigest(seed, sizeMiB, output.randReadLatency.ops))
    return { kind: "invalid", reason: "Random read digest does not match the seed" };

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

  if (output.randWriteLatency.ops === 0 || output.randReadLatency.ops === 0)
    return { kind: "invalid", reason: "No random operations completed" };

  return { kind: "ok" };
}

export function summarizeDisk(input: {
  readonly output: DiskOutput;
  readonly directory: string;
}): DiskResult {
  const { output } = input;
  const fsType = fsTypeName(output.fsType);

  return {
    directory: input.directory,
    fsType,
    memoryBacked: memoryBacked.has(fsType),
    freeGiB: round(output.freeBytes / 2 ** 30, 1),
    sizeMiB: output.sizeMiB,
    seqWriteMiBps: mibPerS(output.sizeMiB, output.seqWrite.writeS + output.seqWrite.syncS),
    seqWriteDirect: output.seqWrite.direct,
    seqReadMiBps: mibPerS(output.sizeMiB, output.seqRead.readS),
    seqReadDirect: output.seqRead.direct,
    randWriteIops: perS(output.randWriteLatency.ops, output.randWrite.wallS),
    randWriteP50Us: micros(output.randWriteLatency.p50Ns),
    randWriteP99Us: micros(output.randWriteLatency.p99Ns),
    randWriteDirect: output.randWrite.direct,
    randReadIops: perS(output.randReadLatency.ops, output.randRead.wallS),
    randReadP50Us: micros(output.randReadLatency.p50Ns),
    randReadP99Us: micros(output.randReadLatency.p99Ns),
    randReadDirect: output.randRead.direct,
    raw: output,
  };
}

/** Finds the directory and file size, as memory-honesty also does for its file. */
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
    const sizeMiB = sizeFor(target.availKiB, options.sizesMiB);

    if (sizeMiB === null)
      throw new CheckStop(
        `${target.dir} has ${Math.round(target.availKiB / 1024)} MiB free, under ${Math.min(...options.sizesMiB) + 256} MiB`,
      );
    await context.note("target", { ...target, sizeMiB });
    context.say(`${target.dir}: ${sizeMiB} MiB file`);
    const seed = randomInt(0, 0x1_0000_0000);
    const started = performance.now();

    const run = await context.exec(
      box,
      `'${installed.path}' disk '${target.dir}' ${seed} ${sizeMiB} ${options.randomSeconds * 1000}`,
      20 * 60_000,
    );

    const hostS = (performance.now() - started) / 1000;
    const parsed = parseNativeOutput(run.stdout, diskOutputSchema);

    if (parsed.kind === "error")
      throw new CheckStop(
        `sbx-native disk: ${parsed.error.error} (errno ${parsed.error.errno ?? "?"})`,
      );

    if (parsed.kind === "invalid")
      throw new CheckStop(
        `sbx-native disk exited ${run.exitCode}: ${parsed.reason} ${run.stderr.slice(-200)}`,
      );
    const verdict = verifyDisk({ output: parsed.value, seed, sizeMiB, hostS });

    if (verdict.kind === "invalid") throw new CheckStop(verdict.reason);
    const result = summarizeDisk({ output: parsed.value, directory: target.dir });
    context.say(
      `${result.fsType}: write ${result.seqWriteMiBps} MiB/s, read ${result.seqReadMiBps} MiB/s, 4K sync write ${result.randWriteIops}/s, 4K read ${result.randReadIops}/s`,
    );

    return result;
  },
});

export const diskReal = diskRealCheck();
