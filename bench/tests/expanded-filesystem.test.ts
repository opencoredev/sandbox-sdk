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
  tarStreamRange,
  transferFiles,
  verifySqlite,
  verifyTar,
} from "../src/expanded/filesystem.js";
import { honestRounds, seedA, verifierSuite, withField } from "./expanded-verifier-suite.js";

/** What the SQLite guest prints for `seed`: ten 0.125 s rounds over a 46-page WAL database file. */
function validSqlite(seed: number): string {
  const expected = expectedSqlite(seed);

  return JSON.stringify({
    seed,
    ops: sqliteOps,
    journalMode: "wal",
    integrityOk: true,
    aggregateSum: expected.aggregateSum,
    fileBytes: 46 * 4096,
    filePageCount: 46,
    filePageSize: 4096,
    fileRows: 2500,
    fileUpdatedSum: expected.updatedSum,
    fileJournalMode: "wal",
    fileIntegrityOk: true,
    rounds: honestRounds(expected.digest, 10, 0.125),
    digest: expected.digest,
  });
}

function validTar(seed: number): string {
  return JSON.stringify({
    seed,
    files: 120,
    rawBytes: tarRawBytes,
    archiveBytes: 3_700_000,
    archiveHead: "1f8b08",
    tarBytes: 6_461_440,
    rounds: honestRounds(expectedTarDigest(seed), 4, 0.25),
    digest: expectedTarDigest(seed),
  });
}

describe("filesystem scenarios", () => {
  verifierSuite(filesystemScenarios, [
    {
      id: "fs-small-files-500",
      valid: (seed) =>
        JSON.stringify({
          seed,
          fileCount: 500,
          rounds: honestRounds(expectedSmallFilesDigest(seed), 10, 0.125),
          digest: expectedSmallFilesDigest(seed),
        }),
      tampered: { fileCount: 499 },
      expectedValue: 4000,
      guest: { source: smallFilesProgram, interpreter: "node" },
      minRounds: 5,
    },
    {
      id: "fs-sqlite-oltp",
      valid: validSqlite,
      tampered: {
        ops: sqliteOps - 1,
        integrityOk: false,
        journalMode: "delete",
        aggregateSum: 0,
        fileRows: 0,
        fileUpdatedSum: 0,
        filePageCount: 0,
        filePageSize: 1000,
        fileBytes: 46 * 4096 - 1,
        fileJournalMode: "delete",
        fileIntegrityOk: false,
      },
      expectedValue: sqliteOps * 8,
      guest: { source: sqliteProgram, interpreter: "python3" },
      minRounds: 5,
    },
    {
      id: "fs-tar-extract-pack",
      valid: validTar,
      tampered: {
        files: 119,
        rawBytes: tarRawBytes - 1,
        archiveBytes: 0,
        archiveHead: "504b03",
        tarBytes: tarRawBytes,
      },
      expectedValue: (tarRawBytes * 4) / 1_000_000,
      guest: { source: tarProgram, interpreter: "node" },
      minRounds: 3,
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
    const raw = withField(
      validSqlite(seedA),
      "aggregateSum",
      expectedSqlite(seedA).aggregateSum + 1,
    );

    expect(verifySqlite(raw, seedA)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/aggregateSum/),
    });
  });

  it("rejects SQLite results without facts read back from the database file", () => {
    const expected = expectedSqlite(seedA);

    // With the file facts a fallback cannot know, each wrong one fails on its own.
    const wrong: readonly (readonly [string, number | string | boolean, RegExp])[] = [
      ["fileRows", 2499, /rows/],
      ["fileUpdatedSum", expected.updatedSum - 1, /updated rows/],
      ["filePageCount", 0, /pages/],
      ["fileBytes", 0, /bytes/],
      ["fileIntegrityOk", false, /integrity/],
    ];

    for (const [field, value, reason] of wrong)
      expect(verifySqlite(withField(validSqlite(seedA), field, value), seedA), field).toMatchObject(
        { ok: false, reason: expect.stringMatching(reason) },
      );
  });

  it("rejects a SQLite file too small to hold the table", () => {
    const tiny = withField(withField(validSqlite(seedA), "fileBytes", 4096), "filePageCount", 1);

    expect(verifySqlite(tiny, seedA)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/only/),
    });
  });

  it("rejects a tar archive no smaller than the tree it packed", () => {
    expect(verifyTar(withField(validTar(seedA), "archiveBytes", tarRawBytes), seedA).ok).toBe(
      false,
    );
  });

  it("rejects an archive whose tar stream is missing file data", () => {
    expect(
      verifyTar(withField(validTar(seedA), "tarBytes", tarStreamRange.min - 512), seedA),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/tar stream/) });
  });

  it("packs about 6.4 MB in the tar tree, and GNU tar's stream fits the range", () => {
    expect(tarRawBytes).toBe(6_389_760);
    expect(6_461_440).toBeGreaterThanOrEqual(tarStreamRange.min);
    expect(6_461_440).toBeLessThanOrEqual(tarStreamRange.max);
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
