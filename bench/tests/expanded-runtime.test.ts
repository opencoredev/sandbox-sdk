import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/expanded/guest-kit.js";
import {
  envInputs,
  expectedEnvDigest,
  expectedMemDigest,
  expectedSpawnDigest,
  expectedStream,
  expectedStreamRound,
  memProgram,
  runtimeScenarios,
  spawnProgram,
  verifySpawn,
} from "../src/expanded/runtime.js";
import { honestRounds, seedA, verifierSuite, withField } from "./expanded-verifier-suite.js";

const mebibyte = 1_048_576;

/** Every round streams a 70-byte salt line before the uploaded lines. */
const streamBytes = expectedStreamRound(seedA, 0).length;

/** 100 distinct child pids per round, none of them the parent's (pid 7). */
function childPids(rounds: number): number[][] {
  return Array.from({ length: rounds }, (_, round) =>
    Array.from({ length: 100 }, (_, i) => 1000 + round * 100 + i),
  );
}

function validSpawn(seed: number): string {
  return JSON.stringify({
    seed,
    spawns: 100,
    parentPid: 7,
    childPids: childPids(4),
    rounds: honestRounds((round) => ({ proof: expectedSpawnDigest(seed, round) }), 4, 0.25),
    digest: expectedSpawnDigest(seed),
  });
}

describe("runtime scenarios", () => {
  verifierSuite(runtimeScenarios, [
    {
      id: "runtime-mem-alloc-128m",
      valid: (seed) =>
        JSON.stringify({
          seed,
          bytes: 128 * mebibyte,
          rssBytes: 180 * mebibyte,
          rounds: honestRounds((round) => ({ proof: expectedMemDigest(seed, round) }), 4, 0.25),
          digest: expectedMemDigest(seed),
        }),
      tampered: { bytes: 64 * mebibyte, rssBytes: mebibyte },
      expectedValue: (128 * mebibyte * 4) / 1_000_000,
      guest: { source: memProgram, interpreter: "node" },
      minRounds: 3,
    },
    {
      id: "runtime-fork-spawn-100",
      valid: validSpawn,
      tampered: { spawns: 99, parentPid: 1000 },
      expectedValue: 400,
      guest: { source: spawnProgram, interpreter: "node" },
      minRounds: 3,
    },
    {
      id: "runtime-stdout-stream",
      valid: (seed) =>
        JSON.stringify({
          seed,
          lines: 7501,
          bytes: expectedStreamRound(seed, 0).length,
          rounds: honestRounds(
            (round) => ({ proof: sha256Hex(expectedStreamRound(seed, round)) }),
            4,
            0.25,
          ),
          digest: sha256Hex(expectedStreamRound(seed, 0)),
        }),
      tampered: { lines: 7500, bytes: streamBytes - 1 },
      expectedValue: (streamBytes * 4) / 1_000_000,
      minRounds: 3,
    },
    {
      id: "runtime-env-isolation",
      valid: (seed) =>
        JSON.stringify({ seed, checksPassed: 4, seconds: 0.5, digest: expectedEnvDigest(seed) }),
      tampered: { checksPassed: 3 },
      expectedValue: 0.5,
    },
  ]);

  it("rejects child pids that are missing, shared or the parent's", () => {
    const reusedPid = childPids(4).map((pids) => pids.map(() => 4242));

    const withParent = childPids(4).map((pids, round) =>
      round === 2 ? [7, ...pids.slice(1)] : pids,
    );

    const short = childPids(4).map((pids, round) => (round === 0 ? pids.slice(1) : pids));

    const wrong: readonly (readonly [string, number[][], RegExp])[] = [
      ["one pid for every child", reusedPid, /distinct child pids/],
      ["a child with the parent's pid", withParent, /parent's pid/],
      ["99 children in a round", short, /distinct child pids/],
      ["pids for only three of four rounds", childPids(3), /rounds/],
    ];

    for (const [name, pids, reason] of wrong)
      expect(
        verifySpawn(withField(validSpawn(seedA), "childPids", pids), seedA),
        name,
      ).toMatchObject({
        ok: false,
        reason: expect.stringMatching(reason),
      });
  });

  it("streams about 0.5 MB, well under the SDK's 1 MiB stdout cap", () => {
    const stream = expectedStream(seedA);

    expect(Buffer.byteLength(stream)).toBe(stream.length);
    expect(stream.length).toBeGreaterThan(500_000);
    expect(stream.length).toBeLessThan(0.6 * mebibyte);
    expect(stream.split("\n")).toHaveLength(7501);
  });

  it("sends every byte value and multibyte UTF-8 through the file checks", () => {
    const inputs = envInputs(seedA);

    expect(new Set(inputs.binary).size).toBe(256);
    expect(Buffer.byteLength(inputs.text)).toBeGreaterThan(inputs.text.length);
    expect(inputs.token).toContain("$HOME");
    expect(inputs.cwd.startsWith("/workspace/bench-env/")).toBe(true);
  });
});
