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
import { minTimedSeconds, roundProof, type Round } from "../src/expanded/rounds.js";
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

/** `count` rounds that each produced `digest` in `secondsEach`, as an honest guest reports them. */
export function honestRounds(digest: string, count: number, secondsEach: number): Round[] {
  return Array.from({ length: count }, (_, round) => ({
    seconds: secondsEach,
    proof: roundProof(round, digest),
  }));
}

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
  /** The minimum round count, for scenarios that repeat their work in timed rounds. */
  readonly minRounds?: number;
}

const jsonValue = z.json();

/** Any JSON value a reply field can hold. */
export type JsonValue = z.infer<typeof jsonValue>;

const payload = z.record(z.string(), jsonValue);

const roundsPayload = z.looseObject({
  digest: z.string(),
  rounds: z.array(z.object({ seconds: z.number(), proof: z.string() })),
});

/** `raw` with one top-level field replaced. */
export function withField(raw: string, key: string, value: JsonValue): string {
  return JSON.stringify({ ...payload.parse(JSON.parse(raw)), [key]: value });
}

/** `raw` with its rounds replaced by `edit(rounds, digest)`. */
function withRounds(
  raw: string,
  edit: (rounds: readonly Round[], digest: string) => readonly Round[],
): string {
  const parsed = roundsPayload.parse(JSON.parse(raw));

  return JSON.stringify({ ...parsed, rounds: edit(parsed.rounds, parsed.digest) });
}

/** `raw` with its timing set to `value`: the top-level `seconds`, or the first round's. */
function withTiming(raw: string, value: number | string): string {
  const parsed = payload.parse(JSON.parse(raw));

  if ("seconds" in parsed) return withField(raw, "seconds", value);

  const rounds = roundsPayload.parse(parsed).rounds;

  return JSON.stringify({
    ...parsed,
    rounds: [{ ...rounds[0], seconds: value }, ...rounds.slice(1)],
  });
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

      expect(scenario.verifyOutput(withTiming(valid, 0), seedA).ok).toBe(false);
      expect(scenario.verifyOutput(withTiming(valid, -1), seedA).ok).toBe(false);
      expect(scenario.verifyOutput(withTiming(valid, "1"), seedA).ok).toBe(false);
      expect(scenario.verifyOutput(withField(valid, "extra", 1), seedA).ok).toBe(false);
    });

    const minRounds = c.minRounds;

    if (minRounds !== undefined)
      describe("timed rounds", () => {
        const verify = (raw: string) => scenario.verifyOutput(raw, seedA);
        const valid = () => c.valid(seedA);

        it("rejects fewer than the minimum rounds, even over a full window", () => {
          const raw = withRounds(valid(), (_, digest) =>
            honestRounds(digest, minRounds - 1, minTimedSeconds),
          );

          expect(verify(raw)).toMatchObject({ ok: false, reason: expect.stringMatching(/rounds/) });
        });

        it("rejects a timed window shorter than the minimum", () => {
          const raw = withRounds(valid(), (_, digest) =>
            honestRounds(digest, minRounds, (minTimedSeconds * 0.9) / minRounds),
          );

          expect(verify(raw)).toMatchObject({ ok: false, reason: expect.stringMatching(/timed/) });
        });

        it("rejects a round whose proof is for another digest or another round", () => {
          const otherDigest = withRounds(valid(), (rounds) =>
            rounds.map((round, i) =>
              i === 1 ? { ...round, proof: roundProof(1, "0".repeat(64)) } : round,
            ),
          );

          const reused = withRounds(valid(), (rounds) =>
            rounds.map((round) => ({ ...round, proof: rounds[0]?.proof ?? "" })),
          );

          expect(verify(otherDigest)).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/round 1 proof/),
          });
          expect(verify(reused)).toMatchObject({
            ok: false,
            reason: expect.stringMatching(/proof/),
          });
        });
      });

    it("gives different proofs for different seeds", () => {
      const a = proofOf(scenario.verifyOutput(c.valid(seedA), seedA));
      const b = proofOf(scenario.verifyOutput(c.valid(seedB), seedB));
      const zero = proofOf(scenario.verifyOutput(c.valid(0), 0));

      expect(new Set([a, b, zero]).size).toBe(3);
    });

    const guest = c.guest;

    if (guest)
      // Each run fills at least a one-second timed window, so two take a few seconds.
      it("accepts what the real guest program prints, for two seeds", { timeout: 30_000 }, () => {
        for (const seed of [seedA, 0xffff_ffff]) {
          const result = scenario.verifyOutput(runLocally(guest, seed), seed);

          expect(result).toMatchObject({ ok: true });
        }
      });
  });
}
