import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { command, quote } from "../workloads.js";
import type { ExpandedOutcome, VerifyResult } from "./types.js";

/** Shared pieces for expanded scenario verifiers: safe JSON decoding, the seeded PRNG, hashing. */

export type Decoded<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: string };

/** Parse one JSON reply with `schema`. Never throws. */
export function decode<T>(schema: z.ZodType<T>, raw: string): Decoded<T> {
  const text = raw.trim();

  if (text === "") return { ok: false, reason: "empty output" };

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "output is not JSON" };
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    const issue = result.error.issues[0];

    return {
      ok: false,
      reason: `unexpected output at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`,
    };
  }

  return { ok: true, data: result.data };
}

/** The mulberry32 generator, as unsigned 32-bit integers. `rngSource` is the same code for guests. */
export function rng32(seed: number): () => number {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return (t ^ (t >>> 14)) >>> 0;
  };
}

/** `rng32` as guest JavaScript. */
export const rngSource = `function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
}`;

/** Cache a per-seed computation, keeping at most eight seeds. */
export function memo<T>(compute: (seed: number) => T): (seed: number) => T {
  const cache = new Map<number, T>();

  return (seed) => {
    const hit = cache.get(seed);

    if (hit !== undefined) return hit;

    if (cache.size >= 8) cache.clear();
    const value = compute(seed);
    cache.set(seed, value);

    return value;
  };
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The verified outcome of a scenario run, or an error carrying the verifier's reason. */
export function outcomeOf(id: string, verdict: VerifyResult): ExpandedOutcome {
  if (!verdict.ok) throw new Error(`${id} failed verification: ${verdict.reason}`);

  return { value: verdict.value, proof: verdict.proof, details: verdict.details };
}

export function wrongSeed(got: number, want: number): VerifyResult {
  return { ok: false, reason: `seed mismatch: got ${got}, want ${want >>> 0}` };
}

export const seedField = z.number().int().nonnegative();
export const hexDigest = z.string().regex(/^[0-9a-f]{64}$/);
export const positiveSeconds = z.number().finite().positive();

/** The edit a fix applies with `box.files.edit`, relative to the project root. */
export interface ProjectEdit {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
}

/** Counts from a `node --test --test-reporter=tap` run; -1 when the summary line is missing. */
export interface TapCounts {
  readonly pass: number;
  readonly fail: number;
}

export function tapCounts(output: string): TapCounts {
  const count = (label: string) =>
    Number(new RegExp(`^# ${label} (\\d+)$`, "m").exec(output)?.[1] ?? -1);

  return { pass: count("pass"), fail: count("fail") };
}

/** Seconds since `startedAt`, a `performance.now()` reading. */
export function secondsSince(startedAt: number): number {
  return (performance.now() - startedAt) / 1000;
}

const unpackScript = [
  'const fs = require("node:fs"), path = require("node:path");',
  "const root = process.argv[1], manifest = path.join(root, '.tree.json');",
  'const files = JSON.parse(fs.readFileSync(manifest, "utf8"));',
  "for (const [name, text] of Object.entries(files)) {",
  "  const target = path.join(root, name);",
  "  fs.mkdirSync(path.dirname(target), { recursive: true });",
  "  fs.writeFileSync(target, text);",
  "}",
  "fs.rmSync(manifest);",
  "console.log(Object.keys(files).length);",
].join("\n");

/**
 * Replace `root` with `files` (paths relative to it) in two round trips: one `files.write` of a JSON
 * manifest and one `node` command that unpacks it. Per-file writes cost one round trip each, which
 * on some providers turns a 150-file tree into seconds of setup.
 */
export async function writeTree(
  box: Sandbox,
  root: string,
  files: Readonly<Record<string, string>>,
  timeoutMs: number,
) {
  await command(box, `rm -rf ${quote(root)} && mkdir -p ${quote(root)}`, timeoutMs);
  await box.files.write(`${root}/.tree.json`, JSON.stringify(files));

  const written = Number(
    await command(box, `node -e ${quote(unpackScript)} ${quote(root)}`, timeoutMs),
  );

  if (written !== Object.keys(files).length)
    throw new Error(`unpacked ${written} files into ${root}, want ${Object.keys(files).length}`);
}
