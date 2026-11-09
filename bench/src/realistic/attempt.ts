/**
 * One attempt: create a sandbox, prepare (toolchain, cache, the profile's prepare steps), run the
 * workload, optionally hold it idle and run the resume steps, decide completion from the frozen checks,
 * and delete the sandbox at once, whatever happened. Headline time runs from the create request to the
 * confirmed deletion.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, type CreateOptions, type Sandbox } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { ProviderTrace, traceProvider, type Clock } from "./gaps.js";
import {
  holdIdle,
  managedIdleCapabilities,
  type IdlePlan,
  type StatePreservation,
} from "./idle.js";
import type { HarnessManifest, Profile } from "./manifest.js";
import { prepare, type PrepareSettings } from "./prepare.js";
import { readResources, resourcesBetween, type ResourceRead } from "./resources.js";
import {
  attemptSchemaVersion,
  type Attribution,
  type AttemptRecord,
  type Completion,
  type IdleRecord,
  type PhaseSpan,
  type Variant,
} from "./record.js";
import { failurePolicy, StepRunner, type BlobStore, type StepResult } from "./steps.js";

export interface AttemptPlan {
  runId: string;
  attemptId: string;
  provider: { name: string; provider: Provider };
  manifest: HarnessManifest;
  manifestSha256: string | null;
  profileName: string;
  track: string;
  variant: Variant;
  batch: number;
  slot: { index: number; id: string };
  seed: number;
  /** The slot's start, for the published start offset. */
  slotStartedAt: number;
  /** Size, image and lifetime for this provider and track. Labels are added by the harness. */
  create?: Omit<CreateOptions, "labels" | "signal" | "key">;
  /** Held-open and zero-wait variants: idle, then the profile's resume steps. */
  idle?: IdlePlan;
  /** Multiply every recorded think gap (0 for the dense run, 3 for gap scaling). Default 1. */
  gapScale?: number;
  /** The provider's state-preservation check; managed idle runs only after a passing one. */
  statePreservation?: StatePreservation;
  /** Working directory for this provider when the manifest's is not writable there. */
  workdir?: string;
  /** Worker count for this provider when its size differs from the track's (the default track). */
  vcpu?: number;
  /** Only the run label, for providers whose labels share a short name budget (Boat). */
  runLabelOnly?: boolean;
  /** Extra create labels, such as the label that routes a Modal create to the attempt's App. */
  labels?: Readonly<Record<string, string>>;
  /** Chunks in flight during an upload, for providers that refuse concurrent writes (Tenki). */
  uploadConcurrency?: number;
}

export interface AttemptEnvironment {
  clock: Clock;
  /** Aborted by the slot timeout. */
  signal: AbortSignal;
  blobs: BlobStore;
  prepare: PrepareSettings;
  attribution: Attribution;
  /** Raw step output goes to `<outputDir>/<attemptId>/<step>.log`. */
  outputDir?: string;
  /** Called with each new sandbox ID before any work, so the caller can journal it. */
  onSandbox?(provider: string, id: string): Promise<void>;
  /** Deadline for the deletion that always follows, even after a slot timeout. */
  destroyTimeoutMs?: number;
  /**
   * Called with each sandbox ID just before deletion, for usage a provider only reports while the
   * sandbox exists (Boat). Returns the file it wrote, which the record lists in usageFiles.
   */
  beforeDestroy?(provider: string, id: string): Promise<string | null>;
  /** Called when the create threw, so the caller can journal the failed allocation. */
  onCreateFailed?(provider: string, cause: unknown): Promise<void>;
  /** Called after each deletion returns, outside the destroy span (Modal's confirmed stop). */
  afterDestroy?(provider: string, id: string): Promise<void>;
}

export class SlotTimeout extends Error {}

function scaled(profile: Profile, scale: number): Profile {
  if (scale === 1) return profile;

  return {
    ...profile,
    steps: profile.steps.map((step) => ({
      ...step,
      gapAfterPrereqMs: Math.round(step.gapAfterPrereqMs * scale),
    })),
  };
}

function failureCompletion(results: readonly StepResult[], aborted: boolean): Completion | null {
  for (const result of results) {
    if (!result.gating || result.status === "passed") continue;

    if (aborted)
      return { kind: "incomplete", reason: "slot-timeout", detail: `Stopped at ${result.id}` };

    if (result.status === "failed" && result.timedOut)
      return { kind: "incomplete", reason: "step-timeout", detail: result.id };

    if (result.status === "failed")
      return {
        kind: "incomplete",
        reason: "check-failed",
        detail: `${result.id}: ${result.failures.map((failure) => failure.kind).join(", ")}`,
      };

    return {
      kind: "incomplete",
      reason: "check-failed",
      detail: `${result.id} blocked by ${result.blockedBy}`,
    };
  }

  return aborted ? { kind: "incomplete", reason: "slot-timeout", detail: "Aborted" } : null;
}

export async function runAttempt(plan: AttemptPlan, environment: AttemptEnvironment) {
  const { clock, signal } = environment;
  const profile = plan.manifest.profiles[plan.profileName];
  const track = plan.manifest.tracks[plan.track];

  if (!profile) throw new Error(`Unknown profile ${plan.profileName}`);

  if (!track) throw new Error(`Unknown track ${plan.track}`);
  const trace = new ProviderTrace(clock);
  const provider = traceProvider(plan.provider.provider, trace);
  const phases: PhaseSpan[] = [];
  const sandboxIds: string[] = [];
  const startedAt = clock.now();
  const outputs = new Map<string, string>();
  let completion: Completion = { kind: "completed" };
  let steps: StepResult[] = [];
  let downloads: AttemptRecord["downloads"] = [];
  let background: AttemptRecord["background"] = [];
  let idle: IdleRecord | null = null;
  let deletionConfirmed = false;
  let box: Sandbox | undefined;
  let firstRead: ResourceRead | null = null;
  const usageFiles: string[] = [];
  let lastRead: ResourceRead | null = null;
  const vcpu = plan.vcpu ?? track.vcpu;

  const span = async <T>(name: PhaseSpan["name"], action: () => Promise<T>, label?: string) => {
    const start = clock.now();

    try {
      return await action();
    } finally {
      const item: PhaseSpan = { name, startedAt: start, endedAt: clock.now() };

      if (label) item.label = label;
      phases.push(item);
    }
  };

  const managedBlocker =
    plan.idle?.policy !== "managed"
      ? null
      : !managedIdleCapabilities(plan.provider.provider).pause
        ? "No pause in the adapter; managed idle reads not available"
        : plan.statePreservation?.verdict !== "state-preserving"
          ? `State-preservation check ${plan.statePreservation?.verdict ?? "not run"}; managed idle needs a passing one`
          : null;

  if (managedBlocker)
    completion = { kind: "incomplete", reason: "not-available", detail: managedBlocker };
  else
    try {
      box = await span("create", () =>
        createSandbox(provider, {
          ...plan.create,
          labels: plan.runLabelOnly
            ? { ...plan.labels, "sandbox-bench-run": plan.runId }
            : {
                ...plan.labels,
                "sandbox-bench-run": plan.runId,
                "rw-attempt": plan.attemptId,
                "rw-variant": plan.variant,
              },
          signal,
        }),
      );
      sandboxIds.push(box.id);
      await environment.onSandbox?.(plan.provider.name, box.id);
      const created = box;
      firstRead = await readResources(created, signal);
      const workdir = plan.workdir ?? plan.manifest.workdir;
      const effective = scaled(profile, plan.gapScale ?? 1);

      const prepared = await span("prepare", async () => {
        const result = await prepare({
          box: created,
          clock,
          signal,
          manifest: plan.manifest,
          profile: effective,
          vcpu,
          workdir,
          blobs: environment.blobs,
          settings:
            plan.uploadConcurrency !== undefined && environment.prepare.upload
              ? {
                  ...environment.prepare,
                  upload: { ...environment.prepare.upload, concurrency: plan.uploadConcurrency },
                }
              : environment.prepare,
        });

        downloads = result.downloads;

        for (const download of result.downloads)
          phases.push({
            name: "download",
            startedAt: download.startedAt,
            endedAt: download.endedAt,
            label: download.role,
          });

        if (result.kind === "failed") return { result, runner: null };

        const runner = new StepRunner({
          box: created,
          clock,
          trace,
          signal,
          workdir,
          placeholders: result.placeholders,
          commands: effective.commands,
          env: { ...result.env, ...effective.env },
          path: result.path,
          blobs: environment.blobs,
          defaultTimeoutMs: effective.stepTimeoutMs,
          onOutput: (id, output) => outputs.set(id, output),
        });

        const own = effective.steps.filter((step) => step.phase === "prepare");
        steps = await runner.run(effective, own, "stop");

        return { result, runner };
      });

      if (prepared.result.kind === "failed")
        completion = {
          kind: "incomplete",
          reason: signal.aborted ? "slot-timeout" : "prepare-failed",
          detail: JSON.stringify(prepared.result.failure),
        };
      else if (prepared.runner) {
        const runner = prepared.runner;
        completion = failureCompletion(steps, signal.aborted) ?? completion;

        if (completion.kind === "completed") {
          const workload = effective.steps.filter((step) => step.phase === "workload");
          steps.push(
            ...(await span("workload", () =>
              runner.run(effective, workload, failurePolicy(effective.kind)),
            )),
          );
          completion = failureCompletion(steps, signal.aborted) ?? completion;
        }

        if (completion.kind === "completed" && plan.idle) {
          const outcome = await holdIdle({
            box: created,
            provider,
            trace,
            clock,
            plan: plan.idle,
            signal,
          });

          for (const item of outcome.spans) phases.push(item);
          const resume = effective.steps.filter((step) => step.phase === "resume");
          const resumed = await span("resume", () => runner.run(effective, resume, "stop"));
          steps.push(...resumed);
          const first = resumed[0];
          const { spans: _, ...rest } = outcome;
          idle = {
            ...rest,
            wakeLatencyMs:
              first && first.status !== "blocked" ? first.endedAt - first.startedAt : null,
          };
          completion = failureCompletion(steps, signal.aborted) ?? completion;
        }

        await runner.stopAll();
        background = runner.events;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      if (!box) await environment.onCreateFailed?.(plan.provider.name, error).catch(() => {});

      completion = {
        kind: "incomplete",
        reason: signal.aborted ? "slot-timeout" : box ? "error" : "create-failed",
        detail,
      };
    } finally {
      if (box) {
        const target = box;
        // A fresh signal: the end read must happen even after a slot timeout.
        lastRead = await readResources(target, AbortSignal.timeout(30_000));

        if (environment.beforeDestroy) {
          const file = await environment
            .beforeDestroy(plan.provider.name, target.id)
            .catch(() => null);

          if (file) usageFiles.push(file);
        }

        deletionConfirmed = await span("destroy", async () => {
          const timeout = AbortSignal.timeout(environment.destroyTimeoutMs ?? 120_000);

          try {
            await Promise.race([
              target.destroy(),
              new Promise<never>((_, reject) =>
                timeout.addEventListener("abort", () => reject(new Error("Deletion timed out")), {
                  once: true,
                }),
              ),
            ]);

            return true;
          } catch {
            return false;
          }
        });

        await environment.afterDestroy?.(plan.provider.name, target.id).catch(() => {});
      }
    }

  // Think gaps only; the held-open wait is already its own "idle" phase.
  const gaps = trace.gaps.filter((gap) => gap.before !== "idle");

  for (const item of gaps)
    phases.push({
      name: "gap",
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      label: item.before,
    });
  phases.sort((a, b) => a.startedAt - b.startedAt);
  let outputDir: string | null = null;

  let outputError: string | null = null;

  // Raw output is for inspection only: failing to write it never loses the record.
  if (environment.outputDir && outputs.size)
    try {
      const directory = join(environment.outputDir, plan.attemptId);
      await mkdir(directory, { recursive: true });

      for (const [id, output] of outputs) await writeFile(join(directory, `${id}.log`), output);
      outputDir = directory;
    } catch (error) {
      outputError = error instanceof Error ? error.message : String(error);
    }

  const record: AttemptRecord = {
    schema: attemptSchemaVersion,
    attemptId: plan.attemptId,
    runId: plan.runId,
    provider: plan.provider.name,
    profile: plan.profileName,
    profileKind: profile.kind,
    track: plan.track,
    variant: plan.variant,
    batch: plan.batch,
    slot: plan.slot,
    seed: plan.seed,
    manifestSha256: plan.manifestSha256,
    sandboxIds,
    startedAt,
    endedAt: clock.now(),
    startOffsetMs: startedAt - plan.slotStartedAt,
    completion,
    deletionConfirmed: box ? deletionConfirmed : true,
    phases,
    steps,
    downloads,
    background,
    gaps: {
      count: gaps.length,
      totalMs: gaps.reduce((sum, gap) => sum + gap.endedAt - gap.startedAt, 0),
      traffic: gaps.flatMap((gap) =>
        trace.trafficDuring(gap).map((call) => ({ gap: gap.before, ...call })),
      ),
    },
    idle,
    resources: resourcesBetween(firstRead, lastRead),
    costEvidence: { attribution: environment.attribution, window: null, usageFiles },
    outputDir,
    outputError,
  };

  return { record, trace };
}
