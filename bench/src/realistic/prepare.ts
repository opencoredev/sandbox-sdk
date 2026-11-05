/**
 * The harness side of the prepare phase, before the profile's own prepare steps (clone, package
 * manager, offline install). It checks free disk, detects the architecture, fetches the pinned
 * toolchain and the dependency cache by hash from one URL we host, rejects any hash mismatch before
 * extracting, and uploads the frozen patches. Each download is timed on its own, so network time is
 * reported apart from compute.
 *
 * Without a hosted URL, `upload` sends each artifact from a local store through the SDK's file
 * transfer instead, in fixed-size chunks joined inside the sandbox. The joined file goes through the
 * same sha256 check before extraction, and the upload is timed as the artifact's transfer.
 */
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Sandbox } from "@opencoredev/sandbox-sdk";
import { quote } from "../workloads.js";
import type { Clock } from "./gaps.js";
import {
  archSchema,
  expand,
  type Arch,
  type Artifact,
  type HarnessManifest,
  type Placeholders,
  type Profile,
} from "./manifest.js";
import { sha256Hex, type BlobStore } from "./steps.js";

/** Local artifacts by sha256, for the upload transfer. */
export interface ArtifactSource {
  /** The artifact's bytes; the store checks the hash once when it first reads the file. */
  read(sha256: string): Promise<Uint8Array>;
}

export interface UploadSettings {
  source: ArtifactSource;
  /** Bytes per `files.write` call. Default 8 MiB, inside every adapter's single-write limit. */
  chunkBytes?: number;
  /** Chunks in flight at once. Default 4. */
  concurrency?: number;
}

export interface PrepareSettings {
  /** The one URL we host. Every object is fetched from `<cacheBaseUrl>/<sha256>`. */
  cacheBaseUrl: string;
  /** Upload from a local store through the SDK instead of fetching from `cacheBaseUrl`. */
  upload?: UploadSettings;
  /** Fetch command with `{url}` and `{dest}`; the default is curl. */
  fetchCommand?: string;
  fetchTimeoutMs?: number;
}

export const defaultFetchCommand = "curl -fsSL --retry 2 --connect-timeout 30 -o {dest} {url}";

export type ArtifactRole = "toolchain" | "dependency-cache";

export interface DownloadRecord {
  role: ArtifactRole;
  sha256: string;
  url: string;
  startedAt: number;
  endedAt: number;
  bytes: number | null;
  hashOk: boolean;
}

export type PrepareFailure =
  | { kind: "unsupported-arch"; uname: string }
  | { kind: "insufficient-disk"; freeGiB: number | null; requiredGiB: number }
  | { kind: "missing-artifact"; role: ArtifactRole; arch: Arch }
  | { kind: "fetch"; role: ArtifactRole; exitCode: number | null; detail: string }
  | { kind: "hash-mismatch"; role: ArtifactRole; expected: string; actual: string | null }
  | { kind: "extract"; role: ArtifactRole; exitCode: number | null; detail: string }
  | { kind: "error"; detail: string };

export type PrepareResult =
  | {
      kind: "ready";
      arch: Arch;
      downloads: DownloadRecord[];
      placeholders: Placeholders;
      env: Record<string, string>;
      path: string[];
    }
  | { kind: "failed"; failure: PrepareFailure; downloads: DownloadRecord[] };

const unameArch = new Map([
  ["x86_64", "x86-64"],
  ["amd64", "x86-64"],
  ["aarch64", "arm64"],
  ["arm64", "arm64"],
]);

/** Directory layout for one attempt's harness-owned files. */
export function layout(workdir: string, vcpu: number): Placeholders {
  return {
    vcpu,
    workdir,
    cache: posix.join(workdir, ".rw/cache"),
    toolchain: posix.join(workdir, ".rw/toolchain"),
    pm: posix.join(workdir, ".rw/pm"),
  };
}

const tail = (text: string) => text.slice(-800);

/**
 * Extract an archive that already passed its hash check. Images without `xz` (Superserve's) cannot
 * open the pinned `.tar.xz` toolchain with tar alone, so an xz stream is decompressed by Python's
 * lzma there; the artifact and its hash are unchanged.
 */
export function untar(archive: string, into: string, strip: number): string {
  const plain = `tar -xf ${quote(archive)} -C ${quote(into)} --strip-components=${strip}`;

  const viaPython = `python3 -c 'import lzma, shutil, sys; shutil.copyfileobj(lzma.open(sys.argv[1]), sys.stdout.buffer)' ${quote(archive)} | tar -x -C ${quote(into)} --strip-components=${strip}`;

  // An xz stream starts with fd 37 7a 58 5a 00.
  const isXz = `[ "$(head -c 6 ${quote(archive)} | od -An -tx1 | tr -d ' \\n')" = fd377a585a00 ]`;

  return `if command -v xz >/dev/null 2>&1 || ! ${isXz}; then ${plain}; else ${viaPython}; fi`;
}

/** Local files by sha256; each is read and hash-checked once, then shared by every attempt. */
export function fileArtifacts(paths: ReadonlyMap<string, string>): ArtifactSource {
  const cache = new Map<string, Promise<Uint8Array>>();

  return {
    read(sha256) {
      let pending = cache.get(sha256);

      if (!pending) {
        const path = paths.get(sha256);

        if (!path) return Promise.reject(new Error(`No local artifact ${sha256}`));

        pending = readFile(path).then((data) => {
          const actual = sha256Hex(data);

          if (actual !== sha256) throw new Error(`Local artifact ${path} has hash ${actual}`);

          return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        });

        cache.set(sha256, pending);
      }

      return pending;
    },
  };
}

/** Write `data` to `dest` through the SDK in chunks, then join them inside the sandbox. */
async function uploadArtifact(input: {
  box: Sandbox;
  data: Uint8Array;
  dest: string;
  settings: UploadSettings;
  signal: AbortSignal;
}): Promise<{ exitCode: number | null; output: string }> {
  const size = input.settings.chunkBytes ?? 8 * 1024 * 1024;
  const count = Math.max(1, Math.ceil(input.data.byteLength / size));
  const name = (index: number) => `${input.dest}.part-${String(index).padStart(5, "0")}`;
  let next = 0;

  const worker = async () => {
    while (next < count) {
      const index = next++;

      const chunk = input.data.subarray(index * size, (index + 1) * size);

      // Rewriting the same bytes to the same path is idempotent, so a failed chunk is retried.
      for (let attempt = 1; ; attempt++) {
        input.signal.throwIfAborted();

        try {
          await input.box.files.write(name(index), chunk);
          break;
        } catch (cause) {
          if (attempt >= 3) throw cause;
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(count, input.settings.concurrency ?? 4) }, worker),
  );

  const joined = await input.box.run(
    `cat ${quote(input.dest)}.part-* > ${quote(input.dest)} && rm -f -- ${quote(input.dest)}.part-*`,
    { cwd: "/", timeoutMs: 600_000, signal: input.signal, maxOutputBytes: 64 * 1024 },
  );

  return { exitCode: joined.exitCode, output: joined.output };
}

/** Blobs read from a local directory of `<sha256>` files, each checked on read. */
export function directoryBlobs(directory: string): BlobStore {
  return {
    async get(sha256) {
      const data = await readFile(join(directory, sha256));
      const actual = sha256Hex(data);

      if (actual !== sha256) throw new Error(`Blob ${sha256} has hash ${actual}`);

      return data;
    },
  };
}

interface PrepareInput {
  box: Sandbox;
  clock: Clock;
  signal: AbortSignal;
  manifest: HarnessManifest;
  profile: Profile;
  vcpu: number;
  workdir: string;
  blobs: BlobStore;
  settings: PrepareSettings;
}

export async function prepare(input: PrepareInput): Promise<PrepareResult> {
  const { box, clock, signal, manifest, profile, workdir, settings } = input;
  const downloads: DownloadRecord[] = [];

  const failed = (failure: PrepareFailure): PrepareResult => ({
    kind: "failed",
    failure,
    downloads,
  });

  const placeholders = layout(workdir, input.vcpu);

  const run = (command: string, timeoutMs = 120_000) =>
    box.run(command, { cwd: "/", timeoutMs, signal, maxOutputBytes: 64 * 1024 });

  try {
    const probe = await run(
      `mkdir -p ${quote(posix.join(workdir, ".rw/dl"))} && uname -m && df -Pk ${quote(workdir)} | tail -n 1`,
    );

    if (probe.exitCode !== 0) return failed({ kind: "error", detail: tail(probe.output) });
    const [uname = "", dfLine = ""] = probe.stdout.trim().split("\n");
    const arch = archSchema.safeParse(unameArch.get(uname.trim()));

    if (!arch.success) return failed({ kind: "unsupported-arch", uname: uname.trim() });
    const availableKiB = Number(dfLine.trim().split(/\s+/)[3]);
    const freeGiB = Number.isFinite(availableKiB) ? availableKiB / 1024 / 1024 : null;

    if (freeGiB === null || freeGiB < profile.minFreeDiskGiB)
      return failed({ kind: "insufficient-disk", freeGiB, requiredGiB: profile.minFreeDiskGiB });

    const fetch = async (
      role: ArtifactRole,
      artifact: Artifact | undefined,
      into: string,
      strip: number,
    ): Promise<PrepareFailure | null> => {
      if (!artifact) return { kind: "missing-artifact", role, arch: arch.data };
      const dest = posix.join(workdir, ".rw/dl", artifact.sha256);
      const upload = settings.upload;

      const url = upload
        ? `sdk-upload:${artifact.sha256}`
        : `${settings.cacheBaseUrl.replace(/\/+$/, "")}/${artifact.sha256}`;

      const startedAt = clock.now();

      const fetched = upload
        ? await uploadArtifact({
            box,
            data: await upload.source.read(artifact.sha256),
            dest,
            settings: upload,
            signal,
          }).catch((cause: unknown) => ({
            exitCode: null,
            output: cause instanceof Error ? cause.message : String(cause),
          }))
        : await run(
            expand(settings.fetchCommand ?? defaultFetchCommand, placeholders)
              .replaceAll("{url}", quote(url))
              .replaceAll("{dest}", quote(dest)),
            settings.fetchTimeoutMs ?? 600_000,
          );

      const endedAt = clock.now();

      const record: DownloadRecord = {
        role,
        sha256: artifact.sha256,
        url,
        startedAt,
        endedAt,
        bytes: null,
        hashOk: false,
      };

      downloads.push(record);

      if (fetched.exitCode !== 0)
        return { kind: "fetch", role, exitCode: fetched.exitCode, detail: tail(fetched.output) };
      const hashed = await run(`sha256sum -- ${quote(dest)} && stat -c %s -- ${quote(dest)}`);
      const [hashLine = "", sizeLine = ""] = hashed.stdout.trim().split("\n");
      const actual = /^[0-9a-f]{64}/.exec(hashLine)?.[0] ?? null;
      record.bytes = Number.isFinite(Number(sizeLine)) ? Number(sizeLine) : null;
      record.hashOk = actual === artifact.sha256;

      if (!record.hashOk) {
        // A rejected download is never extracted.
        await run(`rm -f -- ${quote(dest)}`);

        return { kind: "hash-mismatch", role, expected: artifact.sha256, actual };
      }

      const extracted = await run(
        `mkdir -p ${quote(into)} && ${untar(dest, into, strip)} && rm -f -- ${quote(dest)}`,
        600_000,
      );

      return extracted.exitCode === 0
        ? null
        : { kind: "extract", role, exitCode: extracted.exitCode, detail: tail(extracted.output) };
    };

    const toolchain = manifest.toolchains[profile.toolchain.node];

    if (!toolchain) return failed({ kind: "error", detail: "Unknown toolchain" });

    const toolchainFailure = await fetch(
      "toolchain",
      toolchain.tarballs[arch.data],
      placeholders.toolchain,
      toolchain.stripComponents,
    );

    if (toolchainFailure) return failed(toolchainFailure);

    if (profile.dependencyCache) {
      const cacheFailure = await fetch(
        "dependency-cache",
        profile.dependencyCache.archives[arch.data],
        placeholders.cache,
        0,
      );

      if (cacheFailure) return failed(cacheFailure);
    }

    for (const patch of Object.values(profile.patches))
      await box.files.write(posix.join(workdir, patch.file), await input.blobs.get(patch.sha256));

    return {
      kind: "ready",
      arch: arch.data,
      downloads,
      placeholders,
      env: {
        CACHE: placeholders.cache,
        PM: placeholders.pm,
        TOOLCHAIN: placeholders.toolchain,
        BENCH_VCPU: String(input.vcpu),
      },
      path: [posix.join(placeholders.toolchain, "bin"), posix.join(placeholders.pm, "bin")],
    };
  } catch (error) {
    return failed({
      kind: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}
