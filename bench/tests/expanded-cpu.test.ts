import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cpuScenarios,
  expectedGzipDigest,
  expectedGzipRawBytes,
  expectedJsonChecksum,
  expectedSha256Digest,
  expectedSieve,
  gzipGuestScript,
  jsonDocument,
  jsonGuestScript,
  jsonIterations,
  sha256GuestScript,
  sha256TotalBytes,
  sieveGuestScript,
  sieveLimit,
} from "../src/expanded/cpu.js";
import type { ExpandedScenario } from "../src/expanded/types.js";
import { describeContract, seedA, seedB } from "./expanded-contract.js";

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
    expect(jsonDocument(seedA)).not.toBe(jsonDocument(seedB));
  });
});

describeContract({
  scenario: scenario("cpu-sha256-hash"),
  valid: (seed) => ({
    seed,
    bytes: sha256TotalBytes,
    seconds: 0.25,
    digest: expectedSha256Digest(seed),
  }),
  tampered: [
    ["bytes", sha256TotalBytes / 2],
    ["seconds", 1e-9],
  ],
  proofField: "digest",
});

describeContract({
  scenario: scenario("cpu-gzip-compress"),
  valid: (seed) => ({
    seed,
    rawBytes: expectedGzipRawBytes(seed),
    compressedBytes: Math.floor(expectedGzipRawBytes(seed) / 6),
    seconds: 0.4,
    digest: expectedGzipDigest(seed),
  }),
  tampered: [
    ["rawBytes", expectedGzipRawBytes(seedA) - 1],
    ["compressedBytes", expectedGzipRawBytes(seedA)],
    ["compressedBytes", 0],
    ["seconds", 1e-9],
  ],
  proofField: "digest",
});

describeContract({
  scenario: scenario("cpu-json-parse"),
  valid: (seed) => ({
    seed,
    iterations: jsonIterations,
    bytes: jsonDocument(seed).length,
    seconds: 0.5,
    checksum: expectedJsonChecksum(seed),
  }),
  tampered: [
    ["iterations", jsonIterations - 1],
    ["seconds", 1e-9],
  ],
  proofField: "checksum",
});

describeContract({
  scenario: scenario("cpu-prime-sieve"),
  valid: (seed) => ({
    seed,
    limit: sieveLimit(seed),
    count: expectedSieve(seed).count,
    seconds: 0.2,
    digest: expectedSieve(seed).digest,
  }),
  tampered: [
    ["limit", sieveLimit(seedA) + 1],
    ["count", expectedSieve(seedA).count + 1],
    ["seconds", 1e-9],
  ],
  proofField: "digest",
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
