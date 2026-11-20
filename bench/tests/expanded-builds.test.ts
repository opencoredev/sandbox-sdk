import { describe, expect, it } from "vitest";
import {
  buildScenarios,
  expectedGitDigest,
  expectedHttpDigest,
  expectedPyDigest,
  expectedPyOutput,
  expectedTsDigest,
  expectedTsOutput,
  gitProgram,
  httpProgram,
  pyBytecodeProgram,
  tsBundleProgram,
} from "../src/expanded/builds.js";
import { honestRounds, seedA, seedB, verifierSuite } from "./expanded-verifier-suite.js";

/** Rounds of 0.1, 0.2, ... 1.0 s, round `i` proving `digest(seed, i)`: total 5.5 s, median 0.55 s. */
function risingRounds(seed: number, digest: (seed: number, round: number) => string) {
  return Array.from({ length: 10 }, (_, round) => ({
    seconds: (round + 1) / 10,
    proof: digest(seed, round),
  }));
}

describe("build scenarios", () => {
  verifierSuite(buildScenarios, [
    {
      id: "build-ts-strip-bundle",
      valid: (seed) =>
        JSON.stringify({
          seed,
          moduleCount: 30,
          bundleBytes: 17_000,
          rounds: risingRounds(seed, expectedTsDigest),
          digest: expectedTsDigest(seed, 0),
        }),
      tampered: { moduleCount: 29, bundleBytes: 0 },
      expectedValue: 0.55,
      guest: { source: tsBundleProgram, interpreter: "node" },
      minRounds: 5,
    },
    {
      id: "build-python-bytecode",
      valid: (seed) =>
        JSON.stringify({
          seed,
          modulesCompiled: 60,
          rounds: risingRounds(seed, expectedPyDigest),
          digest: expectedPyDigest(seed, 0),
        }),
      tampered: { modulesCompiled: 59 },
      expectedValue: 0.55,
      guest: { source: pyBytecodeProgram, interpreter: "python3" },
      minRounds: 5,
    },
    {
      id: "build-git-workflow",
      valid: (seed) =>
        JSON.stringify({
          seed,
          commitCount: 22,
          logLines: 22,
          diffFiles: 4,
          trackedFiles: 7,
          clean: true,
          rounds: risingRounds(seed, expectedGitDigest),
          digest: expectedGitDigest(seed, 0),
        }),
      tampered: { commitCount: 21, logLines: 21, diffFiles: 3, trackedFiles: 8, clean: false },
      expectedValue: 0.55,
      guest: { source: gitProgram, interpreter: "node" },
      minRounds: 5,
    },
    {
      id: "build-http-server-load",
      valid: (seed) =>
        JSON.stringify({
          seed,
          requests: 200,
          okCount: 200,
          connections: 50,
          rounds: honestRounds((round) => ({ proof: expectedHttpDigest(seed, round) }), 8, 0.125),
          digest: expectedHttpDigest(seed, 0),
        }),
      tampered: { requests: 199, okCount: 199, connections: 200 },
      expectedValue: 1600,
      guest: { source: httpProgram, interpreter: "node" },
      minRounds: 5,
    },
  ]);

  it("prints a different program result for each seed and each round", () => {
    expect(expectedTsOutput(seedA)).not.toBe(expectedTsOutput(seedB));
    expect(expectedPyOutput(seedA)).not.toBe(expectedPyOutput(seedB));
    expect(expectedTsOutput(seedA, 1)).not.toBe(expectedTsOutput(seedA, 0));
    expect(expectedPyOutput(seedA, 1)).not.toBe(expectedPyOutput(seedA, 0));
    expect(expectedTsOutput(seedA)).toMatch(/^\{"acc":\d+,"samples":\[(\d+,){4}\d+\]\}$/);
  });
});
