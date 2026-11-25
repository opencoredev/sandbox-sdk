/**
 * The runner behind `bun bench fairness <check>`: each check creates its sandboxes on one provider
 * (same-machine track), runs, and records a result, the same way for every provider.
 *
 * Crash safety follows `sustained-cpu.ts`: every event goes to `<out>/logs/<provider>.jsonl` as it
 * happens, the provider's summary to `<out>/providers/<provider>.json` when it ends, and
 * `<out>/<check>.json` is rebuilt from the summaries after every provider (and offline by
 * `--merge-only`). A retry sets the previous attempt's log and summary aside; a lock keeps two
 * invocations from running one provider into one directory. Every sandbox carries the run's and
 * the attempt's labels, and each attempt ends by destroying its sandboxes and sweeping those labels.
 */
import { randomBytes } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createSandbox, type CreateOptions } from "@opencoredev/sandbox-sdk";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import { lookupSandbox, type LookupEvidence } from "../existence.js";
import { isMissingFile } from "../files.js";
import { loadProvider } from "../providers.js";
import { collectMetadata } from "../publication.js";
import { providerSetups, type ProviderSetup } from "../realistic/setup.js";
import { labelsFor, listedLeftovers, type Attempt } from "../sustained-cpu.js";
import { deadline } from "../timing.js";
import { sanitize } from "../v2-runner.js";

export const track = "same-machine";

const jsonSchema = z.json();

/** What a log event may carry. */
export type Json = z.infer<typeof jsonSchema>;

export const checkIds = [
  "security-probe",
  "memory-honesty",
  "disk-real",
  "cpu-native",
  "cpu-burst-10",
] as const;

export const checkIdSchema = z.enum(checkIds);

export type CheckId = z.infer<typeof checkIdSchema>;

const createTimeoutMs = 10 * 60_000;
const destroyTimeoutMs = 120_000;
const destroyAttempts = 3;
const destroyRetryDelayMs = 5_000;
const listTimeoutMs = 60_000;
/** How long cleanup waits for creates still in flight past their deadline. */

const lateCreateWaitMs = 5 * 60_000;
/** A provider may list a sandbox from a refused or abandoned create only after a while. */

const lateSweepDelayMs = 30_000;

// ---------------------------------------------------------------------------------------------
// Sandboxes

export interface CommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface Box {
  readonly id: string;
  run(command: string, options: RunOptions): Promise<CommandResult>;
  write(path: string, data: Uint8Array): Promise<void>;
  /** The provider's exact, read-only lookup of this sandbox; never runs anything in it. */
  lookup(timeoutMs: number): Promise<LookupEvidence>;
  destroy(): Promise<void>;
}

export interface Session {
  create(signal: AbortSignal): Promise<Box>;
  /** IDs of this attempt's sandboxes the provider still lists. */
  leftovers(): Promise<string[]>;
  destroyById(id: string): Promise<void>;
}

export type OpenSession = (
  setup: ProviderSetup,
  plan: Attempt & { readonly lifetimeMs: number },
) => Promise<{ kind: "ready"; session: Session } | { kind: "skipped"; note: string }>;

/** 12 hex characters, fresh for every provider attempt. */
export const newAttemptId = () => randomBytes(6).toString("hex");

/**
 * Loads a provider the way the realistic harness and sustained-cpu do: the same-machine template,
 * product and size, Modal's and Styne's factory lifetime, and `timeoutMs` on create where the
 * adapter takes one.
 */
export const openLiveSession: OpenSession = async (setup, plan) => {
  const config = setup.tracks[track];

  const loaded = await loadProvider(setup.adapter, process.env, undefined, {
    template: config.template ? { [setup.adapter]: config.template } : {},
    product: setup.product ? { [setup.adapter]: setup.product } : {},
    "lifetime-ms":
      setup.adapter === "modal" || setup.adapter === "styne"
        ? { [setup.adapter]: plan.lifetimeMs }
        : {},
  });

  if (loaded.kind !== "ready") return { kind: "skipped", note: loaded.note };
  const provider: Provider = loaded.provider;
  const labels = labelsFor(setup, plan);

  return {
    kind: "ready",
    session: {
      async create(signal) {
        const options: CreateOptions = { labels, signal };

        if (config.size !== undefined) options.size = config.size;

        // Upstash, Superserve and Boat refuse `timeoutMs`; every other adapter gets the lifetime.
        if (setup.lifetime) options.timeoutMs = plan.lifetimeMs;
        const sandbox = await createSandbox(provider, options);

        return {
          id: sandbox.id,
          run: async (command, options) => {
            const result = await sandbox.run(command, { cwd: "/", ...options });

            return {
              ok: result.ok,
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              timedOut: result.timedOut,
            };
          },
          write: (path, data) => sandbox.files.write(path, data, { mode: 0o755 }),
          lookup: (timeoutMs) => lookupSandbox(provider, sandbox.id, timeoutMs),
          destroy: () => sandbox.destroy(),
        };
      },
      leftovers: () => listedLeftovers(provider, labels),
      destroyById: (id) => provider.destroy(id),
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Checks

/** A created sandbox and when the host asked for it, for checks that time the guest's boot. */
export interface CreatedBox {
  readonly box: Box;
  readonly index: number;
  /** Host seconds the create call took. */
  readonly createS: number;
  /** `performance.now()` when the create call returned. */
  readonly readyAtMs: number;
}

export interface CheckContext {
  readonly setup: ProviderSetup;
  readonly boxes: readonly CreatedBox[];
  /** Creates that failed, with their sanitized error. */
  readonly createFailures: readonly string[];
  readonly signal: AbortSignal;
  /** Runs a command with the adapter's timeout plus an outer deadline in case the adapter hangs. */
  exec(box: Box, command: string, timeoutMs: number): Promise<CommandResult>;
  /** As `exec`, but not cancelled by an interrupt: for stopping what the check started. */
  execCleanup(box: Box, command: string, timeoutMs: number): Promise<CommandResult>;
  /** Appends an event to the provider's log; `data` must survive JSON (the log line is parsed). */
  note(name: string, data: Json): Promise<void>;
  say(text: string): void;
}

/** Thrown by a check to stop with a reason; anything else is recorded as an error. */
export class CheckStop extends Error {}

export interface Check<R> {
  readonly id: CheckId;
  /** Sandboxes each provider attempt creates, all at once. */
  readonly boxes: number;
  /** Fewest created sandboxes the check can run with. */
  readonly minBoxes: number;
  /** The hard lifetime for adapters that take one. */
  readonly lifetimeMs: number;
  readonly resultSchema: z.ZodType<R>;
  run(context: CheckContext): Promise<R>;
}

// ---------------------------------------------------------------------------------------------
// Files

const statusSchema = z.enum(["completed", "failed", "skipped"]);

export type AttemptStatus = z.infer<typeof statusSchema>;

const runInfoSchema = z.object({ id: z.string(), sdkCommit: z.string(), startedAt: z.string() });

export const runFileSchema = z.object({
  schema: z.literal("fairness.run.v1"),
  check: checkIdSchema,
  run: runInfoSchema,
});

export type RunFile = z.infer<typeof runFileSchema>;

const sandboxEntrySchema = z.object({ id: z.string(), createS: z.number() });

/**
 * The size the provider's same-machine setup asks for. `sameSize` is false for one that is not
 * 4 vCPU / 8 GiB (boxd's nearest shape is 16 GiB), so a comparison can leave it out or mark it.
 */
const machineSchema = z.object({
  cpu: z.number().positive(),
  memoryGiB: z.number().positive(),
  sameSize: z.boolean(),
});

export type Machine = z.infer<typeof machineSchema>;

export const targetMachine = { cpu: 4, memoryGiB: 8 } as const;

export function machineOf(setup: ProviderSetup): Machine {
  const { cpu, memoryGiB } = setup.tracks[track].provisioned;

  return {
    cpu,
    memoryGiB,
    sameSize: cpu === targetMachine.cpu && memoryGiB === targetMachine.memoryGiB,
  };
}

/** `<out>/providers/<provider>.json`. `result` is the check's own shape, parsed by the check. */
export const providerFileSchema = z.object({
  schema: z.literal("fairness.provider.v1"),
  check: checkIdSchema,
  runId: z.string(),
  attemptId: z.string().min(1),
  provider: z.string(),
  status: statusSchema,
  reason: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string(),
  sandboxes: z.array(sandboxEntrySchema),
  createFailures: z.array(z.string()),
  /** True only when every sandbox the attempt made or its sweep found is confirmed gone. */
  destroyed: z.boolean(),
  cleanupError: z.string().nullable(),
  machine: machineSchema,
  result: z.unknown(),
});

export type ProviderFile = z.infer<typeof providerFileSchema>;

export const logLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    check: checkIdSchema,
    provider: z.string(),
    runId: z.string(),
    attemptId: z.string().min(1),
    at: z.string(),
  }),
  z.object({ kind: z.literal("sandbox"), id: z.string(), createS: z.number(), at: z.string() }),
  z.object({ kind: z.literal("create-failed"), error: z.string(), at: z.string() }),
  z.object({ kind: z.literal("event"), name: z.string(), data: jsonSchema, at: z.string() }),
  z.object({
    kind: z.literal("destroy"),
    sandboxId: z.string(),
    ok: z.boolean(),
    attempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
    at: z.string(),
  }),
  z.object({
    kind: z.literal("sweep"),
    found: z.array(z.string()),
    destroyed: z.array(z.string()),
    error: z.string().nullable(),
    at: z.string(),
  }),
  z.object({
    kind: z.literal("stop"),
    status: statusSchema,
    reason: z.string().nullable(),
    /** The cleanup verdict, so a log alone says whether everything was confirmed gone. */
    destroyed: z.boolean().optional(),
    cleanupError: z.string().nullable().optional(),
    at: z.string(),
  }),
]);

export type LogLine = z.infer<typeof logLineSchema>;

export const reportSchema = z.object({
  schema: z.literal("fairness.v1"),
  check: checkIdSchema,
  track: z.literal(track),
  generatedAt: z.string(),
  run: runInfoSchema,
  providers: z.array(providerFileSchema),
});

export type Report = z.infer<typeof reportSchema>;

export const errorText = (cause: unknown) =>
  sanitize(cause instanceof Error ? cause.message : String(cause)).slice(0, 500);

const now = () => new Date().toISOString();

export const paths = (out: string, check: CheckId) => ({
  run: join(out, "run.json"),
  report: join(out, `${check}.json`),
  providers: join(out, "providers"),
  logs: join(out, "logs"),
  provider: (name: string) => join(out, "providers", `${name}.json`),
  log: (name: string) => join(out, "logs", `${name}.jsonl`),
  lock: (name: string) => join(out, "logs", `${name}.lock`),
});

async function writeJsonAtomic(path: string, value: RunFile | ProviderFile | Report) {
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
}

async function readParsed<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  const text = await readOptional(path);

  if (text === null) return null;
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`${path}: ${errorText(cause)}`);
  }

  const parsed = schema.safeParse(value);

  if (!parsed.success)
    throw new Error(
      `${path}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    );

  return parsed.data;
}

/**
 * Parses a log. A crash can cut the last line short, so only an unterminated final line that is not
 * JSON is dropped; every other bad line fails.
 */
export function parseLog(text: string): LogLine[] {
  const raw = text.split("\n");
  const out: LogLine[] = [];

  for (const [index, line] of raw.entries()) {
    if (line.trim() === "") continue;
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      if (index === raw.length - 1) continue;
      throw new Error(`Log line ${index + 1}: ${errorText(cause)}`);
    }

    const result = logLineSchema.safeParse(parsed);

    if (!result.success) throw new Error(`Log line ${index + 1}: ${result.error.message}`);
    out.push(result.data);
  }

  return out;
}

/**
 * A provider entry for a log whose attempt never wrote its summary (the process died). It is
 * reported as failed, with the sandboxes the log saw and whether the log saw them destroyed.
 */
export function entryFromLog(input: {
  readonly check: CheckId;
  readonly provider: string;
  readonly machine: Machine;
  readonly lines: readonly LogLine[];
}): ProviderFile | null {
  let startIndex = -1;

  for (const [index, line] of input.lines.entries()) if (line.kind === "start") startIndex = index;
  const start = input.lines[startIndex];

  if (start?.kind !== "start") return null;
  const lines = input.lines.slice(startIndex);

  const sandboxes = lines.flatMap((line) =>
    line.kind === "sandbox" ? [{ id: line.id, createS: line.createS }] : [],
  );

  const createFailures = lines.flatMap((line) =>
    line.kind === "create-failed" ? [line.error] : [],
  );

  // Only the stop record's own verdict counts: sweeps can be clean while a create is still pending.
  const stop = lines.filter((line) => line.kind === "stop").at(-1);
  const sweptClean = stop?.kind === "stop" && stop.destroyed === true;

  const last = lines.at(-1);

  return {
    schema: "fairness.provider.v1",
    check: input.check,
    runId: start.runId,
    attemptId: start.attemptId,
    provider: input.provider,
    status: "failed",
    reason: "Run ended without a summary (rebuilt from its log)",
    startedAt: start.at,
    endedAt: last?.at ?? start.at,
    sandboxes,
    createFailures,
    // The stop record's verdict already counts the sweep: a failed direct destroy the sweep
    // finished is still a confirmed cleanup.
    destroyed: sweptClean,
    cleanupError: sweptClean
      ? null
      : stop?.kind === "stop" && stop.cleanupError
        ? stop.cleanupError
        : "The log has no confirmed cleanup",
    machine: input.machine,
    result: null,
  };
}

/**
 * Reads `run.json` and every provider's summary (or, without one, its log), checking each belongs
 * to this run and check and is filed under its own name. The log decides which attempt is live:
 * a summary from another attempt is stale.
 */
export async function loadResults(out: string, check: CheckId, resultSchema?: z.ZodType<unknown>) {
  const files = paths(out, check);
  const runFile = await readParsed(files.run, runFileSchema);

  if (runFile === null) throw new Error(`${files.run} is missing; nothing to merge`);

  if (runFile.check !== check)
    throw new Error(`${files.run} is a ${runFile.check} run, not ${check}`);
  const providers: ProviderFile[] = [];

  for (const setup of providerSetups) {
    const summary = await readParsed(files.provider(setup.name), providerFileSchema);
    const logText = await readOptional(files.log(setup.name));
    const log = logText === null ? [] : parseLog(logText);
    const starts = log.flatMap((line) => (line.kind === "start" ? [line] : []));

    for (const start of starts) {
      if (start.runId !== runFile.run.id || start.check !== check || start.provider !== setup.name)
        throw new Error(
          `logs/${setup.name}.jsonl holds ${start.provider} ${start.check} run ${start.runId}`,
        );
    }

    if (summary !== null) {
      if (
        summary.runId !== runFile.run.id ||
        summary.check !== check ||
        summary.provider !== setup.name
      )
        throw new Error(
          `providers/${setup.name}.json holds ${summary.provider} ${summary.check} run ${summary.runId}`,
        );
    }

    const latest = starts.at(-1);

    if (summary !== null && (latest === undefined || latest.attemptId === summary.attemptId)) {
      const where = `providers/${setup.name}.json`;

      if ((summary.status === "completed") !== (summary.result !== null))
        throw new Error(
          `${where} is ${summary.status} but ${summary.result === null ? "has no" : "has a"} result`,
        );

      if (
        summary.status === "completed" &&
        resultSchema &&
        !resultSchema.safeParse(summary.result).success
      )
        throw new Error(`${where} has a result that does not fit the ${check} schema`);
      providers.push(summary);
      continue;
    }

    const rebuilt = entryFromLog({
      check,
      provider: setup.name,
      machine: machineOf(setup),
      lines: log,
    });

    if (rebuilt !== null) providers.push(rebuilt);
  }

  return { runFile, providers };
}

export async function mergeResults(
  out: string,
  check: CheckId,
  resultSchema?: z.ZodType<unknown>,
): Promise<Report> {
  const { runFile, providers } = await loadResults(out, check, resultSchema);

  const report: Report = {
    schema: "fairness.v1",
    check,
    track,
    generatedAt: now(),
    run: runFile.run,
    providers,
  };

  await writeJsonAtomic(paths(out, check).report, reportSchema.parse(report));

  return report;
}

// ---------------------------------------------------------------------------------------------
// Runner

export interface RunPlan {
  readonly runId: string;
  readonly out: string;
}

export interface RunDependencies {
  readonly open: OpenSession;
  readonly signal: AbortSignal;
  readonly progress: (line: string) => void;
  /** Pause between destroy retries; tests pass 0. */
  readonly retryDelayMs?: number;
  /** Wait before a second sweep after a failed or late create; tests pass 0. */
  readonly lateSweepDelayMs?: number;
  /** A create's deadline; tests pass a short one. */
  readonly createTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function destroyWithRetry(destroy: () => Promise<void>, delayMs: number) {
  let error: string | null = null;

  for (let attempt = 1; attempt <= destroyAttempts; attempt++) {
    try {
      await deadline(destroyTimeoutMs, () => destroy());

      return { ok: true, attempts: attempt, error: null };
    } catch (cause) {
      error = errorText(cause);
    }

    if (attempt < destroyAttempts) await sleep(delayMs);
  }

  return { ok: false, attempts: destroyAttempts, error };
}

const quietly =
  (progress: (line: string) => void) =>
  (line: string): void => {
    try {
      progress(line);
    } catch {
      /* Nothing to report it to. */
    }
  };

const lockHeld = z.object({ code: z.literal("EEXIST") });

async function lockProvider(path: string, holder: string): Promise<() => Promise<void>> {
  let handle;

  try {
    handle = await open(path, "wx");
  } catch (cause) {
    if (!lockHeld.safeParse(cause).success) throw cause;
    const owner = (await readOptional(path))?.trim() || "holder unknown";

    throw new Error(
      `${path} is held by another invocation (${owner}); wait for it, or delete the lock if no fairness process is running`,
    );
  }

  try {
    await handle.writeFile(`${holder}\n`);
  } catch (cause) {
    await unlink(path).catch(() => {});
    throw cause;
  } finally {
    await handle.close();
  }

  return () => unlink(path);
}

async function setAside(path: string, aside: string) {
  try {
    await rename(path, aside);
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
  }
}

export interface Cleanup {
  readonly destroyed: boolean;
  readonly error: string | null;
}

/** One provider attempt under its lock. Throws only when the lock or a file write fails. */
export async function runProvider<R>(
  check: Check<R>,
  setup: ProviderSetup,
  plan: RunPlan,
  dependencies: RunDependencies,
): Promise<ProviderFile> {
  const files = paths(plan.out, check.id);
  const attemptId = newAttemptId();
  await mkdir(files.providers, { recursive: true });
  await mkdir(files.logs, { recursive: true });
  const lockPath = files.lock(setup.name);

  const release = await lockProvider(
    lockPath,
    `pid ${process.pid}, ${check.id} run ${plan.runId}, attempt ${attemptId}, since ${now()}`,
  );

  try {
    return await attempt({ check, setup, plan, dependencies, attemptId });
  } finally {
    await release().catch((cause) =>
      quietly(dependencies.progress)(
        `[${setup.name}] could not remove ${lockPath}: ${errorText(cause)}`,
      ),
    );
  }
}

async function attempt<R>(input: {
  readonly check: Check<R>;
  readonly setup: ProviderSetup;
  readonly plan: RunPlan;
  readonly dependencies: RunDependencies;
  readonly attemptId: string;
}): Promise<ProviderFile> {
  const { check, setup, plan, dependencies, attemptId } = input;
  const files = paths(plan.out, check.id);
  const name = setup.name;
  const logPath = files.log(name);
  const progress = quietly(dependencies.progress);
  const say = (text: string) => progress(`[${check.id} ${name}] ${text}`);
  const startedAt = now();

  const stamp = `${startedAt.replaceAll(":", "-")}.${attemptId}`;
  // Summary first: a merge in between then sees the old log without its summary and reports the
  // attempt as unfinished, never the old summary as current.
  await setAside(files.provider(name), join(files.providers, `${name}.${stamp}.prev.json`));
  await setAside(logPath, join(files.logs, `${name}.${stamp}.prev.jsonl`));

  const log = async (line: LogLine) => {
    await appendFile(logPath, `${JSON.stringify(logLineSchema.parse(line))}\n`);
  };

  let logClosed = false;

  const logQuietly = async (line: LogLine) => {
    if (logClosed) {
      say(`after the attempt: ${line.kind} ${sanitize(JSON.stringify(line)).slice(0, 200)}`);

      return;
    }

    try {
      await log(line);
    } catch (cause) {
      say(`could not log ${line.kind}: ${errorText(cause)}`);
    }
  };

  await log({
    kind: "start",
    check: check.id,
    provider: name,
    runId: plan.runId,
    attemptId,
    at: startedAt,
  });

  const created: CreatedBox[] = [];
  const createFailures: string[] = [];
  /** Every create call itself, not its deadline: one that outlives the deadline is still cleaned up. */
  const pendingCreates: Promise<Box>[] = [];
  let session: Session | null = null;
  let status: AttemptStatus = "failed";
  let reason: string | null = null;
  let result: R | null = null;
  let cleanup: Cleanup = { destroyed: true, error: null };
  const delay = dependencies.retryDelayMs ?? destroyRetryDelayMs;

  const exec = (box: Box, command: string, timeoutMs: number) =>
    deadline(timeoutMs + 60_000, (signal) =>
      box.run(command, { timeoutMs, signal: AbortSignal.any([signal, dependencies.signal]) }),
    );

  const execCleanup = (box: Box, command: string, timeoutMs: number) =>
    deadline(timeoutMs + 60_000, (signal) => box.run(command, { timeoutMs, signal }));

  try {
    const opened = await dependencies.open(setup, {
      runId: plan.runId,
      attemptId,
      lifetimeMs: check.lifetimeMs,
    });

    if (opened.kind === "skipped") {
      status = "skipped";
      throw new CheckStop(`Skipped: ${opened.note}`);
    }

    session = opened.session;

    const ready = session;
    say(`creating ${check.boxes} sandbox${check.boxes === 1 ? "" : "es"}`);

    // All creates at once; each settles on its own, so a refused create never hides a running one.
    const outcomes = await Promise.allSettled(
      Array.from({ length: check.boxes }, async (_, index) => {
        const started = performance.now();

        // The deadline stops the wait, not the create: aborting it would let the SDK reject while
        // the provider still makes the sandbox. The call itself is kept and reclaimed in cleanup.
        const call = ready.create(dependencies.signal);
        pendingCreates.push(call);
        const box = await deadline(dependencies.createTimeoutMs ?? createTimeoutMs, () => call);

        const readyAtMs = performance.now();
        const entry: CreatedBox = { box, index, createS: (readyAtMs - started) / 1000, readyAtMs };
        created.push(entry);
        await logQuietly({
          kind: "sandbox",
          id: box.id,
          createS: round(entry.createS, 3),
          at: now(),
        });

        return entry;
      }),
    );

    for (const outcome of outcomes)
      if (outcome.status === "rejected") {
        const error = errorText(outcome.reason);
        createFailures.push(error);
        await logQuietly({ kind: "create-failed", error, at: now() });
      }

    say(`created ${created.length}/${check.boxes}`);

    if (created.length < check.minBoxes)
      throw new CheckStop(
        `Created ${created.length} of ${check.boxes} sandboxes, fewer than the ${check.minBoxes} this check needs${createFailures[0] ? `: ${createFailures[0]}` : ""}`,
      );
    const boxes = [...created].sort((a, b) => a.index - b.index);

    const raw = await check.run({
      setup,
      boxes,
      createFailures,
      signal: dependencies.signal,
      exec,
      execCleanup,
      note: (eventName, data) => logQuietly({ kind: "event", name: eventName, data, at: now() }),
      say,
    });

    result = check.resultSchema.parse(raw);
    status = "completed";
  } catch (cause) {
    reason = errorText(cause);

    if (status !== "skipped") status = "failed";
    say(`stopped: ${reason}`);
  } finally {
    cleanup = await cleanUp({
      boxes: created,
      pendingCreates,
      createFailed: createFailures.length > 0,
      session,
      log: logQuietly,
      say,
      delay,
      lateSweepDelayMs: dependencies.lateSweepDelayMs ?? lateSweepDelayMs,
    });
  }

  await logQuietly({
    kind: "stop",
    status,
    reason,
    destroyed: cleanup.destroyed,
    cleanupError: cleanup.error,
    at: now(),
  });
  // A create still in flight may settle after this attempt ends; its reclaim still destroys the
  // sandbox but must not write into a later attempt's log.
  logClosed = true;

  const file: ProviderFile = {
    schema: "fairness.provider.v1",
    check: check.id,
    runId: plan.runId,
    attemptId,
    provider: name,
    status,
    reason,
    startedAt,
    endedAt: now(),
    sandboxes: [...created]
      .sort((a, b) => a.index - b.index)
      .map((entry) => ({ id: entry.box.id, createS: round(entry.createS, 3) })),
    createFailures,
    destroyed: cleanup.destroyed,
    cleanupError: cleanup.error,
    machine: machineOf(setup),
    result,
  };

  await writeJsonAtomic(files.provider(name), providerFileSchema.parse(file));
  say(`${status}${reason ? `: ${reason}` : ""}`);

  return file;
}

type QuietLog = (line: LogLine) => Promise<void>;

/**
 * Destroys every created sandbox, then any create that returned after its deadline (waiting for
 * those still in flight, up to `lateCreateWaitMs`), then sweeps the attempt's labels; after a failed
 * or late create, sweeps again `lateSweepDelayMs` later. Never throws.
 */
async function cleanUp(input: {
  readonly boxes: readonly CreatedBox[];
  readonly pendingCreates: readonly Promise<Box>[];
  readonly createFailed: boolean;
  readonly session: Session | null;
  readonly log: QuietLog;
  readonly say: (text: string) => void;
  readonly delay: number;
  readonly lateSweepDelayMs: number;
}): Promise<Cleanup> {
  const { boxes, session, log, say, delay } = input;
  const known = new Set(boxes.map((entry) => entry.box.id));
  const problems: string[] = [];

  const destroyBox = async (box: Box) => {
    const outcome = await destroyWithRetry(() => box.destroy(), delay);
    await log({ kind: "destroy", sandboxId: box.id, ...outcome, at: now() });

    if (!outcome.ok) say(`DESTROY FAILED ${box.id}: ${outcome.error}`);

    return outcome.ok ? null : box.id;
  };

  const failed = (await Promise.all(boxes.map(({ box }) => destroyBox(box)))).filter(
    (id) => id !== null,
  );

  // Creates that outlived their deadline: each is reclaimed on its own as it settles, so one still
  // in flight never holds up (or hides) another's sandbox.
  let late = false;
  let stillPending = 0;

  const reclaims = input.pendingCreates.map((call) => {
    const state = { done: false };

    const work = call.then(
      async (box) => {
        if (!known.has(box.id)) {
          late = true;
          await log({ kind: "sandbox", id: box.id, createS: -1, at: now() });
          say(`late create returned ${box.id}; destroying`);
          const id = await destroyBox(box);

          if (id !== null) failed.push(id);
        }

        state.done = true;
      },
      () => {
        state.done = true;
      },
    );

    return { state, work };
  });

  await deadline(lateCreateWaitMs, () => Promise.all(reclaims.map((r) => r.work))).catch(
    () => null,
  );
  stillPending = reclaims.filter((r) => !r.state.done).length;

  if (stillPending > 0)
    problems.push(`${stillPending} create(s) still in flight after ${lateCreateWaitMs / 1000}s`);

  if (session === null)
    return failed.length === 0 && stillPending === 0
      ? { destroyed: true, error: null }
      : {
          destroyed: false,
          error: [...problems, ...failed.map((id) => `${id} did not destroy`)].join("; "),
        };

  let error = await sweep({ session, failed, log, say, delay });

  if (error === null && (late || input.createFailed || stillPending > 0)) {
    await sleep(input.lateSweepDelayMs);
    error = await sweep({ session, failed: [], log, say, delay });
  }

  if (error !== null) problems.push(error);

  // A sandbox whose destroy failed is gone when the listing no longer shows it or the sweep got it.
  return problems.length === 0
    ? { destroyed: true, error: null }
    : { destroyed: false, error: problems.join("; ") };
}

/** Lists the attempt's sandboxes and destroys any left. Returns null only when all are gone. */
async function sweep(input: {
  readonly session: Session;
  readonly failed: readonly string[];
  readonly log: QuietLog;
  readonly say: (text: string) => void;
  readonly delay: number;
}): Promise<string | null> {
  const { session, failed, log, say, delay } = input;
  let found: string[];

  try {
    found = await deadline(listTimeoutMs, () => session.leftovers());
  } catch (cause) {
    const error = `Listing failed${failed.length ? `, so ${failed.join(", ")} may still run` : ""}: ${errorText(cause)}`;
    await log({ kind: "sweep", found: [], destroyed: [], error, at: now() });
    say(`SWEEP FAILED: ${error}`);

    return error;
  }

  const destroyed: string[] = [];
  const failures: string[] = [];

  for (const id of found) {
    const outcome = await destroyWithRetry(() => session.destroyById(id), delay);

    if (outcome.ok) destroyed.push(id);
    else failures.push(`${id} (${outcome.error ?? "unknown error"})`);
  }

  const error = failures.length === 0 ? null : `Could not destroy ${failures.join("; ")}`;
  await log({ kind: "sweep", found, destroyed, error, at: now() });

  if (error !== null) say(`SWEEP FAILED: ${error}`);
  else if (found.length > 0) say(`sweep found ${found.join(", ")}; destroyed ${destroyed.length}`);

  return error;
}

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

/**
 * Claims the output directory: writes `run.json` exclusively, or checks an existing one is this
 * run and check and that what is already there merges.
 */
async function claimOut(check: CheckId, plan: RunPlan): Promise<RunFile> {
  const files = paths(plan.out, check);
  await mkdir(files.providers, { recursive: true });
  await mkdir(files.logs, { recursive: true });

  const checkExisting = async (raw: string) => {
    const runFile = runFileSchema.parse(JSON.parse(raw));

    if (runFile.run.id !== plan.runId || runFile.check !== check)
      throw new Error(
        `${plan.out} belongs to ${runFile.check} run ${runFile.run.id}; pass --run ${runFile.run.id} to retry into it, or a new --out`,
      );
    const commit = (await collectMetadata(false)).repositoryCommit ?? "unknown";

    if (commit !== runFile.run.sdkCommit)
      throw new Error(
        `${plan.out} was run at ${runFile.run.sdkCommit}; this checkout is ${commit}, so a retry would mix code`,
      );
    await loadResults(plan.out, check);

    return runFile;
  };

  const existing = await readOptional(files.run);

  if (existing !== null) return checkExisting(existing);
  const metadata = await collectMetadata(false);

  const runFile: RunFile = {
    schema: "fairness.run.v1",
    check,
    run: { id: plan.runId, sdkCommit: metadata.repositoryCommit ?? "unknown", startedAt: now() },
  };

  const temporary = `${files.run}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(runFile, null, 2)}\n`, { flag: "wx" });
  let raced = false;

  try {
    await link(temporary, files.run);
  } catch (cause) {
    if (lockHeld.safeParse(cause).success) raced = true;
    else throw cause;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  return raced ? checkExisting(await readFile(files.run, "utf8")) : runFile;
}

export interface Outcome {
  readonly report: Report;
  readonly failures: readonly { readonly provider: string; readonly error: string }[];
  readonly cleanupProblems: readonly { readonly provider: string; readonly error: string }[];
}

/** Runs the providers, `concurrency` at a time, merging after each. Every provider settles first. */
export async function runCheck<R>(
  check: Check<R>,
  setups: readonly ProviderSetup[],
  plan: RunPlan & { readonly concurrency: number },
  dependencies: RunDependencies,
): Promise<Outcome> {
  const names = setups.map((setup) => setup.name);

  if (new Set(names).size !== names.length)
    throw new Error(`Each provider runs once per invocation: ${names.join(", ")}`);
  await claimOut(check.id, plan);
  const progress = quietly(dependencies.progress);
  const failures: { provider: string; error: string }[] = [];
  const cleanupProblems: { provider: string; error: string }[] = [];
  let merging = Promise.resolve();

  const mergeQuietly = () => {
    merging = merging.then(() =>
      mergeResults(plan.out, check.id, check.resultSchema).then(
        () => {},
        (cause) => progress(`merge failed: ${errorText(cause)}`),
      ),
    );

    return merging;
  };

  const runOne = async (setup: ProviderSetup) => {
    try {
      const file = await runProvider(check, setup, plan, dependencies);

      if (!file.destroyed)
        cleanupProblems.push({ provider: setup.name, error: file.cleanupError ?? "unconfirmed" });
    } catch (cause) {
      failures.push({ provider: setup.name, error: errorText(cause) });
      progress(`[${check.id} ${setup.name}] RUN FAILED: ${errorText(cause)}`);
    }

    await mergeQuietly();
  };

  let next = 0;

  const workers = Array.from({ length: Math.min(setups.length, plan.concurrency) }, async () => {
    for (let setup = setups[next++]; setup; setup = setups[next++]) await runOne(setup);
  });

  for (const settled of await Promise.allSettled(workers))
    if (settled.status === "rejected")
      failures.push({ provider: "runner", error: errorText(settled.reason) });

  return {
    report: await mergeResults(plan.out, check.id, check.resultSchema),
    failures,
    cleanupProblems,
  };
}
