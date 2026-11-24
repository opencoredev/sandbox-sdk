/**
 * `bun bench sustained-cpu`: 15 minutes of 100% all-core CPU on one same-machine sandbox per
 * provider, in consecutive segments, to show burstable CPUs throttling (a burst-credit cliff to a
 * baseline share) against dedicated ones.
 *
 * Each segment runs `/tmp/sustained_lcg.py`: one process per vCPU (at most 4), released together by
 * a barrier, each iterating cpu-all's 32-bit LCG (`x = (1664525 * x + 1013904223) & 0xFFFFFFFF`)
 * in small chunks until the segment's target time has passed. The host checks every worker's final
 * value against `lcgChecksum`, so a segment's ops/s is work the guest did, not work it claims.
 *
 * Crash safety: every record goes to `<out>/logs/<provider>.jsonl` as it happens; each provider's
 * summary goes to `<out>/providers/<provider>.json` when it ends; `<out>/sustained-cpu.json` is
 * rebuilt from those after every provider, and offline by `--merge-only`.
 */
import { randomInt } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSandbox, type CreateOptions } from "@opencoredev/sandbox-sdk";
import type { Labels, Provider } from "@opencoredev/sandbox-sdk/provider";
import { z } from "zod";
import { isMissingFile } from "./files.js";
import { loadProvider } from "./providers.js";
import { collectMetadata } from "./publication.js";
import { providerSetups, type ProviderSetup } from "./realistic/setup.js";
import { deadline, pool } from "./timing.js";
import { sanitize } from "./v2-runner.js";

export const schemaVersion = "sustained-cpu.v1";

const track = "same-machine";

/** cpu-all's LCG constants. */
const lcgMultiplier = 1664525;
const lcgIncrement = 1013904223;

/** Mixes the segment seed into each worker's seed: `seed ^ ((index + 1) * golden) mod 2^32`. */
const workerSeedMix = 0x9e3779b9;

/** No single worker can step a 32-bit LCG in Python a billion times a second. */
export const maxWorkerOpsPerSec = 1e9;

/** At full speed a chunk takes about 0.03 s, at a 16% baseline about 0.2 s: segments end on time. */
export const defaultChunkSteps = 500_000;

const maxWorkers = 4;
const scriptPath = "/tmp/sustained_lcg.py";
const createTimeoutMs = 10 * 60_000;
const setupTimeoutMs = 60_000;
const destroyTimeoutMs = 120_000;
const destroyAttempts = 3;
const destroyRetryDelayMs = 5_000;

/** Label every sandbox with the run and the provider, so the sweep finds only its own. */
const runLabel = "sandbox-bench-run";
const providerLabel = "sc-provider";

// ---------------------------------------------------------------------------------------------
// LCG

/** One LCG step as an affine map `x -> a*x + c (mod 2^32)`. */
interface Affine {
  readonly a: number;
  readonly c: number;
}

/** `outer(inner(x))`. */
function compose(outer: Affine, inner: Affine): Affine {
  return {
    a: Math.imul(outer.a, inner.a) >>> 0,
    c: (Math.imul(outer.a, inner.c) + outer.c) >>> 0,
  };
}

/** The LCG's value after `steps` steps from `seed`, by repeated squaring: O(log steps). */
export function lcgChecksum(seed: number, steps: number): number {
  let power: Affine = { a: lcgMultiplier, c: lcgIncrement };
  let result: Affine = { a: 1, c: 0 };
  let remaining = steps;

  while (remaining > 0) {
    if (remaining % 2 === 1) result = compose(power, result);
    power = compose(power, power);
    remaining = Math.floor(remaining / 2);
  }

  return (Math.imul(result.a, seed >>> 0) + result.c) >>> 0;
}

/** Worker `index`'s seed for a segment seed; the script derives the same. */
export function workerSeed(seed: number, index: number): number {
  return (seed ^ Math.imul(index + 1, workerSeedMix)) >>> 0;
}

/** Written to `/tmp/sustained_lcg.py`; run as `<python> <path> <seed> <workers> <target_s> <chunk>`. */
export const burnScript = `import json
import multiprocessing as mp
import sys
import time

MASK = 0xFFFFFFFF
MUL = ${lcgMultiplier}
INC = ${lcgIncrement}
MIX = ${workerSeedMix}


def burn(index, seed, target, chunk, barrier, results):
    x, a, c, m = seed, MUL, INC, MASK
    steps = 0
    barrier.wait()
    start = time.monotonic()
    while True:
        for _ in range(chunk):
            x = (a * x + c) & m
        steps += chunk
        elapsed = time.monotonic() - start
        if elapsed >= target:
            break
    results.put((index, seed, steps, x, elapsed))


def main():
    seed = int(sys.argv[1]) & MASK
    workers = int(sys.argv[2])
    target = float(sys.argv[3])
    chunk = int(sys.argv[4])
    try:
        ctx = mp.get_context("fork")
    except ValueError:
        ctx = mp.get_context("spawn")
    barrier = ctx.Barrier(workers + 1, timeout=120)
    results = ctx.Queue()
    procs = [
        ctx.Process(target=burn, args=(i, (seed ^ ((i + 1) * MIX)) & MASK, target, chunk, barrier, results))
        for i in range(workers)
    ]
    for p in procs:
        p.start()
    barrier.wait()
    start = time.monotonic()
    rows = sorted(results.get(timeout=target * 20 + 120) for _ in range(workers))
    wall = time.monotonic() - start
    for p in procs:
        p.join()
    if any(p.exitcode != 0 for p in procs):
        sys.exit(3)
    total = sum(r[2] for r in rows)
    print(json.dumps({
        "wallS": wall,
        "totalSteps": total,
        "opsPerSec": total / wall,
        "workers": [{"seed": r[1], "steps": r[2], "checksum": r[3], "elapsedS": r[4]} for r in rows],
    }))


if __name__ == "__main__":
    main()
`;

// ---------------------------------------------------------------------------------------------
// Schemas

const workerOutputSchema = z.object({
  seed: z.number().int().nonnegative(),
  steps: z.number().int().positive(),
  checksum: z.number().int().nonnegative(),
  elapsedS: z.number().positive(),
});

/** What the script prints. */
export const burnOutputSchema = z.object({
  wallS: z.number().positive(),
  totalSteps: z.number().int().nonnegative(),
  opsPerSec: z.number().nonnegative(),
  workers: z.array(workerOutputSchema).min(1),
});

export type BurnOutput = z.infer<typeof burnOutputSchema>;

const pointSchema = z.object({
  segment: z.number().int().positive(),
  minute: z.number(),
  elapsedS: z.number(),
  wallOffsetS: z.number(),
  opsPerSec: z.number(),
});

export type Point = z.infer<typeof pointSchema>;

const statusSchema = z.enum(["completed", "stopped-early", "failed"]);

export type ProviderStatus = z.infer<typeof statusSchema>;

const fingerprintSchema = z.object({
  guestVcpus: z.number().int().positive().nullable(),
  memoryGiB: z.number().nonnegative().nullable(),
  uptimeAtStartS: z.number().nonnegative().nullable(),
  python: z.string().nullable(),
  pythonPath: z.string().nullable(),
  cmdline: z.string().nullable(),
});

export type Fingerprint = z.infer<typeof fingerprintSchema>;

export const providerResultSchema = z.object({
  provider: z.string(),
  status: statusSchema,
  stopReason: z.string().nullable(),
  guestVcpus: z.number().nullable(),
  memoryGiB: z.number().nullable(),
  workers: z.number().int().nullable(),
  python: z.string().nullable(),
  uptimeAtStartS: z.number().nullable(),
  durationS: z.number(),
  segmentsCompleted: z.number().int().nonnegative(),
  first3MinOps: z.number().nullable(),
  last3MinOps: z.number().nullable(),
  overallMedianOps: z.number().nullable(),
  retention: z.number().nullable(),
  minOverFirst: z.number().nullable(),
  points: z.array(pointSchema),
});

export type ProviderResult = z.infer<typeof providerResultSchema>;

const runInfoSchema = z.object({ id: z.string(), sdkCommit: z.string(), startedAt: z.string() });

export const reportSchema = z.object({
  schema: z.literal(schemaVersion),
  generatedAt: z.string(),
  track: z.literal(track),
  targetDurationS: z.number(),
  segmentDurationS: z.number(),
  segmentsTarget: z.number().int(),
  run: runInfoSchema,
  providers: z.array(providerResultSchema),
});

export type SustainedReport = z.infer<typeof reportSchema>;

/** `<out>/run.json`: the run an output directory belongs to and its segment plan. */
const runFileSchema = z.object({
  schema: z.literal("sustained-cpu.run.v1"),
  run: runInfoSchema,
  segmentsTarget: z.number().int().positive(),
  segmentDurationS: z.number().positive(),
});

type RunFile = z.infer<typeof runFileSchema>;

/** `<out>/providers/<provider>.json`. */
const providerFileSchema = z.object({
  schema: z.literal("sustained-cpu.provider.v1"),
  runId: z.string(),
  segmentsTarget: z.number().int().positive(),
  segmentDurationS: z.number().positive(),
  sandboxId: z.string().nullable(),
  destroyed: z.boolean(),
  result: providerResultSchema,
});

type ProviderFile = z.infer<typeof providerFileSchema>;

/** One line of `<out>/logs/<provider>.jsonl`. */
export const logLineSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("start"),
    provider: z.string(),
    runId: z.string(),
    at: z.string(),
    segmentsTarget: z.number().int().positive(),
    segmentDurationS: z.number().positive(),
    chunkSteps: z.number().int().positive(),
  }),
  z.object({ kind: z.literal("sandbox"), id: z.string(), at: z.string() }),
  z.object({
    kind: z.literal("fingerprint"),
    at: z.string(),
    fingerprint: fingerprintSchema,
    workers: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("segment"),
    at: z.string(),
    point: pointSchema,
    seed: z.number().int().nonnegative(),
    /** Host-observed time of the exec, for comparison with the guest's clock. */
    hostS: z.number(),
    workers: z.array(workerOutputSchema),
  }),
  z.object({
    kind: z.literal("stop"),
    at: z.string(),
    status: statusSchema,
    stopReason: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("destroy"),
    at: z.string(),
    sandboxId: z.string(),
    ok: z.boolean(),
    attempts: z.number().int().nonnegative(),
    error: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("sweep"),
    at: z.string(),
    found: z.array(z.string()),
    destroyed: z.array(z.string()),
    error: z.string().nullable(),
  }),
]);

export type LogLine = z.infer<typeof logLineSchema>;

// ---------------------------------------------------------------------------------------------
// Verification

/** The script's last line through the schema, or null when it is not JSON at all. */
function parseJsonLine(line: string) {
  try {
    return burnOutputSchema.safeParse(JSON.parse(line));
  } catch {
    return null;
  }
}

export type SegmentCheck =
  | { readonly kind: "ok"; readonly output: BurnOutput; readonly opsPerSec: number }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Checks a segment's printed result: one worker per expected seed, whole chunks, at least the
 * target time, a plausible rate, and every final value equal to the host's `lcgChecksum`. The
 * segment's ops/s is the host's sum of the workers' verified rates.
 */
export function verifySegment(input: {
  readonly stdout: string;
  readonly seed: number;
  readonly workers: number;
  readonly targetSeconds: number;
  readonly chunkSteps: number;
}): SegmentCheck {
  const line = input.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = parseJsonLine(line);

  if (parsed === null)
    return { kind: "invalid", reason: `Output is not JSON: ${line.slice(0, 200)}` };

  if (!parsed.success)
    return {
      kind: "invalid",
      reason: `Output shape: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    };
  const output = parsed.data;

  if (output.workers.length !== input.workers)
    return {
      kind: "invalid",
      reason: `Expected ${input.workers} workers, got ${output.workers.length}`,
    };

  let opsPerSec = 0;
  let totalSteps = 0;

  for (const [index, worker] of output.workers.entries()) {
    const expectedSeed = workerSeed(input.seed, index);

    if (worker.seed !== expectedSeed)
      return {
        kind: "invalid",
        reason: `Worker ${index} seed ${worker.seed}, expected ${expectedSeed}`,
      };

    if (worker.steps % input.chunkSteps !== 0)
      return { kind: "invalid", reason: `Worker ${index} steps ${worker.steps} not whole chunks` };

    if (worker.elapsedS < input.targetSeconds)
      return {
        kind: "invalid",
        reason: `Worker ${index} stopped at ${worker.elapsedS}s, before ${input.targetSeconds}s`,
      };
    const rate = worker.steps / worker.elapsedS;

    if (rate > maxWorkerOpsPerSec)
      return { kind: "invalid", reason: `Worker ${index} claims ${rate} ops/s` };
    const expected = lcgChecksum(worker.seed, worker.steps);

    if (worker.checksum !== expected)
      return {
        kind: "invalid",
        reason: `Worker ${index} checksum ${worker.checksum}, expected ${expected}`,
      };
    opsPerSec += rate;
    totalSteps += worker.steps;
  }

  if (totalSteps !== output.totalSteps)
    return {
      kind: "invalid",
      reason: `totalSteps ${output.totalSteps} is not the workers' ${totalSteps}`,
    };

  return { kind: "ok", output, opsPerSec };
}

// ---------------------------------------------------------------------------------------------
// Summary

const round = (value: number, places: number) => {
  const scale = 10 ** places;

  return Math.round(value * scale) / scale;
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? null)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * Segments in the first and in the last window. A full run (15 minutes or more) uses 3 minutes'
 * worth (6 segments of 30 s); a shorter run uses a fifth of its segments, at least one.
 */
export function windowSegments(plan: { segmentsTarget: number; segmentDurationS: number }) {
  const total = plan.segmentsTarget * plan.segmentDurationS;

  const size =
    total >= 900
      ? Math.max(1, Math.floor(180 / plan.segmentDurationS))
      : Math.max(1, Math.floor(plan.segmentsTarget * 0.2));

  return Math.min(size, plan.segmentsTarget);
}

export function statusOf(segmentsCompleted: number, segmentsTarget: number): ProviderStatus {
  if (segmentsCompleted >= segmentsTarget) return "completed";

  return segmentsCompleted > 0 ? "stopped-early" : "failed";
}

/**
 * A provider's published result. first3MinOps needs the whole first window, last3MinOps needs
 * every segment (the final window), both as medians of verified ops/s.
 */
export function summarize(input: {
  readonly provider: string;
  readonly segmentsTarget: number;
  readonly segmentDurationS: number;
  readonly points: readonly Point[];
  readonly fingerprint: Fingerprint | null;
  readonly workers: number | null;
  readonly stopReason: string | null;
}): ProviderResult {
  const points = [...input.points].sort((a, b) => a.segment - b.segment);
  const window = windowSegments(input);
  const ops = points.map((p) => p.opsPerSec);
  const first = ops.length >= window ? median(ops.slice(0, window)) : null;
  const last = ops.length >= input.segmentsTarget ? median(ops.slice(-window)) : null;
  const overall = median(ops);
  const status = statusOf(points.length, input.segmentsTarget);

  return {
    provider: input.provider,
    status,
    stopReason: status === "completed" ? null : (input.stopReason ?? "Stopped before the target"),
    guestVcpus: input.fingerprint?.guestVcpus ?? null,
    memoryGiB: input.fingerprint?.memoryGiB ?? null,
    workers: input.workers,
    python: input.fingerprint?.python ?? null,
    uptimeAtStartS: input.fingerprint?.uptimeAtStartS ?? null,
    durationS: round(
      points.reduce((sum, p) => sum + p.elapsedS, 0),
      3,
    ),
    segmentsCompleted: points.length,
    first3MinOps: first === null ? null : Math.round(first),
    last3MinOps: last === null ? null : Math.round(last),
    overallMedianOps: overall === null ? null : Math.round(overall),
    retention: first !== null && last !== null && first > 0 ? round(last / first, 4) : null,
    minOverFirst:
      first !== null && first > 0 && ops.length > 0 ? round(Math.min(...ops) / first, 4) : null,
    points,
  };
}

// ---------------------------------------------------------------------------------------------
// Fingerprint

/**
 * Prints `key=value` lines. The interpreter is python3, else python; `cmdline` may be absent
 * (gVisor and some containers hide it).
 */
export const fingerprintCommand = [
  `echo "nproc=$(nproc 2>/dev/null)"`,
  `echo "memkb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)"`,
  `echo "uptime=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)"`,
  `PY=$(command -v python3 || command -v python)`,
  `echo "pythonPath=$PY"`,
  `if [ -n "$PY" ]; then echo "python=$("$PY" --version 2>&1)"; else echo "python="; fi`,
  `echo "cmdline=$(cat /proc/cmdline 2>/dev/null | tr -d '\\n')"`,
].join("\n");

export function parseFingerprint(stdout: string): Fingerprint {
  const values = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");

    if (at > 0) values.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const text = (key: string) => {
    const value = values.get(key);

    return value === undefined || value === "" ? null : value;
  };

  const number = (key: string) => {
    const value = Number(text(key) ?? Number.NaN);

    return Number.isFinite(value) ? value : null;
  };

  const nproc = number("nproc");
  const memkb = number("memkb");

  return {
    guestVcpus: nproc !== null && Number.isInteger(nproc) && nproc > 0 ? nproc : null,
    memoryGiB: memkb === null ? null : round(memkb / 1024 / 1024, 2),
    uptimeAtStartS: number("uptime"),
    python: text("python"),
    pythonPath: text("pythonPath"),
    cmdline: text("cmdline"),
  };
}

export function workerCount(fingerprint: Fingerprint): number {
  return fingerprint.guestVcpus === null
    ? maxWorkers
    : Math.min(fingerprint.guestVcpus, maxWorkers);
}

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Writes the script with a quoted heredoc: no expansion, no stdin support needed. */
export const writeScriptCommand = `cat > ${scriptPath} <<'SUSTAINED_LCG_EOF'\n${burnScript}SUSTAINED_LCG_EOF\n`;

export function burnCommand(input: {
  readonly python: string;
  readonly seed: number;
  readonly workers: number;
  readonly targetSeconds: number;
  readonly chunkSteps: number;
}) {
  return [
    quote(input.python),
    scriptPath,
    input.seed,
    input.workers,
    input.targetSeconds,
    input.chunkSteps,
  ].join(" ");
}

/** A segment's exec timeout: four times its length, at least two minutes. */
export function segmentTimeoutMs(segmentSeconds: number) {
  return Math.max(120_000, segmentSeconds * 4 * 1000);
}

/** The hard lifetime for adapters that take one: the burn plus 10 minutes, at least 25 minutes. */
export function lifetimeMs(plan: { segmentsTarget: number; segmentDurationS: number }) {
  return Math.max(1_500_000, plan.segmentsTarget * plan.segmentDurationS * 1000 + 600_000);
}

// ---------------------------------------------------------------------------------------------
// Sandboxes

/** What a command returns, as the SDK's `RunResult` reports it. */
export interface CommandResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface BurnBox {
  readonly id: string;
  run(command: string, options: { timeoutMs: number; signal: AbortSignal }): Promise<CommandResult>;
  destroy(): Promise<void>;
}

/** One provider's adapter, loaded for this run. */
export interface BurnSession {
  create(signal: AbortSignal): Promise<BurnBox>;
  /** IDs of this run's sandboxes for this provider still listed. */
  leftovers(): Promise<string[]>;
  destroyById(id: string): Promise<void>;
}

export type OpenSession = (
  setup: ProviderSetup,
  plan: { runId: string; segmentsTarget: number; segmentDurationS: number },
) => Promise<{ kind: "ready"; session: BurnSession } | { kind: "skipped"; note: string }>;

function labelsFor(setup: ProviderSetup, runId: string): Labels {
  const labels: Labels = { [runLabel]: runId };

  // Boat's labels share a short name budget; it has no sibling setup on its adapter to tell apart.
  if (setup.adapter !== "boat") labels[providerLabel] = setup.name;

  return labels;
}

/**
 * Loads a provider as the realistic harness does (`loadSlotProvider`): the same-machine template,
 * product and size, Modal's and Styne's factory lifetime, and `timeoutMs` on create where the
 * adapter takes one, long enough for the whole burn.
 */
export const openLiveSession: OpenSession = async (setup, plan) => {
  const config = setup.tracks[track];
  const lifetime = lifetimeMs(plan);

  const loaded = await loadProvider(setup.adapter, process.env, undefined, {
    template: config.template ? { [setup.adapter]: config.template } : {},
    product: setup.product ? { [setup.adapter]: setup.product } : {},
    "lifetime-ms":
      setup.adapter === "modal" || setup.adapter === "styne" ? { [setup.adapter]: lifetime } : {},
  });

  if (loaded.kind !== "ready") return { kind: "skipped", note: loaded.note };
  const provider: Provider = loaded.provider;
  const labels = labelsFor(setup, plan.runId);

  return {
    kind: "ready",
    session: {
      async create(signal) {
        const options: CreateOptions = { labels, signal };

        if (config.size !== undefined) options.size = config.size;

        // Upstash, Superserve and Boat refuse `timeoutMs`; every other adapter gets the lifetime.
        if (setup.lifetime) options.timeoutMs = lifetime;
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
          destroy: () => sandbox.destroy(),
        };
      },
      leftovers: async () => (await provider.list(labels)).map((info) => info.id),
      destroyById: (id) => provider.destroy(id),
    },
  };
};

// ---------------------------------------------------------------------------------------------
// Files

const errorText = (cause: unknown) =>
  sanitize(cause instanceof Error ? cause.message : String(cause)).slice(0, 500);

const now = () => new Date().toISOString();

async function writeJsonAtomic(path: string, value: SustainedReport | ProviderFile | RunFile) {
  const temporary = `${path}.${process.pid}.tmp`;
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

export const paths = (out: string) => ({
  run: join(out, "run.json"),
  report: join(out, "sustained-cpu.json"),
  providers: join(out, "providers"),
  logs: join(out, "logs"),
  provider: (name: string) => join(out, "providers", `${name}.json`),
  log: (name: string) => join(out, "logs", `${name}.jsonl`),
});

/**
 * Parses a log. A crash can cut the last line short, so only an unparsable last line is dropped;
 * one anywhere else is an error.
 */
export function parseLog(text: string): LogLine[] {
  const lines = text.split("\n").filter((line) => line.trim() !== "");

  return lines.flatMap((line, index) => {
    try {
      return [logLineSchema.parse(JSON.parse(line))];
    } catch (cause) {
      if (index === lines.length - 1) return [];
      throw new Error(`Log line ${index + 1}: ${errorText(cause)}`);
    }
  });
}

/** A provider's result from its log alone, for a run that ended before writing its summary. */
export function resultFromLog(provider: string, lines: readonly LogLine[]): ProviderResult | null {
  let startIndex = -1;

  for (const [index, line] of lines.entries()) if (line.kind === "start") startIndex = index;
  const start = lines[startIndex];

  if (start?.kind !== "start") return null;
  const attempt = lines.slice(startIndex);
  const points: Point[] = [];
  let fingerprint: Fingerprint | null = null;
  let workers: number | null = null;
  let stopReason: string | null = null;

  for (const line of attempt) {
    if (line.kind === "fingerprint") {
      fingerprint = line.fingerprint;
      workers = line.workers;
    }

    if (line.kind === "segment") points.push(line.point);

    if (line.kind === "stop") stopReason = line.stopReason;
  }

  const stopped = attempt.some((line) => line.kind === "stop");

  return summarize({
    provider,
    segmentsTarget: start.segmentsTarget,
    segmentDurationS: start.segmentDurationS,
    points,
    fingerprint,
    workers,
    stopReason: stopped ? stopReason : "Run ended without a stop record (rebuilt from its log)",
  });
}

/**
 * Rebuilds `<out>/sustained-cpu.json` from `run.json` and each provider's summary, or its log when
 * the summary is missing, in `providerSetups` order. No sandboxes are touched.
 */
export async function mergeResults(out: string): Promise<SustainedReport> {
  const files = paths(out);
  const runText = await readOptional(files.run);

  if (runText === null) throw new Error(`${files.run} is missing; nothing to merge`);
  const runFile = runFileSchema.parse(JSON.parse(runText));
  const providers: ProviderResult[] = [];

  for (const setup of providerSetups) {
    const summary = await readOptional(files.provider(setup.name));

    if (summary !== null) {
      const file = providerFileSchema.parse(JSON.parse(summary));

      if (
        file.segmentsTarget !== runFile.segmentsTarget ||
        file.segmentDurationS !== runFile.segmentDurationS
      )
        throw new Error(
          `${setup.name} ran ${file.segmentsTarget} x ${file.segmentDurationS}s, the run ${runFile.segmentsTarget} x ${runFile.segmentDurationS}s`,
        );
      providers.push(file.result);
      continue;
    }

    const log = await readOptional(files.log(setup.name));

    if (log === null) continue;
    const rebuilt = resultFromLog(setup.name, parseLog(log));

    if (rebuilt) providers.push(rebuilt);
  }

  const report: SustainedReport = {
    schema: schemaVersion,
    generatedAt: now(),
    track,
    targetDurationS: round(runFile.segmentsTarget * runFile.segmentDurationS, 3),
    segmentDurationS: runFile.segmentDurationS,
    segmentsTarget: runFile.segmentsTarget,
    run: runFile.run,
    providers,
  };

  await writeJsonAtomic(files.report, reportSchema.parse(report));

  return report;
}

// ---------------------------------------------------------------------------------------------
// Runner

export interface RunPlan {
  readonly runId: string;
  readonly out: string;
  readonly segmentsTarget: number;
  readonly segmentDurationS: number;
  readonly chunkSteps: number;
}

export interface RunDependencies {
  readonly open: OpenSession;
  readonly signal: AbortSignal;
  readonly progress: (line: string) => void;
  /** Pause between destroy retries; tests pass 0. */
  readonly retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** Destroys a sandbox, retrying; never throws. */
async function destroyWithRetry(
  destroy: () => Promise<void>,
  delayMs: number,
): Promise<{ ok: boolean; attempts: number; error: string | null }> {
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

class StopError extends Error {}

/** Runs one provider's burn end to end and writes its summary. Never throws for provider faults. */
export async function runProvider(
  setup: ProviderSetup,
  plan: RunPlan,
  dependencies: RunDependencies,
): Promise<ProviderResult> {
  const files = paths(plan.out);
  const logPath = files.log(setup.name);
  const name = setup.name;
  const say = (text: string) => dependencies.progress(`[${name}] ${text}`);

  await mkdir(files.providers, { recursive: true });
  await mkdir(files.logs, { recursive: true });

  // A retry keeps the earlier attempt's log beside the new one.
  const previous = await readOptional(logPath);

  if (previous !== null)
    await rename(
      logPath,
      join(files.logs, `${name}.${new Date().toISOString().replaceAll(":", "-")}.prev.jsonl`),
    );

  const log = async (line: LogLine) => {
    await appendFile(logPath, `${JSON.stringify(logLineSchema.parse(line))}\n`);
  };

  await log({
    kind: "start",
    provider: name,
    runId: plan.runId,
    at: now(),
    segmentsTarget: plan.segmentsTarget,
    segmentDurationS: plan.segmentDurationS,
    chunkSteps: plan.chunkSteps,
  });

  const points: Point[] = [];
  let fingerprint: Fingerprint | null = null;
  let workers: number | null = null;
  let stopReason: string | null = null;
  let box: BurnBox | null = null;
  let destroyed = false;
  let session: BurnSession | null = null;
  const delay = dependencies.retryDelayMs ?? destroyRetryDelayMs;

  const exec = async (command: string, timeoutMs: number) => {
    if (!box) throw new StopError("No sandbox");
    const target = box;

    // The adapter's own timeout kills the command; this outer deadline catches an adapter that hangs.
    return deadline(timeoutMs + 60_000, (signal) =>
      target.run(command, {
        timeoutMs,
        signal: AbortSignal.any([signal, dependencies.signal]),
      }),
    );
  };

  try {
    const opened = await dependencies.open(setup, plan);

    if (opened.kind === "skipped") throw new StopError(`Skipped: ${opened.note}`);
    session = opened.session;
    const ready = session;
    say("creating sandbox");

    box = await deadline(createTimeoutMs, (signal) =>
      ready.create(AbortSignal.any([signal, dependencies.signal])),
    );
    await log({ kind: "sandbox", id: box.id, at: now() });
    say(`sandbox ${box.id}`);

    const probe = await exec(fingerprintCommand, setupTimeoutMs);

    if (!probe.ok)
      throw new StopError(`Fingerprint exited ${probe.exitCode}: ${probe.stderr.slice(0, 300)}`);
    fingerprint = parseFingerprint(probe.stdout);
    workers = workerCount(fingerprint);
    await log({ kind: "fingerprint", at: now(), fingerprint, workers });
    say(
      `nproc ${fingerprint.guestVcpus ?? "?"}, ${fingerprint.memoryGiB ?? "?"} GiB, ${fingerprint.python ?? "no python"}, ${workers} workers`,
    );
    const python = fingerprint.pythonPath;

    if (python === null) throw new StopError("No python3 or python in the sandbox");
    const written = await exec(writeScriptCommand, setupTimeoutMs);

    if (!written.ok)
      throw new StopError(`Writing the script exited ${written.exitCode}: ${written.stderr}`);
    const burnStart = performance.now();

    for (let segment = 1; segment <= plan.segmentsTarget; segment++) {
      if (dependencies.signal.aborted) throw new StopError("Interrupted");
      const seed = randomInt(0, 0x1_0000_0000);
      const started = performance.now();

      const result = await exec(
        burnCommand({
          python,
          seed,
          workers,
          targetSeconds: plan.segmentDurationS,
          chunkSteps: plan.chunkSteps,
        }),
        segmentTimeoutMs(plan.segmentDurationS),
      );

      const ended = performance.now();

      if (result.timedOut) throw new StopError(`Segment ${segment} timed out`);

      if (!result.ok)
        throw new StopError(
          `Segment ${segment} exited ${result.exitCode}: ${result.stderr.slice(-300)}`,
        );

      const check = verifySegment({
        stdout: result.stdout,
        seed,
        workers,
        targetSeconds: plan.segmentDurationS,
        chunkSteps: plan.chunkSteps,
      });

      if (check.kind === "invalid") throw new StopError(`Segment ${segment}: ${check.reason}`);

      const point: Point = {
        segment,
        minute: round((segment * plan.segmentDurationS) / 60, 3),
        elapsedS: round(check.output.wallS, 3),
        wallOffsetS: round((ended - burnStart) / 1000, 3),
        opsPerSec: Math.round(check.opsPerSec),
      };

      points.push(point);
      await log({
        kind: "segment",
        at: now(),
        point,
        seed,
        hostS: round((ended - started) / 1000, 3),
        workers: check.output.workers,
      });
      const first = points[0]?.opsPerSec ?? point.opsPerSec;
      say(
        `segment ${segment}/${plan.segmentsTarget} min ${point.minute}: ${(point.opsPerSec / 1e6).toFixed(2)}M ops/s (${((point.opsPerSec / first) * 100).toFixed(1)}% of segment 1)`,
      );
    }
  } catch (cause) {
    stopReason = cause instanceof StopError ? cause.message : errorText(cause);
    say(`stopped: ${stopReason}`);
  } finally {
    if (box) {
      const target = box;
      const outcome = await destroyWithRetry(() => target.destroy(), delay);
      destroyed = outcome.ok;
      await log({ kind: "destroy", at: now(), sandboxId: target.id, ...outcome });
      say(outcome.ok ? `destroyed ${target.id}` : `DESTROY FAILED ${target.id}: ${outcome.error}`);
    }

    if (session) await sweep(session, log, say, delay);
  }

  const status = statusOf(points.length, plan.segmentsTarget);
  await log({ kind: "stop", at: now(), status, stopReason });

  const result = summarize({
    provider: name,
    segmentsTarget: plan.segmentsTarget,
    segmentDurationS: plan.segmentDurationS,
    points,
    fingerprint,
    workers,
    stopReason,
  });

  await writeJsonAtomic(files.provider(name), {
    schema: "sustained-cpu.provider.v1",
    runId: plan.runId,
    segmentsTarget: plan.segmentsTarget,
    segmentDurationS: plan.segmentDurationS,
    sandboxId: box?.id ?? null,
    destroyed: box === null || destroyed,
    result,
  });
  say(
    `${result.status}: ${result.segmentsCompleted} segments, retention ${result.retention ?? "n/a"}`,
  );

  return result;
}

/** Lists this run's sandboxes for the provider and destroys any still there (a lost create). */
async function sweep(
  session: BurnSession,
  log: (line: LogLine) => Promise<void>,
  say: (text: string) => void,
  delay: number,
) {
  try {
    const found = await deadline(setupTimeoutMs, () => session.leftovers());
    const destroyedIds: string[] = [];

    for (const id of found) {
      const outcome = await destroyWithRetry(() => session.destroyById(id), delay);

      if (outcome.ok) destroyedIds.push(id);
    }

    await log({ kind: "sweep", at: now(), found, destroyed: destroyedIds, error: null });

    if (found.length > 0) say(`sweep found ${found.join(", ")}; destroyed ${destroyedIds.length}`);
  } catch (cause) {
    await log({ kind: "sweep", at: now(), found: [], destroyed: [], error: errorText(cause) });
    say(`sweep failed: ${errorText(cause)}`);
  }
}

/**
 * Claims the output directory for this run: writes `run.json`, or checks that an existing one is
 * the same run with the same segment plan (a retry of some providers).
 */
async function claimOut(plan: RunPlan): Promise<RunFile> {
  const files = paths(plan.out);
  await mkdir(files.providers, { recursive: true });
  await mkdir(files.logs, { recursive: true });
  const existing = await readOptional(files.run);

  if (existing !== null) {
    const runFile = runFileSchema.parse(JSON.parse(existing));

    if (runFile.run.id !== plan.runId)
      throw new Error(
        `${plan.out} belongs to run ${runFile.run.id}; pass --run ${runFile.run.id} to retry into it, or a new --out`,
      );

    if (
      runFile.segmentsTarget !== plan.segmentsTarget ||
      runFile.segmentDurationS !== plan.segmentDurationS
    )
      throw new Error(
        `Run ${runFile.run.id} is ${runFile.segmentsTarget} x ${runFile.segmentDurationS}s; this is ${plan.segmentsTarget} x ${plan.segmentDurationS}s`,
      );

    return runFile;
  }

  const metadata = await collectMetadata(false);

  const runFile: RunFile = {
    schema: "sustained-cpu.run.v1",
    run: {
      id: plan.runId,
      sdkCommit: metadata.repositoryCommit ?? "unknown",
      startedAt: now(),
    },
    segmentsTarget: plan.segmentsTarget,
    segmentDurationS: plan.segmentDurationS,
  };

  await writeJsonAtomic(files.run, runFile);

  return runFile;
}

/** Runs the providers, `concurrency` at a time, merging after each one finishes. */
export async function runSustained(
  setups: readonly ProviderSetup[],
  plan: RunPlan & { readonly concurrency: number },
  dependencies: RunDependencies,
): Promise<SustainedReport> {
  await claimOut(plan);
  let merging = Promise.resolve();

  await pool(setups.length, plan.concurrency, async (index) => {
    const setup = setups[index];

    if (!setup) return;
    await runProvider(setup, plan, dependencies);
    // One merge at a time: each rewrites the combined file from every summary on disk.
    merging = merging.then(async () => {
      await mergeResults(plan.out);
    });
    await merging;
  });

  return mergeResults(plan.out);
}

// ---------------------------------------------------------------------------------------------
// CLI

const positiveInt = z.coerce.number().int().positive();

const cliSchema = z.object({
  providers: z.array(z.string()).min(1),
  segments: positiveInt,
  segmentSeconds: z.coerce.number().positive().max(3600),
  concurrency: positiveInt,
  chunkSteps: positiveInt,
  out: z.string().min(1),
  run: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, '.', '_' and '-'")
    .nullable(),
  mergeOnly: z.boolean(),
});

export type SustainedCli = z.infer<typeof cliSchema>;

export function parseCli(args: readonly string[]): SustainedCli {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      providers: { type: "string" },
      segments: { type: "string", default: "30" },
      "segment-seconds": { type: "string", default: "30" },
      concurrency: { type: "string", default: "15" },
      "chunk-steps": { type: "string", default: String(defaultChunkSteps) },
      out: { type: "string", default: "results/sustained-cpu" },
      run: { type: "string" },
      "merge-only": { type: "boolean", default: false },
    },
  });

  const known = providerSetups.map((s) => s.name);

  const providers =
    values.providers === undefined
      ? known
      : values.providers
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean);

  const unknown = providers.filter((name) => !known.includes(name));

  if (unknown.length > 0)
    throw new Error(`Unknown provider ${unknown.join(", ")}; known: ${known.join(", ")}`);

  return cliSchema.parse({
    providers: [...new Set(providers)],
    segments: values.segments,
    segmentSeconds: values["segment-seconds"],
    concurrency: values.concurrency,
    chunkSteps: values["chunk-steps"],
    out: values.out,
    run: values.run ?? null,
    mergeOnly: values["merge-only"],
  });
}

const autoRunId = () => `sc-${new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15)}`;

export async function sustainedCpuCommand(args: readonly string[]) {
  if (args.includes("--help")) {
    process.stdout.write(
      "bun bench sustained-cpu [--providers a,b] [--segments 30] [--segment-seconds 30] [--concurrency 15] [--chunk-steps 500000] [--out results/sustained-cpu] [--run ID] [--merge-only]\n",
    );

    return;
  }

  const cli = parseCli(args);
  const out = resolve(cli.out);

  if (cli.mergeOnly) {
    const report = await mergeResults(out);
    process.stdout.write(
      `Merged ${report.providers.length} providers into ${paths(out).report}\n${table(report)}`,
    );

    return;
  }

  const existing = await readOptional(paths(out).run);
  const existingRun = existing === null ? null : runFileSchema.parse(JSON.parse(existing)).run.id;
  const runId = cli.run ?? existingRun ?? autoRunId();
  const controller = new AbortController();
  let interrupts = 0;

  const onSignal = () => {
    interrupts++;

    if (interrupts > 1) process.exit(130);
    process.stderr.write("Interrupted: stopping after the current segment and destroying\n");
    controller.abort();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const setups = cli.providers.flatMap((name) => providerSetups.filter((s) => s.name === name));

    process.stdout.write(
      `Run ${runId}: ${setups.length} providers, ${cli.segments} x ${cli.segmentSeconds}s, concurrency ${cli.concurrency}, out ${out}\n`,
    );

    const report = await runSustained(
      setups,
      {
        runId,
        out,
        segmentsTarget: cli.segments,
        segmentDurationS: cli.segmentSeconds,
        chunkSteps: cli.chunkSteps,
        concurrency: cli.concurrency,
      },
      {
        open: openLiveSession,
        signal: controller.signal,
        progress: (line) => process.stdout.write(`${line}\n`),
      },
    );

    process.stdout.write(`${table(report)}Report: ${paths(out).report}\n`);
    const ran = new Set(cli.providers);

    if (report.providers.some((p) => ran.has(p.provider) && p.status !== "completed"))
      process.exitCode = 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function table(report: SustainedReport) {
  const millions = (value: number | null) => (value === null ? "-" : (value / 1e6).toFixed(2));

  return report.providers
    .map(
      (p) =>
        `${p.provider.padEnd(18)} ${p.status.padEnd(13)} ${String(p.segmentsCompleted).padStart(3)}/${report.segmentsTarget} first ${millions(p.first3MinOps)}M last ${millions(p.last3MinOps)}M retention ${p.retention ?? "-"} min/first ${p.minOverFirst ?? "-"}${p.stopReason ? ` (${p.stopReason})` : ""}\n`,
    )
    .join("");
}
