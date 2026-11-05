/**
 * The harness manifest for realistic workloads (SBX-96).
 *
 * It is the machine-checkable form of SBX-95's frozen `manifest.json` (`rw-manifest/1`). Field names
 * follow that file where it is already concrete: `toolchains.<key>.tarballs.<arch>.{url,sha256}`,
 * `profiles.<name>.{repo,commit,lockfile,toolchain,env,commands,patches,dependencyCache,minFreeDiskGiB}`,
 * and the session rig's per-step `exit`, `outputInvariants`, `postconditions.files`, `dependsOn`,
 * `gapAfterPrereqMs` and `overlapsWith`. What SBX-95 states in prose (`completionChecks`, the command
 * `sequence`) becomes `steps`, each with a frozen `check`, so the harness decides success from data.
 *
 * Every artifact the prepare phase fetches is hash-addressed: it is downloaded from
 * `<cacheBaseUrl>/<sha256>`, one URL we host, and rejected unless its hash matches.
 */
import { z } from "zod";

export const archSchema = z.enum(["x86-64", "arm64"]);

export type Arch = z.infer<typeof archSchema>;

export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase sha256");

const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "Expected a kebab-case id");

/** A path relative to the attempt's working directory. Absolute paths and `..` are refused. */
const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) => !path.startsWith("/") && !path.split("/").includes(".."),
    "Expected a relative path inside the working directory",
  );

/** One hash-addressed object. `url` is upstream provenance only; the harness fetches by hash. */
export const artifactSchema = z.object({
  sha256: sha256Schema,
  bytes: z.number().int().positive().optional(),
  file: z.string().min(1).optional(),
  url: z.url().optional(),
});

export type Artifact = z.infer<typeof artifactSchema>;

const perArch = z
  .object({ "x86-64": artifactSchema.optional(), arm64: artifactSchema.optional() })
  .refine((value) => value["x86-64"] || value.arm64, "Expected at least one architecture");

export const toolchainSchema = z.object({
  version: z.string().min(1),
  tarballs: perArch,
  /** Leading path components to drop on extraction (Node tarballs have one top-level directory). */
  stripComponents: z.number().int().min(0).max(4).default(1),
});

const testCounts = z
  .object({
    passed: z.number().int().nonnegative().optional(),
    failed: z.number().int().nonnegative().optional(),
    skipped: z.number().int().nonnegative().optional(),
    todo: z.number().int().nonnegative().optional(),
  })
  .strict();

export type TestCounts = z.infer<typeof testCounts>;

/** Output invariants, named as the session rig (`rig/common.py`) records them. */
export const outputInvariantsSchema = z
  .object({
    tests: testCounts.optional(),
    testFiles: testCounts.optional(),
    tscErrors: z.number().int().nonnegative().optional(),
    /** Each line must appear among the normalised output's key error lines. */
    keyErrorLines: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type OutputInvariants = z.infer<typeof outputInvariantsSchema>;

export const normaliseRuleSchema = z.enum([
  "ansi",
  "iso-timestamps",
  "clock-times",
  "durations",
  "pids",
  "ports",
  "hex-ids",
  "paths",
]);

export type NormaliseRule = z.infer<typeof normaliseRuleSchema>;

/** The rig's rules, in its order. Test order is normalised by sorting key lines. */
export const defaultNormalisation: NormaliseRule[] = [
  "paths",
  "ansi",
  "iso-timestamps",
  "clock-times",
  "durations",
  "pids",
  "ports",
  "hex-ids",
];

/** A test excluded from completion (timing-sensitive). It still runs; its outcome is recorded. */
export const excludedTestSchema = z.object({
  /** Matched as a path suffix of the report's test file, since checkout paths differ. */
  file: z.string().min(1).optional(),
  /** The runner's full test name (vitest `fullName`). */
  name: z.string().min(1),
  reason: z.string().min(1),
});

export type ExcludedTest = z.infer<typeof excludedTestSchema>;

export const expectedExitSchema = z.union([
  z.number().int().min(0).max(255),
  z.literal("non-zero"),
  z.literal("any"),
]);

export type ExpectedExit = z.infer<typeof expectedExitSchema>;

export const stepCheckSchema = z
  .object({
    /** Expected exit status. Non-zero is data: a recorded failing run must fail again. */
    exit: expectedExitSchema.default(0),
    outputInvariants: outputInvariantsSchema.default({}),
    /** Per-test report (path relative to the working directory), read after the step; required for exclusions. */
    testReport: z.object({ kind: z.literal("vitest-json"), path: relativePath }).optional(),
    exclude: z.array(excludedTestSchema).default([]),
    postconditions: z
      .object({
        /** sha256 of files the step leaves behind, relative to the working directory. */
        files: z.record(relativePath, sha256Schema).default({}),
        /** Files that must exist afterwards (build outputs). */
        exists: z.array(relativePath).default([]),
      })
      .default({ files: {}, exists: [] }),
    normalise: z.array(normaliseRuleSchema).default(defaultNormalisation),
  })
  .refine((check) => check.exclude.length === 0 || check.testReport, {
    message: "Excluded tests need a per-test report (testReport) to be counted out",
    path: ["exclude"],
  });

export type StepCheck = z.infer<typeof stepCheckSchema>;

export const stepOpSchema = z.discriminatedUnion("kind", [
  /** A named entry of the profile's `commands`, as SBX-95's `sequence` refers to them. */
  z.object({ kind: z.literal("command"), name: z.string().min(1) }),
  /** A literal script, as a recorded session step holds it. */
  z.object({ kind: z.literal("shell"), script: z.string().min(1) }),
  /** Write a recorded blob (by hash) to a path: a replayed built-in edit. */
  z.object({ kind: z.literal("write"), path: relativePath, blob: sha256Schema }),
  /** Read a file: a replayed built-in read. */
  z.object({ kind: z.literal("read"), path: relativePath }),
  /** A tool call that touches nothing in the sandbox. It becomes a harness-side wait only. */
  z.object({ kind: z.literal("none") }),
]);

export type StepOp = z.infer<typeof stepOpSchema>;

export const readinessSchema = z.discriminatedUnion("kind", [
  /** A TCP connect to 127.0.0.1:port answers (probed with bash's /dev/tcp). */
  z.object({ kind: z.literal("port"), port: z.number().int().min(1).max(65535) }),
  /** The process's output contains a line matching this pattern. */
  z.object({ kind: z.literal("line"), pattern: z.string().min(1) }),
]);

export type ReadinessCheck = z.infer<typeof readinessSchema>;

/** A background process the step starts, with the rig's start, readiness and shutdown events. */
export const backgroundSchema = z.object({
  id: idSchema,
  readiness: readinessSchema,
  /** Frozen readiness timeout for steps that need this process. */
  readinessTimeoutMs: z.number().int().positive().default(120_000),
  shutdown: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("step"), step: idSchema }),
    z.object({ kind: z.literal("exits") }),
    z.object({ kind: z.literal("session-end") }),
  ]),
});

export type BackgroundSpec = z.infer<typeof backgroundSchema>;

export const phaseNameSchema = z.enum(["prepare", "workload", "resume"]);

export type StepPhase = z.infer<typeof phaseNameSchema>;

export const stepSchema = z.object({
  id: idSchema,
  phase: phaseNameSchema,
  op: stepOpSchema,
  /** Working directory relative to the attempt's working directory. */
  cwd: z.union([z.literal("."), relativePath]).default("."),
  timeoutMs: z.number().int().positive().optional(),
  /** Earlier steps this one follows. Omitted: the previous step. Empty: the session start. */
  dependsOn: z.array(idSchema).optional(),
  /** Think gap after the latest prerequisite completes; a harness-side wait. */
  gapAfterPrereqMs: z.number().int().nonnegative().default(0),
  /** Recorded overlaps, informational: steps whose prerequisites allow it run concurrently. */
  overlapsWith: z.array(idSchema).default([]),
  background: backgroundSchema.optional(),
  /** Background processes that must pass readiness before this step runs. */
  needs: z.array(idSchema).default([]),
  check: stepCheckSchema.default({
    exit: 0,
    outputInvariants: {},
    exclude: [],
    postconditions: { files: {}, exists: [] },
    normalise: defaultNormalisation,
  }),
  /** false: result recorded, not part of completion (the session's final regression test). */
  gating: z.boolean().default(true),
});

export type Step = z.infer<typeof stepSchema>;

const patchSchema = z.object({ file: relativePath, sha256: sha256Schema });

const profileBase = z.object({
  status: z.enum(["frozen", "draft"]),
  repo: z.url().optional(),
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  lockfile: z.object({ path: relativePath, sha256: sha256Schema }).optional(),
  toolchain: z.object({ node: z.string().min(1), packageManager: z.string().min(1).optional() }),
  env: z.record(z.string(), z.string()).default({}),
  commands: z.record(z.string(), z.string()).default({}),
  /** Uploaded to the working directory from the blob store before the first step, by hash. */
  patches: z.record(z.string(), patchSchema).default({}),
  dependencyCache: z.object({ archives: perArch }).optional(),
  minFreeDiskGiB: z.number().positive(),
  /** Default per-step deadline. */
  stepTimeoutMs: z.number().int().positive().default(600_000),
  /** The frozen slot timeout: one provider's outage delays a batch by at most this. */
  slotTimeoutMs: z.number().int().positive(),
  steps: z.array(stepSchema).min(1),
});

export const profileSchema = z
  .discriminatedUnion("kind", [
    profileBase.extend({ kind: z.literal("fix-and-test") }),
    profileBase.extend({ kind: z.literal("build") }),
    profileBase.extend({
      kind: z.literal("session"),
      scriptSha256: sha256Schema.optional(),
    }),
  ])
  .superRefine((profile, context) => {
    const ids = new Set<string>();
    const backgrounds = new Set<string>();

    for (const [index, step] of profile.steps.entries()) {
      const at = (message: string) =>
        context.addIssue({ code: "custom", message, path: ["steps", index] });

      if (ids.has(step.id)) at(`Duplicate step id ${step.id}`);

      for (const dependency of step.dependsOn ?? [])
        if (!ids.has(dependency)) at(`${step.id} depends on ${dependency}, which is not earlier`);

      for (const need of step.needs)
        if (!backgrounds.has(need)) at(`${step.id} needs ${need}, which no earlier step starts`);

      if (step.op.kind === "command" && profile.commands[step.op.name] === undefined)
        at(`${step.id} runs unknown command ${step.op.name}`);

      if (step.background && step.op.kind !== "command" && step.op.kind !== "shell")
        at(`${step.id} starts a background process but runs no command`);

      if (step.background) backgrounds.add(step.background.id);
      ids.add(step.id);
    }

    for (const [index, step] of profile.steps.entries())
      if (step.background?.shutdown.kind === "step" && !ids.has(step.background.shutdown.step))
        context.addIssue({
          code: "custom",
          message: `${step.id}'s process stops at unknown step ${step.background.shutdown.step}`,
          path: ["steps", index],
        });

    const workload = profile.steps.filter((step) => step.phase === "workload" && step.gating);

    if (!workload.length)
      context.addIssue({ code: "custom", message: "A profile needs a gating workload step" });

    if (
      profile.kind === "fix-and-test" &&
      !workload.some((step) => step.check.outputInvariants.tests || step.check.testReport)
    )
      context.addIssue({
        code: "custom",
        message: "fix-and-test needs a workload step that checks test counts",
      });

    if (
      profile.kind === "build" &&
      !workload.some((step) => step.check.postconditions.exists.length > 0)
    )
      context.addIssue({
        code: "custom",
        message: "build needs a workload step that checks its output files exist",
      });
  });

export type Profile = z.infer<typeof profileSchema>;

export type ProfileKind = Profile["kind"];

export const trackSchema = z.object({
  vcpu: z.number().int().positive(),
  memoryGiB: z.number().positive(),
});

export const harnessManifestSchema = z.object({
  schema: z.literal("rw-harness/1"),
  /** Provenance: the SBX-95 manifest this one was derived from. */
  source: z
    .object({ schema: z.string().min(1), issue: z.string().min(1), sha256: sha256Schema })
    .optional(),
  /** Root under which each attempt gets its own working directory. */
  workdir: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]+$/)
    .default("/workspace/rw"),
  tracks: z.record(idSchema, trackSchema),
  toolchains: z.record(z.string(), toolchainSchema),
  profiles: z.record(idSchema, profileSchema),
});

export type HarnessManifest = z.infer<typeof harnessManifestSchema>;

/** Parse manifest JSON at the boundary; also checks profiles' toolchain references. */
export function parseManifest(json: string): HarnessManifest {
  const manifest = harnessManifestSchema.parse(JSON.parse(json));

  for (const [name, profile] of Object.entries(manifest.profiles))
    if (!manifest.toolchains[profile.toolchain.node])
      throw new Error(`Profile ${name} uses unknown toolchain ${profile.toolchain.node}`);

  return manifest;
}

/** The placeholders a command may use. SBX-95 writes worker counts as `{vcpu}`. */
export interface Placeholders {
  vcpu: number;
  workdir: string;
  cache: string;
  toolchain: string;
  pm: string;
}

export function expand(template: string, values: Placeholders): string {
  return template.replace(/\{(vcpu|workdir|cache|toolchain|pm)\}/g, (_, key: string) => {
    switch (key) {
      case "vcpu":
        return String(values.vcpu);
      case "workdir":
        return values.workdir;
      case "cache":
        return values.cache;
      case "toolchain":
        return values.toolchain;
      default:
        return values.pm;
    }
  });
}

/** Resolve a step's dependencies: omitted means the step before it. */
export function dependenciesOf(profile: Pick<Profile, "steps">, index: number): string[] {
  const step = profile.steps[index];

  if (!step) return [];

  if (step.dependsOn) return step.dependsOn;
  const previous = profile.steps[index - 1];

  return previous ? [previous.id] : [];
}
