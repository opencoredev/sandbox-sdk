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
import { roundProof } from "../src/expanded/rounds.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { describeContract, flipHex, seedA, seedB } from "./expanded-contract.js";
import { honestRounds } from "./expanded-verifier-suite.js";

/** Three rounds over two seconds, the first impossibly fast: the rate bound must reject it. */
function implausibleRounds(digest: string) {
  return [1e-9, 1, 1].map((seconds, round) => ({ seconds, proof: roundProof(round, digest) }));
}

/** Four 0.25 s rounds of `digest`. */
const fourRounds = (digest: string) => honestRounds(digest, 4, 0.25);

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

  it("derives a seed-dependent sieve limit in the documented range", () => {
    expect(sieveLimit(0)).toBe(32_000_000);
    expect(sieveLimit(seedA)).toBe(32_000_000 + seedA);
    expect(sieveLimit(0xffff_ffff)).toBeLessThan(40_000_000);
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
    rounds: fourRounds(expectedSha256Digest(seed)),
    digest: expectedSha256Digest(seed),
  }),
  tampered: [
    ["bytes", sha256TotalBytes / 2],
    ["rounds", implausibleRounds(expectedSha256Digest(seedA))],
    ["rounds", honestRounds(expectedSha256Digest(seedA), 2, 1)],
    ["rounds", honestRounds(expectedSha256Digest(seedA), 4, 0.2)],
  ],
  proofField: "digest",
});

/** A gzip reply for `seed` at zlib level 6's ratio of 0.223. */
function validGzip(seed: number) {
  return {
    seed,
    rawBytes: expectedGzipRawBytes(seed),
    compressedBytes: Math.floor(expectedGzipRawBytes(seed) * 0.223),
    gzipHead: gzipMagic,
    gzipTrailer: expectedGzipTrailer(seed),
    rounds: fourRounds(expectedGzipDigest(seed)),
    digest: expectedGzipDigest(seed),
  };
}

describeContract({
  scenario: scenario("cpu-gzip-compress"),
  valid: validGzip,
  tampered: [
    ["rawBytes", expectedGzipRawBytes(seedA) - 1],
    ["compressedBytes", expectedGzipRawBytes(seedA)],
    ["compressedBytes", 0],
    ["compressedBytes", 1],
    ["gzipHead", "000000"],
    ["gzipTrailer", flipHex(expectedGzipTrailer(seedA))],
    ["gzipTrailer", expectedGzipTrailer(seedB)],
    ["rounds", implausibleRounds(expectedGzipDigest(seedA))],
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
    limit: sieveLimit(seed),
    count: expectedSieve(seed).count,
    rounds: fourRounds(expectedSieve(seed).digest),
    digest: expectedSieve(seed).digest,
  }),
  tampered: [
    ["limit", sieveLimit(seedA) + 1],
    ["count", expectedSieve(seedA).count + 1],
    ["rounds", implausibleRounds(expectedSieve(seedA).digest)],
  ],
  proofField: "digest",
});

describe("cpu verifiers ask for evidence only the work produces", () => {
  const verifyGzip = scenario("cpu-gzip-compress").verifyOutput;

  it("gzip: the roundtrip hash with an uncompressed or truncated size fails on the ratio", () => {
    for (const compressedBytes of [1, expectedGzipRawBytes(seedA) + 18])
      expect(
        verifyGzip(JSON.stringify({ ...validGzip(seedA), compressedBytes }), seedA),
      ).toMatchObject({ ok: false, reason: expect.stringMatching(/ratio/) });
  });

  it("gzip: a trailer that is not the corpus's CRC-32 and length fails", () => {
    expect(
      verifyGzip(JSON.stringify({ ...validGzip(seedA), gzipTrailer: "0".repeat(16) }), seedA),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/CRC-32/) });
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
