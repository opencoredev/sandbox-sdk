/**
 * The checks every expanded scenario's verifier must pass, shared by the filesystem, builds and
 * runtime test files. Guest programs run on this machine exactly as the sandbox runs them.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ExpandedScenario, VerifyResult } from "../src/expanded/types.js";

export const seedA = 123_456_789;
export const seedB = 3_987_654_321;

export const garbage = [
  "",
  "   \n",
  "not json",
  "{}",
  "[]",
  "null",
  "0",
  '{"ok":true}',
  '{"seed":123456789',
  "Error: guest crashed",
];

export interface GuestProgramCase {
  readonly source: string;
  readonly interpreter: "node" | "python3";
}

export interface VerifierCase {
  readonly id: string;
  /** A payload the verifier must accept for `seed`. */
  readonly valid: (seed: number) => string;
  /** Single-field changes the verifier must reject, one at a time. */
  readonly tampered: Readonly<Record<string, number | boolean | string>>;
  /** The value `valid(seed)` must produce. */
  readonly expectedValue: number;
  /** The guest program, when the scenario's output comes from one. */
  readonly guest?: GuestProgramCase;
}

const payload = z.record(z.string(), z.json());

/** `raw` with one top-level field replaced. */
export function withField(raw: string, key: string, value: number | boolean | string): string {
  return JSON.stringify({ ...payload.parse(JSON.parse(raw)), [key]: value });
}

function flipDigest(raw: string): string {
  const digest = z.object({ digest: z.string() }).parse(JSON.parse(raw)).digest;
  const first = digest.startsWith("0") ? "1" : "0";

  return withField(raw, "digest", `${first}${digest.slice(1)}`);
}

/** Run a guest program here, as `runGuestProgram` runs it in the sandbox, and return stdout. */
export function runLocally(guest: GuestProgramCase, seed: number): string {
  const dir = mkdtempSync(join(tmpdir(), "bench-expanded-"));

  try {
    const file = join(dir, guest.interpreter === "node" ? "program.mjs" : "program.py");
    writeFileSync(file, guest.source);

    const flags = guest.interpreter === "node" ? ["--no-warnings"] : ["-I"];

    const result = spawnSync(guest.interpreter, [...flags, file, String(seed), dir], {
      encoding: "utf8",
      timeout: 60_000,
    });

    if (result.status !== 0)
      throw new Error(
        `${guest.interpreter} exited ${result.status}: ${result.stderr.slice(-2000)}`,
      );

    return result.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function scenarioById(scenarios: readonly ExpandedScenario[], id: string) {
  const scenario = scenarios.find((s) => s.id === id);

  if (!scenario) throw new Error(`no scenario ${id}`);

  return scenario;
}

function proofOf(result: VerifyResult) {
  if (!result.ok) throw new Error(`expected ok, got: ${result.reason}`);

  return result.proof;
}

export function verifierSuite(
  scenarios: readonly ExpandedScenario[],
  cases: readonly VerifierCase[],
) {
  it("covers every scenario in the list exactly once", () => {
    expect(cases.map((c) => c.id).sort()).toEqual(scenarios.map((s) => s.id).sort());
  });

  describe.each(cases)("$id", (c) => {
    const scenario = scenarioById(scenarios, c.id);

    it("accepts a valid payload with the expected value and a seed-bound proof", () => {
      const result = scenario.verifyOutput(c.valid(seedA), seedA);

      expect(result).toMatchObject({ ok: true });

      if (!result.ok) return;
      expect(result.value).toBeCloseTo(c.expectedValue, 9);
      expect(Number.isFinite(result.value) && result.value > 0).toBe(true);
      expect(result.proof.length).toBeGreaterThanOrEqual(8);
    });

    it.each(garbage)("rejects garbage output %j without throwing", (raw) => {
      expect(scenario.verifyOutput(raw, seedA).ok).toBe(false);
    });

    it("rejects output produced for another seed", () => {
      expect(scenario.verifyOutput(c.valid(seedA), seedB).ok).toBe(false);
      // Relabelling the seed does not help: the digest still belongs to seed A.
      expect(scenario.verifyOutput(withField(c.valid(seedA), "seed", seedB), seedB).ok).toBe(false);
    });

    it("rejects a tampered digest", () => {
      expect(scenario.verifyOutput(flipDigest(c.valid(seedA)), seedA)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/digest/),
      });
    });

    it.each(Object.entries(c.tampered))("rejects tampered %s", (key, value) => {
      expect(scenario.verifyOutput(withField(c.valid(seedA), key, value), seedA).ok).toBe(false);
    });

    it("rejects non-positive and non-finite timings and unknown fields", () => {
      const valid = c.valid(seedA);

      expect(scenario.verifyOutput(withField(valid, "seconds", 0), seedA).ok).toBe(false);
      expect(scenario.verifyOutput(withField(valid, "seconds", -1), seedA).ok).toBe(false);
      expect(scenario.verifyOutput(withField(valid, "seconds", "1"), seedA).ok).toBe(false);
      expect(scenario.verifyOutput(withField(valid, "extra", 1), seedA).ok).toBe(false);
    });

    it("gives different proofs for different seeds", () => {
      const a = proofOf(scenario.verifyOutput(c.valid(seedA), seedA));
      const b = proofOf(scenario.verifyOutput(c.valid(seedB), seedB));
      const zero = proofOf(scenario.verifyOutput(c.valid(0), 0));

      expect(new Set([a, b, zero]).size).toBe(3);
    });

    const guest = c.guest;

    if (guest)
      it("accepts what the real guest program prints, for two seeds", () => {
        for (const seed of [seedA, 0xffff_ffff]) {
          const result = scenario.verifyOutput(runLocally(guest, seed), seed);

          expect(result).toMatchObject({ ok: true });
        }
      });
  });
}
