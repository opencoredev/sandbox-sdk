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
import { seedA, seedB, verifierSuite } from "./expanded-verifier-suite.js";

describe("build scenarios", () => {
  verifierSuite(buildScenarios, [
    {
      id: "build-ts-strip-bundle",
      valid: (seed) =>
        JSON.stringify({
          seed,
          moduleCount: 30,
          bundleBytes: 17_000,
          seconds: 0.5,
          digest: expectedTsDigest(seed),
        }),
      tampered: { moduleCount: 29, bundleBytes: 0 },
      expectedValue: 0.5,
      guest: { source: tsBundleProgram, interpreter: "node" },
    },
    {
      id: "build-python-bytecode",
      valid: (seed) =>
        JSON.stringify({ seed, modulesCompiled: 60, seconds: 0.5, digest: expectedPyDigest(seed) }),
      tampered: { modulesCompiled: 59 },
      expectedValue: 0.5,
      guest: { source: pyBytecodeProgram, interpreter: "python3" },
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
          seconds: 0.5,
          digest: expectedGitDigest(seed),
        }),
      tampered: { commitCount: 21, logLines: 21, diffFiles: 3, trackedFiles: 8, clean: false },
      expectedValue: 0.5,
      guest: { source: gitProgram, interpreter: "node" },
    },
    {
      id: "build-http-server-load",
      valid: (seed) =>
        JSON.stringify({
          seed,
          requests: 200,
          okCount: 200,
          connections: 50,
          seconds: 0.5,
          digest: expectedHttpDigest(seed),
        }),
      tampered: { requests: 199, okCount: 199, connections: 200 },
      expectedValue: 400,
      guest: { source: httpProgram, interpreter: "node" },
    },
  ]);

  it("prints a different program result for each seed", () => {
    expect(expectedTsOutput(seedA)).not.toBe(expectedTsOutput(seedB));
    expect(expectedPyOutput(seedA)).not.toBe(expectedPyOutput(seedB));
    expect(expectedTsOutput(seedA)).toMatch(/^\{"acc":\d+,"samples":\[(\d+,){4}\d+\]\}$/);
  });
});
