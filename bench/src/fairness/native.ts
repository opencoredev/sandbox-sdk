/**
 * The host side of `bench/native/sbx-native.c`: its arithmetic (so the host can check what the guest
 * reports), its output schemas, and installing it into a sandbox.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { CheckStop, type Box, type CheckContext } from "./framework.js";
import { nativeBase64, nativeSha256, nativeSize } from "./native-binary.js";

const golden = 0x9e3779b9;

export function fmix32(input: number): number {
  let h = input >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;

  return h >>> 0;
}

/** Word `g` of a seeded stream (only g's low 32 bits matter, as in the C). */
export const streamWord = (seed: number, g: number) =>
  fmix32((Math.imul(g >>> 0, golden) + seed) >>> 0);

/** One xorshift32 step; returns the new state, which is also the output. */
export function xorshift32(state: number): number {
  let x = state >>> 0;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;

  return x >>> 0;
}

const pageStamp = (seed: number, page: number) =>
  fmix32((seed ^ Math.imul(page >>> 0, golden)) >>> 0);

/** The disk test's sequential-read digest: the sum of every page's stamp word, mod 2^32. */
export function diskStampDigest(seed: number, sizeMiB: number): number {
  let digest = 0;

  for (let page = 0; page < sizeMiB * 256; page++) digest = (digest + pageStamp(seed, page)) >>> 0;

  return digest;
}

/** The random-read digest over the first `ops` pages of the reader's sequence. */
export function diskRandomReadDigest(seed: number, sizeMiB: number, ops: number): number {
  const pages = sizeMiB * 256;
  let state = (fmix32((seed ^ 0x5a5a5a5a) >>> 0) | 1) >>> 0;
  let digest = 0;

  for (let op = 0; op < ops; op++) {
    state = xorshift32(state);
    digest = (digest + pageStamp(seed, state % pages)) >>> 0;
  }

  return digest;
}

/** The memory test's digest: word (p * 7) mod 1024 of every 4 KiB page, summed mod 2^32. */
export function memoryDigest(seed: number, mib: number): number {
  let digest = 0;

  for (let page = 0; page < mib * 256; page++)
    digest = (digest + streamWord(seed, page * 1024 + ((page * 7) & 1023))) >>> 0;

  return digest;
}

// ---------------------------------------------------------------------------------------------
// Output schemas

const seconds = z.number().nonnegative();

export const cpuOutputSchema = z.object({
  mode: z.literal("cpu"),
  wallS: z.number().positive(),
  totalSteps: z.number().int().nonnegative(),
  opsPerSec: z.number().nonnegative(),
  workers: z
    .array(
      z.object({
        seed: z.number().int().nonnegative(),
        steps: z.number().int().positive(),
        checksum: z.number().int().nonnegative(),
        elapsedS: z.number().positive(),
      }),
    )
    .min(1),
});

const latencySchema = z.object({
  ops: z.number().int().nonnegative(),
  p50Ns: z.number().int().nonnegative(),
  p99Ns: z.number().int().nonnegative(),
  maxNs: z.number().int().nonnegative(),
});

export const diskOutputSchema = z.object({
  mode: z.literal("disk"),
  fsType: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  sizeMiB: z.number().int().positive(),
  seqWrite: z.object({ direct: z.boolean(), writeS: seconds, syncS: seconds }),
  seqRead: z.object({
    direct: z.boolean(),
    readS: seconds,
    badPages: z.number().int().nonnegative(),
    stampDigest: z.number().int().nonnegative(),
  }),
  randWrite: z.object({ direct: z.boolean(), wallS: seconds }),
  randWriteLatency: latencySchema,
  randRead: z.object({
    direct: z.boolean(),
    wallS: seconds,
    badPages: z.number().int().nonnegative(),
    digest: z.number().int().nonnegative(),
  }),
  randReadLatency: latencySchema,
});

export type DiskOutput = z.infer<typeof diskOutputSchema>;

const kib = z.number().int();

export const memOutputSchema = z.object({
  mode: z.literal("mem"),
  mib: z.number().int().positive(),
  fillS: seconds,
  fileMiB: z.number().int().nonnegative(),
  fileS: seconds,
  fileErrno: z.number().int(),
  verifyS: seconds,
  badWords: z.number().int().nonnegative(),
  digest: z.number().int().nonnegative(),
  rssFilledKiB: kib,
  swapFilledKiB: kib,
  rssAfterFileKiB: kib,
  swapAfterFileKiB: kib,
  end: z.object({
    vmRssKiB: kib,
    vmSwapKiB: kib,
    memAvailableKiB: kib,
    swapFreeKiB: kib,
  }),
});

export type MemOutput = z.infer<typeof memOutputSchema>;

/** What a mode prints when it cannot run: `{"mode":..,"error":..}`. */
const errorOutputSchema = z.object({
  mode: z.string(),
  error: z.string(),
  errno: z.number().int().optional(),
  fsType: z.number().int().optional(),
  freeBytes: z.number().int().optional(),
});

export type NativeError = z.infer<typeof errorOutputSchema>;

export type Parsed<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "error"; readonly error: NativeError }
  | { readonly kind: "invalid"; readonly reason: string };

/** The last JSON line of a run's stdout through `schema`, or the binary's own error line. */
export function parseNativeOutput<T>(stdout: string, schema: z.ZodType<T>): Parsed<T> {
  const line =
    stdout
      .trim()
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .at(-1) ?? "";

  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "invalid", reason: `Output is not JSON: ${line.slice(0, 200)}` };
  }

  const error = errorOutputSchema.safeParse(value);

  if (error.success) return { kind: "error", error: error.data };
  const parsed = schema.safeParse(value);

  if (!parsed.success)
    return {
      kind: "invalid",
      reason: `Output shape: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
    };

  return { kind: "ok", value: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Install

/** The embedded binary, checked against its recorded hash and size before it is sent anywhere. */
export function nativeBytes(): Uint8Array {
  const bytes = Buffer.from(nativeBase64, "base64");
  const sha = createHash("sha256").update(bytes).digest("hex");

  if (sha !== nativeSha256 || bytes.length !== nativeSize)
    throw new Error(
      `Embedded sbx-native is ${bytes.length} bytes, sha256 ${sha}; expected ${nativeSha256}`,
    );

  return new Uint8Array(bytes);
}

export const installedSchema = z.object({
  path: z.string(),
  /** Whether the guest's sha256sum matched; null when the guest has no sha256sum. */
  shaVerified: z.boolean().nullable(),
  /** How the bytes got there. */
  via: z.enum(["files", "base64"]),
});

export type Installed = z.infer<typeof installedSchema>;

const installTimeoutMs = 60_000;
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Tries each directory: copy, mark executable, run `version`. Prints `path=...` on success. */
export function placeCommand(source: string) {
  return [
    `for d in /tmp /var/tmp "$HOME" /workspace /root /dev/shm; do`,
    `  [ -d "$d" ] && [ -w "$d" ] || continue`,
    `  t="$d/.sbx-native"`,
    `  if [ "$t" != ${quote(source)} ]; then cp ${quote(source)} "$t" 2>/dev/null || continue; fi`,
    `  chmod 755 "$t" 2>/dev/null`,
    `  if "$t" version 2>/dev/null | grep -q '"name":"sbx-native"'; then`,
    `    echo "path=$t"`,
    `    if command -v sha256sum >/dev/null 2>&1; then echo "sha=$(sha256sum "$t" | cut -d' ' -f1)"; else echo "sha="; fi`,
    `    exit 0`,
    `  fi`,
    `done`,
    `exit 7`,
  ].join("\n");
}

export function parsePlaced(stdout: string): { path: string; sha: string | null } | null {
  const path = /^path=(.+)$/m.exec(stdout)?.[1]?.trim();
  const sha = /^sha=(.*)$/m.exec(stdout)?.[1]?.trim();

  if (!path) return null;

  return { path, sha: sha ? sha : null };
}

/**
 * Puts the binary in the guest and proves it runs: through the SDK's file write, else a base64
 * heredoc. Throws CheckStop when neither works.
 */
export async function installNative(context: CheckContext, box: Box): Promise<Installed> {
  const bytes = nativeBytes();
  const staging = "/tmp/.sbx-native";
  const errors: string[] = [];

  const place = async (via: Installed["via"]): Promise<Installed | null> => {
    const placed = await context.exec(box, placeCommand(staging), installTimeoutMs);
    const found = placed.ok ? parsePlaced(placed.stdout) : null;

    if (found === null) {
      errors.push(
        `${via}: no directory could run it (exit ${placed.exitCode}) ${placed.stderr.slice(0, 200)}`,
      );

      return null;
    }

    if (found.sha !== null && found.sha !== nativeSha256)
      throw new CheckStop(`sbx-native arrived as sha256 ${found.sha}, expected ${nativeSha256}`);

    return { path: found.path, shaVerified: found.sha === null ? null : true, via };
  };

  try {
    await box.write(staging, bytes);
    const installed = await place("files");

    if (installed) return installed;
  } catch (cause) {
    if (cause instanceof CheckStop) throw cause;
    errors.push(`files: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause)}`);
  }

  const encoded = Buffer.from(bytes)
    .toString("base64")
    .replace(/(.{76})/g, "$1\n");

  const written = await context.exec(
    box,
    `base64 -d > ${staging} <<'SBX_NATIVE_EOF'\n${encoded}\nSBX_NATIVE_EOF\nchmod 755 ${staging}`,
    installTimeoutMs,
  );

  if (written.ok) {
    const installed = await place("base64");

    if (installed) return installed;
  } else errors.push(`base64: exit ${written.exitCode} ${written.stderr.slice(0, 200)}`);

  throw new CheckStop(`Could not install sbx-native: ${errors.join("; ")}`);
}

/** Exec seconds the guest's clock may exceed the host's by: round trips and process start. */
export const clockToleranceS = 1;
