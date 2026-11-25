import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExpandedScenario } from "../src/expanded/types.js";
import type { ProjectEdit } from "../src/expanded/verify-kit.js";
import type { JsonValue } from "./expanded-verifier-suite.js";

/** A reply field a verifier reads. */
export type ReplyValue = JsonValue;

/** One verifier-contract case: a scenario, a valid reply for any seed, and edits that must fail it. */
export interface ContractCase {
  readonly scenario: ExpandedScenario;
  readonly valid: (seed: number) => Readonly<Record<string, ReplyValue>>;
  /** Field overrides on a valid reply, each of which must be rejected. */
  readonly tampered: readonly (readonly [string, ReplyValue])[];
  /** The reply field the proof must equal. */
  readonly proofField: string;
  /** The reply field the value must equal, for host-timed scenarios. */
  readonly valueField?: string;
}

export const seedA = 12_345;
export const seedB = 987_654_321;
export const seedC = 0xffff_ffff;

/** The same hex digest with its last character changed. */
export function flipHex(hex: string): string {
  return `${hex.slice(0, -1)}${hex.endsWith("0") ? "1" : "0"}`;
}

/** Register the verifier contract every expanded scenario must meet. */
export function describeContract(item: ContractCase) {
  const { scenario } = item;

  describe(`${scenario.id} verifyOutput`, () => {
    it("accepts a valid reply and returns a positive value with the digest as proof", () => {
      const reply = item.valid(seedA);
      const result = scenario.verifyOutput(JSON.stringify(reply), seedA);

      expect(result).toMatchObject({ ok: true, proof: reply[item.proofField] });

      if (!result.ok) return;

      expect(Number.isFinite(result.value) && result.value > 0).toBe(true);
      expect(result.proof.length).toBeGreaterThanOrEqual(8);

      if (item.valueField !== undefined) expect(result.value).toBe(reply[item.valueField]);
    });

    it("rejects empty, garbage and malformed replies without throwing", () => {
      const valid = item.valid(seedA);

      const bad = [
        "",
        "   \n",
        "not json",
        "{",
        JSON.stringify(valid).slice(0, -1),
        "null",
        "[]",
        "42",
        '"text"',
        "{}",
        JSON.stringify({ ...valid, seed: "12345" }),
        JSON.stringify({ ...valid, seconds: 0 }),
        JSON.stringify({ ...valid, seconds: -1 }),
        JSON.stringify({ ...valid, [item.proofField]: "abc" }),
        JSON.stringify({ ...valid, extra: 1 }),
      ];

      for (const raw of bad)
        expect(scenario.verifyOutput(raw, seedA), raw).toMatchObject({ ok: false });
    });

    it("rejects a valid reply checked against another seed", () => {
      const reply = item.valid(seedA);

      expect(scenario.verifyOutput(JSON.stringify(reply), seedB)).toMatchObject({ ok: false });
      expect(scenario.verifyOutput(JSON.stringify({ ...reply, seed: seedB }), seedB)).toMatchObject(
        { ok: false },
      );
    });

    it("rejects tampered fields", () => {
      const reply = item.valid(seedA);
      const proof = String(reply[item.proofField]);

      const edits: readonly (readonly [string, ReplyValue])[] = [
        [item.proofField, flipHex(proof)],
        ...item.tampered,
      ];

      for (const [field, value] of edits)
        expect(
          scenario.verifyOutput(JSON.stringify({ ...reply, [field]: value }), seedA),
          field,
        ).toMatchObject({
          ok: false,
        });
    });

    it("gives every seed its own proof", () => {
      const proofs = [seedA, seedB, seedC, 0].map((seed) => {
        const result = scenario.verifyOutput(JSON.stringify(item.valid(seed)), seed);

        expect(result.ok).toBe(true);

        return result.ok ? result.proof : "";
      });

      expect(new Set(proofs).size).toBe(proofs.length);
    });
  });
}

/** A fresh temporary directory holding `files` (paths relative to it). */
export function writeLocalTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "expanded-bench-"));

  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }

  return root;
}

/** Apply an edit the way `box.files.edit` does: the text must occur exactly once. */
export function applyLocalEdit(root: string, edit: ProjectEdit) {
  const path = join(root, edit.path);
  const text = readFileSync(path, "utf8");

  expect(text.split(edit.find).length - 1, `${edit.path} matches`).toBe(1);
  writeFileSync(
    path,
    text.replace(edit.find, () => edit.replace),
  );
}

/** Run a shell command in `cwd` and return its exit status and combined output. */
export function sh(command: string, cwd: string) {
  const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", timeout: 60_000 });

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    output: `${result.stdout}${result.stderr}`,
  };
}
