/**
 * Replies the first verifiers accepted although the work had not run, or had run less than
 * claimed. Each is the reply that version accepted, so every test here failed against it. The
 * scenario test files check the new evidence field by field.
 *
 * This file imports only exports that version also had, so it can run against it unchanged.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cpuScenarios,
  expectedGzipDigest,
  expectedGzipRawBytes,
  expectedJsonChecksum,
  jsonGuestScript,
  jsonIterations,
} from "../src/expanded/cpu.js";
import { expectedSqlite, sqliteOps, verifySqlite } from "../src/expanded/filesystem.js";
import { expectedSpawnDigest, verifySpawn } from "../src/expanded/runtime.js";

const seed = 12_345;

function verifier(id: string) {
  const found = cpuScenarios.find((s) => s.id === id);

  if (found === undefined) throw new Error(`missing scenario ${id}`);

  return found.verifyOutput;
}

/** What the JSON guest prints when it runs `source` instead of the real script. */
function jsonReply(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), "expanded-bypass-"));

  try {
    const path = join(dir, "json.mjs");
    writeFileSync(path, source);
    const run = spawnSync("node", [path, String(seed)], { encoding: "utf8", timeout: 30_000 });

    if (run.status !== 0) throw new Error(`json guest exited ${run.status}: ${run.stderr}`);

    return run.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What the JSON guest prints when every iteration walks from the same start, so one walk could
 * stand in for all 40. That was the guest before each walk started from its iteration.
 */
function sameWalkReply(): string {
  return jsonReply(
    jsonGuestScript.replace("walk(mix(0x811c9dc5, i), doc)", "walk(0x811c9dc5, doc)"),
  );
}

/** The JSON guest with `pattern` rewritten, failing loudly if the script no longer has it. */
function onceReply(pattern: RegExp, replacement: string): string {
  if (!pattern.test(jsonGuestScript)) throw new Error(`json guest has no ${pattern}`);

  return jsonReply(jsonGuestScript.replace(pattern, replacement));
}

describe("expanded verifiers reject replies that skip the work", () => {
  it("gzip: the corpus hash with a 1-byte compressed size", () => {
    const raw = JSON.stringify({
      seed,
      rawBytes: expectedGzipRawBytes(seed),
      compressedBytes: 1,
      seconds: 0.4,
      digest: expectedGzipDigest(seed),
    });

    expect(verifier("cpu-gzip-compress")(raw, seed).ok).toBe(false);
  });

  it("SQLite: the seed's expected results with no database behind them", () => {
    const expected = expectedSqlite(seed);

    const raw = JSON.stringify({
      seed,
      ops: sqliteOps,
      journalMode: "wal",
      integrityOk: true,
      aggregateSum: expected.aggregateSum,
      seconds: 0.5,
      digest: expected.digest,
    });

    expect(verifySqlite(raw, seed).ok).toBe(false);
  });

  it("spawn: the seed's tokens with no child processes", () => {
    const raw = JSON.stringify({
      seed,
      spawns: 100,
      seconds: 0.5,
      digest: expectedSpawnDigest(seed),
    });

    expect(verifySpawn(raw, seed).ok).toBe(false);
  });

  it("JSON: the right checksum with the wrong document size", () => {
    const raw = JSON.stringify({
      seed,
      iterations: jsonIterations,
      bytes: 1,
      seconds: 0.5,
      checksum: expectedJsonChecksum(seed),
    });

    expect(verifier("cpu-json-parse")(raw, seed).ok).toBe(false);
  });

  it("JSON: one walk reused for all 40 iterations", { timeout: 30_000 }, () => {
    expect(verifier("cpu-json-parse")(sameWalkReply(), seed).ok).toBe(false);
  });

  it("JSON: one parse reused for all 40 iterations", { timeout: 30_000 }, () => {
    const raw = onceReply(/JSON\.parse\(([^)]*)\)/, "(globalThis.parsedOnce ??= JSON.parse($1))");

    expect(verifier("cpu-json-parse")(raw, seed).ok).toBe(false);
  });

  it("JSON: one stringify reused for all 40 iterations", { timeout: 30_000 }, () => {
    const raw = onceReply(
      /JSON\.stringify\(doc\)/,
      "(globalThis.stringifiedOnce ??= JSON.stringify(doc))",
    );

    expect(verifier("cpu-json-parse")(raw, seed).ok).toBe(false);
  });
});
