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
import {
  honestRounds,
  seedA,
  verifierSuite,
  withField,
  withRounds,
} from "./expanded-verifier-suite.js";

/** What the SQLite guest prints for `seed`: ten 0.125 s rounds over a 46-page WAL database file. */
function validSqlite(seed: number): string {
  return JSON.stringify({
    seed,
    ops: sqliteOps,
    journalMode: "wal",
    integrityOk: true,
    fileBytes: 46 * 4096,
    filePageCount: 46,
    filePageSize: 4096,
    fileRows: 2500,
    // The file the last round left behind.
    fileUpdatedSum: expectedSqlite(seed, 9).updatedSum,
    fileJournalMode: "wal",
    fileIntegrityOk: true,
    rounds: honestRounds(
      (round) => ({
        proof: expectedSqlite(seed, round).digest,
        aggregateSum: expectedSqlite(seed, round).aggregateSum,
      }),
      10,
      0.125,
    ),
    digest: expectedSqlite(seed).digest,
  });
}

function validTar(seed: number): string {
  return JSON.stringify({
    seed,
    files: 120,
    rawBytes: tarRawBytes,
    rounds: honestRounds(
      (round) => ({
        proof: expectedTarDigest(seed, round),
        archiveBytes: 3_700_000,
        head: "1f8b08",
        tarBytes: 6_461_440,
      }),
      4,
      0.25,
    ),
    digest: expectedTarDigest(seed, 0),
  });
}

/** `raw` with round `index`'s field `key` set to `value`. */
function withRoundField(raw: string, index: number, key: string, value: number | string) {
  return withRounds(raw, (rounds) =>
    rounds.map((round, i) => (i === index ? { ...round, [key]: value } : round)),
  );
}

describe("filesystem scenarios", () => {
  verifierSuite(filesystemScenarios, [
    {
      id: "fs-small-files-500",
      valid: (seed) =>
        JSON.stringify({
          seed,
          fileCount: 500,
          rounds: honestRounds(
            (round) => ({ proof: expectedSmallFilesDigest(seed, round) }),
            10,
            0.125,
          ),
          digest: expectedSmallFilesDigest(seed, 0),
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

  it("checks each round's SQLite aggregate against that round's rows", () => {
    const raw = withRoundField(
      validSqlite(seedA),
      3,
      "aggregateSum",
      expectedSqlite(seedA, 3).aggregateSum + 1,
    );

    expect(verifySqlite(raw, seedA)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^round 3: aggregateSum/),
    });
  });

  it("rejects SQLite results without facts read back from the database file", () => {
    // With the file facts a fallback cannot know, each wrong one fails on its own.
    const wrong: readonly (readonly [string, number | string | boolean, RegExp])[] = [
      ["fileRows", 2499, /rows/],
      ["fileUpdatedSum", expectedSqlite(seedA, 9).updatedSum - 1, /updated rows/],
      // Round 0's file, not the last round's.
      ["fileUpdatedSum", expectedSqlite(seedA, 0).updatedSum, /updated rows/],
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

  it("rejects a round whose archive is no smaller than the tree it packed, or not gzip", () => {
    for (const [key, value] of [
      ["archiveBytes", tarRawBytes],
      ["archiveBytes", 0],
      ["head", "504b03"],
    ] as const)
      expect(verifyTar(withRoundField(validTar(seedA), 2, key, value), seedA), key).toMatchObject({
        ok: false,
        reason: expect.stringMatching(/^round 2: /),
      });
  });

  it("rejects a round whose tar stream is missing file data", () => {
    expect(
      verifyTar(withRoundField(validTar(seedA), 1, "tarBytes", tarStreamRange.min - 512), seedA),
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/^round 1: tar stream/) });
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
