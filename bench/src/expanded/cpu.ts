import { createHash } from "node:crypto";
import { z } from "zod";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { command, quote } from "../workloads.js";
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
 * The guest scripts are plain JavaScript strings that mirror the TypeScript generators below.
 * `tests/expanded-cpu.test.ts` runs each script with the local `node` and checks its output passes
 * `verifyOutput`, so the two copies cannot drift apart unnoticed.
 */

const workDir = "/workspace/bench-cpu";
const bytesPerMegabyte = 1_000_000;

/** Upper bound on any claimed rate; a faster claim means the guest did not do the work it reports. */
const maxMegabytesPerSecond = 50_000;

const seconds = positiveSeconds;

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

/** The digest the guest must print: SHA-256 over the eight per-pass digests, each pass prefixed by (seed, pass). */
export const expectedSha256Digest = memo((seed: number) => {
  const data = sha256Buffer(seed);
  const outer = createHash("sha256");

  for (let pass = 0; pass < shaPasses; pass++) {
    const prefix = Buffer.alloc(8);
    prefix.writeUInt32LE(seed >>> 0, 0);
    prefix.writeUInt32LE(pass, 4);
    outer.update(createHash("sha256").update(prefix).update(data).digest());
  }

  return outer.digest("hex");
});

export const sha256GuestScript = `import { createHash } from "node:crypto";
${rngSource}
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
const started = performance.now();
const outer = createHash("sha256");
let bytes = 0;
for (let pass = 0; pass < PASSES; pass++) {
  const prefix = Buffer.alloc(8);
  prefix.writeUInt32LE(seed, 0);
  prefix.writeUInt32LE(pass, 4);
  const hash = createHash("sha256").update(prefix);
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    hash.update(data.subarray(offset, offset + CHUNK));
    bytes += Math.min(CHUNK, data.length - offset);
  }
  outer.update(hash.digest());
}
const digest = outer.digest("hex");
const seconds = (performance.now() - started) / 1000;
console.log(JSON.stringify({ seed, bytes, seconds, digest }));
`;

const sha256Reply = z.strictObject({
  seed: seedField,
  bytes: z.number().int().positive(),
  seconds,
  digest: hexDigest,
});

function verifySha256(raw: string, seed: number): VerifyResult {
  const reply = decode(sha256Reply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.bytes !== sha256TotalBytes)
    return { ok: false, reason: `hashed ${data.bytes} bytes, want ${sha256TotalBytes}` };

  if (data.digest !== expectedSha256Digest(seed))
    return { ok: false, reason: "digest does not match the seed" };

  const value = data.bytes / bytesPerMegabyte / data.seconds;

  if (value > maxMegabytesPerSecond) return { ok: false, reason: `implausible rate ${value} MB/s` };

  return {
    ok: true,
    value,
    proof: data.digest,
    details: { bytes: data.bytes, seconds: data.seconds },
  };
}

const cpuSha256Hash: ExpandedScenario = {
  id: "cpu-sha256-hash",
  category: "cpu",
  label: "SHA-256 hashing",
  description:
    "Streams SHA-256 over a seeded 32 MiB buffer eight times in Node and reports hashing throughput.",
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

const gzipExpected = memo((seed: number) => {
  const corpus = gzipCorpus(seed);

  return { rawBytes: corpus.length, digest: createHash("sha256").update(corpus).digest("hex") };
});

/** The digest the guest must print for `seed`: SHA-256 of the decompressed corpus. */
export function expectedGzipDigest(seed: number): string {
  return gzipExpected(seed).digest;
}

/** The corpus size in bytes for `seed`. */
export function expectedGzipRawBytes(seed: number): number {
  return gzipExpected(seed).rawBytes;
}

export const gzipGuestScript = `import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
${rngSource}
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
const raw = Buffer.from(lines.join(""), "utf8");
const expected = createHash("sha256").update(raw).digest("hex");
const started = performance.now();
const compressed = gzipSync(raw, { level: 6 });
const restored = gunzipSync(compressed);
const seconds = (performance.now() - started) / 1000;
const digest = createHash("sha256").update(restored).digest("hex");
if (digest !== expected || restored.length !== raw.length) {
  console.error("gzip roundtrip mismatch");
  process.exit(1);
}
console.log(JSON.stringify({ seed, rawBytes: raw.length, compressedBytes: compressed.length, seconds, digest }));
`;

const gzipReply = z.strictObject({
  seed: seedField,
  rawBytes: z.number().int().positive(),
  compressedBytes: z.number().int().positive(),
  seconds,
  digest: hexDigest,
});

function verifyGzip(raw: string, seed: number): VerifyResult {
  const reply = decode(gzipReply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  const expected = gzipExpected(seed);

  if (data.rawBytes !== expected.rawBytes)
    return { ok: false, reason: `corpus is ${data.rawBytes} bytes, want ${expected.rawBytes}` };

  // A structured corpus compresses at least 2x; anything outside (0, raw / 2) was not gzip of it.
  if (data.compressedBytes >= data.rawBytes / 2)
    return { ok: false, reason: `compressed size ${data.compressedBytes} is not plausible` };

  if (data.digest !== expected.digest)
    return { ok: false, reason: "digest does not match the seed" };

  const value = data.rawBytes / bytesPerMegabyte / data.seconds;

  if (value > maxMegabytesPerSecond) return { ok: false, reason: `implausible rate ${value} MB/s` };

  return {
    ok: true,
    value,
    proof: data.digest,
    details: {
      rawBytes: data.rawBytes,
      compressedBytes: data.compressedBytes,
      seconds: data.seconds,
    },
  };
}

const cpuGzipCompress: ExpandedScenario = {
  id: "cpu-gzip-compress",
  category: "cpu",
  label: "gzip roundtrip",
  description:
    "Compresses and decompresses a seeded 8 MiB JSON corpus with zlib and checks the roundtrip byte for byte.",
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

/** The checksum the guest must print for `seed`. */
export const expectedJsonChecksum = memo((seed: number) => {
  const text = jsonDocument(seed);
  const walked = walkJson(0x811c9dc5, jsonValue.parse(JSON.parse(text)));
  let acc = 0x811c9dc5;

  for (let i = 0; i < jsonIterations; i++) acc = mixHash(mixHash(acc, i), walked);

  return createHash("sha256")
    .update(`${seed >>> 0}:${jsonIterations}:${text.length}:${acc}`)
    .digest("hex");
});

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
  const walked = walk(0x811c9dc5, doc);
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

const sieveBaseLimit = 32_000_000;
const sieveLimitSpread = 8_000_000;
const sieveSegmentBytes = 1 << 18;

/** The sieve limit the guest must use for `seed`. */
export function sieveLimit(seed: number): number {
  return sieveBaseLimit + ((seed >>> 0) % sieveLimitSpread);
}

/** Every prime up to `limit`, by a segmented sieve of Eratosthenes. Mirrored in the guest script. */
function segmentedSieve(limit: number): Uint32Array {
  const root = Math.floor(Math.sqrt(limit));
  const small = new Uint8Array(root + 1);
  const base: number[] = [];

  for (let i = 2; i <= root; i++) {
    if (small[i] !== 0) continue;

    base.push(i);

    for (let j = i * i; j <= root; j += i) small[j] = 1;
  }

  const segment = new Uint8Array(sieveSegmentBytes);
  const primes = new Uint32Array(Math.ceil((limit / Math.log(limit)) * 1.3) + 16);
  let count = 0;

  for (let low = 2; low <= limit; low += sieveSegmentBytes) {
    const high = Math.min(low + sieveSegmentBytes - 1, limit);
    segment.fill(0);

    for (const p of base) {
      if (p * p > high) break;

      for (let j = Math.max(p * p, Math.ceil(low / p) * p); j <= high; j += p) segment[j - low] = 1;
    }

    for (let i = low; i <= high; i++) if (segment[i - low] === 0) primes[count++] = i;
  }

  return primes.subarray(0, count);
}

/** SHA-256 over the seed then every prime, each as a little-endian u32. */
function primeDigest(seed: number, primes: Uint32Array): string {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(seed >>> 0, 0);
  const body = Buffer.alloc(primes.length * 4);

  for (let i = 0; i < primes.length; i++) body.writeUInt32LE(primes[i] ?? 0, i * 4);

  return createHash("sha256").update(head).update(body).digest("hex");
}

/** The prime count and digest the guest must print for `seed`. */
export const expectedSieve = memo((seed: number) => {
  const primes = segmentedSieve(sieveLimit(seed));

  return { count: primes.length, digest: primeDigest(seed, primes) };
});

export const sieveGuestScript = `import { createHash } from "node:crypto";
const seed = Number(process.argv[2]) >>> 0;
const limit = ${sieveBaseLimit} + (seed % ${sieveLimitSpread});
const SEGMENT = ${sieveSegmentBytes};
const started = performance.now();
const root = Math.floor(Math.sqrt(limit));
const small = new Uint8Array(root + 1);
const base = [];
for (let i = 2; i <= root; i++) {
  if (small[i] !== 0) continue;
  base.push(i);
  for (let j = i * i; j <= root; j += i) small[j] = 1;
}
const segment = new Uint8Array(SEGMENT);
const primes = new Uint32Array(Math.ceil((limit / Math.log(limit)) * 1.3) + 16);
let count = 0;
for (let low = 2; low <= limit; low += SEGMENT) {
  const high = Math.min(low + SEGMENT - 1, limit);
  segment.fill(0);
  for (const p of base) {
    if (p * p > high) break;
    for (let j = Math.max(p * p, Math.ceil(low / p) * p); j <= high; j += p) segment[j - low] = 1;
  }
  for (let i = low; i <= high; i++) if (segment[i - low] === 0) primes[count++] = i;
}
const head = Buffer.alloc(4);
head.writeUInt32LE(seed, 0);
const body = Buffer.alloc(count * 4);
for (let i = 0; i < count; i++) body.writeUInt32LE(primes[i], i * 4);
const digest = createHash("sha256").update(head).update(body).digest("hex");
const seconds = (performance.now() - started) / 1000;
console.log(JSON.stringify({ seed, limit, count, seconds, digest }));
`;

const sieveReply = z.strictObject({
  seed: seedField,
  limit: z.number().int().positive(),
  count: z.number().int().positive(),
  seconds,
  digest: hexDigest,
});

/** Upper bound on sieve throughput, in numbers per second; well above any CPU run so far. */
const maxSieveRate = 5e10;

function verifySieve(raw: string, seed: number): VerifyResult {
  const reply = decode(sieveReply, raw);

  if (!reply.ok) return reply;

  const { data } = reply;

  if (data.seed !== seed >>> 0) return wrongSeed(data.seed, seed);

  if (data.limit !== sieveLimit(seed))
    return { ok: false, reason: `limit ${data.limit}, want ${sieveLimit(seed)}` };

  const expected = expectedSieve(seed);

  if (data.count !== expected.count)
    return { ok: false, reason: `counted ${data.count} primes, want ${expected.count}` };

  if (data.digest !== expected.digest)
    return { ok: false, reason: "digest does not match the seed" };

  const value = data.limit / data.seconds;

  if (value > maxSieveRate) return { ok: false, reason: `implausible rate ${value} ops/s` };

  return {
    ok: true,
    value,
    proof: data.digest,
    details: { limit: data.limit, primes: data.count, seconds: data.seconds },
  };
}

const cpuPrimeSieve: ExpandedScenario = {
  id: "cpu-prime-sieve",
  category: "cpu",
  label: "Prime sieve",
  description:
    "Runs a segmented sieve of Eratosthenes up to a seeded limit near 32 million and hashes every prime found.",
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
