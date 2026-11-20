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
import { roundProof } from "../src/expanded/rounds.js";
import { honestRounds, seedA, seedB, verifierSuite } from "./expanded-verifier-suite.js";

/** Rounds of 0.1, 0.2, ... 1.0 s: total 5.5 s, median 0.55 s. */
function risingRounds(digest: string) {
  return Array.from({ length: 10 }, (_, round) => ({
    seconds: (round + 1) / 10,
    proof: roundProof(round, digest),
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
          rounds: risingRounds(expectedTsDigest(seed)),
          digest: expectedTsDigest(seed),
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
          rounds: risingRounds(expectedPyDigest(seed)),
          digest: expectedPyDigest(seed),
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
          rounds: risingRounds(expectedGitDigest(seed)),
          digest: expectedGitDigest(seed),
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
          rounds: honestRounds(expectedHttpDigest(seed), 8, 0.125),
          digest: expectedHttpDigest(seed),
        }),
      tampered: { requests: 199, okCount: 199, connections: 200 },
      expectedValue: 1600,
      guest: { source: httpProgram, interpreter: "node" },
      minRounds: 5,
    },
  ]);

  it("prints a different program result for each seed", () => {
    expect(expectedTsOutput(seedA)).not.toBe(expectedTsOutput(seedB));
    expect(expectedPyOutput(seedA)).not.toBe(expectedPyOutput(seedB));
    expect(expectedTsOutput(seedA)).toMatch(/^\{"acc":\d+,"samples":\[(\d+,){4}\d+\]\}$/);
  });
});
