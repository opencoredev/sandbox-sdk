/**
 * Host-side artifacts for the services benchmark, built once by `bun bench services prepare` into a
 * cache directory of `<sha256>` files plus `artifacts.json`:
 *
 * - node:    the pinned Node tarball, as nodejs.org serves it.
 * - fixture: bench/fixtures/services-api with node_modules from `npm ci` against its lockfile, as a
 *            deterministic tar.gz (sorted, mtime 0, numeric owners, gzip -n).
 * - native:  the no-Docker bundle: Zonky's relocatable Postgres 16.16 binaries and a static
 *            redis-server 7.4.12 built here from the pinned source. The build is not bit-for-bit
 *            reproducible (Redis embeds a build ID), so each run records the bundle hash it used.
 *
 * Every input is checked against its pinned sha256 before use, and every artifact again when read.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { fixtureDir, node, redisSource, zonkyPostgres, type PinnedDownload } from "./pins.js";

const run = promisify(execFile);

export const artifactsFile = "artifacts.json";

const artifactSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
});

export const artifactsSchema = z.object({
  schema: z.literal("svc-artifacts/1"),
  createdAt: z.string(),
  node: artifactSchema.extend({ version: z.string() }),
  fixture: artifactSchema.extend({ sourceSha256: z.string() }),
  native: artifactSchema.extend({
    postgresInputSha256: z.string(),
    redisSourceSha256: z.string(),
    redisBuild: z.string(),
  }),
});

export type Artifacts = z.infer<typeof artifactsSchema>;

export type ArtifactRole = "node" | "fixture" | "native";

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export const defaultCacheDir = join(
  process.env.HOME ?? tmpdir(),
  ".cache",
  "sandbox-bench",
  "services",
);

/** The fixture directory, from bench/src/services. */
export const fixturePath = resolve(import.meta.dirname, "..", "..", fixtureDir);

async function listFiles(dir: string, root = dir): Promise<string[]> {
  const out: string[] = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) out.push(...(await listFiles(full, root)));
    else if (entry.isFile()) out.push(relative(root, full));
  }

  return out.sort();
}

/** One hash over the fixture's own files (path and content), without node_modules. */
export async function fixtureSourceHash(dir = fixturePath): Promise<string> {
  const hash = createHash("sha256");

  for (const file of await listFiles(dir)) {
    hash.update(`${file}\0`);
    hash.update(sha256(await readFile(join(dir, file))));
    hash.update("\n");
  }

  return hash.digest("hex");
}

async function download(pin: PinnedDownload, dir: string): Promise<string> {
  const path = join(dir, pin.sha256);

  try {
    if (sha256(await readFile(path)) === pin.sha256) return path;
  } catch {
    // Not cached yet.
  }

  const response = await fetch(pin.url, { signal: AbortSignal.timeout(600_000) });

  if (!response.ok) throw new Error(`${pin.url}: HTTP ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  const actual = sha256(data);

  if (actual !== pin.sha256)
    throw new Error(`${pin.url}: sha256 ${actual}, expected ${pin.sha256}`);
  await writeFile(`${path}.partial`, data);
  await rename(`${path}.partial`, path);

  return path;
}

/** A deterministic gzip tar of `dir`'s contents. */
async function pack(dir: string, out: string) {
  await run(
    "sh",
    [
      "-c",
      'tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C "$1" . | gzip -n -9 > "$2"',
      "pack",
      dir,
      out,
    ],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
}

async function store(cacheDir: string, file: string) {
  const data = await readFile(file);
  const hash = sha256(data);
  await cp(file, join(cacheDir, hash));
  await rm(file, { force: true });

  return { sha256: hash, bytes: data.byteLength };
}

async function buildFixture(cacheDir: string, work: string) {
  const stage = join(work, "fixture");
  await cp(fixturePath, stage, {
    recursive: true,
    filter: (source) => !source.split("/").includes("node_modules"),
  });
  await run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stage,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  await pack(stage, join(work, "fixture.tar.gz"));

  return store(cacheDir, join(work, "fixture.tar.gz"));
}

/** Whether `bytes` start a 64-bit little-endian ELF for x86_64 (e_machine 62, EM_X86_64). */
export function x86_64Elf(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  return (
    bytes.byteLength >= 20 &&
    view.getUint32(0) === 0x7f454c46 &&
    bytes[4] === 2 &&
    bytes[5] === 1 &&
    view.getUint16(18, true) === 62
  );
}

async function buildNative(cacheDir: string, inputs: string, work: string) {
  const stage = join(work, "native");
  await mkdir(join(stage, "pg"), { recursive: true });
  await mkdir(join(stage, "redis"), { recursive: true });

  // The Maven jar is a zip holding postgres-linux-x86_64.txz.
  const jar = await download(zonkyPostgres, inputs);
  await run(
    "python3",
    [
      "-I",
      "-c",
      "import sys,zipfile;zipfile.ZipFile(sys.argv[1]).extract('postgres-linux-x86_64.txz',sys.argv[2])",
      jar,
      work,
    ],
    { timeout: 120_000 },
  );
  await run("tar", ["-xJf", join(work, "postgres-linux-x86_64.txz"), "-C", join(stage, "pg")], {
    timeout: 120_000,
  });

  const source = await download(redisSource, inputs);
  await run("tar", ["-xzf", source, "-C", work], { timeout: 120_000 });
  const tree = join(work, "redis-7.4.12");

  const flags = [
    "MALLOC=libc",
    "BUILD_TLS=no",
    "USE_SYSTEMD=no",
    "CFLAGS=-static",
    "LDFLAGS=-static",
  ];

  await run("make", ["-j8", ...flags, "redis-server"], {
    cwd: tree,
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  await run("strip", [
    "-o",
    join(stage, "redis", "redis-server"),
    join(tree, "src", "redis-server"),
  ]);

  // The guests run x86_64 only: a Redis built for the host's own machine would not start there.
  if (!x86_64Elf(await readFile(join(stage, "redis", "redis-server"))))
    throw new Error("redis-server was not built as an x86_64 ELF; prepare on a Linux x86_64 host");
  const { stdout: version } = await run(join(stage, "redis", "redis-server"), ["--version"]);
  const { stdout: gcc } = await run("gcc", ["--version"]);
  await pack(stage, join(work, "native.tar.gz"));
  const stored = await store(cacheDir, join(work, "native.tar.gz"));

  return {
    ...stored,
    postgresInputSha256: zonkyPostgres.sha256,
    redisSourceSha256: redisSource.sha256,
    redisBuild: `${version.trim()}; ${gcc.split("\n")[0]}; static glibc`,
  };
}

/** Build every artifact into `cacheDir` and write its artifacts.json. */
export async function prepareArtifacts(cacheDir = defaultCacheDir): Promise<Artifacts> {
  const inputs = join(cacheDir, "inputs");
  await mkdir(inputs, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "sbx-services-"));

  try {
    const nodePath = await download(node, inputs);
    await cp(nodePath, join(cacheDir, node.sha256));

    const artifacts: Artifacts = {
      schema: "svc-artifacts/1",
      createdAt: new Date().toISOString(),
      node: { sha256: node.sha256, bytes: (await stat(nodePath)).size, version: node.version },
      fixture: { ...(await buildFixture(cacheDir, work)), sourceSha256: await fixtureSourceHash() },
      native: await buildNative(cacheDir, inputs, work),
    };

    await writeFile(join(cacheDir, artifactsFile), `${JSON.stringify(artifacts, null, 2)}\n`);

    return artifacts;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The pins a manifest was built from that differ from the current ones: Node, the Postgres
 * binaries and the Redis source. Results are labelled with the current pins, so any difference
 * means the cache must be rebuilt.
 */
export function stalePins(artifacts: Artifacts): string[] {
  return [
    artifacts.node.sha256 !== node.sha256 || artifacts.node.version !== node.version
      ? "the Node tarball"
      : null,
    artifacts.native.postgresInputSha256 !== zonkyPostgres.sha256 ? "the Postgres binaries" : null,
    artifacts.native.redisSourceSha256 !== redisSource.sha256 ? "the Redis source" : null,
  ].filter((pin): pin is string => pin !== null);
}

/** artifacts.json, refused when the fixture or any pinned input changed after it was built. */
export async function readArtifacts(cacheDir = defaultCacheDir): Promise<Artifacts> {
  let text: string;

  try {
    text = await readFile(join(cacheDir, artifactsFile), "utf8");
  } catch {
    throw new Error(`No ${artifactsFile} in ${cacheDir}; run \`bun bench services prepare\` first`);
  }

  const artifacts = artifactsSchema.parse(JSON.parse(text));
  const source = await fixtureSourceHash();

  if (source !== artifacts.fixture.sourceSha256)
    throw new Error(
      `bench/${fixtureDir} changed since its artifact was built; run \`bun bench services prepare\` again`,
    );
  const stale = stalePins(artifacts);

  if (stale.length)
    throw new Error(
      `${artifactsFile} in ${cacheDir} was built from other pins than the current ones (${stale.join(", ")}); run \`bun bench services prepare\` again`,
    );

  return artifacts;
}

/** An artifact's bytes, checked against its hash. */
export async function readArtifact(cacheDir: string, hash: string): Promise<Uint8Array> {
  const data = await readFile(join(cacheDir, hash));
  const actual = sha256(data);

  if (actual !== hash) throw new Error(`Artifact ${hash} has hash ${actual}`);

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
