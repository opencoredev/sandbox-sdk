import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/expanded/guest-kit.js";
import {
  envInputs,
  expectedEnvDigest,
  expectedMemDigest,
  expectedSpawnDigest,
  expectedStream,
  memProgram,
  runtimeScenarios,
  spawnProgram,
} from "../src/expanded/runtime.js";
import { seedA, verifierSuite } from "./expanded-verifier-suite.js";

const mebibyte = 1_048_576;
const streamBytes = expectedStream(seedA).length;

describe("runtime scenarios", () => {
  verifierSuite(runtimeScenarios, [
    {
      id: "runtime-mem-alloc-128m",
      valid: (seed) =>
        JSON.stringify({
          seed,
          bytes: 128 * mebibyte,
          rssBytes: 180 * mebibyte,
          seconds: 0.5,
          digest: expectedMemDigest(seed),
        }),
      tampered: { bytes: 64 * mebibyte, rssBytes: mebibyte },
      expectedValue: 256,
      guest: { source: memProgram, interpreter: "node" },
    },
    {
      id: "runtime-fork-spawn-100",
      valid: (seed) =>
        JSON.stringify({ seed, spawns: 100, seconds: 0.5, digest: expectedSpawnDigest(seed) }),
      tampered: { spawns: 99 },
      expectedValue: 200,
      guest: { source: spawnProgram, interpreter: "node" },
    },
    {
      id: "runtime-stdout-stream",
      valid: (seed) =>
        JSON.stringify({
          seed,
          lines: 7500,
          bytes: expectedStream(seed).length,
          seconds: 0.5,
          digest: sha256Hex(expectedStream(seed)),
        }),
      tampered: { lines: 7499, bytes: streamBytes - 1 },
      expectedValue: streamBytes / mebibyte / 0.5,
    },
    {
      id: "runtime-env-isolation",
      valid: (seed) =>
        JSON.stringify({ seed, checksPassed: 4, seconds: 0.5, digest: expectedEnvDigest(seed) }),
      tampered: { checksPassed: 3 },
      expectedValue: 0.5,
    },
  ]);

  it("streams about 512 KiB, well under the SDK's 1 MiB stdout cap", () => {
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
