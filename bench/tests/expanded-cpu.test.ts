import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cpuScenarios,
  expectedGzipDigest,
  expectedGzipRawBytes,
  expectedGzipTrailer,
  expectedJsonBytes,
  expectedJsonChecksum,
  expectedSha256Digest,
  expectedSieve,
  gzipGuestScript,
  gzipMagic,
  jsonDocument,
  jsonGuestScript,
  jsonIterations,
  sha256GuestScript,
  sha256TotalBytes,
  sieveGuestScript,
  sieveLimit,
} from "../src/expanded/cpu.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { describeContract, flipHex, seedA, seedB } from "./expanded-contract.js";
import {
  honestRounds,
  reusedRounds,
  type JsonValue,
  type RoundRecord,
} from "./expanded-verifier-suite.js";

/** What round `round` of a scenario reports. */
type Evidence = (round: number) => Readonly<Record<string, JsonValue>>;

/** Three rounds over two seconds, the first impossibly fast: the rate bound must reject it. */
function implausibleRounds(evidence: Evidence) {
  return [1e-9, 1, 1].map((seconds, round) => ({ ...evidence(round), seconds }));
}

/** Four 0.25 s rounds, each with its own round's evidence. */
const fourRounds = (evidence: Evidence) => honestRounds(evidence, 4, 0.25);

/** `rounds` with round `index` changed by `edit`. */
function editRound(
  rounds: readonly RoundRecord[],
  index: number,
  edit: Readonly<Record<string, JsonValue>>,
): RoundRecord[] {
  return rounds.map((round, i) => (i === index ? { ...round, ...edit } : round));
}

/** Each SHA-256 round hashes 256 MiB here too, so its fixtures use the minimum of three rounds. */
const shaEvidence =
  (seed: number): Evidence =>
  (round) => ({ proof: expectedSha256Digest(seed, round) });

const shaRounds = (seed: number) => honestRounds(shaEvidence(seed), 3, 0.4);

const gzipEvidence =
  (seed: number): Evidence =>
  (round) => ({
    proof: expectedGzipDigest(seed, round),
    compressedBytes: Math.floor(expectedGzipRawBytes(seed) * 0.223),
    head: gzipMagic,
    trailer: expectedGzipTrailer(seed, round),
  });

const sieveEvidence =
  (seed: number): Evidence =>
  (round) => ({
    proof: expectedSieve(seed, round).digest,
    limit: expectedSieve(seed, round).limit,
    count: expectedSieve(seed, round).count,
  });

function scenario(id: string): ExpandedScenario {
  const found = cpuScenarios.find((s) => s.id === id);

  if (found === undefined) throw new Error(`missing scenario ${id}`);

  return found;
}

describe("cpu scenarios", () => {
  it("registers four higher-is-better CPU scenarios", () => {
    expect(cpuScenarios.map((s) => [s.id, s.category, s.unit, s.better])).toEqual([
      ["cpu-sha256-hash", "cpu", "MB/s", "higher"],
      ["cpu-gzip-compress", "cpu", "MB/s", "higher"],
      ["cpu-json-parse", "cpu", "ops/s", "higher"],
      ["cpu-prime-sieve", "cpu", "ops/s", "higher"],
    ]);
  });

  it("derives a seed-dependent sieve limit in the documented range, different every round", () => {
    expect(sieveLimit(0)).toBe(32_000_000);
    expect(sieveLimit(seedA)).toBe(32_000_000 + seedA);
    expect(sieveLimit(0xffff_ffff)).toBeLessThan(40_000_000);

    const limits = Array.from({ length: 5000 }, (_, round) => sieveLimit(0xffff_ffff, round));

    expect(new Set(limits).size).toBe(5000);
    expect(Math.min(...limits)).toBeGreaterThanOrEqual(32_000_000);
    expect(Math.max(...limits)).toBeLessThan(40_000_000);
  });

  it("builds a JSON document of about 1 MiB", () => {
    expect(jsonDocument(seedA).length).toBeGreaterThan(900_000);
    expect(expectedJsonBytes(seedA)).toBe(jsonDocument(seedA).length);
    expect(jsonDocument(seedA)).not.toBe(jsonDocument(seedB));
  });
});

describeContract({
  scenario: scenario("cpu-sha256-hash"),
  valid: (seed) => ({
    seed,
    bytes: sha256TotalBytes,
    rounds: shaRounds(seed),
    digest: expectedSha256Digest(seed, 0),
  }),
  tampered: [
    ["bytes", sha256TotalBytes / 2],
    ["rounds", implausibleRounds(shaEvidence(seedA))],
    ["rounds", honestRounds(shaEvidence(seedA), 2, 1)],
    ["rounds", honestRounds(shaEvidence(seedA), 4, 0.2)],
    ["rounds", reusedRounds(shaRounds(seedA))],
  ],
  proofField: "digest",
});

const gzipTrailerA = (round: number) => expectedGzipTrailer(seedA, round);

/** A gzip reply for `seed` at zlib level 6's ratio of 0.223. */
function validGzip(seed: number) {
  return {
    seed,
    rawBytes: expectedGzipRawBytes(seed),
    rounds: fourRounds(gzipEvidence(seed)),
    digest: expectedGzipDigest(seed),
  };
}

describeContract({
  scenario: scenario("cpu-gzip-compress"),
  valid: validGzip,
  tampered: [
    ["rawBytes", expectedGzipRawBytes(seedA) - 1],
    ["rounds", editRound(validGzip(seedA).rounds, 1, { compressedBytes: 0 })],
    ["rounds", editRound(validGzip(seedA).rounds, 1, { head: "000000" })],
    ["rounds", editRound(validGzip(seedA).rounds, 2, { trailer: flipHex(gzipTrailerA(2)) })],
    ["rounds", editRound(validGzip(seedA).rounds, 0, { trailer: expectedGzipTrailer(seedB) })],
    ["rounds", reusedRounds(validGzip(seedA).rounds)],
    ["rounds", implausibleRounds(gzipEvidence(seedA))],
  ],
  proofField: "digest",
});

describeContract({
  scenario: scenario("cpu-json-parse"),
  valid: (seed) => ({
    seed,
    iterations: jsonIterations,
    bytes: expectedJsonBytes(seed),
    seconds: 0.5,
    checksum: expectedJsonChecksum(seed),
  }),
  tampered: [
    ["iterations", jsonIterations - 1],
    ["seconds", 1e-9],
    ["bytes", expectedJsonBytes(seedA) - 1],
    ["bytes", expectedJsonBytes(seedA) + 1],
  ],
  proofField: "checksum",
});

describeContract({
  scenario: scenario("cpu-prime-sieve"),
  valid: (seed) => ({
    seed,
    rounds: fourRounds(sieveEvidence(seed)),
    digest: expectedSieve(seed, 0).digest,
  }),
  tampered: [
    ["rounds", editRound(fourRounds(sieveEvidence(seedA)), 1, { limit: sieveLimit(seedA, 1) + 1 })],
    [
      "rounds",
      editRound(fourRounds(sieveEvidence(seedA)), 2, {
        count: expectedSieve(seedA, 2).count + 1,
      }),
    ],
    ["rounds", reusedRounds(fourRounds(sieveEvidence(seedA)))],
    ["rounds", implausibleRounds(sieveEvidence(seedA))],
  ],
  proofField: "digest",
});

describe("cpu verifiers ask for evidence only the work produces", () => {
  const verifyGzip = scenario("cpu-gzip-compress").verifyOutput;

  it("gzip: the roundtrip hash with an uncompressed or truncated size fails on the ratio", () => {
    for (const compressedBytes of [1, expectedGzipRawBytes(seedA) + 18]) {
      const rounds = editRound(validGzip(seedA).rounds, 1, { compressedBytes });

      expect(verifyGzip(JSON.stringify({ ...validGzip(seedA), rounds }), seedA)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^round 1: compression ratio/),
      });
    }
  });

  it("gzip: a trailer that is not the round's corpus's CRC-32 and length fails", () => {
    const zero = editRound(validGzip(seedA).rounds, 2, { trailer: "0".repeat(16) });
    // Round 0's trailer in round 2: the CRC-32 of another corpus.
    const reused = editRound(validGzip(seedA).rounds, 2, { trailer: gzipTrailerA(0) });

    for (const rounds of [zero, reused])
      expect(verifyGzip(JSON.stringify({ ...validGzip(seedA), rounds }), seedA)).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^round 2: .*CRC-32/),
      });
  });

  it("gzip: every round's corpus, and so its CRC-32 and digest, is its own", () => {
    const trailers = new Set([0, 1, 2, 3].map(gzipTrailerA));
    const digests = new Set([0, 1, 2, 3].map((round) => expectedGzipDigest(seedA, round)));

    expect(trailers.size).toBe(4);
    expect(digests.size).toBe(4);
  });

  it("json: the document size must be exact", () => {
    const raw = JSON.stringify({
      seed: seedA,
      iterations: jsonIterations,
      bytes: 1,
      seconds: 0.5,
      checksum: expectedJsonChecksum(seedA),
    });

    expect(scenario("cpu-json-parse").verifyOutput(raw, seedA)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/bytes/),
    });
  });
});

describe("cpu guest scripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "expanded-cpu-"));

  const scripts = [
    ["cpu-sha256-hash", sha256GuestScript],
    ["cpu-gzip-compress", gzipGuestScript],
    ["cpu-json-parse", jsonGuestScript],
    ["cpu-prime-sieve", sieveGuestScript],
  ] as const;

  for (const [id, source] of scripts)
    it(`${id}: the guest script's real output passes verification`, { timeout: 30_000 }, () => {
      const path = join(dir, `${id}.mjs`);
      writeFileSync(path, source);
      const seed = 424_242;
      const run = spawnSync("node", [path, String(seed)], { encoding: "utf8", timeout: 30_000 });

      expect(run.status, run.stderr).toBe(0);

      const verdict = scenario(id).verifyOutput(run.stdout, seed);

      expect(verdict).toMatchObject({ ok: true });
      expect(scenario(id).verifyOutput(run.stdout, seed + 1)).toMatchObject({ ok: false });
    });
});
