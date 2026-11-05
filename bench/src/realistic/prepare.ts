/**
 * The harness side of the prepare phase, before the profile's own prepare steps (clone, package
 * manager, offline install). It checks free disk, detects the architecture, fetches the pinned
 * toolchain and the dependency cache by hash from one URL we host, rejects any hash mismatch before
 * extracting, and uploads the frozen patches. Each download is timed on its own, so network time is
 * reported apart from compute.
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

export interface PrepareSettings {
  /** The one URL we host. Every object is fetched from `<cacheBaseUrl>/<sha256>`. */
  cacheBaseUrl: string;
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
      const url = `${settings.cacheBaseUrl.replace(/\/+$/, "")}/${artifact.sha256}`;
      const startedAt = clock.now();

      const fetched = await run(
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
        `mkdir -p ${quote(into)} && tar -xf ${quote(dest)} -C ${quote(into)} --strip-components=${strip} && rm -f -- ${quote(dest)}`,
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
