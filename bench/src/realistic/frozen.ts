/**
 * SBX-95's frozen manifest (`rw-manifest/1`) as the harness manifest (`rw-harness/1`), for the two
 * release-1 profiles. What the frozen file states in prose becomes steps with frozen checks:
 *
 * - fix-and-test: the canonical offline sequence (`tools/profile_phases.py offline_install`), then
 *   patch A, typecheck, tests, patch B, typecheck, tests. Test counts come from vitest's JSON report
 *   with the timing-sensitive test excluded (`completionChecks.*.testsExcludingTimingSensitive`).
 *   The resume steps (held-open diagnostic) are `git status` and the test suite again.
 * - build: the offline install, then the build, which must leave the three bundles.
 *
 * The dependency cache's own hash check (`commands.depcache`) is the harness's prepare phase, which
 * checks every artifact's sha256 before extracting it. Commands keep the frozen text; only paths move
 * into the attempt's working directory.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManifest, type HarnessManifest } from "./manifest.js";

const sha = z.string().regex(/^[0-9a-f]{64}$/);

const artifact = z.object({ sha256: sha, url: z.string().optional(), file: z.string().optional() });

const frozenSchema = z.looseObject({
  schema: z.literal("rw-manifest/1"),
  issue: z.string(),
  toolchains: z.record(
    z.string(),
    z.looseObject({
      version: z.string(),
      tarballs: z.object({ "x86-64": artifact.optional(), arm64: artifact.optional() }),
    }),
  ),
  profiles: z.looseObject({
    "fix-and-test": z.looseObject({
      commit: z.string(),
      lockfile: z.object({ path: z.string(), sha256: sha }),
      toolchain: z.object({ node: z.string(), packageManager: z.string() }),
      env: z.record(z.string(), z.string()),
      commands: z.looseObject({
        clone: z.string(),
        packageManager: z.string(),
        installEnv: z.record(z.string(), z.string()),
        typecheck: z.string(),
        test: z.string(),
      }),
      patches: z.object({
        patchA: z.object({ file: z.string(), sha256: sha }),
        patchB: z.object({ file: z.string(), sha256: sha }),
      }),
      timingSensitiveTests: z.object({ tests: z.array(z.string()) }),
      completionChecks: z.object({
        afterPatchA: z.object({
          testsExcludingTimingSensitive: z.record(z.string(), z.number()),
        }),
        afterPatchB: z.object({
          testsExcludingTimingSensitive: z.record(z.string(), z.number()),
        }),
      }),
      minFreeDiskGiB: z.number(),
      dependencyCache: z.object({
        archives: z.object({ "x86-64": artifact, arm64: artifact }),
      }),
    }),
    build: z.looseObject({
      commit: z.string(),
      lockfile: z.object({ path: z.string(), sha256: sha }),
      toolchain: z.object({ node: z.string() }),
      env: z.record(z.string(), z.string()),
      commands: z.looseObject({
        clone: z.string(),
        packageManager: z.string(),
        build: z.string(),
      }),
      completionChecks: z.object({ outputs: z.record(z.string(), z.string()) }),
      minFreeDiskGiB: z.number(),
      dependencyCache: z.object({
        archives: z.object({ "x86-64": artifact, arm64: artifact }),
      }),
    }),
  }),
});

/** Per-step deadline: installs on the smallest sizes and 4,000-test suites need room. */
const stepTimeoutMs = 20 * 60_000;

/** Slot timeout for one headline attempt, upload and preparation included. */
export const SLOT_TIMEOUT_MS = 45 * 60_000;

/** Environment the reference runs set (`tools/profile_phases.py phases`), moved into the workdir. */
const homeEnv = {
  HOME: "{workdir}/home",
  XDG_CACHE_HOME: "{workdir}/.rw/xdg-cache",
  XDG_DATA_HOME: "{workdir}/.rw/xdg-data",
  XDG_CONFIG_HOME: "{workdir}/home/.config",
  XDG_STATE_HOME: "{workdir}/home/.state",
  NEXT_TELEMETRY_DISABLED: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  npm_config_update_notifier: "false",
};

/**
 * `$CACHE` in an env value is not shell-expanded; the harness expands `{cache}`. npm reads its
 * config from env case-insensitively and some images (Upstash) set `NPM_CONFIG_CACHE`, which then
 * wins, so the frozen cache is set in both cases.
 */
const npmCacheUpper = (env: Record<string, string>) =>
  env.npm_config_cache === undefined ? {} : { NPM_CONFIG_CACHE: env.npm_config_cache };

const placeholderEnv = (env: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, value.replaceAll("$CACHE", "{cache}")]),
  );

const setup = {
  id: "setup",
  phase: "prepare",
  op: { kind: "shell", script: "mkdir -p home .rw/xdg-cache .rw/xdg-data" },
} as const;

/** The frozen `<file> > <describe> > <test>` id as the harness matches it against vitest's report. */
function splitTestId(id: string): { file: string; name: string } {
  const at = id.indexOf(" > ");

  // vitest's `fullName` joins describe blocks and the test with spaces; the frozen ids use " > ".
  return at < 0
    ? { file: "", name: id }
    : { file: id.slice(0, at), name: id.slice(at + 3).replaceAll(" > ", " ") };
}

export function harnessManifestFromFrozen(json: string): HarnessManifest {
  const frozen = frozenSchema.parse(JSON.parse(json));
  const fat = frozen.profiles["fix-and-test"];
  const build = frozen.profiles.build;

  const toolchains = Object.fromEntries(
    Object.entries(frozen.toolchains)
      .filter(([name]) => name.startsWith("node-"))
      .map(([name, toolchain]) => [
        name,
        { version: toolchain.version, tarballs: toolchain.tarballs, stripComponents: 1 },
      ]),
  );

  const exclude = fat.timingSensitiveTests.tests.map((id) => ({
    ...splitTestId(id),
    reason: "Timing-sensitive (manifest timingSensitiveTests): runs and is recorded, not counted",
  }));

  // The frozen test command writes its JSON report to $REPORT; each test step gets its own file.
  const test = (report: string) => fat.commands.test.replace("$REPORT", `../.rw/${report}`);

  const testStep = (input: {
    id: string;
    command: string;
    report: string;
    phase: "workload" | "resume";
    counts: Record<string, number>;
    exit: 0 | 1;
  }) => ({
    id: input.id,
    phase: input.phase,
    cwd: "repo",
    op: { kind: "command", name: input.command },
    check: {
      exit: input.exit,
      outputInvariants: { tests: input.counts },
      testReport: { kind: "vitest-json", path: `.rw/${input.report}` },
      exclude,
    },
  });

  const install = {
    id: "install",
    phase: "prepare",
    cwd: "repo",
    op: { kind: "command", name: "install" },
    timeoutMs: stepTimeoutMs,
  } as const;

  const manifest = {
    schema: "rw-harness/1",
    source: {
      schema: frozen.schema,
      issue: frozen.issue,
      sha256: createHash("sha256").update(json).digest("hex"),
    },
    workdir: "/workspace/rw",
    tracks: {
      "same-machine": { vcpu: 4, memoryGiB: 8 },
      // Each provider's own default size; the CLI sets the worker count per provider.
      default: { vcpu: 2, memoryGiB: 4 },
    },
    toolchains,
    profiles: {
      "fix-and-test": {
        kind: "fix-and-test",
        status: "frozen",
        commit: fat.commit,
        lockfile: fat.lockfile,
        toolchain: fat.toolchain,
        env: {
          ...placeholderEnv(fat.env),
          ...placeholderEnv(fat.commands.installEnv),
          ...npmCacheUpper(placeholderEnv(fat.commands.installEnv)),
          ...homeEnv,
          pnpm_config_update_notifier: "false",
        },
        commands: {
          clone: fat.commands.clone,
          packageManager: fat.commands.packageManager,
          install:
            "sha256sum -c --quiet $CACHE/lockfile.sha256 && pnpm install --offline --store-dir $CACHE/store --frozen-lockfile",
          patchA: `git apply ../${fat.patches.patchA.file}`,
          patchB: `git apply ../${fat.patches.patchB.file}`,
          typecheck: fat.commands.typecheck,
          testA: test("report-a.json"),
          testB: test("report-b.json"),
          testResume: test("report-resume.json"),
          status: "git status --short",
        },
        patches: fat.patches,
        dependencyCache: fat.dependencyCache,
        minFreeDiskGiB: fat.minFreeDiskGiB,
        stepTimeoutMs,
        slotTimeoutMs: SLOT_TIMEOUT_MS,
        steps: [
          setup,
          { id: "clone", phase: "prepare", op: { kind: "command", name: "clone" } },
          {
            id: "package-manager",
            phase: "prepare",
            op: { kind: "command", name: "packageManager" },
          },
          install,
          {
            id: "patch-a",
            phase: "workload",
            cwd: "repo",
            op: { kind: "command", name: "patchA" },
          },
          {
            id: "typecheck-a",
            phase: "workload",
            cwd: "repo",
            op: { kind: "command", name: "typecheck" },
          },
          testStep({
            id: "test-a",
            command: "testA",
            report: "report-a.json",
            phase: "workload",
            counts: fat.completionChecks.afterPatchA.testsExcludingTimingSensitive,
            exit: 1,
          }),
          {
            id: "patch-b",
            phase: "workload",
            cwd: "repo",
            op: { kind: "command", name: "patchB" },
          },
          {
            id: "typecheck-b",
            phase: "workload",
            cwd: "repo",
            op: { kind: "command", name: "typecheck" },
          },
          testStep({
            id: "test-b",
            command: "testB",
            report: "report-b.json",
            phase: "workload",
            counts: fat.completionChecks.afterPatchB.testsExcludingTimingSensitive,
            exit: 0,
          }),
          {
            id: "resume-status",
            phase: "resume",
            cwd: "repo",
            op: { kind: "command", name: "status" },
          },
          testStep({
            id: "resume-test",
            command: "testResume",
            report: "report-resume.json",
            phase: "resume",
            counts: fat.completionChecks.afterPatchB.testsExcludingTimingSensitive,
            exit: 0,
          }),
        ],
      },
      build: {
        kind: "build",
        status: "frozen",
        commit: build.commit,
        lockfile: build.lockfile,
        toolchain: { node: build.toolchain.node, packageManager: "npm" },
        env: {
          ...placeholderEnv(build.env),
          ...npmCacheUpper(placeholderEnv(build.env)),
          ...homeEnv,
        },
        commands: {
          clone: build.commands.clone,
          packageManager: build.commands.packageManager,
          install: "sha256sum -c --quiet $CACHE/lockfile.sha256 && npm ci --no-fund --no-audit",
          build: build.commands.build,
        },
        dependencyCache: build.dependencyCache,
        minFreeDiskGiB: build.minFreeDiskGiB,
        stepTimeoutMs,
        slotTimeoutMs: SLOT_TIMEOUT_MS,
        steps: [
          setup,
          { id: "clone", phase: "prepare", op: { kind: "command", name: "clone" } },
          {
            id: "package-manager",
            phase: "prepare",
            op: { kind: "command", name: "packageManager" },
          },
          install,
          {
            id: "build",
            phase: "workload",
            cwd: "repo",
            op: { kind: "command", name: "build" },
            timeoutMs: stepTimeoutMs,
            check: {
              exit: 0,
              postconditions: {
                exists: Object.keys(build.completionChecks.outputs).map((path) => `repo/${path}`),
              },
            },
          },
        ],
      },
    },
  };

  return parseManifest(JSON.stringify(manifest));
}
