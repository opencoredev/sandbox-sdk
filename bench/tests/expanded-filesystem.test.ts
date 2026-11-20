import { describe, expect, it } from "vitest";
import {
  expectedSmallFilesDigest,
  expectedSqlite,
  expectedTarDigest,
  expectedTransferDigest,
  filesystemScenarios,
  smallFilesProgram,
  sqliteOps,
  sqliteProgram,
  tarProgram,
  tarRawBytes,
  transferFiles,
  verifySqlite,
  verifyTar,
} from "../src/expanded/filesystem.js";
import { seedA, verifierSuite, withField } from "./expanded-verifier-suite.js";

describe("filesystem scenarios", () => {
  verifierSuite(filesystemScenarios, [
    {
      id: "fs-small-files-500",
      valid: (seed) =>
        JSON.stringify({
          seed,
          fileCount: 500,
          seconds: 0.25,
          digest: expectedSmallFilesDigest(seed),
        }),
      tampered: { fileCount: 499 },
      expectedValue: 2000,
      guest: { source: smallFilesProgram, interpreter: "node" },
    },
    {
      id: "fs-sqlite-oltp",
      valid: (seed) => {
        const expected = expectedSqlite(seed);

        return JSON.stringify({
          seed,
          ops: sqliteOps,
          journalMode: "wal",
          integrityOk: true,
          aggregateSum: expected.aggregateSum,
          seconds: 0.5,
          digest: expected.digest,
        });
      },
      tampered: { ops: sqliteOps - 1, integrityOk: false, journalMode: "delete", aggregateSum: 0 },
      expectedValue: sqliteOps / 0.5,
      guest: { source: sqliteProgram, interpreter: "python3" },
    },
    {
      id: "fs-tar-extract-pack",
      valid: (seed) =>
        JSON.stringify({
          seed,
          files: 120,
          rawBytes: tarRawBytes,
          archiveBytes: 3_700_000,
          seconds: 0.25,
          digest: expectedTarDigest(seed),
        }),
      tampered: { files: 119, rawBytes: tarRawBytes - 1, archiveBytes: 0 },
      expectedValue: tarRawBytes / 1_048_576 / 0.25,
      guest: { source: tarProgram, interpreter: "node" },
    },
    {
      id: "fs-sdk-transfer-batch",
      valid: (seed) =>
        JSON.stringify({
          seed,
          fileCount: 20,
          seconds: 0.5,
          digest: expectedTransferDigest(seed),
        }),
      tampered: { fileCount: 19 },
      expectedValue: 40,
    },
  ]);

  it("reports the SQLite aggregate the guest computed from the seed", () => {
    const result = verifySqlite(
      JSON.stringify({
        seed: seedA,
        ops: sqliteOps,
        journalMode: "wal",
        integrityOk: true,
        aggregateSum: expectedSqlite(seedA).aggregateSum + 1,
        seconds: 0.5,
        digest: expectedSqlite(seedA).digest,
      }),
      seedA,
    );

    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/aggregateSum/) });
  });

  it("rejects a tar archive no smaller than the tree it packed", () => {
    const valid = JSON.stringify({
      seed: seedA,
      files: 120,
      rawBytes: tarRawBytes,
      archiveBytes: 3_700_000,
      seconds: 0.25,
      digest: expectedTarDigest(seedA),
    });

    expect(verifyTar(withField(valid, "archiveBytes", tarRawBytes), seedA).ok).toBe(false);
  });

  it("packs about 6 MiB in the tar tree", () => {
    expect(tarRawBytes).toBe(6_389_760);
  });

  it("transfers 20 files from 1 to 64 KiB, half binary", () => {
    const files = transferFiles(seedA);
    const sizes = files.map((f) => (f.kind === "text" ? Buffer.byteLength(f.data) : f.data.length));

    expect(files).toHaveLength(20);
    expect(Math.min(...sizes)).toBe(1024);
    expect(Math.max(...sizes)).toBe(65_536);
    expect(files.filter((f) => f.kind === "bytes")).toHaveLength(10);
    expect(new Set(files.map((f) => f.name)).size).toBe(20);
  });
});
