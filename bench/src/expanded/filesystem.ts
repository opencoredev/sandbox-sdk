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
import { deadline } from "../timing.js";
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
import {
  checkRounds,
  nodeRoundsSource,
  perRound,
  proofIs,
  pythonRoundsSource,
  roundsSchema,
  roundsWith,
} from "./rounds.js";
import { memo } from "./verify-kit.js";
import type { ExpandedContext, ExpandedScenario, VerifyResult } from "./types.js";

const bytesPerMegabyte = 1_000_000;

// fs-small-files-500

const smallFileCount = 500;
const smallDirCount = 20;

const pad = (value: number, width: number) => String(value).padStart(width, "0");

/** Path and content of small file `index`, as the guest generates it, before a round's salt. */
function smallFile(seed: number, index: number) {
  const lines: string[] = [];

  for (let line = 0; line < 2 + (index % 7); line++)
    lines.push(`export const k${index}_${line} = "${seededHex(seed, "small", index, line)}";`);

  return {
    path: `d${pad(index % smallDirCount, 2)}/f${pad(index, 3)}.ts`,
    content: `${lines.join("\n")}\n`,
  };
}

const smallFiles = memo((seed) =>
  Array.from({ length: smallFileCount }, (_, index) => smallFile(seed, index)),
);

/**
 * The manifest digest round `round` must print: every file starts with the round's salt line,
 * `// <salt>`, then its seeded lines.
 */
export const expectedSmallFilesDigest = perRound((seed, round) => {
  const salt = `// ${seededHex(seed, "small-round", round)}\n`;
  const entries = new Map<string, string>();

  for (const file of smallFiles(seed))
    entries.set(file.path, createHash("sha256").update(salt).update(file.content).digest("hex"));

  return manifestDigest(entries);
});

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
const prepare = (round) => {
  const salt = "// " + h("small-round", round) + "\\n";
  return new Map(files.map(([path, content]) => [path, salt + content]));
};
let fileCount = 0;
const rounds = await timedRounds(${smallMinRounds}, prepare, (written) => {
  for (let d = 0; d < ${smallDirCount}; d++) mkdirSync(base + "/d" + pad(d, 2), { recursive: true });
  for (const [path, content] of written) writeFileSync(base + "/" + path, content);
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
  return { proof: sha(entries.map(([p, d]) => p + ":" + d).join("\\n")) };
});
console.log(JSON.stringify({ seed: SEED, fileCount, rounds, digest: rounds[0].proof }));
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

  if (out.digest !== expectedSmallFilesDigest(seed, 0)) return failure("manifest digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: smallMinRounds,
    check: proofIs((round) => expectedSmallFilesDigest(seed, round)),
  });

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

/** The seed's rows before any round's salt, with the lookup and update plans every round runs. */
const sqliteBase = memo((seed) => {
  const rows = Array.from({ length: sqliteRows }, (_, i) => {
    const hex = seededHex(seed, "row", i);

    return {
      key: hex.slice(0, 16),
      group: hexInt(hex, 16, 20) % 50,
      value: hexInt(hex, 20, 28) % 1_000_000,
    };
  });

  const lookups = Array.from(
    { length: sqliteLookups },
    (_, j) => hexInt(seededHex(seed, "look", j), 0, 8) % sqliteRows,
  );

  const updates = Array.from({ length: sqliteUpdates }, (_, j) => {
    const hex = seededHex(seed, "upd", j);

    return { id: hexInt(hex, 0, 8) % sqliteRows, delta: hexInt(hex, 8, 12) % 1000 };
  });

  return { rows, lookups, updates };
});

/** Round `round`'s salt: row `i` stores its seeded value plus `salt * (i + 1)`, mod 1,000,000. */
function sqliteSalt(seed: number, round: number): number {
  return hexInt(seededHex(seed, "sqlite-round", round), 0, 5);
}

const sqliteRound = perRound((seed, round) => {
  const base = sqliteBase(seed);
  const salt = sqliteSalt(seed, round);

  const rows: SqliteRow[] = base.rows.map((row, i) => ({
    ...row,
    value: (row.value + salt * (i + 1)) % 1_000_000,
  }));

  const lookupSum = base.lookups.reduce((sum, id) => sum + (rows[id]?.value ?? 0), 0);

  for (const update of base.updates) {
    const row = rows[update.id];

    if (row) row.value += update.delta;
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
  const updatedIds = new Set(base.updates.map((update) => update.id));
  const updatedSum = [...updatedIds].reduce((total, id) => total + (rows[id]?.value ?? 0), 0);

  return { aggregateSum, updatedSum, digest: sha256Hex(`${lookupSum}|${groupText}`) };
});

/** The guest's table after round `round`'s inserts, lookups and updates, recomputed from the seed. */
export function expectedSqlite(seed: number, round = 0) {
  return sqliteRound(seed, round);
}

/** Minimum timed rounds of the OLTP mix; each is about 12 ms on local disk. */
const sqliteMinRounds = 5;

export const sqliteProgram = `${pythonPrelude}
${pythonRoundsSource}
import sqlite3
base_rows = []
for i in range(${sqliteRows}):
    r = h("row", i)
    base_rows.append((i, r[:16], int(r[16:20], 16) % 50, int(r[20:28], 16) % 1000000))
looks = [int(h("look", j)[:8], 16) % ${sqliteRows} for j in range(${sqliteLookups})]
updates = []
for j in range(${sqliteUpdates}):
    u = h("upd", j)
    updates.append((int(u[8:12], 16) % 1000, int(u[:8], 16) % ${sqliteRows}))
path = os.path.join(ROOT, "test.db")
state = {}
def prepare(r):
    salt = int(h("sqlite-round", r)[:5], 16)
    return [(i, k, g, (v + salt * (i + 1)) % 1000000) for i, k, g, v in base_rows]
def work(rows):
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
    state.update(ops=ops, mode=mode, integrity=integrity)
    return {"proof": sha("%d|%s" % (lookup_sum, ";".join("%d:%d:%d" % g for g in groups))),
        "aggregateSum": sum(g[1] for g in groups)}
rounds = timed_rounds(${sqliteMinRounds}, prepare, work)
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
    "integrityOk": state["integrity"] == "ok",
    "fileBytes": file_bytes, "filePageCount": page_count, "filePageSize": page_size,
    "fileRows": file_rows, "fileUpdatedSum": updated_sum, "fileJournalMode": file_mode,
    "fileIntegrityOk": file_integrity == "ok", "rounds": rounds, "digest": rounds[0]["proof"]}))
`;

const sqliteOutput = z.strictObject({
  seed: seedSchema,
  ops: z.number().int(),
  journalMode: z.string(),
  integrityOk: z.boolean(),
  fileBytes: z.number().int(),
  filePageCount: z.number().int(),
  filePageSize: z.number().int(),
  fileRows: z.number().int(),
  fileUpdatedSum: z.number().int(),
  fileJournalMode: z.string(),
  fileIntegrityOk: z.boolean(),
  rounds: roundsWith({ aggregateSum: z.number().int() }),
  digest: digestSchema,
});

type SqliteRound = z.infer<typeof sqliteOutput>["rounds"][number];

function sqliteRoundWrong(seed: number, round: SqliteRound, index: number): string | null {
  const expected = expectedSqlite(seed, index);

  if (round.aggregateSum !== expected.aggregateSum)
    return `aggregateSum ${round.aggregateSum}, expected ${expected.aggregateSum}`;

  if (round.proof !== expected.digest) return "query digest does not match the round's rows";

  return null;
}

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

  if (out.digest !== expectedSqlite(seed, 0).digest) return failure("query digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: sqliteMinRounds,
    check: (round, index) => sqliteRoundWrong(seed, round, index),
  });

  if (!rounds.ok) return rounds;

  // The digests and aggregates follow from the seed alone, so they cannot show a database was
  // used. These facts come from reopening the file the last round wrote.
  const last = expectedSqlite(seed, rounds.count - 1);

  if (out.fileRows !== sqliteRows) return failure(`file holds ${out.fileRows} rows`);

  if (out.fileUpdatedSum !== last.updatedSum)
    return failure(`updated rows sum to ${out.fileUpdatedSum}, expected ${last.updatedSum}`);

  if (!isPageSize(out.filePageSize)) return failure(`page size ${out.filePageSize}`);

  if (out.filePageCount <= 0 || out.fileBytes !== out.filePageCount * out.filePageSize)
    return failure(`file is ${out.fileBytes} bytes for ${out.filePageCount} pages`);

  // Every row's 16-character key is stored twice, in the table and in its index.
  if (out.fileBytes < sqliteRows * 32) return failure(`file is only ${out.fileBytes} bytes`);

  if (out.fileJournalMode !== "wal")
    return failure(`file journal mode ${out.fileJournalMode}, expected wal`);

  if (!out.fileIntegrityOk) return failure("integrity_check on the reopened file failed");

  return {
    ok: true,
    value: (out.ops * rounds.count) / rounds.totalSeconds,
    proof: proofOf("fs-sqlite", out.digest),
    details: {
      seconds: rounds.totalSeconds,
      rounds: rounds.count,
      ops: out.ops,
      aggregateSum: expectedSqlite(seed, 0).aggregateSum,
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

const tarPath = (i: number) => `src/m${i % 8}/file${pad(i, 3)}.txt`;

/** Each file's seeded text after its first 65-byte line, which every round replaces. */
const tarTails = memo((seed) =>
  Array.from({ length: tarFileCount }, (_, i) => hexText(seed, "tar", i, tarFileSize(i)).slice(65)),
);

/**
 * The extracted-tree digest round `round` must print: each file's first line is the round's own
 * seeded line, `h("tar-round", round, i)`, and the rest is the file's seeded text.
 */
export const expectedTarDigest = perRound((seed, round) => {
  const tails = tarTails(seed);
  const entries = new Map<string, string>();

  for (const [i, tail] of tails.entries())
    entries.set(
      tarPath(i),
      createHash("sha256")
        .update(`${seededHex(seed, "tar-round", round, i)}\n`)
        .update(tail)
        .digest("hex"),
    );

  return manifestDigest(entries);
});

/** Minimum timed pack-and-extract rounds; each is about 0.22 s on local disk. */
const tarMinRounds = 3;

export const tarProgram = `${nodePrelude}
${nodeRoundsSource}
import { closeSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const tree = ROOT + "/tree", out = ROOT + "/out", archive = ROOT + "/project.tgz";
const tails = [];
let rawBytes = 0;
for (let i = 0; i < ${tarFileCount}; i++) {
  const size = 32768 + (i % 6) * 8192;
  const parts = [];
  let length = 0;
  for (let k = 0; length < size; k++) { const line = h("tar", i, k) + "\\n"; parts.push(line); length += line.length; }
  tails.push(parts.join("").slice(65, size));
  mkdirSync(tree + "/src/m" + (i % 8), { recursive: true });
  rawBytes += size;
}
const rel = (i) => "src/m" + (i % 8) + "/file" + String(i).padStart(3, "0") + ".txt";
// Untimed: the round's tree, every file under its own first line.
const prepare = (round) => {
  const originals = new Map();
  tails.forEach((tail, i) => {
    const content = Buffer.from(h("tar-round", round, i) + "\\n" + tail);
    writeFileSync(tree + "/" + rel(i), content);
    originals.set(rel(i), content);
  });
  return originals;
};
const walk = (dir, prefix) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(dir + "/" + e.name, prefix + e.name + "/") : [prefix + e.name]);
let files = 0;
const rounds = await timedRounds(${tarMinRounds}, prepare, (originals) => {
  rmSync(out, { recursive: true, force: true });
  rmSync(archive, { force: true });
  execFileSync("tar", ["-czf", archive, "-C", tree, "."]);
  mkdirSync(out);
  execFileSync("tar", ["-xzf", archive, "-C", out]);
  const extracted = walk(out, "").sort();
  if (extracted.length !== originals.size) throw new Error("extracted " + extracted.length + " files");
  const lines = [];
  for (const name of extracted) {
    const back = readFileSync(out + "/" + name);
    const original = originals.get(name);
    if (!original || !back.equals(original)) throw new Error("byte mismatch at " + name);
    lines.push(name + ":" + sha(back));
  }
  files = extracted.length;
  // The member's first three bytes and the trailer's length field, without reading the archive.
  const archiveBytes = statSync(archive).size;
  const head = Buffer.alloc(3), size = Buffer.alloc(4), fd = openSync(archive, "r");
  readSync(fd, head, 0, 3, 0);
  readSync(fd, size, 0, 4, archiveBytes - 4);
  closeSync(fd);
  return { proof: sha(lines.join("\\n")), archiveBytes, head: head.toString("hex"), tarBytes: size.readUInt32LE(0) };
});
console.log(JSON.stringify({ seed: SEED, files, rawBytes, rounds, digest: rounds[0].proof }));
`;

const tarOutput = z.strictObject({
  seed: seedSchema,
  files: z.number().int(),
  rawBytes: z.number().int(),
  rounds: roundsWith({
    archiveBytes: z.number().int(),
    head: z.string(),
    tarBytes: z.number().int(),
  }),
  digest: digestSchema,
});

type TarRound = z.infer<typeof tarOutput>["rounds"][number];

/**
 * Why a round's archive is not a tar -czf of its own tree. The extracted digest alone would also
 * pass a plain copy of the tree. A gzip member whose trailer length is a tar stream holding every
 * file, at hex text's ratio, needs tar -czf.
 */
function tarRoundWrong(seed: number, round: TarRound, index: number): string | null {
  if (round.head !== "1f8b08") return `archive starts ${round.head}, not gzip`;

  if (round.tarBytes < tarStreamRange.min || round.tarBytes > tarStreamRange.max)
    return `tar stream is ${round.tarBytes} bytes, expected ${tarStreamRange.min} or a little more`;

  const ratio = round.archiveBytes / tarRawBytes;

  if (ratio < tarRatioRange.min || ratio > tarRatioRange.max)
    return `archiveBytes ${round.archiveBytes} out of range`;

  if (round.proof !== expectedTarDigest(seed, index))
    return "extracted tree digest does not match the round's tree";

  return null;
}

export function verifyTar(raw: string, seed: number): VerifyResult {
  const parsed = parseGuestJson(raw, tarOutput);

  if (!parsed.ok) return parsed;
  const out = parsed.data;

  const wrongSeed = seedMismatch(out.seed, seed);

  if (wrongSeed) return wrongSeed;

  if (out.files !== tarFileCount) return failure(`files ${out.files}, expected ${tarFileCount}`);

  if (out.rawBytes !== tarRawBytes)
    return failure(`rawBytes ${out.rawBytes}, expected ${tarRawBytes}`);

  if (out.digest !== expectedTarDigest(seed, 0)) return failure("extracted tree digest mismatch");

  const rounds = checkRounds({
    rounds: out.rounds,
    minRounds: tarMinRounds,
    check: (round, index) => tarRoundWrong(seed, round, index),
  });

  if (!rounds.ok) return rounds;

  const last = out.rounds.at(-1);

  return {
    ok: true,
    value: (out.rawBytes * rounds.count) / bytesPerMegabyte / rounds.totalSeconds,
    proof: proofOf("fs-tar", out.digest),
    details: {
      seconds: rounds.totalSeconds,
      rounds: rounds.count,
      rawBytes: out.rawBytes,
      archiveBytes: last?.archiveBytes ?? 0,
      tarBytes: last?.tarBytes ?? 0,
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

    // The size checks run outside the timed transfer.
    let checkMs = 0;

    for (const file of files) {
      const path = `${transferDir}/${file.name}`;
      const expected = fileBytes(file);
      const checkStart = performance.now();
      // A file of another size is refused before it is read, so the guest cannot have a large one buffered.
      const { size } = await box.files.stat(path);
      checkMs += performance.now() - checkStart;

      if (size !== expected.byteLength) throw new Error(`fs-sdk-transfer-batch: ${path} differs`);
      const back = await deadline(ctx.timeoutMs, () => box.files.read(path, { as: "bytes" }));

      if (!sameBytes(back, expected)) throw new Error(`fs-sdk-transfer-batch: ${path} differs`);
    }

    const seconds = (performance.now() - start - checkMs) / 1000;

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
