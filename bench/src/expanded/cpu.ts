import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { z } from "zod";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { command, quote } from "../workloads.js";
import {
  checkRounds,
  nodeRoundsSource,
  perRound,
  proofIs,
  roundsSchema,
  roundsWith,
  type Round,
} from "./rounds.js";
import type { ExpandedContext, ExpandedScenario, VerifyResult } from "./types.js";
import {
  decode,
  hexDigest,
  memo,
  outcomeOf,
  positiveSeconds,
  rng32,
  rngSource,
  seedField,
  wrongSeed,
} from "./verify-kit.js";

/**
 * CPU scenarios. Each guest script derives its input from the run's seed, times only the kernel
 * with `performance.now()`, and prints one JSON line. The host recomputes the exact digest from
 * the seed, so a cached or hardcoded reply fails verification.
 *
 * SHA-256, gzip and the sieve each take about 0.1 s, so they repeat in timed rounds (see
 * `rounds.ts`) for at least a second and report work done per second over every round.
 *
 * The guest code is ours: proofs catch a workload that silently did less or wrong work (a missing
 * tool, a broken fallback, a bug), not a malicious guest. Each proof needs evidence only the real
 * work produces, such as the gzip trailer's CRC-32 of the corpus.
 *
 * The guest scripts are plain JavaScript strings that mirror the TypeScript generators below.
 * `tests/expanded-cpu.test.ts` runs each script with the local `node` and checks its output passes
 * `verifyOutput`, so the two copies cannot drift apart unnoticed.
 */

const workDir = "/workspace/bench-cpu";
const bytesPerMegabyte = 1_000_000;

/** Upper bound on any claimed rate; a faster claim means the guest did not do the work it reports. */
const maxMegabytesPerSecond = 50_000;

const seconds = positiveSeconds;

/** The fastest round's rate in `unitsPerRound` per second; the plausibility bound checks this. */
function fastestRate(rounds: readonly Round[], unitsPerRound: number): number {
  return unitsPerRound / Math.min(...rounds.map((round) => round.seconds));
}

/** Write a guest script, run it with the seed, and return its last stdout line. */
async function runGuestScript(box: Sandbox, ctx: ExpandedContext, name: string, source: string) {
  const path = `${workDir}/${name}`;
  await command(box, `mkdir -p ${workDir}`, ctx.timeoutMs);
  await box.files.write(path, source);
  const stdout = await command(box, `node ${quote(path)} ${ctx.seed >>> 0}`, ctx.timeoutMs);
  await box.run(`rm -rf ${workDir}`, { timeoutMs: ctx.timeoutMs });

  return stdout.split("\n").at(-1) ?? "";
}

// ---------------------------------------------------------------------------------------------
// cpu-sha256-hash
// ---------------------------------------------------------------------------------------------

const shaBlockBytes = 1 << 20;
const shaBlocks = 32;
const shaPasses = 8;
const shaChunkBytes = 1 << 16;

/** Bytes the guest hashes in total: a 32 MiB buffer, eight passes. */
export const sha256TotalBytes = shaBlockBytes * shaBlocks * shaPasses;

/** The 32 MiB seeded buffer: one 1 MiB random block, copied 32 times, each copy stamped with its index and the seed. */
function sha256Buffer(seed: number): Buffer {
  const next = rng32(seed ^ 0x5a17);
  const block = Buffer.alloc(shaBlockBytes);

  for (let i = 0; i < shaBlockBytes; i += 4) block.writeUInt32LE(next(), i);

  const data = Buffer.alloc(shaBlockBytes * shaBlocks);

  for (let b = 0; b < shaBlocks; b++) {
    const offset = b * shaBlockBytes;
    block.copy(data, offset);
    data.writeUInt32LE(b, offset);
    data.writeUInt32LE(seed >>> 0, offset + 4);
  }

  return data;
}

/** The last seed's buffer: 32 MiB is too much to keep for several seeds. */
let shaBufferCache: { readonly seed: number; readonly data: Buffer } | null = null;

function sha256BufferFor(seed: number): Buffer {
  if (shaBufferCache?.seed !== seed) shaBufferCache = { seed, data: sha256Buffer(seed) };

  return shaBufferCache.data;
}

/**
 * The digest round `round` must print: SHA-256 over the eight per-pass digests, each pass
 * prefixed by (seed, round, pass). The prefix changes every block's hash state, so a round's
 * digest needs that round's full 256 MiB of hashing, here and in the guest.
 */
export const expectedSha256Digest = perRound((seed, round) => {
  const data = sha256BufferFor(seed);
  const outer = createHash("sha256");

  for (let pass = 0; pass < shaPasses; pass++) {
    const prefix = Buffer.alloc(12);
    prefix.writeUInt32LE(seed >>> 0, 0);
    prefix.writeUInt32LE(round, 4);
    prefix.writeUInt32LE(pass, 8);
    outer.update(createHash("sha256").update(prefix).update(data).digest());
  }

  return outer.digest("hex");
});

/** Minimum timed rounds for SHA-256; each is about 0.1 s on a fast core. */
const sha256MinRounds = 3;

export const sha256GuestScript = `import { createHash } from "node:crypto";
${rngSource}
${nodeRoundsSource}
const seed = Number(process.argv[2]) >>> 0;
const BLOCK = ${shaBlockBytes}, BLOCKS = ${shaBlocks}, PASSES = ${shaPasses}, CHUNK = ${shaChunkBytes};
const next = rng32(seed ^ 0x5a17);
const block = Buffer.alloc(BLOCK);
for (let i = 0; i < BLOCK; i += 4) block.writeUInt32LE(next(), i);
const data = Buffer.alloc(BLOCK * BLOCKS);
for (let b = 0; b < BLOCKS; b++) {
  const offset = b * BLOCK;
  block.copy(data, offset);
  data.writeUInt32LE(b, offset);
  data.writeUInt32LE(seed, offset + 4);
}
let bytes = 0;
const prepare = (round) => Array.from({ length: PASSES }, (_, pass) => {
  const prefix = Buffer.alloc(12);
  prefix.writeUInt32LE(seed, 0);
  prefix.writeUInt32LE(round, 4);
  prefix.writeUInt32LE(pass, 8);
  return prefix;
});
const rounds = await timedRounds(${sha256MinRounds}, prepare, (prefixes) => {
  const outer = createHash("sha256");
  bytes = 0;
  for (const prefix of prefixes) {
    const hash = createHash("sha256").update(prefix);
    for (let offset = 0; offset < data.length; offset += CHUNK) {
      hash.update(data.subarray(offset, offset + CHUNK));
      bytes += Math.min(CHUNK, data.length - offset);
    }
    outer.update(hash.digest());
  }
  return { proof: outer.digest("hex") };
});
console.log(JSON.stringify({ seed, bytes, rounds, digest: rounds[0].proof }));
`;

const sha256Reply = z.strictObject({
  seed: seedField,
  bytes: z.number().int().positive(),
  rounds: roundsSchema,
  digest: hexDigest,
});

function verifySha256(raw: string, seed: number): VerifyResult {
  const reply = decode(sha256Reply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.bytes !== sha256TotalBytes)
    return { ok: false, reason: `hashed ${data.bytes} bytes, want ${sha256TotalBytes}` };

  if (data.digest !== expectedSha256Digest(seed, 0))
    return { ok: false, reason: "digest does not match the seed" };

  // The rate bound first: it needs no hashing, and an implausible round is not worth checking.
  const fastest = fastestRate(data.rounds, data.bytes / bytesPerMegabyte);

  if (fastest > maxMegabytesPerSecond)
    return { ok: false, reason: `implausible rate ${fastest} MB/s` };

  const rounds = checkRounds({
    rounds: data.rounds,
    minRounds: sha256MinRounds,
    check: proofIs((round) => expectedSha256Digest(seed, round)),
  });

  if (!rounds.ok) return rounds;

  return {
    ok: true,
    value: (data.bytes * rounds.count) / bytesPerMegabyte / rounds.totalSeconds,
    proof: data.digest,
    details: { bytes: data.bytes, rounds: rounds.count, seconds: rounds.totalSeconds },
  };
}

const cpuSha256Hash: ExpandedScenario = {
  id: "cpu-sha256-hash",
  category: "cpu",
  label: "SHA-256 hashing",
  description:
    "Streams SHA-256 over a seeded 32 MiB buffer eight times per round in Node, each pass and round under its own prefix, in rounds for at least a second, and reports hashing throughput.",
  unit: "MB/s",
  better: "higher",
  async run(box, ctx) {
    const raw = await runGuestScript(box, ctx, "sha256.mjs", sha256GuestScript);

    return outcomeOf("cpu-sha256-hash", verifySha256(raw, ctx.seed));
  },
  verifyOutput: verifySha256,
};

// ---------------------------------------------------------------------------------------------
// cpu-gzip-compress
// ---------------------------------------------------------------------------------------------

const gzipTargetBytes = 8 * (1 << 20);
const gzipRecordCount = 4096;

const words = [
  "alpha",
  "bravo",
  "cache",
  "delta",
  "event",
  "fetch",
  "graph",
  "hydra",
  "index",
  "jolt",
  "kernel",
  "lambda",
  "merge",
  "node",
  "orbit",
  "parse",
  "query",
  "relay",
  "scope",
  "token",
  "union",
  "vector",
  "worker",
  "yield",
  "zone",
  "bundle",
  "client",
  "driver",
  "engine",
  "filter",
  "gateway",
  "handler",
  "ingest",
  "journal",
  "keystore",
  "loader",
  "module",
  "network",
  "option",
  "plugin",
  "queue",
  "router",
  "schema",
  "tracer",
  "update",
  "volume",
  "webhook",
  "xform",
  "agent",
  "build",
  "commit",
  "deploy",
  "export",
  "format",
  "git",
  "hook",
  "import",
  "join",
  "kit",
  "lint",
  "mount",
  "notify",
  "output",
  "patch",
] as const;

function word(next: () => number): string {
  return words[next() % words.length] ?? "alpha";
}

/**
 * The seeded gzip corpus: 4096 distinct package-manifest JSON records, then sequenced lines picking
 * records at random until the corpus reaches 8 MiB. Repeats sit far apart, beyond gzip's 32 KiB window.
 */
function gzipCorpus(seed: number): Buffer {
  const next = rng32(seed ^ 0x6a1b);
  const records: string[] = [];

  for (let i = 0; i < gzipRecordCount; i++) {
    const deps: string[] = [];
    const depCount = 1 + (next() % 5);

    for (let d = 0; d < depCount; d++)
      deps.push(`"@${word(next)}/${word(next)}":"^${next() % 9}.${next() % 20}.${next() % 30}"`);

    records.push(
      `"name":"@${word(next)}/${word(next)}-${word(next)}","version":"${next() % 9}.${next() % 40}.${next() % 99}",` +
        `"main":"src/${word(next)}/${word(next)}.ts","size":${next() % 100_000},"deps":{${deps.join(",")}}}`,
    );
  }

  const lines: string[] = [];
  let bytes = 0;

  for (let seq = 0; bytes < gzipTargetBytes; seq++) {
    const line = `{"seq":${seq},${records[next() % gzipRecordCount] ?? ""}\n`;
    lines.push(line);
    bytes += line.length;
  }

  return Buffer.from(lines.join(""), "utf8");
}

/** The seeded corpus, kept for a few seeds: every round compresses it behind its own salt line. */
const gzipBase = memo(gzipCorpus);

/** Round `round`'s salt line, the same length every round: `{"salt":"<64 hex>"}` and a newline. */
function gzipSalt(seed: number, round: number): Buffer {
  const salt = createHash("sha256")
    .update(`${seed >>> 0}:gzip:${round}`)
    .digest("hex");

  return Buffer.from(`{"salt":"${salt}"}\n`, "utf8");
}

/** What round `round` must report: its corpus is the salt line, then the shared seeded corpus. */
const gzipRound = perRound((seed, round) => {
  const base = gzipBase(seed);
  const salt = gzipSalt(seed, round);
  const rawBytes = salt.length + base.length;
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(base, crc32(salt)), 0);
  trailer.writeUInt32LE(rawBytes % 2 ** 32, 4);

  return {
    rawBytes,
    digest: createHash("sha256").update(salt).update(base).digest("hex"),
    trailer: trailer.toString("hex"),
  };
});

/** The gzip trailer, CRC-32 then length as little-endian hex, round `round` must end with. */
export function expectedGzipTrailer(seed: number, round = 0): string {
  return gzipRound(seed, round).trailer;
}

/** Gzip magic and the deflate method byte: every gzip member starts with these. */
export const gzipMagic = "1f8b08";

/**
 * Compressed size over raw size. zlib level 6 gives 0.223 on this corpus for every seed tried;
 * the range leaves room for other zlib builds, and rejects stored (about 1.0) or truncated output.
 */
const gzipRatioRange = { min: 0.15, max: 0.3 } as const;

/** Minimum timed gzip rounds; each is about 0.17 s on a fast core. */
const gzipMinRounds = 3;

/** The digest round `round` must print: SHA-256 of its decompressed corpus. */
export function expectedGzipDigest(seed: number, round = 0): string {
  return gzipRound(seed, round).digest;
}

/** Every round's corpus size in bytes for `seed`: the salt line keeps it the same. */
export function expectedGzipRawBytes(seed: number): number {
  return gzipRound(seed, 0).rawBytes;
}

export const gzipGuestScript = `import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
${rngSource}
${nodeRoundsSource}
const seed = Number(process.argv[2]) >>> 0;
const words = ${JSON.stringify(words)};
const word = (next) => words[next() % words.length];
const next = rng32(seed ^ 0x6a1b);
const records = [];
for (let i = 0; i < ${gzipRecordCount}; i++) {
  const deps = [];
  const depCount = 1 + (next() % 5);
  for (let d = 0; d < depCount; d++)
    deps.push(\`"@\${word(next)}/\${word(next)}":"^\${next() % 9}.\${next() % 20}.\${next() % 30}"\`);
  records.push(
    \`"name":"@\${word(next)}/\${word(next)}-\${word(next)}","version":"\${next() % 9}.\${next() % 40}.\${next() % 99}",\` +
      \`"main":"src/\${word(next)}/\${word(next)}.ts","size":\${next() % 100000},"deps":{\${deps.join(",")}}}\`,
  );
}
const lines = [];
let total = 0;
for (let seq = 0; total < ${gzipTargetBytes}; seq++) {
  const line = \`{"seq":\${seq},\${records[next() % ${gzipRecordCount}]}\\n\`;
  lines.push(line);
  total += line.length;
}
const base = Buffer.from(lines.join(""), "utf8");
const prepare = (round) => {
  const salt = createHash("sha256").update(seed + ":gzip:" + round).digest("hex");
  return Buffer.concat([Buffer.from('{"salt":"' + salt + '"}\\n', "utf8"), base]);
};
const rounds = await timedRounds(${gzipMinRounds}, prepare, (corpus) => {
  const compressed = gzipSync(corpus, { level: 6 });
  const restored = gunzipSync(compressed);
  return {
    proof: createHash("sha256").update(restored).digest("hex"),
    compressedBytes: compressed.length,
    head: compressed.subarray(0, 3).toString("hex"),
    trailer: compressed.subarray(-8).toString("hex"),
  };
});
console.log(JSON.stringify({ seed, rawBytes: prepare(0).length, rounds, digest: rounds[0].proof }));
`;

const gzipReply = z.strictObject({
  seed: seedField,
  rawBytes: z.number().int().positive(),
  rounds: roundsWith({
    compressedBytes: z.number().int().positive(),
    head: z.string(),
    trailer: z.string().regex(/^[0-9a-f]{16}$/),
  }),
  digest: hexDigest,
});

type GzipRound = z.infer<typeof gzipReply>["rounds"][number];

/**
 * Why a round's gzip evidence is not its own corpus's. The roundtrip digest alone is the corpus
 * hash, which skipping compression also yields; the member header, the trailer's CRC-32 and
 * length of that round's corpus, and a ratio in zlib's range only come from compressing it.
 */
function gzipRoundWrong(seed: number, round: GzipRound, index: number): string | null {
  const expected = gzipRound(seed, index);

  if (round.head !== gzipMagic) return `output starts ${round.head}, not a gzip member`;

  if (round.trailer !== expected.trailer)
    return "gzip trailer CRC-32 or length does not match the round's corpus";

  const ratio = round.compressedBytes / expected.rawBytes;

  if (ratio < gzipRatioRange.min || ratio > gzipRatioRange.max)
    return `compression ratio ${ratio.toFixed(3)} is not plausible`;

  if (round.proof !== expected.digest) return "roundtrip digest does not match the round's corpus";

  return null;
}

function verifyGzip(raw: string, seed: number): VerifyResult {
  const reply = decode(gzipReply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  const rawBytes = expectedGzipRawBytes(seed);

  if (data.rawBytes !== rawBytes)
    return { ok: false, reason: `corpus is ${data.rawBytes} bytes, want ${rawBytes}` };

  if (data.digest !== expectedGzipDigest(seed))
    return { ok: false, reason: "digest does not match the seed" };

  const fastest = fastestRate(data.rounds, rawBytes / bytesPerMegabyte);

  if (fastest > maxMegabytesPerSecond)
    return { ok: false, reason: `implausible rate ${fastest} MB/s` };

  const rounds = checkRounds({
    rounds: data.rounds,
    minRounds: gzipMinRounds,
    check: (round, index) => gzipRoundWrong(seed, round, index),
  });

  if (!rounds.ok) return rounds;

  const compressedBytes = data.rounds.reduce((sum, round) => sum + round.compressedBytes, 0);

  return {
    ok: true,
    value: (rawBytes * rounds.count) / bytesPerMegabyte / rounds.totalSeconds,
    proof: data.digest,
    details: {
      rawBytes,
      compressedBytes: Math.round(compressedBytes / rounds.count),
      rounds: rounds.count,
      seconds: rounds.totalSeconds,
    },
  };
}

const cpuGzipCompress: ExpandedScenario = {
  id: "cpu-gzip-compress",
  category: "cpu",
  label: "gzip roundtrip",
  description:
    "Compresses and decompresses a seeded 8 MiB JSON corpus with zlib, salted differently each round, in rounds for at least a second, and checks every round's roundtrip digest and gzip CRC-32.",
  unit: "MB/s",
  better: "higher",
  async run(box, ctx) {
    const raw = await runGuestScript(box, ctx, "gzip.mjs", gzipGuestScript);

    return outcomeOf("cpu-gzip-compress", verifyGzip(raw, ctx.seed));
  },
  verifyOutput: verifyGzip,
};

// ---------------------------------------------------------------------------------------------
// cpu-json-parse
// ---------------------------------------------------------------------------------------------

/** Parse, traverse and stringify rounds the guest runs. */
export const jsonIterations = 40;
const jsonPackageCount = 2300;

interface JsonDependency {
  readonly name: string;
  readonly range: string;
  readonly optional: boolean;
}

interface JsonFileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly lines: number;
}

interface JsonPackage {
  readonly name: string;
  readonly version: string;
  readonly deps: readonly JsonDependency[];
  readonly files: readonly JsonFileEntry[];
  readonly scripts: { readonly build: string; readonly test: string };
  readonly deprecated: null | string;
}

interface JsonAstNode {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly children: readonly JsonAstNode[];
}

interface JsonGraph {
  readonly root: string;
  readonly seed: number;
  readonly packages: readonly JsonPackage[];
  readonly ast: JsonAstNode;
}

function jsonAst(next: () => number, depth: number, start: number): JsonAstNode {
  const children: JsonAstNode[] = [];
  const width = depth >= 5 ? 0 : 2 + (next() % 3);
  let cursor = start + 1;

  for (let i = 0; i < width; i++) {
    const child = jsonAst(next, depth + 1, cursor);
    children.push(child);
    cursor = child.end + 1;
  }

  return { kind: word(next), start, end: cursor + (next() % 40), children };
}

/** The seeded package graph plus a nested AST, about 1 MiB once stringified. */
export function jsonDocument(seed: number): string {
  const next = rng32(seed ^ 0x750a);
  const packages: JsonPackage[] = [];

  for (let i = 0; i < jsonPackageCount; i++) {
    const deps: JsonDependency[] = [];
    const files: JsonFileEntry[] = [];
    const depCount = next() % 6;
    const fileCount = 1 + (next() % 4);

    for (let d = 0; d < depCount; d++)
      deps.push({
        name: `@${word(next)}/${word(next)}`,
        range: `^${next() % 9}.${next() % 20}.0`,
        optional: next() % 7 === 0,
      });

    for (let f = 0; f < fileCount; f++)
      files.push({
        path: `src/${word(next)}/${word(next)}.ts`,
        bytes: next() % 50_000,
        lines: next() % 2_000,
      });

    packages.push({
      name: `@${word(next)}/${word(next)}-${i}`,
      version: `${next() % 9}.${next() % 40}.${next() % 99}`,
      deps,
      files,
      scripts: { build: `tsc -p ${word(next)}`, test: `vitest run ${word(next)}` },
      deprecated: next() % 11 === 0 ? `use @${word(next)}/${word(next)}` : null,
    });
  }

  const graph: JsonGraph = {
    root: `@${word(next)}/app`,
    seed: seed >>> 0,
    packages,
    ast: jsonAst(next, 0, 0),
  };

  return JSON.stringify(graph);
}

function mixHash(hash: number, value: number): number {
  return Math.imul(hash ^ (value >>> 0), 0x01000193) >>> 0;
}

function mixText(hash: number, text: string): number {
  let h = mixHash(hash, text.length);

  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;

  return h;
}

const jsonValue = z.json();

type JsonValue = z.infer<typeof jsonValue>;

function isJsonText(value: JsonValue): value is string {
  return typeof value === "string";
}

function isJsonNumber(value: JsonValue): value is number {
  return typeof value === "number";
}

function isJsonFlag(value: JsonValue): value is boolean {
  return typeof value === "boolean";
}

/** FNV-style walk in document order. Mirrored by `walk` in the guest script. */
function walkJson(hash: number, value: JsonValue): number {
  if (value === null) return mixHash(hash, 3);

  if (isJsonText(value)) return mixText(hash, value);

  if (isJsonNumber(value)) return mixHash(hash, value | 0);

  if (isJsonFlag(value)) return mixHash(hash, value ? 1 : 2);

  if (Array.isArray(value)) {
    let h = mixHash(hash, 0xa1 + value.length);

    for (const item of value) h = walkJson(h, item);

    return h;
  }

  let h = mixHash(hash, 0xb2);

  for (const [key, item] of Object.entries(value)) h = walkJson(mixText(h, key), item);

  return h;
}

/**
 * The document size and checksum the guest must print for `seed`. Iteration `i` starts its walk
 * from a hash of `i`, so each of the 40 checksums needs its own walk; one walk reused fails.
 */
const jsonExpected = memo((seed: number) => {
  const text = jsonDocument(seed);
  const doc = jsonValue.parse(JSON.parse(text));
  let acc = 0x811c9dc5;

  for (let i = 0; i < jsonIterations; i++)
    acc = mixHash(mixHash(acc, i), walkJson(mixHash(0x811c9dc5, i), doc));

  return {
    bytes: text.length,
    checksum: createHash("sha256")
      .update(`${seed >>> 0}:${jsonIterations}:${text.length}:${acc}`)
      .digest("hex"),
  };
});

/** The checksum the guest must print for `seed`. */
export function expectedJsonChecksum(seed: number): string {
  return jsonExpected(seed).checksum;
}

/** The exact length of the seeded document. */
export function expectedJsonBytes(seed: number): number {
  return jsonExpected(seed).bytes;
}

export const jsonGuestScript = `import { createHash } from "node:crypto";
${rngSource}
const seed = Number(process.argv[2]) >>> 0;
const words = ${JSON.stringify(words)};
const word = (next) => words[next() % words.length];
const next = rng32(seed ^ 0x750a);
function ast(depth, start) {
  const children = [];
  const width = depth >= 5 ? 0 : 2 + (next() % 3);
  let cursor = start + 1;
  for (let i = 0; i < width; i++) {
    const child = ast(depth + 1, cursor);
    children.push(child);
    cursor = child.end + 1;
  }
  return { kind: word(next), start, end: cursor + (next() % 40), children };
}
const packages = [];
for (let i = 0; i < ${jsonPackageCount}; i++) {
  const deps = [];
  const files = [];
  const depCount = next() % 6;
  const fileCount = 1 + (next() % 4);
  for (let d = 0; d < depCount; d++)
    deps.push({ name: \`@\${word(next)}/\${word(next)}\`, range: \`^\${next() % 9}.\${next() % 20}.0\`, optional: next() % 7 === 0 });
  for (let f = 0; f < fileCount; f++)
    files.push({ path: \`src/\${word(next)}/\${word(next)}.ts\`, bytes: next() % 50000, lines: next() % 2000 });
  packages.push({
    name: \`@\${word(next)}/\${word(next)}-\${i}\`,
    version: \`\${next() % 9}.\${next() % 40}.\${next() % 99}\`,
    deps,
    files,
    scripts: { build: \`tsc -p \${word(next)}\`, test: \`vitest run \${word(next)}\` },
    deprecated: next() % 11 === 0 ? \`use @\${word(next)}/\${word(next)}\` : null,
  });
}
const text = JSON.stringify({ root: \`@\${word(next)}/app\`, seed, packages, ast: ast(0, 0) });
const mix = (h, v) => Math.imul(h ^ (v >>> 0), 0x01000193) >>> 0;
const mixText = (h, s) => {
  h = mix(h, s.length);
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
};
function walk(h, v) {
  if (Array.isArray(v)) {
    h = mix(h, 0xa1 + v.length);
    for (const item of v) h = walk(h, item);
    return h;
  }
  if (v !== null && typeof v === "object") {
    h = mix(h, 0xb2);
    for (const [key, item] of Object.entries(v)) h = walk(mixText(h, key), item);
    return h;
  }
  if (typeof v === "string") return mixText(h, v);
  if (typeof v === "number") return mix(h, v | 0);
  return mix(h, v === null ? 3 : v ? 1 : 2);
}
const started = performance.now();
let acc = 0x811c9dc5;
for (let i = 0; i < ${jsonIterations}; i++) {
  const doc = JSON.parse(text);
  const walked = walk(mix(0x811c9dc5, i), doc);
  if (JSON.stringify(doc).length !== text.length) {
    console.error("stringify roundtrip mismatch");
    process.exit(1);
  }
  acc = mix(mix(acc, i), walked);
}
const seconds = (performance.now() - started) / 1000;
const checksum = createHash("sha256").update(\`\${seed}:${jsonIterations}:\${text.length}:\${acc}\`).digest("hex");
console.log(JSON.stringify({ seed, iterations: ${jsonIterations}, bytes: text.length, seconds, checksum }));
`;

const jsonReply = z.strictObject({
  seed: seedField,
  iterations: z.number().int().positive(),
  bytes: z.number().int().positive(),
  seconds,
  checksum: hexDigest,
});

function verifyJson(raw: string, seed: number): VerifyResult {
  const reply = decode(jsonReply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.iterations !== jsonIterations)
    return { ok: false, reason: `ran ${data.iterations} iterations, want ${jsonIterations}` };

  if (data.bytes !== expectedJsonBytes(seed))
    return {
      ok: false,
      reason: `document is ${data.bytes} bytes, want ${expectedJsonBytes(seed)}`,
    };

  if (data.checksum !== expectedJsonChecksum(seed))
    return { ok: false, reason: "checksum does not match the seed" };

  const value = data.iterations / data.seconds;

  if ((data.bytes * value) / bytesPerMegabyte > maxMegabytesPerSecond)
    return { ok: false, reason: `implausible rate ${value} ops/s` };

  return {
    ok: true,
    value,
    proof: data.checksum,
    details: { bytes: data.bytes, seconds: data.seconds },
  };
}

const cpuJsonParse: ExpandedScenario = {
  id: "cpu-json-parse",
  category: "cpu",
  label: "JSON parse and walk",
  description:
    "Parses, walks and re-serializes a seeded 1 MiB package-graph JSON document 40 times in Node.",
  unit: "ops/s",
  better: "higher",
  async run(box, ctx) {
    const raw = await runGuestScript(box, ctx, "json.mjs", jsonGuestScript);

    return outcomeOf("cpu-json-parse", verifyJson(raw, ctx.seed));
  },
  verifyOutput: verifyJson,
};

// ---------------------------------------------------------------------------------------------
// cpu-prime-sieve
// ---------------------------------------------------------------------------------------------

/** Where the first window may start; above 10^8 the work per number is close to flat. */
const sieveWindowBase = 100_000_000;
/** How far the seed moves the first window. */

const sieveSeedSpread = 8_000_000;
/** Numbers each round sieves. */

const sieveWindowSize = 16_000_000;
const sieveSegmentBytes = 1 << 18;
/** Most rounds a reply may carry, so every window stays below 2^32 for its u32 encoding. */

const sieveMaxRounds = 250;

/**
 * The window round `round` sieves: `[low, high]`. Windows of one seed are consecutive and never
 * overlap, so no round's primes can be reused for another round.
 */
export function sieveWindow(seed: number, round = 0) {
  const low = sieveWindowBase + ((seed >>> 0) % sieveSeedSpread) + round * sieveWindowSize;

  return { low, high: low + sieveWindowSize - 1 };
}

/** Every prime in `[low, high]`, by a segmented sieve of Eratosthenes. Mirrored in the guest script. */
function segmentedSieve(low: number, high: number): Uint32Array {
  const root = Math.floor(Math.sqrt(high));
  const small = new Uint8Array(root + 1);
  const base: number[] = [];

  for (let i = 2; i <= root; i++) {
    if (small[i] !== 0) continue;

    base.push(i);

    for (let j = i * i; j <= root; j += i) small[j] = 1;
  }

  const segment = new Uint8Array(sieveSegmentBytes);
  const primes = new Uint32Array(Math.ceil(((high - low + 1) / Math.log(low)) * 1.3) + 16);
  let count = 0;

  for (let from = low; from <= high; from += sieveSegmentBytes) {
    const to = Math.min(from + sieveSegmentBytes - 1, high);
    segment.fill(0);

    for (const p of base) {
      if (p * p > to) break;

      for (let j = Math.max(p * p, Math.ceil(from / p) * p); j <= to; j += p) segment[j - from] = 1;
    }

    for (let i = from; i <= to; i++) if (segment[i - from] === 0) primes[count++] = i;
  }

  return primes.subarray(0, count);
}

/**
 * What round `round` must print: its window, its prime count, and SHA-256 over (seed, round) then
 * every prime in its window, each as a little-endian u32. The host sieves every round's window
 * itself, because the evidence is the work.
 */
export const expectedSieve = perRound((seed, round) => {
  const { low, high } = sieveWindow(seed, round);
  const primes = segmentedSieve(low, high);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(seed >>> 0, 0);
  head.writeUInt32LE(round, 4);
  const body = Buffer.alloc(primes.length * 4);

  for (let i = 0; i < primes.length; i++) body.writeUInt32LE(primes[i] ?? 0, i * 4);

  return {
    low,
    high,
    count: primes.length,
    digest: createHash("sha256").update(head).update(body).digest("hex"),
  };
});

/** Minimum timed sieve rounds; each is about 0.1 s on a fast core. */
const sieveMinRounds = 3;

export const sieveGuestScript = `import { createHash } from "node:crypto";
${nodeRoundsSource}
const seed = Number(process.argv[2]) >>> 0;
const SEGMENT = ${sieveSegmentBytes};
const prepare = (round) => {
  const low = ${sieveWindowBase} + (seed % ${sieveSeedSpread}) + round * ${sieveWindowSize};
  return { round, low, high: low + ${sieveWindowSize} - 1 };
};
const rounds = await timedRounds(${sieveMinRounds}, prepare, ({ round, low, high }) => {
const root = Math.floor(Math.sqrt(high));
const small = new Uint8Array(root + 1);
const base = [];
for (let i = 2; i <= root; i++) {
  if (small[i] !== 0) continue;
  base.push(i);
  for (let j = i * i; j <= root; j += i) small[j] = 1;
}
const segment = new Uint8Array(SEGMENT);
const primes = new Uint32Array(Math.ceil(((high - low + 1) / Math.log(low)) * 1.3) + 16);
let count = 0;
for (let from = low; from <= high; from += SEGMENT) {
  const to = Math.min(from + SEGMENT - 1, high);
  segment.fill(0);
  for (const p of base) {
    if (p * p > to) break;
    for (let j = Math.max(p * p, Math.ceil(from / p) * p); j <= to; j += p) segment[j - from] = 1;
  }
  for (let i = from; i <= to; i++) if (segment[i - from] === 0) primes[count++] = i;
}
const head = Buffer.alloc(8);
head.writeUInt32LE(seed, 0);
head.writeUInt32LE(round, 4);
const body = Buffer.alloc(count * 4);
for (let i = 0; i < count; i++) body.writeUInt32LE(primes[i], i * 4);
return { proof: createHash("sha256").update(head).update(body).digest("hex"), low, high, count };
});
console.log(JSON.stringify({ seed, rounds, digest: rounds[0].proof }));
`;

const sieveReply = z.strictObject({
  seed: seedField,
  rounds: roundsWith({
    low: z.number().int().positive(),
    high: z.number().int().positive(),
    count: z.number().int().positive(),
  }),
  digest: hexDigest,
});

type SieveRound = z.infer<typeof sieveReply>["rounds"][number];

/** Upper bound on sieve throughput, in numbers per second; well above any CPU run so far. */
const maxSieveRate = 5e10;

function sieveRoundWrong(seed: number, round: SieveRound, index: number): string | null {
  const expected = expectedSieve(seed, index);

  if (round.low !== expected.low || round.high !== expected.high)
    return `window ${round.low}..${round.high}, want ${expected.low}..${expected.high}`;

  if (round.count !== expected.count)
    return `counted ${round.count} primes, want ${expected.count}`;

  if (round.proof !== expected.digest) return "prime digest does not match the round's window";

  return null;
}

function verifySieve(raw: string, seed: number): VerifyResult {
  const reply = decode(sieveReply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.rounds.length > sieveMaxRounds)
    return { ok: false, reason: `ran ${data.rounds.length} rounds, at most ${sieveMaxRounds}` };

  if (data.digest !== expectedSieve(seed, 0).digest)
    return { ok: false, reason: "digest does not match the seed" };

  const rounds = checkRounds({
    rounds: data.rounds,
    minRounds: sieveMinRounds,
    check: (round, index) => sieveRoundWrong(seed, round, index),
  });

  if (!rounds.ok) return rounds;

  const fastest = sieveWindowSize / Math.min(...data.rounds.map((round) => round.seconds));

  if (fastest > maxSieveRate) return { ok: false, reason: `implausible rate ${fastest} ops/s` };

  return {
    ok: true,
    value: (sieveWindowSize * rounds.count) / rounds.totalSeconds,
    proof: data.digest,
    details: {
      windowSize: sieveWindowSize,
      firstWindowPrimes: expectedSieve(seed, 0).count,
      rounds: rounds.count,
      seconds: rounds.totalSeconds,
    },
  };
}

const cpuPrimeSieve: ExpandedScenario = {
  id: "cpu-prime-sieve",
  category: "cpu",
  label: "Prime sieve",
  description:
    "Runs a segmented sieve of Eratosthenes over a 16-million-number window above 100 million, a new non-overlapping window each round, and hashes every prime found, in rounds for at least a second.",
  unit: "ops/s",
  better: "higher",
  async run(box, ctx) {
    const raw = await runGuestScript(box, ctx, "sieve.mjs", sieveGuestScript);

    return outcomeOf("cpu-prime-sieve", verifySieve(raw, ctx.seed));
  },
  verifyOutput: verifySieve,
};

export const cpuScenarios: readonly ExpandedScenario[] = [
  cpuSha256Hash,
  cpuGzipCompress,
  cpuJsonParse,
  cpuPrimeSieve,
];
