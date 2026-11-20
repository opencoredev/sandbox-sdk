/**
 * Filesystem scenarios: many small files, a SQLite OLTP mix on a real disk file, a tar pack and
 * extract round trip, and file transfer through the SDK's own `box.files` API.
 *
 * The small-file, SQLite and tar workloads take 10 to 250 ms each, so they repeat in timed rounds
 * (see `rounds.ts`) for at least a second and report a rate over every round.
 * The guest code is ours: proofs catch a workload that silently did less or wrong work, not a
 * malicious guest, so each asks for evidence only the real work leaves behind, such as facts read
 * back from the SQLite file or the tar stream length in the gzip trailer.
 */
import { createHash } from "node:crypto";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { z } from "zod";
import { command, quote } from "../workloads.js";
import {
  digestSchema,
  failure,
  hexInt,
  manifestDigest,
  nodePrelude,
  outcomeOf,
  parseGuestJson,
  proofOf,
  pythonPrelude,
  runGuestProgram,
  secondsSchema,
  seededHex,
  seedMismatch,
  seedSchema,
  sha256Hex,
} from "./guest-kit.js";
import { checkRounds, nodeRoundsSource, pythonRoundsSource, roundsSchema } from "./rounds.js";
import type { ExpandedContext, ExpandedScenario, VerifyResult } from "./types.js";

const bytesPerMegabyte = 1_000_000;

// fs-small-files-500

const smallFileCount = 500;
const smallDirCount = 20;

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** Path and content of small file `index`, as the guest generates it. */
function smallFile(seed: number, index: number) {
  const lines: string[] = [];

  for (let line = 0; line < 2 + (index % 7); line++)
    lines.push(`export const k${index}_${line} = "${seededHex(seed, "small", index, line)}";`);

  return {
    path: `d${pad(index % smallDirCount, 2)}/f${pad(index, 3)}.ts`,
    content: `${lines.join("\n")}\n`,
  };
}

export function expectedSmallFilesDigest(seed: number): string {
  const entries = new Map<string, string>();

  for (let index = 0; index < smallFileCount; index++) {
    const file = smallFile(seed, index);
    entries.set(file.path, sha256Hex(file.content));
  }

  return manifestDigest(entries);
}

/** Minimum timed rounds of the 500-file tree; each is about 15 ms on local disk. */
const smallMinRounds = 5;

export const smallFilesProgram = `${nodePrelude}
${nodeRoundsSource}
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
const pad = (v, w) => String(v).padStart(w, "0");
const base = ROOT + "/tree";
const files = [];
for (let i = 0; i < ${smallFileCount}; i++) {
  const lines = [];
  for (let j = 0; j < 2 + (i % 7); j++) lines.push("export const k" + i + "_" + j + ' = "' + h("small", i, j) + '";');
  files.push(["d" + pad(i % ${smallDirCount}, 2) + "/f" + pad(i, 3) + ".ts", lines.join("\\n") + "\\n"]);
}
const written = new Map(files);
let fileCount = 0;
const { rounds, digest } = await timedRounds(${smallMinRounds}, () => {
  for (let d = 0; d < ${smallDirCount}; d++) mkdirSync(base + "/d" + pad(d, 2), { recursive: true });
  for (const [path, content] of files) writeFileSync(base + "/" + path, content);
  const entries = [];
  for (const dir of readdirSync(base).sort()) {
    for (const name of readdirSync(base + "/" + dir).sort()) {
      const path = dir + "/" + name;
      const back = readFileSync(base + "/" + path, "utf8");
      if (back !== written.get(path)) throw new Error("readback mismatch at " + path);
      entries.push([path, sha(back)]);
    }
  }
  rmSync(base, { recursive: true });
  if (existsSync(base)) throw new Error("tree survived delete");
  fileCount = entries.length;
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha(entries.map(([p, d]) => p + ":" + d).join("\\n"));
});
console.log(JSON.stringify({ seed: SEED, fileCount, rounds, digest }));
`;

const smallFilesOutput = z.strictObject({
  seed: seedSchema,
  fileCount: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifySmallFiles(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, smallFilesOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.fileCount !== smallFileCount)
    return failure(`fileCount ${out.fileCount}, expected ${smallFileCount}`);

  if (out.digest !== expectedSmallFilesDigest(seed)) return failure("manifest digest mismatch");

  const rounds = checkRounds({ rounds: out.rounds, digest: out.digest, minRounds: smallMinRounds });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (smallFileCount * rounds.count) / rounds.totalSeconds,
    proof: proofOf("fs-small", out.digest),
    details: { seconds: rounds.totalSeconds, rounds: rounds.count, fileCount: out.fileCount },
  };
}

// fs-sqlite-oltp

const sqliteRows = 2500;
const sqliteBatch = 250;
const sqliteLookups = 500;
const sqliteUpdates = 250;

/** Inserts, lookups, updates, one aggregate and one integrity check. */
export const sqliteOps = sqliteRows + sqliteLookups + sqliteUpdates + 2;

interface SqliteRow {
  readonly key: string;
  readonly group: number;
  value: number;
}

/** The guest's table after its inserts, lookups and updates, recomputed from the seed. */
export function expectedSqlite(seed: number) {
  const rows: SqliteRow[] = [];

  for (let i = 0; i < sqliteRows; i++) {
    const hex = seededHex(seed, "row", i);
    rows.push({
      key: hex.slice(0, 16),
      group: hexInt(hex, 16, 20) % 50,
      value: hexInt(hex, 20, 28) % 1_000_000,
    });
  }

  let lookupSum = 0;

  for (let j = 0; j < sqliteLookups; j++)
    lookupSum += rows[hexInt(seededHex(seed, "look", j), 0, 8) % sqliteRows]?.value ?? 0;

  for (let j = 0; j < sqliteUpdates; j++) {
    const hex = seededHex(seed, "upd", j);
    const row = rows[hexInt(hex, 0, 8) % sqliteRows];

    if (row) row.value += hexInt(hex, 8, 12) % 1000;
  }

  const groups = new Map<number, { sum: number; count: number }>();

  for (const row of rows) {
    const group = groups.get(row.group) ?? { sum: 0, count: 0 };
    group.sum += row.value;
    group.count += 1;
    groups.set(row.group, group);
  }

  const ordered = [...groups.entries()].sort(([a], [b]) => a - b);
  const aggregateSum = ordered.reduce((total, [, group]) => total + group.sum, 0);
  const groupText = ordered.map(([id, group]) => `${id}:${group.sum}:${group.count}`).join(";");
  const updatedIds = new Set<number>();

  for (let j = 0; j < sqliteUpdates; j++)
    updatedIds.add(hexInt(seededHex(seed, "upd", j), 0, 8) % sqliteRows);

  const updatedSum = [...updatedIds].reduce((total, id) => total + (rows[id]?.value ?? 0), 0);

  return { aggregateSum, updatedSum, digest: sha256Hex(`${lookupSum}|${groupText}`) };
}

/** Minimum timed rounds of the OLTP mix; each is about 12 ms on local disk. */
const sqliteMinRounds = 5;

export const sqliteProgram = `${pythonPrelude}
${pythonRoundsSource}
import sqlite3
rows = []
for i in range(${sqliteRows}):
    r = h("row", i)
    rows.append((i, r[:16], int(r[16:20], 16) % 50, int(r[20:28], 16) % 1000000))
looks = [int(h("look", j)[:8], 16) % ${sqliteRows} for j in range(${sqliteLookups})]
updates = []
for j in range(${sqliteUpdates}):
    u = h("upd", j)
    updates.append((int(u[8:12], 16) % 1000, int(u[:8], 16) % ${sqliteRows}))
path = os.path.join(ROOT, "test.db")
state = {}
def work(r):
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            os.remove(path + suffix)
    con = sqlite3.connect(path, isolation_level=None)
    mode = con.execute("PRAGMA journal_mode=WAL").fetchone()[0]
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("CREATE TABLE items(id INTEGER PRIMARY KEY, k TEXT NOT NULL, grp INTEGER NOT NULL, val INTEGER NOT NULL)")
    con.execute("CREATE INDEX items_k ON items(k)")
    con.execute("CREATE INDEX items_grp ON items(grp)")
    ops = 0
    for start in range(0, ${sqliteRows}, ${sqliteBatch}):
        con.execute("BEGIN")
        con.executemany("INSERT INTO items(id, k, grp, val) VALUES (?, ?, ?, ?)", rows[start:start + ${sqliteBatch}])
        con.execute("COMMIT")
    ops += ${sqliteRows}
    lookup_sum = 0
    for idx in looks:
        found = con.execute("SELECT val FROM items WHERE k = ?", (rows[idx][1],)).fetchall()
        if len(found) != 1:
            raise SystemExit("lookup returned %d rows" % len(found))
        lookup_sum += found[0][0]
        ops += 1
    con.execute("BEGIN")
    for delta, idx in updates:
        if con.execute("UPDATE items SET val = val + ? WHERE id = ?", (delta, idx)).rowcount != 1:
            raise SystemExit("update missed row %d" % idx)
        ops += 1
    con.execute("COMMIT")
    groups = con.execute("SELECT grp, SUM(val), COUNT(*) FROM items GROUP BY grp ORDER BY grp").fetchall()
    ops += 1
    integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
    ops += 1
    con.close()
    state.update(ops=ops, mode=mode, integrity=integrity, aggregate=sum(g[1] for g in groups))
    return sha("%d|%s" % (lookup_sum, ";".join("%d:%d:%d" % g for g in groups)))
rounds, digest = timed_rounds(${sqliteMinRounds}, work)
# Untimed: facts only the database file the last round left behind can answer.
file_bytes = os.path.getsize(path)
con = sqlite3.connect(path, isolation_level=None)
updated = sorted(set(idx for _, idx in updates))
file_rows = con.execute("SELECT COUNT(*) FROM items").fetchone()[0]
updated_sum = con.execute("SELECT SUM(val) FROM items WHERE id IN (%s)" % ",".join("?" * len(updated)), updated).fetchone()[0]
page_count = con.execute("PRAGMA page_count").fetchone()[0]
page_size = con.execute("PRAGMA page_size").fetchone()[0]
file_mode = con.execute("PRAGMA journal_mode").fetchone()[0]
file_integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
con.close()
print(json.dumps({"seed": SEED, "ops": state["ops"], "journalMode": state["mode"],
    "integrityOk": state["integrity"] == "ok", "aggregateSum": state["aggregate"],
    "fileBytes": file_bytes, "filePageCount": page_count, "filePageSize": page_size,
    "fileRows": file_rows, "fileUpdatedSum": updated_sum, "fileJournalMode": file_mode,
    "fileIntegrityOk": file_integrity == "ok", "rounds": rounds, "digest": digest}))
`;

const sqliteOutput = z.strictObject({
  seed: seedSchema,
  ops: z.number().int(),
  journalMode: z.string(),
  integrityOk: z.boolean(),
  aggregateSum: z.number().int(),
  fileBytes: z.number().int(),
  filePageCount: z.number().int(),
  filePageSize: z.number().int(),
  fileRows: z.number().int(),
  fileUpdatedSum: z.number().int(),
  fileJournalMode: z.string(),
  fileIntegrityOk: z.boolean(),
  rounds: roundsSchema,
  digest: digestSchema,
});

/** SQLite page sizes are powers of two from 512 to 65536. */
const isPageSize = (size: number) => size >= 512 && size <= 65_536 && (size & (size - 1)) === 0;

export function verifySqlite(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, sqliteOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (!out.integrityOk) return failure("PRAGMA integrity_check did not return ok");

  if (out.journalMode !== "wal") return failure(`journal mode ${out.journalMode}, expected wal`);

  if (out.ops !== sqliteOps) return failure(`ops ${out.ops}, expected ${sqliteOps}`);
  const expected = expectedSqlite(seed);

  if (out.aggregateSum !== expected.aggregateSum)
    return failure(`aggregateSum ${out.aggregateSum}, expected ${expected.aggregateSum}`);

  if (out.digest !== expected.digest) return failure("query digest mismatch");

  // The digest and aggregate follow from the seed alone, so they cannot show a database was
  // used. These facts come from reopening the file the last round wrote.
  if (out.fileRows !== sqliteRows) return failure(`file holds ${out.fileRows} rows`);

  if (out.fileUpdatedSum !== expected.updatedSum)
    return failure(`updated rows sum to ${out.fileUpdatedSum}, expected ${expected.updatedSum}`);

  if (!isPageSize(out.filePageSize)) return failure(`page size ${out.filePageSize}`);

  if (out.filePageCount <= 0 || out.fileBytes !== out.filePageCount * out.filePageSize)
    return failure(`file is ${out.fileBytes} bytes for ${out.filePageCount} pages`);

  // Every row's 16-character key is stored twice, in the table and in its index.
  if (out.fileBytes < sqliteRows * 32) return failure(`file is only ${out.fileBytes} bytes`);

  if (out.fileJournalMode !== "wal")
    return failure(`file journal mode ${out.fileJournalMode}, expected wal`);

  if (!out.fileIntegrityOk) return failure("integrity_check on the reopened file failed");

  const rounds = checkRounds({
    rounds: out.rounds,
    digest: out.digest,
    minRounds: sqliteMinRounds,
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (out.ops * rounds.count) / rounds.totalSeconds,
    proof: proofOf("fs-sqlite", out.digest),
    details: {
      seconds: rounds.totalSeconds,
      rounds: rounds.count,
      ops: out.ops,
      aggregateSum: out.aggregateSum,
      fileBytes: out.fileBytes,
    },
  };
}

// fs-tar-extract-pack

const tarFileCount = 120;

/** Hex text lines from the seeded generator, cut to `size` bytes. */
function hexText(seed: number, label: string, index: number, size: number): string {
  const parts: string[] = [];
  let length = 0;

  for (let k = 0; length < size; k++) {
    const line = `${seededHex(seed, label, index, k)}\n`;
    parts.push(line);
    length += line.length;
  }

  return parts.join("").slice(0, size);
}

const tarFileSize = (index: number) => 32_768 + (index % 6) * 8192;

export const tarRawBytes = Array.from({ length: tarFileCount }, (_, i) => tarFileSize(i)).reduce(
  (a, b) => a + b,
  0,
);

/** Archive entries: `.`, `src`, the eight module directories and every file. */
const tarEntries = 2 + 8 + tarFileCount;

/**
 * The shortest tar stream that holds the tree: a 512-byte header per entry, every file's data
 * (sizes are multiples of 512, so no padding), and the two zero blocks that end the archive.
 * GNU tar pads to a 10240-byte record; other tars add extended headers, so allow some slack.
 */
export const tarStreamRange = {
  min: tarEntries * 512 + tarRawBytes + 1024,
  max: tarEntries * 512 + tarRawBytes + 1024 + tarEntries * 1536 + 10_240,
} as const;

/** gzip-compressed hex text is about 0.58 of its size; well outside that was not gzip of the tree. */
const tarRatioRange = { min: 0.45, max: 0.75 } as const;

export function expectedTarDigest(seed: number): string {
  const entries = new Map<string, string>();

  for (let i = 0; i < tarFileCount; i++)
    entries.set(
      `src/m${i % 8}/file${pad(i, 3)}.txt`,
      sha256Hex(hexText(seed, "tar", i, tarFileSize(i))),
    );

  return manifestDigest(entries);
}

/** Minimum timed pack-and-extract rounds; each is about 0.22 s on local disk. */
const tarMinRounds = 3;

export const tarProgram = `${nodePrelude}
${nodeRoundsSource}
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const tree = ROOT + "/tree", out = ROOT + "/out", archive = ROOT + "/project.tgz";
const originals = new Map();
let rawBytes = 0;
for (let i = 0; i < ${tarFileCount}; i++) {
  const size = 32768 + (i % 6) * 8192;
  const parts = [];
  let length = 0;
  for (let k = 0; length < size; k++) { const line = h("tar", i, k) + "\\n"; parts.push(line); length += line.length; }
  const content = Buffer.from(parts.join("").slice(0, size));
  const rel = "src/m" + (i % 8) + "/file" + String(i).padStart(3, "0") + ".txt";
  mkdirSync(tree + "/src/m" + (i % 8), { recursive: true });
  writeFileSync(tree + "/" + rel, content);
  originals.set(rel, content);
  rawBytes += size;
}
const walk = (dir, prefix) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(dir + "/" + e.name, prefix + e.name + "/") : [prefix + e.name]);
let files = 0;
const { rounds, digest } = await timedRounds(${tarMinRounds}, () => {
  rmSync(out, { recursive: true, force: true });
  rmSync(archive, { force: true });
  execFileSync("tar", ["-czf", archive, "-C", tree, "."]);
  mkdirSync(out);
  execFileSync("tar", ["-xzf", archive, "-C", out]);
  const extracted = walk(out, "").sort();
  if (extracted.length !== originals.size) throw new Error("extracted " + extracted.length + " files");
  const lines = [];
  for (const rel of extracted) {
    const back = readFileSync(out + "/" + rel);
    const original = originals.get(rel);
    if (!original || !back.equals(original)) throw new Error("byte mismatch at " + rel);
    lines.push(rel + ":" + sha(back));
  }
  files = extracted.length;
  return sha(lines.join("\\n"));
});
const archiveBytes = statSync(archive).size;
const packed = readFileSync(archive);
const archiveHead = packed.subarray(0, 3).toString("hex");
const tarBytes = packed.readUInt32LE(packed.length - 4);
console.log(JSON.stringify({ seed: SEED, files, rawBytes, archiveBytes, archiveHead, tarBytes, rounds, digest }));
`;

const tarOutput = z.strictObject({
  seed: seedSchema,
  files: z.number().int(),
  rawBytes: z.number().int(),
  archiveBytes: z.number().int(),
  archiveHead: z.string(),
  tarBytes: z.number().int(),
  rounds: roundsSchema,
  digest: digestSchema,
});

export function verifyTar(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, tarOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.files !== tarFileCount) return failure(`files ${out.files}, expected ${tarFileCount}`);

  if (out.rawBytes !== tarRawBytes)
    return failure(`rawBytes ${out.rawBytes}, expected ${tarRawBytes}`);

  // The extracted digest alone would also pass a plain copy of the tree. A gzip member whose
  // trailer length is a tar stream holding every file, at hex text's ratio, needs tar -czf.
  if (out.archiveHead !== "1f8b08") return failure(`archive starts ${out.archiveHead}, not gzip`);

  if (out.tarBytes < tarStreamRange.min || out.tarBytes > tarStreamRange.max)
    return failure(
      `tar stream is ${out.tarBytes} bytes, expected ${tarStreamRange.min} or a little more`,
    );

  const ratio = out.archiveBytes / out.rawBytes;

  if (ratio < tarRatioRange.min || ratio > tarRatioRange.max)
    return failure(`archiveBytes ${out.archiveBytes} out of range`);

  if (out.digest !== expectedTarDigest(seed)) return failure("extracted tree digest mismatch");

  const rounds = checkRounds({ rounds: out.rounds, digest: out.digest, minRounds: tarMinRounds });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (out.rawBytes * rounds.count) / bytesPerMegabyte / rounds.totalSeconds,
    proof: proofOf("fs-tar", out.digest),
    details: {
      seconds: rounds.totalSeconds,
      rounds: rounds.count,
      rawBytes: out.rawBytes,
      archiveBytes: out.archiveBytes,
      tarBytes: out.tarBytes,
    },
  };
}

// fs-sdk-transfer-batch

const transferCount = 20;
const transferDir = "/workspace/bench-sdk-xfer";

/** Seeded bytes from raw SHA-256 digests, cut to `size`. */
function seededBytes(seed: number, index: number, size: number): Uint8Array {
  const out = new Uint8Array(size);

  for (let k = 0, offset = 0; offset < size; k++, offset += 32)
    out.set(
      createHash("sha256")
        .update(`${seed}:xfer:${index}:${k}`)
        .digest()
        .subarray(0, size - offset),
      offset,
    );

  return out;
}

/** The 20 files: 1 to 64 KiB, binary on even indexes and text on odd ones. */
export function transferFiles(seed: number) {
  return Array.from({ length: transferCount }, (_, index) => {
    const size = 1024 * (1 + ((index * 7) % 64));
    const binary = index % 2 === 0;

    const name = `f${pad(index, 2)}.${binary ? "bin" : "txt"}`;

    return binary
      ? { kind: "bytes" as const, name, data: seededBytes(seed, index, size) }
      : { kind: "text" as const, name, data: hexText(seed, "xfer", index, size) };
  });
}

/** The bytes a transfer file should have on disk. */
const fileBytes = (file: ReturnType<typeof transferFiles>[number]) =>
  file.kind === "text" ? new TextEncoder().encode(file.data) : file.data;

export function expectedTransferDigest(seed: number): string {
  return manifestDigest(new Map(transferFiles(seed).map((f) => [f.name, sha256Hex(fileBytes(f))])));
}

/** Guest-side manifest of what actually landed on disk. */
const transferManifestScript = `const { createHash } = require("node:crypto");
const fs = require("node:fs");
const dir = process.argv[1];
const names = fs.readdirSync(dir).sort();
const lines = names.map((n) => n + ":" + createHash("sha256").update(fs.readFileSync(dir + "/" + n)).digest("hex"));
console.log(JSON.stringify({ fileCount: names.length, digest: createHash("sha256").update(lines.join("\\n")).digest("hex") }));`;

const transferGuest = z.strictObject({ fileCount: z.number().int(), digest: digestSchema });

const transferOutput = z.strictObject({
  seed: seedSchema,
  fileCount: z.number().int(),
  seconds: secondsSchema,
  digest: digestSchema,
});

function sameBytes(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

/**
 * Raw output here is the host's record: SDK write and read-back time measured on the host, and the
 * manifest digest the guest computed from the files on its disk.
 */
export function verifyTransfer(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, transferOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.fileCount !== transferCount)
    return failure(`fileCount ${out.fileCount}, expected ${transferCount}`);

  if (out.digest !== expectedTransferDigest(seed)) return failure("transfer digest mismatch");

  return {
    ok: true,
    value: transferCount / out.seconds,
    proof: proofOf("fs-sdk-xfer", out.digest),
    details: { seconds: out.seconds, fileCount: out.fileCount },
  };
}

async function runTransfer(box: Sandbox, ctx: ExpandedContext) {
  const files = transferFiles(ctx.seed);

  await command(box, `rm -rf ${transferDir} && mkdir -p ${transferDir}`, ctx.timeoutMs);

  try {
    const start = performance.now();

    for (const file of files) await box.files.write(`${transferDir}/${file.name}`, file.data);

    for (const file of files) {
      const path = `${transferDir}/${file.name}`;
      const back = await box.files.read(path, { as: "bytes" });

      if (!sameBytes(back, fileBytes(file)))
        throw new Error(`fs-sdk-transfer-batch: ${path} differs`);
    }

    const seconds = (performance.now() - start) / 1000;

    const guest = parseGuestJson(
      await command(box, `node -e ${quote(transferManifestScript)} ${transferDir}`, ctx.timeoutMs),
      transferGuest,
    );

    if (!guest.ok) throw new Error(`fs-sdk-transfer-batch: ${guest.reason}`);

    return JSON.stringify({ seed: ctx.seed, ...guest.data, seconds });
  } finally {
    await box.run(`rm -rf ${transferDir}`, { timeoutMs: ctx.timeoutMs });
  }
}

export const filesystemScenarios: readonly ExpandedScenario[] = [
  {
    id: "fs-small-files-500",
    category: "filesystem",
    label: "500 small files",
    description:
      "Create 500 seeded source files across 20 directories, list and read every one back, hash the manifest and delete the tree, in rounds for at least a second.",
    unit: "files/s",
    better: "higher",
    verifyOutput: verifySmallFiles,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        {
          dir: "/workspace/bench-fs-small",
          file: "small.mjs",
          source: smallFilesProgram,
          interpreter: "node",
        },
        ctx,
      );

      return outcomeOf("fs-small-files-500", verifySmallFiles(raw, ctx.seed));
    },
  },
  {
    id: "fs-sqlite-oltp",
    category: "filesystem",
    label: "SQLite OLTP",
    description:
      "SQLite on a disk file in WAL mode: 2,500 batched inserts, 500 indexed lookups, 250 updates, an aggregate and an integrity check, in rounds for at least a second.",
    unit: "queries/s",
    better: "higher",
    verifyOutput: verifySqlite,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        {
          dir: "/workspace/bench-sqlite",
          file: "oltp.py",
          source: sqliteProgram,
          interpreter: "python3",
        },
        ctx,
      );

      return outcomeOf("fs-sqlite-oltp", verifySqlite(raw, ctx.seed));
    },
  },
  {
    id: "fs-tar-extract-pack",
    category: "filesystem",
    label: "tar pack and extract",
    description:
      "Pack a seeded 6.4 MB, 120-file project with tar -czf, extract it to a clean directory and compare every byte, in rounds for at least a second.",
    unit: "MB/s",
    better: "higher",
    verifyOutput: verifyTar,
    async run(box, ctx) {
      const raw = await runGuestProgram(
        box,
        { dir: "/workspace/bench-tar", file: "tar.mjs", source: tarProgram, interpreter: "node" },
        ctx,
      );

      return outcomeOf("fs-tar-extract-pack", verifyTar(raw, ctx.seed));
    },
  },
  {
    id: "fs-sdk-transfer-batch",
    category: "filesystem",
    label: "SDK file transfer",
    description:
      "Write 20 seeded files of 1 to 64 KiB through box.files.write, read each back byte-exact with box.files.read, and check the guest's copy.",
    unit: "files/s",
    better: "higher",
    verifyOutput: verifyTransfer,
    async run(box, ctx) {
      return outcomeOf(
        "fs-sdk-transfer-batch",
        verifyTransfer(await runTransfer(box, ctx), ctx.seed),
      );
    },
  },
];
