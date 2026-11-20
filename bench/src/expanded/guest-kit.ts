/**
 * Shared plumbing for the filesystem, builds and runtime scenarios.
 *
 * Every guest program derives its data from one seeded generator, SHA-256 of `seed:label:i...` as
 * hex, which the host reimplements here with `seededHex`. The host recomputes each expected digest
 * from the seed alone, so output that was cached, hardcoded or produced for another seed fails.
 */
import { createHash } from "node:crypto";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { z } from "zod";
import { command, quote } from "../workloads.js";
import type { ExpandedContext, VerifyResult } from "./types.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of `seed:part:part...`, the generator every guest program reimplements. */
export function seededHex(seed: number, ...parts: readonly (string | number)[]): string {
  return sha256Hex([seed, ...parts].join(":"));
}

/** Integer value of `hex.slice(start, end)`, as Python's `int(h[start:end], 16)`. */
export function hexInt(hex: string, start: number, end: number): number {
  return Number.parseInt(hex.slice(start, end), 16);
}

/** SHA-256 of a sorted `path:sha256` manifest, the tree digest guests print. */
export function manifestDigest(entries: ReadonlyMap<string, string>): string {
  const lines = [...entries.keys()].sort().map((path) => `${path}:${entries.get(path) ?? ""}`);

  return sha256Hex(lines.join("\n"));
}

export const seedSchema = z.number().int().min(0).max(0xffff_ffff);

export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, "digest must be 64 hex characters");

export const secondsSchema = z.number().finite().positive().max(3600);

export type Parsed<T> = { readonly ok: true; readonly data: T } | VerifyFailure;

export type VerifyFailure = { readonly ok: false; readonly reason: string };

export function failure(reason: string): VerifyFailure {
  return { ok: false, reason };
}

/** Parse trimmed guest stdout as JSON against `schema`; never throws. */
export function parseGuestJson<T>(raw: string, schema: z.ZodType<T>): Parsed<T> {
  const text = raw.trim();

  if (text.length === 0) return failure("empty output");

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    return failure("output is not JSON");
  }

  const parsed = schema.safeParse(json);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];

    return failure(
      `unexpected output: ${issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "invalid"}`,
    );
  }

  return { ok: true, data: parsed.data };
}

/** The seed check every verifier starts with. */
export function seedMismatch(reported: number, seed: number): VerifyFailure | null {
  return reported === seed ? null : failure(`seed ${reported} does not match ${seed}`);
}

/** Scenario proof: a scenario prefix and the seed-bound digest, so proofs differ per seed. */
export function proofOf(prefix: string, digest: string): string {
  return `${prefix}:${digest.slice(0, 32)}`;
}

/** Turn a verifier result into the outcome `run` returns, throwing on a failed check. */
export function outcomeOf(scenarioId: string, result: VerifyResult) {
  if (!result.ok) throw new Error(`${scenarioId} verification failed: ${result.reason}`);

  return { value: result.value, proof: result.proof, details: result.details };
}

export interface GuestProgram {
  /** Fresh working directory the program owns; removed before and after. */
  readonly dir: string;
  /** File name inside `dir`. */
  readonly file: string;
  readonly source: string;
  /** Interpreter invocation; the program path and seed are appended. */
  readonly interpreter: "node" | "python3";
}

/** Upload a guest program into a clean directory, run it with the seed, and return its stdout. */
export async function runGuestProgram(box: Sandbox, program: GuestProgram, ctx: ExpandedContext) {
  const path = `${program.dir}/${program.file}`;
  const runner = program.interpreter === "node" ? "node --no-warnings" : "python3 -I";

  await command(
    box,
    `rm -rf ${quote(program.dir)} && mkdir -p ${quote(program.dir)}`,
    ctx.timeoutMs,
  );
  await box.files.write(path, program.source);

  try {
    return await command(
      box,
      `${runner} ${quote(path)} ${String(ctx.seed)} ${quote(program.dir)}`,
      ctx.timeoutMs,
    );
  } finally {
    await box.run(`rm -rf ${quote(program.dir)}`, { timeoutMs: ctx.timeoutMs });
  }
}

/** Node prelude shared by guest programs: seed, work directory and the seeded generator `h`. */
export const nodePrelude = `
import { createHash } from "node:crypto";
const SEED = Number(process.argv[2]);
const ROOT = process.argv[3];
if (!Number.isSafeInteger(SEED) || !ROOT) throw new Error("usage: <seed> <dir>");
const sha = (data) => createHash("sha256").update(data).digest("hex");
const h = (...parts) => sha([SEED, ...parts].join(":"));
const now = () => Number(process.hrtime.bigint()) / 1e9;
`;

/** Python prelude shared by guest programs: seed, work directory and the seeded generator `h`. */
export const pythonPrelude = `
import hashlib, json, os, sys, time
SEED = int(sys.argv[1])
ROOT = sys.argv[2]
def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()
def h(*parts):
    return sha(":".join(str(p) for p in (SEED,) + parts))
`;
