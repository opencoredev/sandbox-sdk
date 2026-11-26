/**
 * One services attempt (`svc-attempt/1`), one JSON line in services-attempts.jsonl. A failed
 * attempt is a record like any other: its stage, reason and the phases it reached are kept.
 */
import { z } from "zod";
import { expectedTests } from "./pins.js";
import { probeSchema } from "./probe.js";

export const attemptSchemaVersion = "svc-attempt/1";

/** compose: Docker (or a Docker-compatible daemon) runs compose.yaml. native: plain processes. */
export const servicePaths = ["compose", "native"] as const;

export type ServicePath = (typeof servicePaths)[number];

export const servicePathSchema = z.enum(servicePaths);

/** Where an attempt stopped. */
export const stages = [
  "create",
  "probe",
  "upload",
  "toolchain",
  "daemon",
  "image-pull",
  "services-start",
  "services-ready",
  "tests",
  "timeout",
  "error",
] as const;

export type Stage = (typeof stages)[number];

/** How the compose path got a daemon, in the order the ladder tries them. */
export const daemonMethods = [
  "preinstalled-running",
  "preinstalled-started",
  "static-rootful",
  "rootless",
  "podman",
] as const;

export type DaemonMethod = (typeof daemonMethods)[number];

const phaseSchema = z.object({
  name: z.string(),
  startedAt: z.number(),
  endedAt: z.number(),
  ok: z.boolean(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  note: z.string().optional(),
});

export type Phase = z.infer<typeof phaseSchema>;

const daemonTrySchema = z.object({
  method: z.enum(daemonMethods),
  config: z.string(),
  ok: z.boolean(),
  ms: z.number(),
  error: z.string().nullable(),
  /**
   * The failure is evidence about the sandbox itself: no daemon on the socket, a daemon log that
   * names a missing privilege or kernel feature, or storage that cannot mount. False for faults
   * that say nothing about Docker here (downloads, checksums, transport and exec errors, a daemon
   * that stayed silent or died without saying why). Rows from before this field read as false.
   */
  conclusive: z.boolean().default(false),
});

export type DaemonTry = z.infer<typeof daemonTrySchema>;

const daemonSchema = z.object({
  method: z.enum(daemonMethods).nullable(),
  config: z.string().nullable(),
  /** Methods the ladder did not try, with the probe fact that ruled each out. */
  skipped: z.array(z.object({ method: z.enum(daemonMethods), reason: z.string() })),
  tries: z.array(daemonTrySchema),
  storageDriver: z.string().nullable(),
  network: z.enum(["bridge", "host"]).nullable(),
  serverVersion: z.string().nullable(),
  compose: z.enum(["preinstalled", "fetched"]).nullable(),
  /** This attempt's own Compose project name, so no other attempt's containers are touched. */
  project: z.string().nullable().default(null),
  /**
   * The chosen daemon was launched by this attempt inside the sandbox (every method but
   * preinstalled-running), so it and everything it holds go with the sandbox.
   */
  launched: z.boolean().default(false),
  /** `compose down -v` of that project before the sandbox went: true when it exited 0. */
  down: z.boolean().nullable().default(null),
  /**
   * The ladder ran to its end: a method was chosen, or every method failed or was skipped (a storage
   * fallback that ran out included). False when a timeout, abort or vanished sandbox cut it short,
   * so the attempt says nothing about Docker.
   */
  // Rows from before this field read as unfinished: their daemon result stays out of the verdict.
  finished: z.boolean().default(false),
});

export type DaemonRecord = z.infer<typeof daemonSchema>;

const outcomeSchema = z.discriminatedUnion("kind", [
  // Green means every fixture test passed: a record claiming fewer is refused at the boundary.
  z.object({ kind: z.literal("green"), testsPassed: z.literal(expectedTests) }),
  z.object({
    kind: z.literal("failed"),
    stage: z.enum(stages),
    reason: z.string(),
    detail: z.string(),
  }),
  // The harness cannot measure this sandbox (its pinned artifacts do not run there): a result
  // about the provider, never counted as a failure.
  z.object({ kind: z.literal("unsupported"), reason: z.string(), detail: z.string() }),
]);

export type Outcome = z.infer<typeof outcomeSchema>;

const ms = z.number().nullable();

/**
 * Durations in ms; null when the attempt never got there.
 * - servicesUpMs: from the path's first service step (daemon setup or bundle upload) to both
 *   services answering. The headline.
 * - readyToGreenMs: from the first upload after the probe to the tests passing (create and the
 *   measurement-only probe excluded).
 */
export const metricsSchema = z.object({
  createMs: ms,
  probeMs: ms,
  uploadMs: ms,
  daemonReadyMs: ms,
  imagePullMs: ms,
  servicesStartMs: ms,
  servicesReadyMs: ms,
  servicesUpMs: ms,
  testsMs: ms,
  readyToGreenMs: ms,
});

export type Metrics = z.infer<typeof metricsSchema>;

/**
 * One line of projects.jsonl. `pending` is written before `compose up` can create anything on
 * that daemon; `down` after its `down` exited 0; `with-sandbox` after the sandbox's deletion
 * was confirmed, for a daemon this attempt launched inside it. Recovery treats every pending claim
 * without a later line as an obligation.
 */
export const projectEventSchema = z.object({
  provider: z.string(),
  attemptId: z.string(),
  project: z.string(),
  /** The daemon that holds it, as method/config. */
  daemon: z.string(),
  provenance: z.enum(["as-found", "launched"]),
  sandboxId: z.string().nullable(),
  state: z.enum(["pending", "down", "with-sandbox"]),
});

export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const projectCleanupSchema = z.enum(["none", "down", "with-sandbox", "open"]);

export type ProjectCleanup = z.infer<typeof projectCleanupSchema>;

/** A compose attempt whose project may still run on a daemon that outlives its sandbox. */
export const projectOpen = (record: { path: string; projectCleanup: ProjectCleanup }) =>
  record.path === "compose" && record.projectCleanup === "open";

export const attemptRecordSchema = z.object({
  schema: z.literal(attemptSchemaVersion),
  runId: z.string(),
  attemptId: z.string(),
  provider: z.string(),
  track: z.string(),
  path: servicePathSchema,
  attempt: z.number().int().positive(),
  sandboxIds: z.array(z.string()),
  startedAt: z.number(),
  endedAt: z.number(),
  probe: probeSchema.nullable(),
  probeError: z.string().nullable(),
  daemon: daemonSchema.nullable(),
  phases: z.array(phaseSchema),
  outcome: outcomeSchema,
  metrics: metricsSchema,
  deletionConfirmed: z.boolean(),
  /**
   * Everything the attempt made is gone: the sandbox's deletion is confirmed, and its Compose
   * project came down, or lived on a daemon this attempt launched inside that sandbox. Separate
   * from the outcome: a green workload can leave cleanup unconfirmed. Rows from before this field
   * read as unconfirmed.
   */
  cleanup: z.enum(["confirmed", "unconfirmed"]).default("unconfirmed"),
  /**
   * The Compose project's own obligation, tracked apart from the sandbox (attempt.ts
   * projectCleanupOf). `open` is never resolved by deleting the sandbox; `with-sandbox` is, once
   * that deletion is confirmed. Rows from before this field read as open (compose rows only count).
   */
  projectCleanup: projectCleanupSchema.default("open"),
  estimatedUSD: z.number().nullable(),
  artifacts: z.object({ node: z.string(), fixture: z.string(), native: z.string().nullable() }),
  outputDir: z.string().nullable(),
});

export type AttemptRecord = z.infer<typeof attemptRecordSchema>;
