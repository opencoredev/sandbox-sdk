/**
 * A tiny fix-and-test fixture with the shape of SBX-95's frozen vue-core profile: a pinned git commit,
 * a pinned toolchain tarball, an offline install from a dependency-cache tarball, patch A (leaves one
 * test failing by design), patch B (all pass), plus a timing-sensitive test that is excluded from
 * completion but still runs. Every tarball is served hash-addressed from a local `file://` cache URL.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import {
  parseManifest,
  type HarnessManifest,
  type harnessManifestSchema,
  type profileSchema,
  type stepCheckSchema,
  type TestCounts,
} from "../../src/realistic/manifest.js";

type StepCheckInput = z.input<typeof stepCheckSchema>;

import { memoryBlobs, sha256Hex, type BlobStore } from "../../src/realistic/steps.js";

const runner = `import { writeFileSync } from "node:fs";
import { sum } from "./src/sum.mjs";
import pad from "left-pad";
const cases = [
  ["sum > adds", () => sum(2, 3) === 5],
  ["sum > handles zero", () => sum(0, 4) === 4],
  ["sum > negative", () => sum(-2, -3) === -5],
  ["pad > pads", () => pad("7", 3) === "007"],
  ["timing > finishes within 1ms", () => process.env.RW_FLAKY !== "fail"],
];
const results = cases.map(([fullName, run]) => ({ fullName, status: run() ? "passed" : "failed" }));
for (const r of results) console.log((r.status === "passed" ? " ✓ " : " FAIL ") + r.fullName);
const failed = results.filter((r) => r.status === "failed").length;
const passed = results.length - failed;
writeFileSync("report.json", JSON.stringify({ testResults: [{ name: process.cwd() + "/run-tests.mjs", assertionResults: results }] }));
console.log(" Tests  " + (failed ? failed + " failed | " : "") + passed + " passed (" + results.length + ") in 12ms at 2026-11-05T10:00:00Z pid 4242");
process.exit(failed ? 1 : 0);
`;

const buggy = `export function sum(a, b) {
  if (a === 0) return 0;
  if (a < 0) return a - b;
  return a + b;
}
`;

const half = `export function sum(a, b) {
  if (a < 0) return a - b;
  return a + b;
}
`;

const fixed = `export function sum(a, b) {
  return a + b;
}
`;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "rw",
      GIT_AUTHOR_EMAIL: "rw@example.invalid",
      GIT_COMMITTER_NAME: "rw",
      GIT_COMMITTER_EMAIL: "rw@example.invalid",
    },
  })
    .toString()
    .trim();

const diff = (cwd: string) => git(cwd, "diff") + "\n";

async function tarball(source: string, out: string, prefix: string) {
  execFileSync("tar", ["-czf", out, "-C", source, prefix]);

  return sha256Hex(await readFile(out));
}

export type ManifestInput = z.input<typeof harnessManifestSchema>;

export interface Fixture {
  root: string;
  cacheDir: string;
  cacheBaseUrl: string;
  manifest: HarnessManifest;
  manifestJson: string;
  /** The manifest before parsing, for tests that build invalid variants. */
  manifestInput: ManifestInput;
  blobs: BlobStore;
  cacheSha256: string;
  cleanup(): Promise<void>;
}

/** Steps for the fix-and-test profile; `exclude` names the timing-sensitive test. */
function profile(input: {
  patchA: string;
  patchB: string;
  commit: string;
  repoUrl: string;
  cacheSha: string;
}) {
  const testCheck = (counts: TestCounts, exit: number | "non-zero"): StepCheckInput => ({
    exit,
    outputInvariants: { tests: counts },
    testReport: { kind: "vitest-json" as const, path: "repo/report.json" },
    exclude: [
      {
        file: "run-tests.mjs",
        name: "timing > finishes within 1ms",
        reason: "Timing-sensitive; frozen as excluded",
      },
    ],
  });

  return {
    kind: "fix-and-test",
    status: "frozen",
    commit: input.commit,
    toolchain: { node: "fixture-node", packageManager: "cp" },
    // The excluded timing test fails on every run here, so exclusions are always exercised.
    env: { CI: "true", TZ: "UTC", WORKERS: "{vcpu}", RW_FLAKY: "fail" },
    commands: {
      clone: `git init -q repo && git -C repo fetch -q --depth 1 ${input.repoUrl} ${input.commit} && git -C repo checkout -q FETCH_HEAD`,
      install: `mkdir -p node_modules && cp -R "$CACHE/store/." node_modules/`,
      patchA: "git apply ../patches/a.patch",
      patchB: "git apply ../patches/b.patch",
      test: "rwnode run-tests.mjs",
      status: "git status --short",
    },
    patches: {
      patchA: { file: "patches/a.patch", sha256: input.patchA },
      patchB: { file: "patches/b.patch", sha256: input.patchB },
    },
    dependencyCache: {
      archives: { "x86-64": { sha256: input.cacheSha }, arm64: { sha256: input.cacheSha } },
    },
    minFreeDiskGiB: 0.01,
    stepTimeoutMs: 30_000,
    slotTimeoutMs: 60_000,
    steps: [
      { id: "clone", phase: "prepare", op: { kind: "command", name: "clone" } },
      { id: "install", phase: "prepare", cwd: "repo", op: { kind: "command", name: "install" } },
      { id: "patch-a", phase: "workload", cwd: "repo", op: { kind: "command", name: "patchA" } },
      {
        id: "test-a",
        phase: "workload",
        cwd: "repo",
        op: { kind: "command", name: "test" },
        check: testCheck({ passed: 3, failed: 1 }, "non-zero"),
      },
      { id: "patch-b", phase: "workload", cwd: "repo", op: { kind: "command", name: "patchB" } },
      {
        id: "test-b",
        phase: "workload",
        cwd: "repo",
        op: { kind: "command", name: "test" },
        check: testCheck({ passed: 4 }, 0),
      },
      {
        id: "resume-status",
        phase: "resume",
        cwd: "repo",
        op: { kind: "command", name: "status" },
      },
      {
        id: "resume-test",
        phase: "resume",
        cwd: "repo",
        op: { kind: "command", name: "test" },
        check: testCheck({ passed: 4 }, 0),
      },
    ],
  } satisfies z.input<typeof profileSchema>;
}

export async function buildFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "rw-fixture-"));
  const repo = join(root, "upstream");
  const cacheDir = join(root, "cache");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(cacheDir);
  await writeFile(join(repo, "run-tests.mjs"), runner);
  await writeFile(join(repo, "src/sum.mjs"), buggy);
  await writeFile(join(repo, "package.json"), '{ "name": "rw-fixture", "type": "module" }\n');
  await writeFile(join(repo, ".gitignore"), "node_modules\nreport.json\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "fixture");
  const commit = git(repo, "rev-parse", "HEAD");
  await writeFile(join(repo, "src/sum.mjs"), half);
  const patchA = diff(repo);
  // Patch B applies on top of patch A: diff it against a temporary commit of the half fix.
  git(repo, "commit", "-q", "-am", "half");
  await writeFile(join(repo, "src/sum.mjs"), fixed);
  const patchB = diff(repo);
  git(repo, "reset", "-q", "--hard", commit);

  // Toolchain: a pinned wrapper on PATH, as the Node tarball's bin/ would be.
  const tool = join(root, "tool");
  await mkdir(join(tool, "fixture-node-1/bin"), { recursive: true });
  await writeFile(join(tool, "fixture-node-1/bin/rwnode"), '#!/bin/sh\nexec node "$@"\n', {
    mode: 0o755,
  });
  const toolSha = await tarball(tool, join(root, "tool.tgz"), "fixture-node-1");
  // Dependency cache: one package in a store directory, installed offline by copying.
  const store = join(root, "depcache");
  await mkdir(join(store, "store/left-pad"), { recursive: true });
  await writeFile(
    join(store, "store/left-pad/package.json"),
    '{ "name": "left-pad", "type": "module", "main": "index.mjs" }\n',
  );
  await writeFile(
    join(store, "store/left-pad/index.mjs"),
    'export default (s, n) => String(s).padStart(n, "0");\n',
  );
  const cacheSha = await tarball(store, join(root, "depcache.tgz"), "store");
  await copyFile(join(root, "tool.tgz"), join(cacheDir, toolSha));
  await copyFile(join(root, "depcache.tgz"), join(cacheDir, cacheSha));

  const manifest = {
    schema: "rw-harness/1",
    workdir: "/workspace/rw",
    tracks: { "same-machine": { vcpu: 4, memoryGiB: 8 } },
    toolchains: {
      "fixture-node": {
        version: "1",
        tarballs: { "x86-64": { sha256: toolSha }, arm64: { sha256: toolSha } },
      },
    },
    profiles: {
      "fix-and-test": profile({
        patchA: sha256Hex(patchA),
        patchB: sha256Hex(patchB),
        commit,
        repoUrl: `file://${repo}`,
        cacheSha,
      }),
    },
  } satisfies ManifestInput;

  const manifestJson = JSON.stringify(manifest);
  const encoder = new TextEncoder();

  return {
    root,
    cacheDir,
    cacheBaseUrl: `file://${cacheDir}`,
    manifest: parseManifest(manifestJson),
    manifestJson,
    manifestInput: manifest,
    blobs: memoryBlobs([encoder.encode(patchA), encoder.encode(patchB)]),
    cacheSha256: cacheSha,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
