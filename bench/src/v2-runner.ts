import { RestoreCleanup, type RestoreAttempt } from "./restore-state.js";
import {
  SandboxError,
  createSandbox,
  connectSandbox,
  type CreateOptions,
  type Sandbox,
} from "@opencoredev/sandbox-sdk";
import type { CreateInput, SandboxInfo } from "@opencoredev/sandbox-sdk/provider";
import { cpus, loadavg } from "node:os";
import { readFile, mkdir } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { journalFiles } from "./files.js";
import { resolve, join } from "node:path";
import { z } from "zod";
import { isSizePreset, type ConfigV2 } from "./v2-config.js";
import {
  destroyTimings,
  providerMember,
  type LoadedProvider,
  type ReadyProvider,
} from "./providers.js";
import type { ReportV2, Sample, HostSample, Outcome, ProviderBudget } from "./v2-model.js";
import { PhaseClock, perfMetrics, filePayloads, firstByteAttempt } from "./measurement.js";
import { collectMetadata, headroom } from "./publication.js";
import {
  resources,
  verifyRestoredResources,
  parseFingerprint,
  type Fingerprint,
} from "./fingerprint.js";
import { estimateCost, budgetUSD, settledBudgetUSD } from "./pricing.js";
import { pricedResources, reservationResources } from "./billed-resources.js";
import {
  accountCap,
  cohortAggregate,
  cohortBoundMs,
  deleteAttemptMs,
  cohortOnly,
  isCohortKind,
  isStressSelection,
  iterationBoundMs,
  parseCohortScenario,
  scenarioNames,
  selectedCohorts,
  selectsScenario,
  survivalEndBy,
  type CohortKind,
  type SurvivalPlan,
} from "./scenarios.js";
import {
  cpuOverlap,
  cpuPhaseEvidence,
  cpuWork,
  maxStepsPerSecond,
  overlapThreshold,
  newCpuSeed,
  runStagedCpuProbe,
  stageCpuProbe,
  throughputSpread,
  type CpuMemberTiming,
  type CpuRun,
  type CpuWork,
  type StagedCpuProbe,
} from "./cpu.js";
import {
  heartbeatCommand,
  heartbeatDetails,
  heartbeatWindow,
  parseBootId,
  sessionRefusal,
  survivalFailure,
  type SurvivalVerdict,
} from "./survival.js";
import { roundRobin, schedule } from "./scheduler.js";
import { shuffle, distribution, wilson } from "./v2-stats.js";
import { performanceScript } from "./perf-script.js";
import {
  Barrier,
  CohortGates,
  DeadlineError,
  deadline,
  DeletionWork,
  PendingWork,
} from "./timing.js";
import { command, Skip, uploadFixture, cloneCommand, previewText, replay } from "./workloads.js";
import {
  autoStandby,
  idle,
  readUptime,
  standbyGap,
  startTicker,
  stopTicker,
  tickerStarted,
} from "./standby.js";
import {
  recordAbsentResolution,
  recordVerifiedRelease,
  UnverifiedOwnershipError,
  DeletionUnconfirmedError,
  hasRunOwnership,
  verifyRunOwnership,
  writeOwnership,
  assertJournalFree,
  type CleanupReview,
  proveSnapshotSource,
  type SnapshotProvenance,
  snapshotProvenanceSchema,
} from "./ownership.js";
import {
  snapshotCleaner,
  undeletableSnapshots,
  createNamedDaytonaSnapshot,
  createNamedMaritimeSnapshot,
  maritimeSnapshotName,
  settleJournaledSnapshot,
  settleMaritimeSave,
  snapshotsFromSource,
  deleteProvenSnapshot,
} from "./snapshots.js";
import { collectionPolicy } from "./collection-policy.js";
import { isAbsent, lookupSandbox } from "./existence.js";
import { connectionOf, journalFingerprint } from "./connections.js";
import { captureVercelMeter } from "./billing/providers.js";
import { recordStop, stopJournalFile } from "./stops.js";
import { failureOutcome } from "./failure.js";
import {
  attemptLabel,
  cleanService,
  isDefiniteRefusal,
  isRetrySlug,
  isServiceSuperseded,
  probePendingService,
  settleAllocationAttempt,
  tierLabel,
  type ServiceState,
} from "./microsandbox.js";
import { microsandboxTier } from "./providers.js";
import type { MicrosandboxHooks } from "@opencoredev/sandbox-sdk/microsandbox";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import {
  allocated,
  attemptApp,
  beginAllocation,
  failedAllocation,
  journalApp,
  pendingForRun,
  preparesApps,
  reconcileDiscovered,
  type JournalApp,
} from "./modal-apps.js";

/**
 * Providers whose snapshots keep files but not CPU and memory, so a restore must ask for the
 * source's size again. Other providers' snapshots or templates own their resources, and their
 * restores stay as published.
 */
const restoreNeedsSize: ReadonlySet<string> = new Set([
  "modal",
  "microsandbox",
  "microsandbox-shared",
]);

/**
 * The size a restore asks for. A Microsandbox restore keeps the snapshot's disk and takes CPU and memory
 * only, so an exact size loses its `diskGb`: `--size microsandbox=4:8192:64` creates cold with 64 GiB and
 * restores at 4:8192.
 */
export function restoreSize(provider: string, size: NonNullable<CreateOptions["size"]>) {
  if (microsandboxTier(provider) === undefined || isSizePreset(size)) return size;

  return { cpu: size.cpu, memoryMb: size.memoryMb };
}

/** A Microsandbox provider that takes the bench's attempt hooks (`setAttemptHooks`). */
function takesAttemptHooks(
  provider: Provider,
): provider is Provider & { setAttemptHooks(hooks: MicrosandboxHooks): void } {
  return "setAttemptHooks" in provider && typeof provider.setAttemptHooks === "function";
}

export { scenarioNames } from "./scenarios.js";

const workloadNames = new Set([
  "git-clone",
  "npm-install",
  "dev-server",
  "preview-first-byte",
  "edit-loop",
  "tool-replay",
  "pip-install",
]);

const perfSchema = z.object({
  metrics: z.record(z.string(), z.number().finite()),
  notes: z.array(z.string()),
  workers: z.number(),
  method: z.string(),
});

/** What a timed-out create left behind, recorded on the failed sample once it settles. */
interface CreateEvidence {
  unverifiedSandboxId?: string;
  cleanupOutcome?: "succeeded" | "failed" | "already-absent" | "unknown";
  settled: boolean;
  sandboxId?: string;
  stage: string;
  code?: string;
  cause?: import("./failure.js").FailureOutcome["cause"];
}

interface RestoreDetails {
  verification: ReturnType<typeof verifyRestoredResources> | null;
}

/** Scenarios that cannot run once the keyed scenario has failed. */
const downstream = new Map([
  ["create-from-snapshot", ["restore-fingerprint"]],
  ["npm-install", ["dev-server", "preview-provisioning", "preview-first-byte", "edit-loop"]],
  ["preview-provisioning", ["dev-server", "preview-first-byte", "edit-loop"]],
  ["dev-server", ["preview-first-byte", "edit-loop"]],
  ["preview-first-byte", ["edit-loop"]],
]);

/** One cohort's shared state: K members start together, then the cohort writes its aggregate row. */
interface CohortRun {
  kind: CohortKind;
  k: number;
  /** Released once every member is created (or failed): cpu-burst work and survival windows start together. */
  ready: Barrier;
  /** Released once every member has finished its work; members keep their sandboxes until then. */
  done: Barrier;
  /** `performance.now()` when the cohort started admitting members: the survival deadline's base. */
  startedAt: number;
  /**
   * Each member's successful CPU workload (cpu-burst): when its exec returned (`performance.now()`,
   * taken before any report write), its phases on the host clock, and that clock's uncertainty.
   */
  cpu: (CpuMemberTiming & { returnedAt: number })[];
  /** Each member's window verdict (survival). */
  verdicts: SurvivalVerdict["kind"][];
}

/** The aggregate a finished cohort records. `finishedAt` is epoch milliseconds. */
interface CohortRow {
  outcome: Outcome;
  durationMs: number;
  unit: string;
  finishedAt: number;
  details: object;
}

interface CohortMember {
  run: CohortRun;
  gates: CohortGates;
}

const outcomeValues = (rows: readonly Sample[]) =>
  rows.flatMap((s) => (s.outcome.kind === "sample" ? [s.outcome.value] : []));

/** A burst cohort is a sample only when every sandbox became ready. */
function burstOutcome(burst: {
  k: number;
  success: number;
  attempted: number;
  readyMs: number;
  durationMs: number;
}): Outcome {
  const { k, success, attempted } = burst;

  if (success === k) return { kind: "sample", value: burst.readyMs };

  const note = `${success}/${k} ready; ${attempted} attempted (budgets may prevent admission)`;

  if (attempted < k) return { kind: "skipped", note };

  if (attempted > k) return { kind: "failure", note };

  return { kind: "failure", note, stage: `burst-${k}/all-ready`, elapsedMs: burst.durationMs };
}

/** The snapshot IDs the ownership journal holds for one source sandbox of one provider. */
export function journaledSnapshots(
  entries: Iterable<{ provider: string; id: string; kind: string; parent: string | null }>,
  provider: string,
  sourceId: string,
): ReadonlySet<string> {
  return new Set(
    Array.from(entries)
      .filter((e) => e.provider === provider && e.kind === "snapshot" && e.parent === sourceId)
      .map((e) => e.id),
  );
}

const errorNote = (cause: unknown) =>
  sanitize(cause instanceof Error ? cause.message : "Unknown failure");

/**
 * Credential shapes no environment variable names: Maritime's account and server keys (`mk_`, `mlk_`),
 * sandbox secrets (`mst_`) and URL tokens (`mut_`), Microsandbox's organization keys and personal
 * access tokens (`msb_`, `msb_pat_`), and any `token=` query value, such as a preview URL's.
 */
const leakPatterns: [RegExp, string][] = [
  [/(?:mst|mut|mk|mlk)_[A-Za-z0-9_-]{8,}/g, "[REDACTED]"],
  [/msb_(?:pat_)?[A-Za-z0-9_-]+/g, "[REDACTED]"],
  [/([?&;]token=)[^&#\s"'<>]+/gi, "$1[REDACTED]"],
];

export function sanitize(text: string) {
  let result = text;

  for (const [name, value] of Object.entries(process.env))
    if (/KEY|TOKEN|SECRET|PASSWORD/.test(name) && value && value.length > 5)
      result = result.replaceAll(value, "[REDACTED]");

  for (const [pattern, replacement] of leakPatterns) result = result.replace(pattern, replacement);

  return result;
}

async function host(): Promise<HostSample> {
  return {
    timestamp: new Date().toISOString(),
    load: loadavg(),
    cpu: process.cpuUsage(),
    cpuTicks: cpus().map((c) => Object.values(c.times)),
    network: await readFile("/proc/net/dev", "utf8").catch(() => "unavailable"),
  };
}

/**
 * Per-group statistics. `regions` maps each provider to the region its run was configured with
 * (`configuredRegion`), so every cost figure, including performance per dollar, carries the
 * region multiplier the provider bills (Modal).
 */
export function summarize(
  samples: Sample[],
  seed: number,
  regions: Readonly<Record<string, string | null>> = {},
) {
  const groups = new Map<string, Sample[]>();

  for (const s of samples) {
    const key = JSON.stringify([
      s.track ?? "default",
      s.requestedSize ?? null,
      s.template ?? null,
      s.product ?? null,
      s.provider,
      s.scenario,
      s.unit,
    ]);

    const values = groups.get(key) ?? [];
    values.push(s);
    groups.set(key, values);
  }

  return [...groups.values()].flatMap((rows) => {
    const first = rows[0];

    if (!first) return [];

    const successes = rows.filter((r) => r.outcome.kind === "sample"),
      values = successes.flatMap((r) => (r.outcome.kind === "sample" ? [r.outcome.value] : [])),
      failures = rows.filter((r) => r.outcome.kind === "failure").length;

    const costs = rows.map((r) => r.estimatedCost),
      cost = costs.every((c) => c !== null) ? costs.reduce((a, b) => a + b, 0) : null;

    const efficiency = successes.map((row) => {
      const rate = estimateCost(
        row.provider,
        1000,
        pricedResources(row.provider, row.fingerprint, row.requestedSize ?? null)?.resources ??
          null,
        regions[row.provider] ?? null,
      );

      if (!rate || row.outcome.kind !== "sample" || row.outcome.value <= 0) return null;

      return (row.unit === "ms" ? 1000 / row.outcome.value : row.outcome.value) / rate;
    });

    const performancePerDollar =
      efficiency.length && efficiency.every((v) => v !== null)
        ? efficiency.reduce((a, b) => a + b, 0) / efficiency.length
        : null;

    return [
      {
        track: first.track ?? "default",
        requestedSize: first.requestedSize ?? null,
        template: first.template ?? null,
        product: first.product ?? null,
        provider: first.provider,
        scenario: first.scenario,
        unit: first.unit,
        stats: distribution(values, seed),
        success: wilson(successes.length, successes.length + failures),
        failures,
        skipped: rows.filter((r) => r.outcome.kind === "skipped").length,
        blocked: rows.filter((r) => r.outcome.kind === "blocked").length,
        estimatedCost: cost,
        per1000: cost === null ? null : (cost / rows.length) * 1000,
        performancePerDollar,
      },
    ];
  });
}

/**
 * The providers a run may create on: every ready one whose connection fingerprint the journal
 * can record. One without is skipped with the reason, so no sandbox is ever created that a later
 * reap would refuse to clean up.
 */
export async function fingerprinted(candidates: readonly LoadedProvider[]): Promise<{
  loaded: LoadedProvider[];
  connectionFingerprints: Record<string, string>;
}> {
  const connectionFingerprints: Record<string, string> = {};
  const loaded: LoadedProvider[] = [];

  for (const p of candidates) {
    if (p.kind === "skipped") {
      loaded.push(p);
      continue;
    }

    const fingerprint = await journalFingerprint(p.provider);

    if (fingerprint.kind === "unknown") {
      loaded.push({
        kind: "skipped",
        name: p.name,
        note: `No connection fingerprint for the run's journal (${fingerprint.reason}); skipped before any create, since a reap could not clean up its sandboxes`,
      });
      continue;
    }

    connectionFingerprints[p.name] = fingerprint.value;
    loaded.push(p);
  }

  return { loaded, connectionFingerprints };
}

/**
 * What a sandbox's iteration charged the budget for it: its life from `since` to `chargedUntil`,
 * at `price` for a whole lifetime of a given length (billing minimum and creation fee included).
 * `chargedUntil` is `since` when nothing was charged (a sandbox no iteration claimed) and
 * `Infinity` while its iteration is still open. When `chargedUSD` is set, it holds the exact USD
 * booked to the budget for this sandbox; otherwise the charged part is priced at `chargedUntil - since`.
 */
export type Charge = {
  since: number;
  chargedUntil: number;
  chargedUSD?: number;
  price: (lifetimeMs: number) => number | null;
};

/**
 * What the budget still owes for a sandbox observed live until `end`: its whole observed life
 * priced on the charge's basis, less what that basis already charged, never below zero. Pricing
 * the time past `chargedUntil` as a lifetime of its own would charge the billing minimum and the
 * creation fee a second time. Null when the life cannot be priced.
 */
export function chargeBeyond(charge: Charge, end: number): number | null {
  if (end <= charge.chargedUntil) return 0;
  const whole = charge.price(end - charge.since);

  if (whole === null) return null;

  const charged =
    charge.chargedUSD !== undefined
      ? charge.chargedUSD
      : charge.chargedUntil > charge.since
        ? charge.price(charge.chargedUntil - charge.since)
        : 0;

  // An unpriceable charged part is taken as nothing: the guard over-charges, never under.
  return Math.max(0, whole - (charged ?? 0));
}

export async function runV2(
  candidates: LoadedProvider[],
  config: ConfigV2,
  checkpoint: (report: ReportV2) => Promise<void>,
  metadata = collectMetadata(),
) {
  // Each adapter's connection fingerprint, never the connection itself: an endpoint can carry a
  // credential in its userinfo, path or query. `reap` reads only through an adapter whose
  // connection, rebuilt from its environment, has the same fingerprint, so a provider whose
  // fingerprint cannot be read now (Docker's /info failing, an unresolved connection) is skipped
  // before its first create: its sandboxes could never be reaped after a crash.
  const { loaded, connectionFingerprints } = await fingerprinted(candidates);

  await mkdir(resolve(config.out), { recursive: true });
  // Before this run writes anything there: another run's journal must not be overwritten.
  await assertJournalFree(join(resolve(config.out), "ownership.json"), config.run, config.force);
  await journalFiles.writeFile(
    join(resolve(config.out), "run.json"),
    JSON.stringify({ runId: config.run }),
    {
      flag: "wx",
    },
  );

  const report: ReportV2 = {
    schemaVersion: 2,
    runId: config.run,
    timestamp: new Date().toISOString(),
    finishedAt: "",
    config,
    metadata: await metadata,
    host: { cpu: cpus()[0]?.model ?? "unknown", os: process.platform, runtime: process.version },
    samples: [],
    summaries: [],
    providers: loaded.map((p) => ({
      name: p.name,
      track: config.track,
      requestedSize: config.size[p.name] ?? (p.name === "local" ? "medium" : null),
      template: config.template[p.name] ?? null,
      product: config.product[p.name] ?? null,
      kind: p.kind,
      configuredRegion: p.kind === "ready" ? p.region : null,
      note:
        p.kind === "skipped"
          ? p.note
          : (config.product[p.name] ? `Native product: ${config.product[p.name]}. ` : "") +
            (config.size[p.name] || config.template[p.name]
              ? "Requested allocation/template overrides; verify actual resources in fingerprints"
              : p.name === "local"
                ? "Docker reference baseline; host costs excluded"
                : "Provider default image and allocation"),
    })),
    cleanup: [],
    cleanupReview: [],
    cleanupReleased: [],
    cleanupResolved: [],
    budgets: {},
    admissionStopped: [],
    methodology: [
      "Daytona snapshots use its native nameable API with a 600-second completion budget to journal a run-owned snapshot name before creation. The SDK wrapper retains recovery names in errors, but generates them internally. Other lifecycle calls use the common SDK. Snapshot timeout is retained as failure and cleanup uses only journaled names.",
      "Round-robin iteration admission, independent per-provider and global limits. Seeded scenario groups; dependencies (install → dev → preview → edit) retain order. Fingerprint first, cold first, destroy last. No warmup samples discarded.",
      "Cold and restore time adapter.create through a bare adapter true command before SDK handle initialization; burst all-ready ends at the slowest bare command. adapterCreateMs, firstCommandMs, coldMs and sdkReadyMs expose phases; sdkReadyMs includes SDK initialization and is excluded from the headline. firstCommandOKMs starts at iteration admission before host sampling and budget work. Destroy/restore-destroy time only deletion requests (including retries); live ownership verification and journal writes are recorded separately. Live ownership verification and durable journal writes are excluded from cold/burst readiness and recorded as ownershipVerifyMs/ownershipPersistMs. Reconnect/resume still use SDK command readiness.",
      "Tracks remain separate: default uses provider defaults (local medium); same-spec records explicitly requested allocation and factory template per provider. Fingerprints establish actual resources; a track label does not prove resource equality. Fixture uploads run in separate preparation scenarios before npm-install/tool-replay. Image, package, CDN and filesystem caches are uncontrolled.",
      "Dependent scenarios share a sandbox. A failed cold/reconnect/resume/snapshot blocks subsequent work; blocked_by rows are reported separately and excluded from independent failure denominators. App install/provision/start/preview prerequisites also propagate blocking. Cleanup still runs.",
      "Preview provisioning and dev-server start are separate scenarios. Each HTTP attempt is timed through its first chunk only; cancellation and inter-attempt sleeps are outside that measurement. Failed attempts remain failure rows. Snapshot values time native API only; snapshot-setup and snapshot-total expose client setup/journal overhead.",
      "Repeated burst cohorts retain independent cohort indices. Client-headroom flags use load1/logical CPUs >=1 or sampled host CPU utilization >=90%; overlapping samples share host counters and must not be summed as provider-attributable traffic.",
      "At n=100, nearest-rank p99 depends on roughly the two slowest observations and is unstable. Bootstrap intervals do not eliminate this tail uncertainty; publish sample counts and raw values.",
      "All failures retained; percentiles/CI describe successful observations only. Independent success rate uses Wilson 95% interval (skips and blocked dependencies excluded). Nearest rank, population stddev, 2000 seeded bootstrap resamples for p50 and mean. No outlier removal.",
      "Fingerprint includes public ipinfo.io lookup (optional); region and org are observed egress, not a promise about placement. Host counters are cumulative: difference before/after to derive CPU and network load.",
      "CPython fixed LCG iterations/s; all-core uses ceil of min(nproc, cgroup quota), capped at 64 with worker count recorded. Python version and CPU flags retained: runtime differences remain a confounder. 16 MiB memory copy; 64 MiB buffered sequential I/O; fsync writes and 256 random 4 KiB operations at queue depth 1. Reads may be cached; no O_DIRECT. Decimal MB/s.",
      "Network: 25,000,000 bytes from speed.cloudflare.com including TLS; mean of five TCP connects to 1.1.1.1:443. Egress geography, CDN caches, shared host load and provider caches are uncontrolled.",
      "Costs are estimates, not invoices; marginal usage only, excludes subscriptions/credits/transfer/persistent snapshot retention. Cost per scenario allocates its measured duration; sandbox-lifetime records include setup and idle time and must not be summed with scenario allocations. Upstash/boxd allocated-resource estimates are upper bounds. Modal is priced on its requested allocation, never the guest view: exact when sized (request = limit), a lower bound on the default track (0.125 CPU / 128 MiB minimum request; billed burst usage above it is not counted), with Modal's region multiplier for a pinned region. Unknown resources yield null, never zero. Pricing retrieval dates are recorded per provider; EUR and USD remain separate with no cross-currency ranking.",
      "Budget admission reserves timeout × scenario count at observed or conservative default resources. Dollar budgets are estimates, not account spend caps; boxd uses conservative 2 USD/EUR for budget only. Failed/unknown creations count toward sandbox budget.",
      "Reported budget spend prices every sandbox from its iteration's start until it was first observed gone: an exact native lookup found it absent or terminal. A delete acknowledgment is not a stop; after one, the harness looks the sandbox up every 0.1-1 s for up to the step timeout (at most 30 s), and once more after every provider's final sweep. Cleanup time past a reserve cannot be bounded: a sandbox still there when its reserve runs out is deleted by the run's final sweep and priced until it is seen gone. One never observed gone (including any on a provider with no exact lookup) is listed in budgets as an open liability, and every provider's budget is priced to one cutoff taken after all sweeps, just before the report is saved. An estimate over the dollar cap says so in the budget's stop note.",
    ],
  };

  if (selectsScenario(config.scenarios, "cpu-sustained") || config.scenarios.includes("cpu-burst"))
    report.methodology.push(
      `CPU probe (probes/cpu.py): perf.py's CPython 32-bit LCG kernel from a fresh random seed per run, fixed work of segments x steps (cpu-sustained ${cpuWork.sustained.segments}x${cpuWork.sustained.steps}, cpu-burst ${cpuWork.burst.segments}x${cpuWork.burst.steps}) on one process, then on ceil(min(nproc, quota)) fork() workers (max 64) reporting over pipes. The script is written to the guest and the guest clock read before the run. A row fails unless every process's final LCG state equals the harness's own value for that seed, segment times add up to each phase, guest wall-clock spans match, no rate exceeds ${maxStepsPerSecond.toExponential(0)} steps/s, and the phases fit inside the exec the host timed. These checks reject wrong, stale or implausible replies; they cannot prove the guest executed the work, since the LCG has a closed form and the provider controls the guest's output. Rows: steps/s single and all-core (worker startup included), each segment's rate, consistency (slowest segment over median segment) and trend (last quarter of segments over first quarter), and the CPUs the guest sees (affinity, cgroup quota). Python version differences remain a confounder.`,
    );

  if (config.scenarios.includes("cpu-burst"))
    report.methodology.push(
      `CPU burst: K sandboxes created at once; each stages its probe, then once every member is ready (or failed) all dispatch the short CPU workload together. Each member's throughput is its own row; all-complete runs from that common start to the slowest member's exec return (timestamped before any report write) and is a sample only when all K complete. Overlap is proven from the host clock, never a guest wall clock: each member's throughput rows record its exec on the host clock (exec, from just before dispatch to its return) and each phase's length on the guest's own monotonic timer. A member ran single and then all-core inside its exec, so its single phase started no later than return - all - single and ended no earlier than dispatch + single (all-core: return - all and dispatch + single + all). The span from the latest such start to the earliest such end across members is a lower bound on the time every member ran that phase together, whatever any guest clock did; the aggregate records it per phase (provenMs, and provenFraction of the median member's phase), flags the cohort unless both fractions are at least ${overlapThreshold}, and marks it inconsistent when a member's phases are longer than its exec. Publication recomputes this from the members' rows. clockDriftMs, the change in a guest clock's offset from the host between a read at staging and one after the run, is recorded as a diagnostic and gates nothing. Per-sandbox spread: nearest-rank p50/p95, min/max, max/min and coefficient of variation.`,
    );

  if (config.scenarios.includes("survival"))
    report.methodology.push(
      `Burst survival: K sandboxes created at once; once every member is ready (or failed), each sends a heartbeat (${heartbeatCommand}) every ${config["survival-heartbeat-ms"]} ms and at the window's end (${config["survival-window-ms"]} ms), each bounded by the interval. A missed heartbeat triggers an exact read-only native lookup within the same bound. Exact lifecycle evidence decides: absent, terminal or a dead native state is death and a live native state is not, whatever the exec error; an SDK not_found decides only when no lookup answered; a changed boot ID is death. Any other miss marks the member unresponsive. Slots that pass while a miss is being handled are recorded as skipped, never sent late, and every heartbeat and lookup ends by one cohort deadline that keeps the cleanup reserve. Survival needs every slot answered, through the window's end. Create failures and heartbeats need a typed signal (SDK code quota or HTTP 429) to count as account limits; a proven death never does. An interrupted run's unfinished windows are skipped, not failures.`,
    );

  let reportWrites = Promise.resolve();

  const save = () => {
    reportWrites = reportWrites.then(() => checkpoint(report));

    return reportWrites;
  };

  const stopping = new AbortController();

  const requestStop = () => {
    stopping.abort();
  };

  process.on("SIGINT", requestStop);
  process.on("SIGTERM", requestStop);
  const ready = loaded.filter((p) => p.kind === "ready");

  type ProviderState = {
    created: number;
    estimatedUSD: number;
    stop: string | null;
    reserved: number;
    fp: Fingerprint | null;
  };

  const states = new Map<string, ProviderState>(
    ready.map((p) => [
      p.name,
      {
        created: 0,
        estimatedUSD: 0,
        stop: null,
        reserved: 0,
        fp: null,
      },
    ]),
  );

  const runDir = resolve(config.out);
  await mkdir(runDir, { recursive: true });
  // The durable journal records cleanup candidates; live labels authorize deletion.
  const unsafeProviders = new Set<string>();
  const deletions = new DeletionWork();
  /**
   * Sandboxes whose iteration's cleanup reserve ran out before a deletion was confirmed. Their
   * iteration touches them no more; the run's final sweep retries them, and they stay journaled
   * for `bun bench reap` if that fails too.
   */
  const leftForReap = new Set<string>();

  /**
   * When each sandbox was first observed gone, by `provider/id`: an exact lookup found it absent
   * or terminal. A delete acknowledgment is never a stop; until a lookup sees the sandbox gone it
   * is an open liability.
   */
  const gone = new Map<string, number>();

  /** Watches started by acknowledged deletes, each looking until its sandbox is observed gone. */
  const watches = new Map<string, Promise<void>>();
  const stopWatching = new AbortController();

  /** One exact lookup; records the sandbox gone, at the lookup's return, if it found it absent. */
  async function observeGone(p: ReadyProvider, id: string, timeoutMs: number) {
    const key = `${p.name}/${id}`;

    if (gone.has(key)) return true;
    const evidence = await lookupSandbox(p.provider, id, Math.max(1, timeoutMs));

    if (!isAbsent(evidence)) return false;

    if (!gone.has(key)) gone.set(key, performance.now());

    return true;
  }

  /**
   * After a delete is acknowledged, look the sandbox up at once and then every 0.1-1 s until it
   * is observed gone, for as long as the final sweep's listing wait (the step timeout, at most
   * 30 s). Runs beside the iteration, so it changes no timing. A sandbox still unseen when the
   * watch ends is looked up once more before the run prices its budgets.
   */
  function watchGone(p: ReadyProvider, id: string) {
    const key = `${p.name}/${id}`;

    if (gone.has(key) || watches.has(key)) return;
    const end = performance.now() + Math.min(config["timeout-ms"], 30_000);

    const watch = (async () => {
      for (let delay = 0; ; delay = Math.min(1000, Math.max(100, delay * 2))) {
        if (delay > 0) await wait(delay, undefined, { signal: stopWatching.signal });

        const left = end - performance.now();

        if (left <= 0 || (await observeGone(p, id, Math.min(config["timeout-ms"], left)))) return;
      }
    })()
      .catch(() => {})
      .finally(() => watches.delete(key));

    watches.set(key, watch);
  }

  const charges = new Map<string, Charge>();
  const runStart = performance.now();
  const restores = new RestoreCleanup();

  interface OwnedEntry {
    provider: string;
    id: string;
    /**
     * `allocation-attempt`: a Microsandbox create journaled before it is sent, by the sandbox name it
     * carries (`id`) and its allocation marker; a restore's also names its snapshot (`parent`) and source.
     * `service`: a Microsandbox Service slug (`id`) journaled before it is made, for sandbox `parent`.
     */
    kind: "sandbox" | "snapshot" | "snapshot-source" | "allocation-attempt" | "service";
    parent: string | null;
    snapshotProof?: SnapshotProvenance;
    /** The save's idempotency key, journaled before a Maritime save so an unanswered one can be settled. */
    idempotencyKey?: string;
    /** A Microsandbox create's allocation marker. */
    allocId?: string;
    /** A Microsandbox restore attempt's source sandbox. */
    sourceId?: string | null;
    /** When a Microsandbox create was journaled, for its settlement window. */
    attemptedAt?: string;
    /** The sandbox name a Microsandbox Service targets. */
    sandboxName?: string;
    /** A Microsandbox Service's create: `pending` until the adapter confirms it made the Service. */
    serviceState?: ServiceState;
    /** The server `created_at` of a confirmed Microsandbox Service create. */
    serviceCreatedAt?: string;
    /** True once a retry slug proved this base slug hit a foreign 409 conflict. */
    serviceSuperseded?: boolean;
    /** A Microsandbox capture's name; equal to `id` while the capture is unconfirmed. */
    snapshotName?: string;
  }

  const owned = new Map<string, OwnedEntry>();

  // Per-attempt Apps (--app-per-attempt): journaled before any sandbox is allocated in them and
  // never removed, so recovery can list their sandboxes and billing can attribute their charges.
  const apps = new Map<string, JournalApp>();
  // Restores still tagged pending, owned by the exact tag read that listed them (Modal).
  const pendingOwned = new Set<string>();

  let journal = Promise.resolve();

  // Before any create, so a run that dies before its first create returns still leaves the
  // fingerprints a reap needs for label recovery: reap refuses a connection the journal lacks.
  if (loaded.some((p) => p.kind === "ready")) await persist();

  function serializeJournal(override?: { key: string; value: OwnedEntry }) {
    const resources = [...owned.entries()].map(([k, v]) =>
      override && k === override.key ? override.value : v,
    );

    if (override && !owned.has(override.key)) resources.push(override.value);

    return JSON.stringify(
      { runId: config.run, connectionFingerprints, resources, apps: [...apps.values()] },
      null,
      2,
    );
  }

  function persist() {
    const next = journal.then(() =>
      writeOwnership(join(runDir, "ownership.json"), serializeJournal()),
    );

    journal = next.catch(() => {});

    return next;
  }

  /**
   * Persist a confirmed snapshot entry (without `idempotencyKey`) to disk BEFORE mutating `owned`.
   * If a concurrent timeout or rename failure interrupts the write, `owned` keeps the pending
   * `idempotencyKey` entry intact so neither cleanup nor recovery can skip persisting or send DELETE
   * while `ownership.json` on disk still carries the save key.
   */
  function persistConfirmedSnapshot(key: string, value: OwnedEntry) {
    const next = journal.then(async () => {
      await writeOwnership(join(runDir, "ownership.json"), serializeJournal({ key, value }));
      owned.set(key, value);
    });

    journal = next.catch(() => {});

    return next;
  }

  /**
   * Applies `mutate` to a shallow copy of `owned`, writes the candidate to `ownership.json`, and
   * applies `mutate` to live `owned` only after the atomic rename succeeds. Applying `mutate(owned)`
   * rather than replacing the whole map preserves concurrent mutations on other keys (such as a
   * burst sibling retiring a refused allocation attempt while this rename was in flight).
   */
  function persistJournalUpdate(mutate: (target: Map<string, OwnedEntry>) => void) {
    const next = journal.then(async () => {
      const nextOwned = new Map<string, OwnedEntry>();

      for (const [k, v] of owned) nextOwned.set(k, { ...v });
      mutate(nextOwned);

      await writeOwnership(
        join(runDir, "ownership.json"),
        JSON.stringify(
          {
            runId: config.run,
            connectionFingerprints,
            resources: [...nextOwned.values()],
            apps: [...apps.values()],
          },
          null,
          2,
        ),
      );

      mutate(owned);
    });

    journal = next.catch(() => {});

    return next;
  }

  /** Microsandbox attempt names by the per-call label the tracked create adds. */
  const attemptNames = new Map<string, string>();
  /** The name of the latest Microsandbox capture journaled for each source sandbox. */
  const captureNames = new Map<string, string>();

  /**
   * Journals each Microsandbox allocation before the adapter sends it: a create's name and marker, a
   * Service's slug, a capture's name. A journal write that fails stops the request before it is sent.
   */
  function microsandboxJournal(name: string): MicrosandboxHooks {
    return {
      create: async (attempt) => {
        const label = attempt.labels[attemptLabel];
        const attemptedAt = new Date().toISOString();

        await persistJournalUpdate((target) => {
          target.set(`${name}/allocation-attempt/${attempt.name}`, {
            provider: name,
            id: attempt.name,
            kind: "allocation-attempt",
            parent: attempt.from ?? null,
            sourceId:
              attempt.from === undefined
                ? null
                : (target.get(`${name}/snapshot/${attempt.from}`)?.parent ?? null),
            allocId: attempt.allocId,
            attemptedAt,
          });
        });

        if (label !== undefined) attemptNames.set(label, attempt.name);
      },
      service: async (attempt) => {
        const key = `${name}/service/${attempt.slug}`;

        await persistJournalUpdate((nextOwned) => {
          let hasOlderRetry = false;

          for (const other of nextOwned.values()) {
            if (
              other.provider === name &&
              other.kind === "service" &&
              other.parent === attempt.sandboxId
            ) {
              if (isRetrySlug(attempt.slug, other.id)) other.serviceSuperseded = true;

              if (isRetrySlug(other.id, attempt.slug)) hasOlderRetry = true;
            }
          }

          // Delete before set so a re-attempted base slug always sits AFTER any older retry slug.
          nextOwned.delete(key);

          const entry: OwnedEntry = {
            provider: name,
            id: attempt.slug,
            kind: "service",
            parent: attempt.sandboxId,
            sandboxName: attempt.sandboxName,
            serviceState: "pending",
          };

          if (hasOlderRetry) entry.serviceSuperseded = false;
          nextOwned.set(key, entry);
        });
      },
      // A confirmed create marks the slug the run's; a 409 or other refusal drops it before any other
      // slug is tried, so a slug that was someone else's never stays journaled as the run's.
      serviceSettled: async ({ slug, outcome, createdAt }) => {
        const key = `${name}/service/${slug}`;
        const entry = owned.get(key);

        if (entry === undefined) return;

        if (outcome === "created") {
          const nextCreatedAt = createdAt ?? entry.serviceCreatedAt;

          if (entry.serviceState === "created" && entry.serviceCreatedAt === nextCreatedAt) return;
          const updated = { ...entry, serviceState: "created" as const };

          if (nextCreatedAt !== undefined) updated.serviceCreatedAt = nextCreatedAt;
          await persistConfirmedSnapshot(key, updated);

          return;
        }

        await persistJournalUpdate((nextOwned) => {
          const current = nextOwned.get(key);

          if (current === undefined) return;
          const entries = [...nextOwned.entries()];
          const entryIndex = entries.findIndex(([k]) => k === key);

          for (let i = 0; i < entryIndex; i++) {
            const other = entries[i]![1];

            if (
              other.provider === name &&
              other.kind === "service" &&
              other.parent === current.parent &&
              isRetrySlug(current.id, other.id) &&
              other.serviceSuperseded === undefined
            )
              other.serviceSuperseded = true;
          }

          nextOwned.delete(key);
        });
      },
      snapshot: async (attempt) => {
        await persistJournalUpdate((nextOwned) => {
          nextOwned.set(`${name}/snapshot/${attempt.name}`, {
            provider: name,
            id: attempt.name,
            kind: "snapshot",
            parent: attempt.sandboxId,
            snapshotProof: nextOwned.get(`${name}/snapshot-source/${attempt.sandboxId}`)
              ?.snapshotProof,
            snapshotName: attempt.name,
          });
        });

        captureNames.set(attempt.sandboxId, attempt.name);
      },
      // No capture request went out under this name, so its name-journaled entry can never settle.
      snapshotSettled: async (settled) => {
        const key = `${name}/snapshot/${settled.name}`;

        await persistJournalUpdate((nextOwned) => {
          if (nextOwned.get(key)?.snapshotName === settled.name) nextOwned.delete(key);
        });

        if (captureNames.get(settled.sandboxId) === settled.name)
          captureNames.delete(settled.sandboxId);
      },
    };
  }

  for (const p of ready)
    if (microsandboxTier(p.name) !== undefined && takesAttemptHooks(p.provider))
      p.provider.setAttemptHooks(microsandboxJournal(p.name));

  /**
   * Settles a Microsandbox create journaled by name: a sandbox carrying its marker joins the journal as a
   * sandbox and leaves the attempt. `pending` while it is still unresolved (a name 404 included, however
   * old), which keeps it, and a restore's snapshot and source, journaled.
   */
  async function settleAttempt(p: ReadyProvider, entry: OwnedEntry): Promise<string | "pending"> {
    const tier = microsandboxTier(p.name);

    if (tier === undefined) return "pending";

    const outcome = await settleAllocationAttempt(
      connectionOf(p.provider, "microsandbox"),
      {
        id: entry.id,
        allocId: entry.allocId,
        attemptedAt: entry.attemptedAt,
      },
      tier,
    );

    if (outcome.kind === "pending") {
      review(p.name, entry.id, outcome.reason, "allocation-attempt");

      return "pending";
    }

    owned.delete(`${p.name}/allocation-attempt/${entry.id}`);
    owned.set(`${p.name}/${outcome.id}`, {
      provider: p.name,
      id: outcome.id,
      kind: "sandbox",
      parent: null,
    });
    report.cleanupReview = report.cleanupReview?.filter(
      (r) => !(r.provider === p.name && r.id === entry.id && r.kind === "allocation-attempt"),
    );
    await persist();

    return outcome.id;
  }

  function review(
    provider: string,
    id: string,
    reason: string,
    kind: CleanupReview["kind"] = "sandbox",
  ) {
    if (
      !report.cleanupReview?.some((v) => v.provider === provider && v.id === id && v.kind === kind)
    )
      report.cleanupReview?.push({
        provider,
        id: sanitize(id),
        kind,
        reason,
        status: kind === "sandbox" ? "checking" : "unresolved",
      });
  }

  /** Milliseconds left before `endBy` (`performance.now()`), or unbounded without one. */
  const leftUntil = (endBy: number | undefined) =>
    endBy === undefined ? Infinity : endBy - performance.now();

  async function resolveAbsent(p: ReadyProvider, id: string, endBy?: number) {
    if (leftUntil(endBy) <= 0) return false;
    await deletions.wait(
      p.name,
      id,
      Math.min(config["timeout-ms"] / 2, 30_000, Math.max(0, leftUntil(endBy))),
    );

    if (leftUntil(endBy) <= 0) return false;

    const evidence = await lookupSandbox(
      p.provider,
      id,
      Math.min(config["timeout-ms"], leftUntil(endBy)),
    );

    if (!isAbsent(evidence)) {
      for (const item of report.cleanupReview ?? [])
        if (item.provider === p.name && item.id === id && item.kind === "sandbox")
          item.status = "unresolved";

      return false;
    }

    recordAbsentResolution(
      report.cleanupReview ?? [],
      report.cleanupResolved ?? [],
      p.name,
      id,
      evidence,
    );

    if (!gone.has(`${p.name}/${id}`)) gone.set(`${p.name}/${id}`, performance.now());
    restores.mark(p.name, id, "destroyed");
    owned.delete(`${p.name}/${id}`);
    await persist();

    return true;
  }

  async function reconcileReviews(p: ReadyProvider) {
    // Copy first: resolveAbsent removes reviews while iterating.
    for (const entry of Array.from(report.cleanupReview ?? []))
      if (entry.provider === p.name && entry.kind === "sandbox") await resolveAbsent(p, entry.id);
  }

  /**
   * Polls the exact lookup until it reads absent, within the run's timeout and what is left of
   * `endBy` (a stress sandbox's reserve); false if it never does.
   */
  async function confirmGone(loaded: ReadyProvider, id: string, endBy?: number) {
    const end = performance.now() + Math.min(config["timeout-ms"], leftUntil(endBy));

    for (let backoffMs = 100; ; backoffMs = Math.min(backoffMs * 2, 2000)) {
      const left = end - performance.now();

      if (left <= 0) return false;

      if (isAbsent(await lookupSandbox(loaded.provider, id, left))) return true;
      const wait = end - performance.now();

      if (wait <= 0) return false;
      await new Promise((resolve) => setTimeout(resolve, Math.min(backoffMs, wait)));
    }
  }

  /**
   * The iteration's cleanup reserve ran out before a deletion was confirmed: leave the sandbox
   * journaled for `bun bench reap`, stop admitting more on this provider, and say so.
   */
  function reserveExhausted(loaded: ReadyProvider, id: string) {
    leftForReap.add(`${loaded.name}/${id}`);
    review(
      loaded.name,
      id,
      "Cleanup reserve exhausted before deletion was confirmed; retried by the run's final sweep, else journaled for `bun bench reap`",
    );

    for (const item of report.cleanupReview ?? [])
      if (item.provider === loaded.name && item.id === id && item.kind === "sandbox")
        item.status = "unresolved";
    const state = states.get(loaded.name);

    if (state) state.stop ??= "Cleanup reserve exhausted; no more sandboxes admitted";

    return new Error(`Cleanup reserve exhausted for ${id}; run bun bench reap`);
  }

  /**
   * Verify ownership and delete, retrying a failed delete up to three times. With `endBy` (a
   * stress sandbox's reserve, as `performance.now()`), an attempt starts only while a whole one
   * (`deleteAttemptMs`) still fits and every wait is cut to the time left, so retries never hold
   * the sandbox past what admission charged; a sandbox still there is left for `reap`.
   */
  async function remove(
    loaded: ReadyProvider,
    id: string,
    measurement?: { clock: PhaseClock; phases: Record<string, number> },
    endBy?: number,
  ) {
    if (restores.blocksSource(loaded.name, id))
      throw new Error("Restore cleanup unresolved; source retained");

    const stepMs = () => Math.min(config["timeout-ms"], leftUntil(endBy));

    for (let attempt = 0; attempt < 3; attempt++) {
      if (leftUntil(endBy) < deleteAttemptMs(config["timeout-ms"]))
        throw reserveExhausted(loaded, id);
      const verifyStart = performance.now();
      let verified: boolean;

      try {
        verified =
          pendingOwned.has(`${loaded.name}/${id}`) ||
          (await verifyRunOwnership(
            loaded.provider,
            id,
            config.run,
            stepMs(),
            config["ownership-visibility-ms"] &&
              Math.min(config["ownership-visibility-ms"], stepMs()),
            { tier: microsandboxTier(loaded.name) },
          ));
      } finally {
        if (measurement)
          measurement.phases.ownershipVerifyMs =
            (measurement.phases.ownershipVerifyMs ?? 0) + performance.now() - verifyStart;
      }

      if (!verified) {
        if (await resolveAbsent(loaded, id, endBy)) return;

        // Cut short by the reserve, verification proves nothing either way.
        if (leftUntil(endBy) <= 0) throw reserveExhausted(loaded, id);
        restores.mark(loaded.name, id, "quarantined");
        review(
          loaded.name,
          id,
          "Live run label and SDK ownership marker could not be verified; no deletion attempted",
        );

        for (const item of report.cleanupReview ?? [])
          if (item.provider === loaded.name && item.id === id && item.kind === "sandbox")
            item.status = "unresolved";
        throw new UnverifiedOwnershipError(id);
      }

      restores.mark(loaded.name, id, "alive");

      const quarantined = report.cleanupReview?.some(
        (v) => v.provider === loaded.name && v.id === id && v.kind === "sandbox",
      );

      if (quarantined) {
        recordVerifiedRelease(
          report.cleanupReview ?? [],
          report.cleanupReleased ?? [],
          loaded.name,
          id,
        );
        owned.set(`${loaded.name}/${id}`, {
          provider: loaded.name,
          id,
          kind: "sandbox",
          parent: null,
        });
        await persist();
      }

      try {
        if (microsandboxTier(loaded.name) !== undefined) {
          await journal;

          const allServices = [...owned.values()].filter(
            (r) => r.provider === loaded.name && r.kind === "service",
          );

          const unprovenServices = allServices.filter(
            (r, idx) =>
              r.parent === id &&
              r.sandboxName !== undefined &&
              (r.serviceState !== "created" || r.serviceCreatedAt === undefined) &&
              !isServiceSuperseded(allServices, idx),
          );

          // Each probe gets only what is left of the reserve, like the delete it gates.
          for (const svc of unprovenServices) {
            const probed = await deadline(stepMs(), () =>
              probePendingService(
                connectionOf(loaded.provider, "microsandbox"),
                svc.id,
                svc.sandboxName!,
              ),
            );

            if (probed.kind === "not-found" && svc.serviceState !== "created")
              throw new Error(
                `Pending Service ${svc.id} is still unresolved (404); retaining sandbox ${id} so a late create cannot detach without proof`,
              );

            if (probed.kind === "attached") {
              if (probed.createdAt === undefined)
                throw new Error(
                  `Attached Service ${svc.id} lacks creation timestamp; retaining sandbox ${id} for retry`,
                );
              const svcKey = `${loaded.name}/service/${svc.id}`;
              const current = owned.get(svcKey);

              if (
                current !== undefined &&
                (current.serviceState !== "created" ||
                  current.serviceCreatedAt !== probed.createdAt)
              ) {
                await persistConfirmedSnapshot(svcKey, {
                  ...current,
                  serviceState: "created",
                  serviceCreatedAt: probed.createdAt,
                });
              }
            }
          }

          // A reserve spent on the probes sends no DELETE; the sandbox is left for the reap.
          if (leftUntil(endBy) <= 0) throw new DeadlineError("Cleanup reserve spent before DELETE");
        }

        if (measurement) {
          const { clock } = measurement;

          if (clock.start === null) clock.begin();
          else if (clock.end !== null) {
            clock.excludedMs += performance.now() - clock.end;
            clock.end = null;
          }
        }

        try {
          await deadline(stepMs(), () =>
            deletions.start(loaded.name, id, () => loaded.provider.destroy(id)),
          );
        } finally {
          measurement?.clock.finish();
        }

        // Microsandbox finishes a DELETE asynchronously: until an exact read confirms the sandbox is
        // gone, it stays journaled and keeps a restore's snapshot and source.
        if (
          microsandboxTier(loaded.name) !== undefined &&
          !(await confirmGone(loaded, id, endBy))
        ) {
          restores.mark(loaded.name, id, "quarantined");
          review(
            loaded.name,
            id,
            "Deletion accepted, but the sandbox still reads; kept until an exact read confirms it is gone",
          );

          for (const item of report.cleanupReview ?? [])
            if (item.provider === loaded.name && item.id === id && item.kind === "sandbox")
              item.status = "unresolved";
          throw new DeletionUnconfirmedError(id);
        }

        // Acknowledged, not yet observed gone: the stop time is the first lookup that finds it so.
        watchGone(loaded, id);
        restores.mark(loaded.name, id, "destroyed");
        owned.delete(`${loaded.name}/${id}`);

        // A timed destroy row carries the confirmed stop in its phases; any other deletion
        // journals it, so billing can still settle the sandbox's App (Modal).
        if (!measurement)
          await recordStop({
            path: join(runDir, stopJournalFile),
            provider: loaded.name,
            sandboxId: id,
          }).catch(() => {});
        const persistStart = performance.now();

        try {
          await persist();
        } finally {
          if (measurement)
            measurement.phases.ownershipPersistMs =
              (measurement.phases.ownershipPersistMs ?? 0) + performance.now() - persistStart;
        }

        return;
      } catch (e) {
        if (e instanceof DeletionUnconfirmedError) throw e;

        if (e instanceof DeadlineError) {
          if (await resolveAbsent(loaded, id, endBy)) return;

          if (leftUntil(endBy) <= 0) throw reserveExhausted(loaded, id);
          review(loaded.name, id, "Deletion deadline expired; exact existence remains unresolved");

          for (const item of report.cleanupReview ?? [])
            if (item.provider === loaded.name && item.id === id && item.kind === "sandbox")
              item.status = "unresolved";
          throw e;
        }

        if (attempt === 2) throw e;
      }
    }
  }

  const costSuite = config.scenarios.length === 1 && config.scenarios[0] === "cost";

  const survivalPlan: SurvivalPlan = {
    windowMs: config["survival-window-ms"],
    intervalMs: config["survival-heartbeat-ms"],
  };

  function selected(scenario: string) {
    return config.scenarios.includes("all") || config.scenarios.includes(scenario);
  }

  async function iteration(p: ReadyProvider, index: number, cohort?: CohortMember) {
    const prefix = cohort ? `${cohort.run.kind}-${cohort.run.k}` : null;
    const foundState = states.get(p.name);

    if (!foundState) return;
    const state = foundState;
    const timeout = config["timeout-ms"];
    let fp: Fingerprint | null = null;
    let box: Sandbox | undefined;
    const pending = new PendingWork();
    const ids = new Set<string>();
    let unsafe = false;
    let blockedBy: string | null = null;
    const dependencies = new Map<string, string>();
    const reconnectedHandles: Sandbox[] = [];
    let reconnectedTo: Sandbox | undefined;
    let restoredDurationMs = 0;
    let restoredCost: number | null = 0;

    const lifeStart = performance.now(),
      startTime = new Date().toISOString();

    let reserve = 0;
    const hostStart = await host();
    const phases: Record<string, number> = {};
    const coldClock = new PhaseClock();
    let createClock = coldClock;
    let createPhases = phases;
    let restoredId: string | undefined;

    let createEvidence: CreateEvidence = { settled: false, stage: "adapter-create" };

    let adapterCreateRejected = false;
    let clockPhase: "adapter-create" | "first-command" | "sdk-init" = "adapter-create";

    const allocation = {
      track: config.track,
      requestedSize: config.size[p.name] ?? (p.name === "local" ? "medium" : null),
      template: config.template[p.name] ?? null,
      product: config.product[p.name] ?? null,
    };

    // Request-billed providers (Modal) are priced on the request, never on the guest's view.
    const priced = (fingerprint: Fingerprint | null) =>
      pricedResources(p.name, fingerprint, allocation.requestedSize)?.resources ?? null;

    const budgetMax = config["provider-max-sandboxes"][p.name] ?? config["max-sandboxes"];
    const dollarsMax = config["provider-max-dollars"][p.name] ?? config["max-dollars"];

    // The longest this iteration may hold a sandbox. Admission charges a reserve for it, and
    // cleanup ends by it (`cleanupEndBy`), so the charge never outgrows the reserve.
    const boundMs = costSuite
      ? timeout * 4
      : cohort
        ? cohortBoundMs(cohort.run.kind, timeout, survivalPlan)
        : iterationBoundMs(timeout, config.scenarios);

    // Stress sandboxes (cpu-burst and survival members, cpu-sustained iterations) reserve their
    // cleanup steps; the publication suites keep their published cleanup unchanged.
    const stress =
      cohort?.run.kind === "cpu-burst" ||
      cohort?.run.kind === "survival" ||
      (!cohort && config.scenarios.includes("cpu-sustained"));

    const cleanupEndBy = stress ? lifeStart + boundMs : undefined;

    /** Remove one of this iteration's sandboxes; a stress sandbox's cleanup ends by its reserve. */
    const removeOwn = (id: string) => remove(p, id, undefined, cleanupEndBy);

    const priceFor = (targetFp: Fingerprint | null) => {
      const basis = reservationResources(p.name, targetFp ?? state.fp, allocation.requestedSize);

      return (ms: number) => {
        const usd = estimateCost(p.name, ms, basis, p.region);

        return usd === null ? null : budgetUSD(p.name, usd);
      };
    };

    // Priced once the iteration ends; starts unbooked with a captured fallback basis so a
    // late-settling create never escapes final reconciliation.
    const sourceCharge: Charge = {
      since: lifeStart,
      chargedUntil: lifeStart,
      chargedUSD: 0,
      price: priceFor(null),
    };

    let currentRestoreCharge: Charge | undefined;

    const restoreCharges: {
      charge: Charge;
      end: number;
      durationMs: number;
      fingerprint: Fingerprint | null;
      cost: number | null;
    }[] = [];

    /** Record a sandbox this iteration created, for cleanup and for pricing. */
    const own = (id: string, sandboxCharge: Charge = sourceCharge) => {
      ids.add(id);
      charges.set(`${p.name}/${id}`, sandboxCharge);
    };

    /** A cleanup wait: the step timeout, cut to what is left of a stress sandbox's reserve. */
    const cleanupMs = () =>
      cleanupEndBy === undefined
        ? timeout
        : Math.max(0, Math.min(timeout, cleanupEndBy - performance.now()));

    reserve = budgetUSD(
      p.name,
      estimateCost(
        p.name,
        boundMs,
        reservationResources(p.name, state.fp, allocation.requestedSize),
        p.region,
      ) ?? dollarsMax,
    );

    const stop =
      state.stop ??
      (stopping.signal.aborted ? "Interrupted; no more sandboxes scheduled" : null) ??
      (state.created >= budgetMax
        ? "Sandbox budget reached"
        : state.estimatedUSD + state.reserved + reserve > dollarsMax
          ? "Estimated dollar budget reached"
          : null);

    if (stop) {
      state.stop = stop;

      const skipped = prefix
        ? [`${prefix}/cold`]
        : [
            "cold",
            ...(config.scenarios.includes("all")
              ? scenarioNames
              : config.scenarios.filter((name) => !isCohortKind(name))),
            "destroy",
          ];

      for (const scenario of skipped)
        report.admissionStopped?.push({
          provider: p.name,
          scenario,
          iteration: index,
          track: config.track,
          reason: stop,
        });
      report.budgets[p.name] = { created: state.created, estimatedUSD: state.estimatedUSD, stop };
      await cohort?.gates.done();

      return;
    }

    state.created++;
    state.reserved += reserve;
    const createSize = allocation.requestedSize;

    // This iteration's own App, for the cold create and its restores. Bursts share the default App.
    const app =
      !cohort && config["app-per-attempt"].some((name) => name === p.name)
        ? attemptApp(config.run, index)
        : undefined;

    /** Journal the App, then look it up or create it, before the create that allocates in it. */
    const prepareApp = async (name: string) => {
      const known = apps.get(`${p.name}/${name}`);

      if (known?.appId) return known;
      const entry = known ?? journalApp(p.name, name);
      apps.set(`${p.name}/${name}`, entry);
      await persist();

      if (!preparesApps(p.provider)) throw new Error(`${p.name} cannot prepare an App`);
      const prepared = await p.provider.prepareApp(name);

      if (!prepared) throw new Error(`App ${name} could not be created`);
      entry.appId = prepared.appId;
      await persist();

      return entry;
    };

    const tracked = new Proxy(p.provider, {
      get(target, key) {
        if (key === "create")
          return (input: CreateInput) => {
            let restore: RestoreAttempt | undefined;
            // This create, journaled in its App before submission (per-attempt Apps).
            let allocation: { app: JournalApp; id: string } | undefined;
            const callStart = performance.now();

            const callCharge: Charge = input.from
              ? (currentRestoreCharge ?? {
                  since: callStart,
                  chargedUntil: callStart,
                  chargedUSD: 0,
                  price: priceFor(fp),
                })
              : sourceCharge;

            return pending.track(
              (async () => {
                if (input.from) {
                  if (state.created >= budgetMax) {
                    report.admissionStopped?.push({
                      provider: p.name,
                      scenario: "create-from-snapshot",
                      iteration: index,
                      track: config.track,
                      reason: "Sandbox budget prevents restore",
                    });
                    throw new Skip("Sandbox budget prevents restore");
                  }

                  state.created++;
                  const sourceId = owned.get(`${p.name}/snapshot/${input.from}`)?.parent ?? box?.id;

                  if (!sourceId) throw new Error("Restore source unavailable");
                  restore = restores.begin(p.name, input.from, sourceId);
                }

                createEvidence = { settled: false, stage: "adapter-create" };
                clockPhase = "adapter-create";
                // Before allocation and outside create timing: the App is journaled and resolved,
                // and so is this create, so a lost response still leaves a record in the App.
                const owner = app === undefined ? undefined : await prepareApp(app);
                const attempt = owner && beginAllocation(owner);

                if (owner && attempt) {
                  allocation = { app: owner, id: attempt.id };
                  await persist();
                }

                const tier = microsandboxTier(p.name);
                // Names this call to the attempt hook, and its tier to sweeps (Microsandbox).
                const attemptTag = tier === undefined ? undefined : crypto.randomUUID();

                const request =
                  attempt === undefined
                    ? input
                    : { ...input, labels: { ...input.labels, ...attempt.labels } };

                if (attemptTag !== undefined && tier !== undefined)
                  request.labels = {
                    ...request.labels,
                    [attemptLabel]: attemptTag,
                    [tierLabel]: tier,
                  };

                createClock.begin();
                adapterCreateRejected = false;
                let info: SandboxInfo;

                try {
                  info = await target.create(request);
                } catch (error) {
                  adapterCreateRejected = true;

                  // The adapter's own failure. Anything but outcome_unknown means nothing it made is
                  // left (never sent, refused, or deleted on a fresh deadline): the attempt goes.
                  const attemptName =
                    attemptTag === undefined ? undefined : attemptNames.get(attemptTag);

                  if (
                    attemptName !== undefined &&
                    !(error instanceof SandboxError && error.code === "outcome_unknown")
                  ) {
                    owned.delete(`${p.name}/allocation-attempt/${attemptName}`);
                    await persist().catch(() => {});
                  }

                  if (allocation) failedAllocation(allocation.app, allocation.id, p.name, error);
                  throw error;
                }

                if (allocation) allocated(allocation.app, allocation.id, info.id);

                const returned = performance.now();

                if (restore) restores.identify(restore, info.id, "quarantined");
                const ownershipCheckStart = performance.now();
                let verified: boolean;

                try {
                  verified = await verifyRunOwnership(
                    target,
                    info.id,
                    config.run,
                    timeout,
                    config["ownership-visibility-ms"],
                    { tier: microsandboxTier(p.name) },
                  );
                } finally {
                  const ownershipVerifyMs = performance.now() - ownershipCheckStart;
                  createPhases.ownershipVerifyMs = ownershipVerifyMs;
                  createClock.excludedMs += ownershipVerifyMs;
                }

                if (!verified) {
                  createEvidence.unverifiedSandboxId = info.id;
                  review(p.name, info.id, "Returned create ID lacks live run/SDK ownership proof");
                  throw new UnverifiedOwnershipError(info.id);
                }

                if (restore) restores.identify(restore, info.id, "alive");
                createEvidence.sandboxId = info.id;
                createEvidence.stage = "ownership-persist";
                own(info.id, callCharge);

                if (input.from) restoredId = info.id;
                owned.set(`${p.name}/${info.id}`, {
                  provider: p.name,
                  id: info.id,
                  kind: "sandbox",
                  parent: null,
                });

                // The confirmed sandbox replaces its journaled attempt in the same write.
                if (attemptTag !== undefined) {
                  const attemptName = attemptNames.get(attemptTag);

                  if (attemptName !== undefined)
                    owned.delete(`${p.name}/allocation-attempt/${attemptName}`);
                }

                createPhases.adapterCreateMs = returned - (createClock.start ?? returned);
                createPhases.apiReturnedMs = createPhases.adapterCreateMs;
                const journalStart = performance.now();

                try {
                  await persist();
                } finally {
                  const ownershipPersistMs = performance.now() - journalStart;
                  createPhases.ownershipPersistMs = ownershipPersistMs;
                  createClock.excludedMs += ownershipPersistMs;
                }

                if (input.signal?.aborted) {
                  await removeOwn(info.id);
                  ids.delete(info.id);
                  throw new Error("Late create cleaned up");
                }

                clockPhase = "first-command";
                createEvidence.stage = "first-command";
                const firstStart = performance.now();

                try {
                  const result = await target.exec(info.id, {
                    command: "true",
                    cwd: "/workspace",
                    env: {},
                    timeoutMs: timeout,
                    signal: input.signal ?? stopping.signal,
                    streaming: false,
                    onChunk() {},
                  });

                  if (result.exitCode !== 0 || result.timedOut || input.signal?.aborted)
                    throw new Error(
                      `First command failed (exit ${result.exitCode}, timedOut ${result.timedOut})`,
                    );
                  createClock.finish();
                  createPhases.coldMs = createClock.elapsed() ?? 0;
                  createPhases.firstCommandOKMs = performance.now() - lifeStart;
                } finally {
                  createPhases.firstCommandMs = performance.now() - firstStart;
                }

                clockPhase = "sdk-init";
                createEvidence.stage = "sdk-init";

                return info;
              })()
                .catch(async (cause: unknown) => {
                  // The create's journal entry: refused, or still unknown (a lost response).
                  if (allocation) await persist();
                  const failure = failureOutcome(cause, sanitize);
                  createEvidence.code = failure.code;
                  createEvidence.cause = failure.cause;
                  createEvidence.stage = failure.cause?.stage ?? createEvidence.stage;
                  const nativeId = failure.sandboxId;

                  if (restore && nativeId && restore.state.id === null)
                    restores.identify(restore, nativeId, "quarantined");

                  if (nativeId && !createEvidence.unverifiedSandboxId) {
                    const admitted =
                      adapterCreateRejected &&
                      cause instanceof SandboxError &&
                      cause.provider === p.name &&
                      failure.cause?.operation === "create" &&
                      failure.cause.admittedByThisCall === true;

                    const verified =
                      admitted &&
                      (await verifyRunOwnership(
                        target,
                        nativeId,
                        config.run,
                        timeout,
                        config["ownership-visibility-ms"],
                        { tier: microsandboxTier(p.name) },
                      ));

                    if (!verified) {
                      createEvidence.unverifiedSandboxId = nativeId;
                      review(
                        p.name,
                        nativeId,
                        admitted
                          ? "Admitted error ID lacks live run/SDK ownership proof"
                          : "Create error has no trusted explicit admission marker",
                      );
                      throw cause;
                    }

                    if (restore) restores.identify(restore, nativeId, "alive");
                    createEvidence.sandboxId = nativeId;
                    own(nativeId, callCharge);

                    if (allocation) allocated(allocation.app, allocation.id, nativeId);

                    if (input.from) restoredId = nativeId;
                    owned.set(`${p.name}/${nativeId}`, {
                      provider: p.name,
                      id: nativeId,
                      kind: "sandbox",
                      parent: null,
                    });
                    // Adapter rejection can still represent an admitted resource. Persist before any cleanup.
                    await persist();

                    try {
                      await removeOwn(nativeId);
                      ids.delete(nativeId);
                      createEvidence.cleanupOutcome = "succeeded";
                    } catch {
                      // Preserve the native error; the normal cleanup passes retry the journaled ID.
                      createEvidence.cleanupOutcome = "failed";
                    }
                  }

                  throw cause;
                })
                .finally(() => {
                  createEvidence.settled = true;
                }),
            );
          };

        if (key === "destroy")
          return (id: string) =>
            pending.track(
              removeOwn(id).then(() => {
                ids.delete(id);
              }),
            );

        return providerMember(target, key);
      },
    });

    const add = async <D>(
      scenario: string,
      unit: string,
      outcome: Outcome,
      start: number,
      startedAt: string,
      before: HostSample,
      details: D | null = null,
      phaseValues: Record<string, number> = {},
      clock?: PhaseClock,
      recordedDurationMs?: number,
      observedAfter?: HostSample,
    ) => {
      const durationMs = recordedDurationMs ?? clock?.elapsed() ?? performance.now() - start;
      const hostAfter = observedAfter ?? (await host());

      const sample: Sample = {
        ...allocation,
        provider: p.name,
        iteration: index,
        scenario: prefix ? `${prefix}/${scenario}` : scenario,
        unit,
        startedAt: clock?.startedAt ?? startedAt,
        finishedAt: clock?.finishedAt ?? new Date().toISOString(),
        durationMs,
        sandboxId:
          box?.id ??
          [...ids][0] ??
          (outcome.kind === "failure" ? (outcome.sandboxId ?? null) : null),
        outcome:
          outcome.kind === "failure"
            ? {
                ...outcome,
                stage: outcome.stage ?? scenario,
                elapsedMs: outcome.elapsedMs ?? durationMs,
              }
            : outcome,
        phases: { ...phaseValues },
        hostBefore: before,
        hostAfter,
        headroom: headroom(before, hostAfter),
        fingerprint: fp,
        estimatedCost: estimateCost(p.name, durationMs, priced(fp), p.region),
        details,
      };

      report.samples.push(sample);
      await journalFiles.appendFile(join(runDir, "samples.ndjson"), JSON.stringify(sample) + "\n");
      process.stderr.write(
        `${p.name}/${sample.scenario}: ${outcome.kind} ${Math.round(durationMs)}ms\n`,
      );

      return sample;
    };

    async function measureDestroy(scenario: string, id: string) {
      const clock = new PhaseClock();
      const phases: Record<string, number> = {};

      // Vercel reports a sandbox's usage only once its session stops and not after deletion, so
      // the cost suite stops it and saves the meter first. A failed or stalled read (bounded by the
      // scenario timeout) leaves its cost unknown and never holds up the deletion.
      if (costSuite && p.name === "vercel")
        await deadline(timeout, () => captureVercelMeter(id, join(runDir, "usage"))).catch(
          () => null,
        );

      return measure(
        scenario,
        async () => {
          try {
            await remove(p, id, { clock, phases }, cleanupEndBy);
          } finally {
            // Modal: the row times a confirmed stop; these split it into the request and the stop.
            const timing = destroyTimings.get(`${p.name}/${id}`);
            destroyTimings.delete(`${p.name}/${id}`);

            if (timing) {
              if (timing.requestMs !== null) phases.terminateRequestMs = timing.requestMs;

              if (timing.stoppedMs !== null) phases.confirmedStopMs = timing.stoppedMs;
            }
          }

          ids.delete(id);

          if (clock.start === null)
            throw new Skip("Sandbox already absent; no deletion request to time");
        },
        phases,
        clock,
        null,
        // A stress sandbox's retries run inside its remaining reserve, never on in the background.
        cleanupEndBy === undefined ? timeout : Math.max(1, cleanupEndBy - performance.now()),
      );
    }

    async function measure<T, F = null>(
      scenario: string,
      action: (signal: AbortSignal) => Promise<T>,
      phaseValues: Record<string, number> = {},
      clock?: PhaseClock,
      failureDetails: F | null = null,
      /** The step's deadline, and the drain after a failure; a stress destroy runs to its reserve. */
      limitMs = timeout,
    ) {
      const start = performance.now(),
        at = new Date().toISOString(),
        before = await host();

      const dependency = dependencies.get(scenario) ?? blockedBy;

      if (
        dependency &&
        ![
          "destroy",
          "restore-destroy",
          "snapshot-cleanup",
          "snapshot-total",
          "reconnect-cleanup",
        ].includes(scenario)
      ) {
        const sample = await add(
          scenario,
          "ms",
          { kind: "blocked", blocked_by: dependency, note: `Blocked by ${dependency}` },
          start,
          at,
          before,
          failureDetails,
        );

        return { kind: "unsuccessful" as const, sample };
      }

      try {
        const result = await deadline(limitMs, (signal) =>
          pending.track(action(AbortSignal.any([signal, stopping.signal]))),
        );

        const durationMs = clock?.elapsed() ?? performance.now() - start;

        const sample = await add(
          scenario,
          "ms",
          { kind: "sample", value: durationMs },
          start,
          at,
          before,
          result ?? null,
          phaseValues,
          clock,
          durationMs,
        );

        return { kind: "success" as const, result, sample };
      } catch (error) {
        const sample = await add(
          scenario,
          "ms",
          error instanceof Skip
            ? { kind: "skipped", note: error.message }
            : failureOutcome(error, sanitize),
          start,
          at,
          before,
          failureDetails,
          phaseValues,
          clock,
        );

        const timedOutCreate =
          error instanceof DeadlineError && ["cold", "create-from-snapshot"].includes(scenario);

        if (timedOutCreate && sample.outcome.kind === "failure")
          sample.outcome.clockPhase = clockPhase;

        if (!(error instanceof Skip)) {
          if (["cold", "reconnect", "pause-resume", "snapshot"].includes(scenario))
            blockedBy ??= scenario;

          // Probes sized from the fingerprint's CPU count cannot run without it.
          if (scenario === "fingerprint")
            for (const sized of ["perf", "cpu-sustained", "cpu"]) dependencies.set(sized, scenario);

          for (const target of downstream.get(scenario) ?? [])
            dependencies.set(target, dependencies.get(scenario) ?? scenario);
        }

        if (!(await pending.drain(Math.min(timeout, limitMs)))) {
          unsafe = true;
          unsafeProviders.add(p.name);
          state.stop = "Timed-out work did not drain; stopped for cleanup safety";
        }

        if (timedOutCreate && sample.outcome.kind === "failure") {
          sample.outcome.lateSettlement = createEvidence;
          sample.outcome.cause ??= createEvidence.cause;
          sample.sandboxId ??= createEvidence.sandboxId ?? null;
          sample.phases = { ...phaseValues };
        }

        if (
          ["cold", "create-from-snapshot"].includes(scenario) &&
          createEvidence.unverifiedSandboxId &&
          sample.outcome.kind === "failure"
        ) {
          sample.outcome.unverifiedSandboxId = createEvidence.unverifiedSandboxId;
          delete sample.outcome.sandboxId;
          sample.sandboxId = null;
        }

        return { kind: "unsuccessful" as const, sample };
      }
    }

    /** Whether a sample belongs to this iteration's namespace: main rows, or this cohort's members. */
    function sameNamespace(scenario: string) {
      const parsed = parseCohortScenario(scenario);

      if (!prefix) return parsed === null;

      return parsed !== null && !parsed.aggregate && `${parsed.kind}-${parsed.k}` === prefix;
    }

    /**
     * Stage a CPU probe run: a fresh seed, the worker count from the fingerprint, the script
     * written into the guest and the guest clock read. Bounded by the step timeout.
     */
    async function stageCpu(active: Sandbox, work: CpuWork): Promise<StagedCpuProbe> {
      if (p.name === "memory") throw new Skip("Memory is an offline fake");

      if (!fp) throw new Error("Fingerprint required to size the all-core run");
      const workers = Math.min(64, Math.ceil(resources(fp).cpu));

      return deadline(timeout, (signal) =>
        pending.track(
          stageCpuProbe(active, { work, seed: newCpuSeed(), workers }, timeout, signal),
        ),
      );
    }

    /**
     * Run a staged CPU probe (probes/cpu.py) and publish its probe row plus two throughput
     * rows, `<scenario>-single` and `<scenario>-all`, like perf's derived metrics. A staging
     * failure fails the probe row. `onReturn` sees the run as soon as its exec returns.
     */
    async function cpuScenario(
      active: Sandbox,
      scenario: string,
      staging: Promise<StagedCpuProbe>,
      onReturn: (ran: CpuRun) => void = () => {},
    ) {
      const probe = await measure(scenario, async (signal) => {
        // measure's deadline started just now: the diagnostic clock read must end before it.
        const endBy = performance.now() + timeout;

        const ran = await runStagedCpuProbe(active, await staging, timeout, {
          signal,
          endBy,
          track: (work) => pending.track(work),
        });

        onReturn(ran);

        return { ...ran.result, seed: ran.result.probe.seed, ran };
      });

      const source = probe.sample;

      for (const phase of ["single", "all"] as const) {
        const outcome: Outcome =
          probe.kind === "success"
            ? {
                kind: "sample",
                value:
                  phase === "single"
                    ? probe.result.singleOpsPerSecond
                    : probe.result.allOpsPerSecond,
              }
            : source.outcome;

        const details =
          probe.kind === "success"
            ? {
                work: { segments: probe.result.probe.segments, steps: probe.result.probe.steps },
                seed: probe.result.seed,
                workers: phase === "single" ? 1 : probe.result.workers,
                consistency: probe.result[phase],
                guestVcpus: probe.result.guestVcpus,
                ...cpuPhaseEvidence(probe.result.ran, phase),
                cpus: probe.result.probe.cpus,
                python: probe.result.probe.python,
              }
            : null;

        const clock = new PhaseClock();
        clock.start = 0;
        clock.end = source.durationMs;
        clock.startedAt = source.startedAt;
        clock.finishedAt = source.finishedAt;
        await add(
          `${scenario}-${phase}`,
          "ops/s",
          outcome,
          0,
          source.startedAt,
          source.hostBefore,
          details,
          {},
          clock,
          source.durationMs,
          source.hostAfter,
        );
      }

      return probe;
    }

    /**
     * A cohort member's work once every member is created: nothing for a readiness burst, the
     * short CPU workload for cpu-burst, the heartbeat window for survival.
     */
    async function cohortWork({ run, gates }: CohortMember, active: Sandbox) {
      // A cpu-burst member stages its probe before the common start, so a slow upload or clock
      // read cannot delay its CPU phases relative to the others.
      const staging = run.kind === "cpu-burst" ? stageCpu(active, cpuWork.burst) : null;

      await staging?.catch(() => {});
      await gates.ready();

      if (stopping.signal.aborted) return;

      switch (run.kind) {
        case "burst":
          return;
        case "cpu-burst": {
          // Staged before the barrier, below; only the exec dispatch follows the common start.
          await cpuScenario(
            active,
            "cpu",
            staging ?? Promise.reject(new Error("CPU probe not staged")),
            (ran) =>
              run.cpu.push({
                returnedAt: ran.returnedAt,
                exec: ran.exec,
                singleSeconds: ran.result.singleSeconds,
                allSeconds: ran.result.allSeconds,
              }),
          );

          return;
        }

        case "survival": {
          const before = await host(),
            at = new Date().toISOString(),
            start = performance.now();

          const result = await heartbeatWindow({
            plan: survivalPlan,
            heartbeat: async (signal) =>
              parseBootId(await command(active, heartbeatCommand, timeout, signal)),
            lookup: (ms) => lookupSandbox(p.provider, active.id, ms),
            heartbeatTimeoutMs: timeout,
            // One deadline for the whole cohort, leaving its cleanup steps reserved.
            endBy: survivalEndBy(run.startedAt, timeout, survivalPlan),
            stop: stopping.signal,
            sanitize,
            track: (work) => pending.track(work),
          });

          run.verdicts.push(result.verdict.kind);

          const outcome: Outcome =
            result.verdict.kind === "survived"
              ? { kind: "sample", value: result.elapsedMs }
              : result.verdict.kind === "interrupted"
                ? { kind: "skipped", note: "Run interrupted before the window ended" }
                : (survivalFailure(result, `${prefix}/window`) ?? {
                    kind: "failure",
                    note: "Heartbeat window failed",
                  });

          await add(
            "window",
            "ms",
            outcome,
            start,
            at,
            before,
            { ...heartbeatDetails(result), plan: survivalPlan },
            {},
            undefined,
            result.elapsedMs,
          );

          return;
        }

        default: {
          const exhaustive: never = run.kind;

          return exhaustive;
        }
      }
    }

    try {
      await measure(
        "cold",
        async (signal) => {
          const options: CreateOptions = {
            labels: { "sandbox-bench-run": config.run },
            ports: [3000],
            signal,
          };

          if (createSize !== null) options.size = createSize;
          box = await createSandbox(tracked, options);
          phases.sdkReadyMs = performance.now() - (coldClock.start ?? lifeStart);
        },
        phases,
        coldClock,
      );

      if (!box) return;
      let active: Sandbox = box;

      if (costSuite) {
        const prep = await measure("tool-replay-prepare", () => uploadFixture(active));

        if (prep.kind !== "success") dependencies.set("tool-replay", "tool-replay-prepare");
        await measure("tool-replay", () => replay(active, timeout));

        return;
      }

      // A single guest exec for the fingerprint, including the 1s steal interval.
      await measure("fingerprint", async (signal) => {
        if (p.name === "memory") throw new Skip("Memory is an offline fake");
        const script = await readFile(new URL("../probes/fingerprint.py", import.meta.url), "utf8");

        const output = await command(
          active,
          `python3 - <<'BENCH_FINGERPRINT'\n${script}\nBENCH_FINGERPRINT`,
          timeout,
          signal,
        );

        fp = parseFingerprint(output);
        state.fp = fp;

        for (const sample of report.samples)
          if (
            sample.provider === p.name &&
            sample.iteration === index &&
            !sample.fingerprint &&
            sameNamespace(sample.scenario)
          ) {
            sample.fingerprint = fp;
            sample.estimatedCost = estimateCost(p.name, sample.durationMs, priced(fp), p.region);
          }

        return fp;
      });

      if (cohort) {
        await cohortWork(cohort, active);

        return;
      }

      const groups = shuffle(
        [
          "command",
          "files-1kb",
          "files-10mb",
          "reconnect",
          "pause-resume",
          "snapshot",
          "perf",
          "git-clone",
          "app",
          "tool-replay",
          "pip-install",
          // Appended only when selected, so runs without it keep their seeded order.
          ...(selectsScenario(config.scenarios, "cpu-sustained") ? ["cpu-sustained"] : []),
        ],
        config.seed + index,
      );

      let fixture = false;

      for (const group of groups) {
        if (stopping.signal.aborted) break;

        if (unsafe) blockedBy ??= "pending-work";

        if (index >= config.runs && !workloadNames.has(group) && group !== "app") continue;

        if (workloadNames.has(group) && index >= (config["workload-runs"] ?? config.runs)) continue;

        const targets =
          group === "app"
            ? ["npm-install", "dev-server", "preview-first-byte", "edit-loop"]
            : [group];

        if (!targets.some(selected)) continue;

        if (group === "app") {
          if (index >= (config["workload-runs"] ?? config.runs)) continue;

          const prep = await measure("npm-install-prepare", async () => {
            await uploadFixture(active);
            fixture = true;
          });

          if (prep.kind !== "success")
            for (const target of [
              "npm-install",
              "dev-server",
              "preview-provisioning",
              "preview-first-byte",
              "edit-loop",
            ])
              dependencies.set(target, "npm-install-prepare");
          await measure("npm-install", async (signal) => {
            return command(
              active,
              "cd /workspace/bench-app && npm ci --ignore-scripts --no-audit --no-fund",
              timeout,
              signal,
            );
          });

          if (!targets.slice(1).some(selected)) continue;
          // The preview's URL and headers can carry its credentials (Maritime's `?token=`, Styne's and
          // Boat's auth headers), so they stay in this variable: the measured result, which the runner
          // writes to samples.ndjson and the merged output, is nothing.
          let access: { url: string; headers?: Record<string, string> } | undefined;

          const preview = await measure("preview-provisioning", async () => {
            access = await active.preview(3000);

            return null;
          });

          await measure("dev-server", async () => {
            if (preview.kind !== "success" || !access)
              throw new Error("Preview provisioning did not return a URL");

            const h = await active.start("npm run dev", {
              env: { BENCH_PREVIEW_HOST: new URL(access.url).hostname },
              name: "bench-vite",
              cwd: "/workspace/bench-app",
              ready: { log: /Local:/ },
              readyTimeoutMs: timeout,
            });

            if (!h.ready) throw new Error("Vite not ready");
          });

          if (selected("preview-first-byte")) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              const clock = new PhaseClock();

              const result = await measure(
                "preview-first-byte",
                async (signal) => {
                  if (preview.kind !== "success" || !access) throw new Error("Preview unavailable");
                  await firstByteAttempt(access, signal, clock, (work) => {
                    void pending.track(work);
                  });

                  return { attempt };
                },
                {},
                clock,
                { attempt },
              );

              if (result.kind === "success") {
                if (dependencies.get("edit-loop") === "preview-first-byte")
                  dependencies.delete("edit-loop");
                break;
              }

              if (dependencies.has("preview-first-byte") || blockedBy || unsafe) break;

              if (attempt < 3) await new Promise((r) => setTimeout(r, 500));
            }
          }

          if (selected("edit-loop"))
            await measure("edit-loop", async (signal) => {
              await active.files.edit("/workspace/bench-app/index.html", {
                find: "bench-initial",
                replace: "bench-edited",
              });

              while (!signal.aborted) {
                if ((await previewText(active, signal)).includes("bench-edited")) return;
                await new Promise((r) => setTimeout(r, 50));
              }

              throw new Error("Edited content not observed");
            });
          continue;
        }

        if (group === "snapshot") {
          const snapshotTotalStart = performance.now(),
            snapshotTotalAt = new Date().toISOString(),
            snapshotTotalHost = await host();

          let snapshotId: string | undefined;
          let snapshotReady = false;
          // A Maritime save's idempotency key, journaled with its name before the request.
          let saveKey: string | undefined;
          let pendingKeylessWrite: Promise<void> | undefined;
          let clean: ((id: string) => Promise<void>) | undefined;
          let snapshotProof: SnapshotProvenance | undefined;

          const setupPhases: Record<string, number> = {},
            snapshotPhases: Record<string, number> = {};

          const proveSource = async (phases: Record<string, number>) => {
            const verifyStart = performance.now();

            try {
              return await proveSnapshotSource(
                p.provider,
                active.id,
                config.run,
                timeout,
                config["ownership-visibility-ms"],
                { tier: microsandboxTier(p.name) },
              );
            } finally {
              phases.ownershipVerifyMs = performance.now() - verifyStart;
            }
          };

          const setup = await measure(
            "snapshot-setup",
            async () => {
              if (!p.provider.capabilities.has("snapshot") || !p.provider.snapshot)
                throw new Skip("Provider has no snapshot");
              const undeletable = undeletableSnapshots.get(p.name);

              if (undeletable) throw new Skip(undeletable);
              snapshotProof = await proveSource(setupPhases);
              const nativeCleaner = await snapshotCleaner(p.name, p.provider, active.id);
              clean = (id) => {
                if (restores.blocksSnapshot(p.name, id))
                  throw new Error("Restore cleanup unresolved; snapshot and source retained");

                return deleteProvenSnapshot(
                  p.name,
                  p.provider,
                  id,
                  active.id,
                  snapshotProof,
                  config.run,
                  timeout,
                  nativeCleaner,
                );
              };

              if (
                ["daytona", "superserve", "maritime"].includes(p.name) ||
                microsandboxTier(p.name) !== undefined
              ) {
                owned.set(`${p.name}/snapshot-source/${active.id}`, {
                  provider: p.name,
                  id: active.id,
                  kind: "snapshot-source",
                  parent: null,
                  snapshotProof,
                });

                // Named and journaled before the request, so a lost answer still names it for cleanup.
                if (p.name === "daytona") {
                  snapshotId = `bench-${config.run.slice(0, 25)}-${crypto.randomUUID().slice(0, 8)}`;
                  owned.set(`${p.name}/snapshot/${snapshotId}`, {
                    provider: p.name,
                    id: snapshotId,
                    kind: "snapshot",
                    parent: active.id,
                    snapshotProof,
                  });
                }

                // Maritime: the name, the source and the save's idempotency key, so a save whose answer is
                // lost is settled by replaying it, never forgotten on a first 404.
                if (p.name === "maritime") {
                  snapshotId = maritimeSnapshotName(config.run);
                  saveKey = crypto.randomUUID();
                  owned.set(`${p.name}/snapshot/${snapshotId}`, {
                    provider: p.name,
                    id: snapshotId,
                    kind: "snapshot",
                    parent: active.id,
                    snapshotProof,
                    idempotencyKey: saveKey,
                  });
                }

                await persist();
              }

              return true;
            },
            setupPhases,
          );

          if (setup.kind !== "success") {
            dependencies.set("snapshot", "snapshot-setup");
          }

          const snapshotClock = new PhaseClock();

          const snapshot = await measure(
            "snapshot",
            async (signal) => {
              if (!p.provider.snapshot) throw new Skip("Provider has no snapshot");
              snapshotProof = await proveSource(snapshotPhases);
              const sourceEntry = owned.get(`${p.name}/snapshot-source/${active.id}`);

              if (sourceEntry) sourceEntry.snapshotProof = snapshotProof;

              if (snapshotId) {
                const entry = owned.get(`${p.name}/snapshot/${snapshotId}`);

                if (entry) entry.snapshotProof = snapshotProof;
              }

              if (snapshotId || sourceEntry) await persist();
              snapshotClock.begin();
              let snap: { id: string };

              try {
                snap = !snapshotId
                  ? await p.provider.snapshot(active.id)
                  : p.name === "maritime" && saveKey
                    ? await createNamedMaritimeSnapshot(p.provider, active.id, snapshotId, saveKey)
                    : await createNamedDaytonaSnapshot(p.provider, active.id, snapshotId);
              } catch (error) {
                // Microsandbox: a capture refused before any operation started made nothing, so its
                // journaled name goes; any other failure keeps it for settlement.
                const captured = captureNames.get(active.id);

                if (
                  captured !== undefined &&
                  error instanceof SandboxError &&
                  isDefiniteRefusal(error.code)
                ) {
                  owned.delete(`${p.name}/snapshot/${captured}`);
                  captureNames.delete(active.id);
                  await persist().catch(() => {});
                }

                throw error;
              } finally {
                snapshotClock.finish();
              }

              snapshotId = snap.id;

              const snapKey = `${p.name}/snapshot/${snap.id}`;

              const confirmed: OwnedEntry = {
                provider: p.name,
                id: snap.id,
                kind: "snapshot",
                parent: active.id,
                snapshotProof,
              };

              // Microsandbox: the confirmed managed ID replaces the capture's journaled name.
              const captured = captureNames.get(active.id);

              if (captured !== undefined) {
                confirmed.snapshotName = captured;
                owned.delete(`${p.name}/snapshot/${captured}`);
                captureNames.delete(active.id);
              }

              if (owned.get(snapKey)?.idempotencyKey !== undefined) {
                // A journaled save key (Maritime): disk drops the key before memory does, so a failed
                // write keeps the key for settling and never lets cleanup DELETE behind it.
                const write = persistConfirmedSnapshot(snapKey, confirmed);

                pendingKeylessWrite = write;
                await write;
              } else {
                // No save key, and the ID learned only now (E2B and most others): in memory first, so
                // cleanup and the final sweep find the snapshot even when the journal write fails.
                owned.set(snapKey, confirmed);
                await persist();
              }

              snapshotReady = true;
              saveKey = undefined;

              if (signal.aborted) {
                await clean?.(snap.id);
                owned.delete(`${p.name}/snapshot/${snap.id}`);
                await persist();
                throw new Error("Late snapshot cleaned after timeout");
              }

              return { snapshotId: snap.id };
            },
            snapshotPhases,
            snapshotClock,
          );

          const snapshotTotalMs = performance.now() - snapshotTotalStart;
          await add(
            "snapshot-total",
            "ms",
            snapshot.kind === "success"
              ? { kind: "sample", value: snapshotTotalMs }
              : setup.kind !== "success"
                ? setup.sample.outcome
                : snapshot.sample.outcome,
            snapshotTotalStart,
            snapshotTotalAt,
            snapshotTotalHost,
            null,
            {},
            undefined,
            snapshotTotalMs,
          );

          if (snapshotId && clean) {
            const id = snapshotId;
            let restored: Sandbox | undefined;
            const restoreStart = performance.now();

            const restoreCharge: Charge = {
              since: restoreStart,
              chargedUntil: restoreStart,
              chargedUSD: 0,
              price: priceFor(fp),
            };

            currentRestoreCharge = restoreCharge;

            try {
              if (snapshotReady) {
                createClock = new PhaseClock();
                createPhases = {};
                await measure(
                  "create-from-snapshot",
                  async (signal) => {
                    const restoreOptions: CreateOptions = {
                      from: id,
                      labels: { "sandbox-bench-run": config.run },
                      ports: [3000],
                      signal,
                    };

                    // Only where the snapshot keeps files but not resources; elsewhere it stays unchanged.
                    if (createSize !== null && restoreNeedsSize.has(p.name))
                      restoreOptions.size = restoreSize(p.name, createSize);
                    restored = await createSandbox(tracked, restoreOptions);
                    createPhases.sdkReadyMs = performance.now() - (createClock.start ?? lifeStart);

                    return { ...createPhases };
                  },
                  createPhases,
                  createClock,
                );
              }
            } finally {
              if (restoredId) {
                const restoredBox = restored;
                const restoreId = restoredId;
                const sourceFingerprint: Fingerprint | null = fp;
                let restoredFingerprint: Fingerprint | null = null;

                const restoreDetails: RestoreDetails = { verification: null };

                try {
                  await measure(
                    "restore-fingerprint",
                    async (signal) => {
                      if (!restoredBox) throw new Error("Restore handle unavailable");

                      const script = await readFile(
                        new URL("../probes/fingerprint.py", import.meta.url),
                        "utf8",
                      );

                      fp = restoredFingerprint = parseFingerprint(
                        await command(
                          restoredBox,
                          `python3 - <<'BENCH_FINGERPRINT'\n${script}\nBENCH_FINGERPRINT`,
                          timeout,
                          signal,
                        ),
                      );
                      restoreDetails.verification = verifyRestoredResources(sourceFingerprint, fp, {
                        compareDisk: p.name !== "boat",
                        // An unsized Modal sandbox reports its host's memory, which differs host to host.
                        compareMemory: !(p.name === "modal" && allocation.requestedSize === null),
                      });

                      if (restoreDetails.verification.matches === false)
                        throw new Error(
                          `Restored allocation differs from source: ${restoreDetails.verification.mismatches.join(", ")}`,
                        );

                      return restoreDetails;
                    },
                    {},
                    undefined,
                    restoreDetails,
                  );
                } finally {
                  fp = sourceFingerprint;
                }

                await measureDestroy("restore-destroy", restoreId);
                const restoreEnd = performance.now();
                const restoredMs = restoreEnd - restoreStart;
                restoredDurationMs += restoredMs;

                const cost = estimateCost(
                  p.name,
                  restoredMs,
                  priced(restoredFingerprint),
                  p.region,
                );

                restoredCost = restoredCost === null || cost === null ? null : restoredCost + cost;
                restoreCharges.push({
                  charge: restoreCharge,
                  end: restoreEnd,
                  durationMs: restoredMs,
                  fingerprint: restoredFingerprint,
                  cost,
                });

                for (const sample of report.samples) {
                  if (
                    sample.provider === p.name &&
                    sample.iteration === index &&
                    ["create-from-snapshot", "restore-fingerprint", "restore-destroy"].includes(
                      sample.scenario,
                    )
                  ) {
                    if (
                      sample.scenario === "create-from-snapshot" &&
                      restoreDetails.verification?.matches === false
                    ) {
                      sample.outcome = {
                        kind: "failure",
                        note: `Restored allocation differs from source: ${restoreDetails.verification.mismatches.join(", ")}`,
                        stage: "restore-fingerprint",
                        elapsedMs: sample.durationMs,
                      };
                    } else if (
                      sample.scenario === "create-from-snapshot" &&
                      sample.outcome.kind === "sample" &&
                      restoreDetails.verification?.matches !== true
                    ) {
                      // Only a restore proven to match its source ranks. An unverifiable one is kept, unranked, and not
                      // charged to the provider: a failed restore-fingerprint row already records any provider fault.
                      const why = restoreDetails.verification
                        ? "source fingerprint unavailable"
                        : "restored fingerprint failed";

                      sample.outcome = {
                        kind: "blocked",
                        blocked_by: "restore-fingerprint",
                        note: `Restore not verified: ${why}`,
                      };
                    }

                    sample.sandboxId = restoreId;
                    sample.fingerprint = restoredFingerprint;
                    sample.estimatedCost = estimateCost(
                      p.name,
                      sample.durationMs,
                      priced(restoredFingerprint),
                      p.region,
                    );
                  }
                }
              }

              await measure("snapshot-cleanup", async () => {
                // A restore that is still quarantined must be resolved/deleted before its snapshot.
                const pendingRestore = createEvidence.unverifiedSandboxId;

                if (pendingRestore) await removeOwn(pendingRestore);

                if (restoredId && owned.has(`${p.name}/${restoredId}`)) await removeOwn(restoredId);

                if (pendingKeylessWrite) {
                  await pendingKeylessWrite;
                  snapshotReady = true;
                  saveKey = undefined;
                }

                // A Maritime save that never confirmed may still land: settle it first. Only a refused
                // save, or a source gone with no snapshot, drops the journal entry without a delete; an
                // unsettled one throws and stays journaled for recovery.
                if (p.name === "maritime" && !snapshotReady && saveKey) {
                  const settled = await settleMaritimeSave({
                    provider: p.provider,
                    sandboxId: active.id,
                    name: id,
                    idempotencyKey: saveKey,
                    timeoutMs: timeout,
                  });

                  if (settled === "absent") {
                    owned.delete(`${p.name}/snapshot/${id}`);
                    await persist();

                    return;
                  }

                  // Confirmed on the server: persist the keyless entry BEFORE deleting so a
                  // dropped delete response cannot replay POST /save later.
                  const current = owned.get(`${p.name}/snapshot/${id}`);

                  if (current?.idempotencyKey !== undefined) {
                    const { idempotencyKey: _, ...withoutKey } = current;
                    await persistConfirmedSnapshot(`${p.name}/snapshot/${id}`, withoutKey);
                  }

                  snapshotReady = true;
                  saveKey = undefined;
                }

                await clean?.(id);
                report.cleanupReview = report.cleanupReview?.filter(
                  (r) => !(r.provider === p.name && r.id === id && r.kind === "snapshot"),
                );
                owned.delete(`${p.name}/snapshot/${id}`);
                await persist();
              });
              currentRestoreCharge = undefined;
            }
          }

          continue;
        }

        if (group === "cpu-sustained") {
          const staging = stageCpu(active, cpuWork.sustained);

          await staging.catch(() => {});
          await cpuScenario(active, "cpu-sustained", staging);

          continue;
        }

        if (group === "perf") {
          const probe = await measure("perf", async (signal) => {
            if (!fp) throw new Error("Fingerprint required to size all-core benchmark");

            const script = performanceScript(
              await readFile(new URL("../probes/perf.py", import.meta.url), "utf8"),
              config["omit-network-download"],
            );

            const cores = Math.min(64, Math.ceil(resources(fp).cpu));

            const output = await command(
              active,
              `BENCH_CORES=${cores} python3 - <<'BENCH_PERF'\n${script}\nBENCH_PERF`,
              timeout,
              signal,
            );

            if (signal.aborted) throw new Error("Performance probe aborted");

            return perfSchema.parse(JSON.parse(output));
          });

          // Publish exactly once, after the deadline race has settled. Persistence is not guest work.
          const source = probe.sample;

          for (const [metric, unit] of Object.entries(perfMetrics)) {
            if (metric === "network-mbps" && config["omit-network-download"]) continue;
            const value = probe.kind === "success" ? probe.result.metrics[metric] : undefined;

            // A documented capability gap (Instabox blocks 1.1.1.1:443, so tcp-ms never connects) is not
            // a provider failure. A value the probe did return is still recorded, and flagged: the
            // publication merge drops every row a not-run rule matches, so the rule is now stale.
            const notRun =
              probe.kind === "success"
                ? collectionPolicy().notRun.find(
                    (rule) =>
                      rule.provider === p.name &&
                      (rule.track ?? "default") === config.track &&
                      rule.suite === "main" &&
                      rule.scenario === metric,
                  )
                : undefined;

            if (notRun) {
              const info = report.providers.find((v) => v.name === p.name);

              const note =
                value === undefined
                  ? `${metric} documented not-run: ${notRun.reason}`
                  : `${metric} returned a value but is documented not-run; remove its collection-policy entry before merging`;

              if (info && !info.note.includes(note)) info.note += `; ${note}`;

              if (value === undefined) continue;
            }

            const outcome: Outcome =
              probe.kind !== "success"
                ? source.outcome
                : value === undefined
                  ? {
                      kind: "failure",
                      note: probe.result.notes.join("; ") || `Probe omitted ${metric}`,
                    }
                  : { kind: "sample", value };

            const clock = new PhaseClock();
            clock.start = 0;
            clock.end = source.durationMs;
            clock.startedAt = source.startedAt;
            clock.finishedAt = source.finishedAt;
            await add(
              metric,
              unit,
              outcome,
              0,
              source.startedAt,
              source.hostBefore,
              probe.kind === "success" ? probe.result : null,
              {},
              clock,
              source.durationMs,
              source.hostAfter,
            );
          }

          continue;
        }

        if (group === "tool-replay" && !fixture) {
          const prep = await measure("tool-replay-prepare", async () => {
            await uploadFixture(active);
            fixture = true;
          });

          if (prep.kind !== "success") dependencies.set("tool-replay", "tool-replay-prepare");
        }

        const standby = group === "pause-resume" ? autoStandby.get(p.name) : undefined;

        // Reconnect, and pause-resume by standby, time only part of the scenario.
        const partClock =
          group === "reconnect" || standby !== undefined ? new PhaseClock() : undefined;

        const lifecyclePhases: Record<string, number> = {};
        await measure(
          group,
          async (signal) => {
            switch (group) {
              case "command":
                return command(active, "true", timeout, signal);
              case "files-1kb":
              case "files-10mb": {
                const size = group === "files-1kb" ? 1024 : 10 * 1024 * 1024;
                const bytes = filePayloads.get(size);

                if (!bytes) throw new Error("Unprepared file payload");
                const path = `/workspace/bench-${size}.bin`;
                await active.files.write(path, bytes);

                if (!bytes.equals(await active.files.read(path, { as: "bytes" })))
                  throw new Error("File bytes differ");

                return { bytes: size };
              }

              case "reconnect": {
                const previous = active;
                const start = performance.now();
                partClock?.begin();
                const connected = await connectSandbox(tracked, active.id);
                const api = performance.now() - start;
                await command(connected, "true", timeout, signal);
                const firstCommandOKMs = performance.now() - start;
                partClock?.finish();
                reconnectedHandles.push(previous);
                reconnectedTo = connected;
                active = connected;
                box = connected;

                return { connectReturnedMs: api, firstCommandOKMs };
              }

              case "pause-resume": {
                // No pause call: send nothing until the sandbox goes on standby by itself (proved by
                // a gap in an in-sandbox ticker), then time the first command, which resumes it.
                if (standby) {
                  const ticker = tickerStarted(await command(active, startTicker, timeout, signal));
                  const tickerStartedAt = performance.now();
                  await idle(standby.idleMs, signal);
                  partClock?.begin();
                  const atRequest = await command(active, readUptime, timeout, signal);
                  partClock?.finish();
                  const resumeReadyMs = partClock?.elapsed() ?? Number.NaN;
                  const output = await command(active, stopTicker(ticker.pid), timeout, signal);

                  const evidence = standbyGap({
                    output,
                    ticker,
                    hostElapsedMs: performance.now() - tickerStartedAt,
                    atRequest,
                    requestMs: resumeReadyMs,
                    minGapMs: standby.minGapMs,
                  });

                  if ("refused" in evidence)
                    throw new Error(
                      `No standby proven after ${standby.idleMs} ms idle: ${evidence.refused}`,
                    );

                  // No pause or resume call exists, so pauseMs and resumeReturnedMs stay unset;
                  // the standby phases mark the sample as a pause by idling (attempts.ts).
                  lifecyclePhases.resumeReadyMs = resumeReadyMs;
                  lifecyclePhases.standbyIdleMs = standby.idleMs;
                  // The evidence itself, so a later rule can be checked against these samples.
                  lifecyclePhases.standbyGapMs = evidence.gapMs;
                  lifecyclePhases.standbyGapUptimeMs = evidence.gapUptimeMs;
                  lifecyclePhases.standbyAwakeBeforeRequestMs = evidence.awakeBeforeRequestMs;

                  return { ...lifecyclePhases };
                }

                if (
                  !p.provider.capabilities.has("pause") ||
                  !p.provider.pause ||
                  !p.provider.resume
                )
                  throw new Skip("Provider has no pause/resume");
                const start = performance.now();
                await p.provider.pause(active.id);
                const pauseMs = performance.now() - start;
                lifecyclePhases.pauseMs = pauseMs;
                const r = performance.now();
                await p.provider.resume(active.id);
                const resumeReturnedMs = performance.now() - r;
                lifecyclePhases.resumeReturnedMs = resumeReturnedMs;
                await command(active, "true", timeout, signal);
                lifecyclePhases.resumeReadyMs = performance.now() - r;

                return { ...lifecyclePhases };
              }

              case "git-clone":
                return command(active, cloneCommand, timeout, signal);
              case "tool-replay":
                return replay(active, timeout);
              case "pip-install": {
                const script = await readFile(
                  new URL("../probes/pip-install.py", import.meta.url),
                  "utf8",
                );

                return command(
                  active,
                  `python3 - <<'BENCH_PIP'\n${script}\nBENCH_PIP`,
                  timeout,
                  signal,
                );
              }

              default:
                throw new Skip(`Unknown scenario ${group}`);
            }
          },
          lifecyclePhases,
          partClock,
        );
      }
    } finally {
      await cohort?.gates.done();

      if (!(await pending.drain(cleanupMs()))) {
        unsafeProviders.add(p.name);
        state.stop = "Pending work could not drain; no further sandboxes scheduled";
      }

      if (createEvidence.unverifiedSandboxId) {
        try {
          await removeOwn(createEvidence.unverifiedSandboxId);
        } catch {
          /* Keep unresolved quarantine. */
        }
      }

      // Restores first, then their proven snapshots, then the source.
      for (const id of ids) {
        const isSource = [...owned.values()].some(
          (v) =>
            v.provider === p.name &&
            ((v.kind === "snapshot" && v.parent === id) ||
              (v.kind === "snapshot-source" && v.id === id)),
        );

        if (!isSource && !leftForReap.has(`${p.name}/${id}`)) await measureDestroy("destroy", id);
      }

      for (const source of [...owned.values()].filter(
        (v) => v.provider === p.name && v.kind === "snapshot-source" && ids.has(v.id),
      )) {
        const restoreUnresolved = restores.blocksSource(p.name, source.id);

        if (restoreUnresolved)
          review(
            p.name,
            source.id,
            "Restore cleanup unresolved; snapshot and source retained",
            "snapshot-source",
          );
        else
          try {
            const proof = snapshotProvenanceSchema
              .refine(
                (value) => value.sourceId === source.id && value.runLabel === config.run,
                "Snapshot-source provenance mismatch",
              )
              .parse(source.snapshotProof);

            const sourceCleaner = await snapshotCleaner(p.name, p.provider, source.id);
            const journaled = journaledSnapshots(owned.values(), p.name, source.id);
            await deadline(timeout, async (signal) => {
              for (;;) {
                if (signal.aborted) throw new Error("Snapshot source recovery deadline expired");

                const snapshots = await snapshotsFromSource(
                  p.name,
                  p.provider,
                  source.id,
                  journaled,
                );

                if (!snapshots.length) break;

                for (const snapshot of snapshots) {
                  const entry = {
                    provider: p.name,
                    id: snapshot.id,
                    kind: "snapshot" as const,
                    parent: source.id,
                    snapshotProof: proof,
                  };

                  owned.set(`${p.name}/snapshot/${snapshot.id}`, entry);
                  await persist();
                  await deleteProvenSnapshot(
                    p.name,
                    p.provider,
                    snapshot.id,
                    source.id,
                    proof,
                    config.run,
                    timeout,
                    sourceCleaner,
                  );
                  owned.delete(`${p.name}/snapshot/${snapshot.id}`);

                  if (snapshot.name) owned.delete(`${p.name}/snapshot/${snapshot.name}`);
                  await persist();
                }

                await new Promise((resolve) => setTimeout(resolve, 10));
              }
            });
            owned.delete(`${p.name}/snapshot-source/${source.id}`);
            await persist();
          } catch {
            review(
              p.name,
              source.id,
              "Recorded source snapshot recovery could not be verified/completed",
              "snapshot-source",
            );
          }
      }

      for (const id of ids) {
        if (
          !owned.has(`${p.name}/${id}`) ||
          leftForReap.has(`${p.name}/${id}`) ||
          restores.blocksSource(p.name, id) ||
          [...owned.values()].some(
            (v) =>
              v.provider === p.name &&
              ((v.kind === "snapshot" && v.parent === id) ||
                (v.kind === "snapshot-source" && v.id === id)),
          )
        )
          continue;
        await measureDestroy("destroy", id);
      }

      if (!(await pending.drain(cleanupMs()))) {
        unsafeProviders.add(p.name);
        state.stop = "Cleanup could not drain";
      }

      // Provider clients are cached by sandbox ID and detach when the last local handle closes,
      // so the final row closes the newest handle too and times that release.
      for (const [index, previous] of reconnectedHandles.entries())
        await measure("reconnect-cleanup", async () => {
          if (index === reconnectedHandles.length - 1) await reconnectedTo?.close();
          await previous.close();
        });
      const sourceEnd = performance.now();
      const duration = sourceEnd - lifeStart;

      const sourcePrice = priceFor(fp);
      sourceCharge.chargedUntil = sourceEnd;
      sourceCharge.price = sourcePrice;

      const restorePrices = restoreCharges.map((r) => priceFor(r.fingerprint ?? fp));

      for (const [i, r] of restoreCharges.entries()) {
        r.charge.chargedUntil = r.end;
        r.charge.price = restorePrices[i] ?? sourcePrice;
      }

      const sourceCost = estimateCost(p.name, duration, priced(fp), p.region);

      const cost = sourceCost === null || restoredCost === null ? null : sourceCost + restoredCost;
      state.reserved -= reserve;

      // A lower-bound estimate would under-charge the guard, so it charges the reservation's resources.
      const lowerBound = pricedResources(p.name, fp, allocation.requestedSize)?.bound === "lower";

      if (cost !== null && lowerBound) {
        const sourceBooked = sourcePrice(duration);

        const restoreBooked = restoreCharges.map((r, i) =>
          (restorePrices[i] ?? sourcePrice)(r.durationMs),
        );

        if (sourceBooked !== null && restoreBooked.every((usd) => usd !== null)) {
          sourceCharge.chargedUSD = sourceBooked;
          state.estimatedUSD += sourceBooked;

          for (const [i, r] of restoreCharges.entries()) {
            const booked = restoreBooked[i] ?? 0;
            r.charge.chargedUSD = booked;
            state.estimatedUSD += booked;
          }
        } else {
          sourceCharge.chargedUSD = reserve;
          state.estimatedUSD += reserve;

          for (const r of restoreCharges) r.charge.chargedUSD = 0;
        }
      } else if (cost !== null) {
        const sourceBooked = sourceCost === null ? 0 : budgetUSD(p.name, sourceCost);
        sourceCharge.chargedUSD = sourceBooked;
        state.estimatedUSD += sourceBooked;

        for (const r of restoreCharges) {
          const booked = r.cost === null ? 0 : budgetUSD(p.name, r.cost);
          r.charge.chargedUSD = booked;
          state.estimatedUSD += booked;
        }
      } else if (p.cloud) {
        // An unpriced iteration (usually a failed create) is charged for its measured
        // duration at conservative resources; it must not end the provider's run.
        const sourceSettled = settledBudgetUSD(
          p.name,
          duration,
          fp ? resources(fp) : null,
          state.fp ? resources(state.fp) : null,
        );

        const restoreSettled = restoreCharges.map((r) =>
          settledBudgetUSD(
            p.name,
            r.durationMs,
            r.fingerprint ? resources(r.fingerprint) : null,
            fp ? resources(fp) : state.fp ? resources(state.fp) : null,
          ),
        );

        if (sourceSettled !== null && restoreSettled.every((usd) => usd !== null)) {
          sourceCharge.chargedUSD = sourceSettled;
          state.estimatedUSD += sourceSettled;

          for (const [i, r] of restoreCharges.entries()) {
            const booked = restoreSettled[i] ?? 0;
            r.charge.chargedUSD = booked;
            state.estimatedUSD += booked;
          }
        } else {
          sourceCharge.chargedUSD = reserve;
          state.estimatedUSD += reserve;

          for (const r of restoreCharges) r.charge.chargedUSD = 0;
          state.stop ??= "Unknown cost/resources; reserved estimate charged to budget";
        }
      } else {
        sourceCharge.chargedUSD = 0;

        for (const r of restoreCharges) r.charge.chargedUSD = 0;
      }

      const lifetime = await add(
        "sandbox-lifetime",
        "ms",
        { kind: "sample", value: duration },
        lifeStart,
        startTime,
        hostStart,
        { estimatedCost: cost, restoredDurationMs },
        phases,
        undefined,
        duration,
      );

      lifetime.estimatedCost = cost;

      if (!box)
        lifetime.outcome = { kind: "skipped", note: "Creation failed; billed lifetime unknown" };
      report.budgets[p.name] = {
        created: state.created,
        estimatedUSD: state.estimatedUSD,
        stop: state.stop,
      };
      await reconcileReviews(p);
      await save();
    }
  }

  const jobs = roundRobin(
    ready.map((p) => p.name),
    // A stress run has no workloads: an iteration past `runs` would create a sandbox and probe
    // nothing, and a refused create there would count as a sustained failure.
    costSuite
      ? config["cost-runs"]
      : isStressSelection(config.scenarios)
        ? config.runs
        : Math.max(config.runs, config["workload-runs"] ?? config.runs),
  );

  await schedule(
    cohortOnly(config.scenarios) ? [] : jobs,
    { global: config.concurrency, perProvider: costSuite ? 1 : config["provider-concurrency"] },
    async (job) => {
      const p = ready.find((p) => p.name === job.provider);

      if (p) {
        // Cost tasks are capped at ten per Boat quota window.
        if (costSuite && p.name === "boat" && job.iteration > 0)
          await new Promise((resolve) => setTimeout(resolve, 6500));
        await iteration(p, job.iteration);
      }
    },
  );

  /** The aggregate row a finished cohort writes from its members' rows. */
  function cohortRow(
    run: CohortRun,
    rows: readonly Sample[],
    timing: { at: string; start: number; cohortIndex: number },
  ): CohortRow {
    const { kind, k } = run;
    const prefix = `${kind}-${k}`;
    const cold = rows.filter((s) => s.scenario === `${prefix}/cold`);
    const attempted = cold.length;
    const readyCount = outcomeValues(cold).length;
    const base = { k, cohort: timing.cohortIndex, attempted };

    switch (kind) {
      case "burst": {
        const readyAt =
          readyCount === k ? Math.max(...cold.map((s) => Date.parse(s.finishedAt))) : Date.now();

        const readyMs =
          readyCount === k
            ? Math.max(
                ...cold.map(
                  (s) =>
                    Date.parse(s.finishedAt) -
                    Date.parse(timing.at) -
                    (s.phases.ownershipPersistMs ?? 0) -
                    (s.phases.ownershipVerifyMs ?? 0),
                ),
              )
            : readyAt - Date.parse(timing.at);

        const durationMs = readyCount === k ? readyMs : performance.now() - timing.start;

        return {
          unit: "ms",
          finishedAt: readyAt,
          durationMs,
          outcome: burstOutcome({ k, success: readyCount, attempted, readyMs, durationMs }),
          details: { k, cohort: timing.cohortIndex, success: readyCount, attempted },
        };
      }

      case "cpu-burst": {
        const single = outcomeValues(rows.filter((s) => s.scenario === `${prefix}/cpu-single`));
        const all = outcomeValues(rows.filter((s) => s.scenario === `${prefix}/cpu-all`));
        const released = run.ready.releasedAt;

        // From the moment every member was released together to the slowest member's return,
        // each timestamped as its exec returned, before its rows were written.
        const allCompleteMs =
          single.length === k && released !== null && run.cpu.length === k
            ? Math.max(...run.cpu.map((m) => m.returnedAt)) - released
            : null;

        // Whether the members provably ran their CPU phases together, from the host clock alone.
        const overlap = run.cpu.length >= 2 ? cpuOverlap(run.cpu) : null;

        const durationMs = allCompleteMs ?? performance.now() - timing.start;
        const note = `${single.length}/${k} completed the CPU workload; ${readyCount}/${k} ready; ${attempted} attempted (budgets may prevent admission)`;

        // A probe skipped as inapplicable (the offline memory fake) makes the cohort no observation.
        const skippedProbe = rows.some(
          (s) => s.scenario === `${prefix}/cpu` && s.outcome.kind === "skipped",
        );

        const outcome: Outcome =
          allCompleteMs !== null
            ? { kind: "sample", value: allCompleteMs }
            : attempted < k || skippedProbe
              ? { kind: "skipped", note }
              : {
                  kind: "failure",
                  note,
                  stage: `${prefix}/${cohortAggregate[kind]}`,
                  elapsedMs: durationMs,
                };

        return {
          unit: "ms",
          finishedAt: Date.now(),
          durationMs,
          outcome,
          details: {
            ...base,
            work: cpuWork.burst,
            ready: readyCount,
            completed: single.length,
            allCompleteMs,
            overlap,
            single: throughputSpread(single),
            all: throughputSpread(all),
          },
        };
      }

      case "survival": {
        const count = (verdict: SurvivalVerdict["kind"]) =>
          run.verdicts.filter((v) => v === verdict).length;

        const tally = {
          survived: count("survived"),
          died: count("died"),
          unresponsive: count("unresponsive"),
          interrupted: count("interrupted"),
          createFailed: attempted - readyCount,
          // Created, but stopped before its window (the run was interrupted while waiting).
          noWindow: readyCount - run.verdicts.length,
        };

        const note = `${tally.survived}/${k} survived ${survivalPlan.windowMs} ms; ${attempted} attempted`;

        const outcome: Outcome =
          attempted < k
            ? { kind: "skipped", note: `${note} (budgets may prevent admission)` }
            : tally.interrupted || tally.noWindow
              ? { kind: "skipped", note: `${note}; run interrupted before every window ended` }
              : { kind: "sample", value: tally.survived };

        return {
          unit: "sandboxes",
          finishedAt: Date.now(),
          durationMs: performance.now() - timing.start,
          outcome,
          details: { ...base, ...tally, plan: survivalPlan },
        };
      }

      default: {
        const exhaustive: never = kind;

        return exhaustive;
      }
    }
  }

  /** One isolated cohort on one provider: admission, K members together, then the aggregate row. */
  async function runCohort(p: ReadyProvider, kind: CohortKind, k: number, cohortIndex: number) {
    const prefix = `${kind}-${k}`;
    const scenario = `${prefix}/${cohortAggregate[kind]}`;

    const excluded = collectionPolicy().notRun.find(
      (rule) =>
        rule.provider === p.name &&
        (rule.track ?? "default") === config.track &&
        rule.suite === kind &&
        (rule.scenario === scenario || rule.scenario === `${prefix}/*`),
    );

    if (excluded) {
      const info = report.providers.find((v) => v.name === p.name);

      if (info) info.note += `; ${scenario} documented not-run: ${excluded.reason}`;

      return;
    }

    const refusal =
      kind === "survival" ? sessionRefusal(p.name, survivalPlan, config["timeout-ms"]) : null;

    if (refusal) {
      report.admissionStopped?.push({
        provider: p.name,
        scenario,
        iteration: cohortIndex,
        track: config.track,
        reason: `Survival not run: ${refusal}`,
      });
      const info = report.providers.find((v) => v.name === p.name);

      if (info) info.note += `; ${scenario} not run: ${refusal}`;

      return;
    }

    const account = accountCap(p.name, config["account-limits"]);

    const existing = await deadline(config["timeout-ms"], () => p.provider.list({}))
      .then((v) => v.length)
      .catch(() => account);

    if (k > Math.min(account - existing, config.concurrency)) {
      const reason = `${kind === "burst" ? "Burst" : kind} ${k} admission stopped: account cap ${account}, ${existing} existing SDK sandboxes, global concurrency ${config.concurrency}`;
      report.admissionStopped?.push({
        provider: p.name,
        scenario,
        iteration: cohortIndex,
        track: config.track,
        reason,
      });
      const info = report.providers.find((v) => v.name === p.name);

      if (info)
        info.note += `; ${kind} ${k} skipped: account cap ${account}, ${existing} existing SDK sandboxes, global concurrency ${config.concurrency}`;

      return;
    }

    const start = performance.now();

    const at = new Date().toISOString(),
      before = await host();

    const offset = report.samples.length;

    const run: CohortRun = {
      kind,
      k,
      ready: new Barrier(k),
      done: new Barrier(k),
      startedAt: start,
      cpu: [],
      verdicts: [],
    };

    await Promise.all(
      Array.from({ length: k }, (_, i) =>
        iteration(p, cohortIndex * k + i, { run, gates: new CohortGates(run.ready, run.done) }),
      ),
    );

    const cohortHostAfter = await host();
    const row = cohortRow(run, report.samples.slice(offset), { at, start, cohortIndex });

    report.samples.push({
      track: config.track,
      requestedSize: config.size[p.name] ?? (p.name === "local" ? "medium" : null),
      template: config.template[p.name] ?? null,
      product: config.product[p.name] ?? null,
      provider: p.name,
      iteration: cohortIndex,
      scenario,
      unit: row.unit,
      startedAt: at,
      finishedAt: new Date(row.finishedAt).toISOString(),
      durationMs: row.durationMs,
      sandboxId: null,
      outcome: row.outcome,
      phases: {},
      hostBefore: before,
      hostAfter: cohortHostAfter,
      headroom: headroom(before, cohortHostAfter),
      fingerprint: null,
      estimatedCost: null,
      details: row.details,
    });
  }

  // Cohorts are isolated from normal iterations and from each other. K is bounded by account limits.
  const kinds = costSuite ? [] : selectedCohorts(config.scenarios, config.bursts);

  // Cohort indices count per kind and K, so a K listed twice (`--bursts 1,1`) gives distinct cohorts.
  const cohortIndices = new Map<string, number>();

  for (let round = 0; round < config["burst-cohorts"]; round++)
    for (const kind of kinds)
      for (const k of config.bursts) {
        const key = `${kind}-${k}`;
        const cohortIndex = cohortIndices.get(key) ?? 0;
        cohortIndices.set(key, cohortIndex + 1);

        for (const p of ready) await runCohort(p, kind, k, cohortIndex);
      }

  /**
   * Charge the budget for every sandbox's life past what its iteration charged: to the first
   * observation that it was gone, or, when it was never observed gone, to `cutoff`, listing it as
   * an open liability. `cutoff` is one timestamp for every provider, taken after every sweep. A
   * sandbox no iteration claimed (found only by its label, or in review) is priced from the run's
   * start. A total over the dollar cap is stated in the stop note.
   */
  function priceBeyondCharges(
    p: ReadyProvider,
    swept: ReadonlySet<string>,
    remaining: ReadonlySet<string>,
    cutoff: number,
  ) {
    const state = states.get(p.name);

    if (!state) return;
    const requestedSize = config.size[p.name] ?? (p.name === "local" ? "medium" : null);

    const unclaimed: Charge = {
      since: runStart,
      chargedUntil: runStart,
      chargedUSD: 0,
      price: (ms) => {
        const usd = estimateCost(
          p.name,
          ms,
          reservationResources(p.name, state.fp, requestedSize),
          p.region,
        );

        return usd === null ? null : budgetUSD(p.name, usd);
      },
    };

    const sandboxes = new Map([...charges].filter(([key]) => key.startsWith(`${p.name}/`)));

    // Listed or journaled at the sweep, or in review (its ownership or its deletion unresolved):
    // priced even when no iteration claimed it.
    const unresolved = new Set([
      ...remaining,
      ...(report.cleanupReview ?? []).flatMap((r) =>
        r.provider === p.name && r.kind === "sandbox" ? [r.id] : [],
      ),
    ]);

    for (const id of [...swept, ...unresolved]) {
      const key = `${p.name}/${id}`;
      sandboxes.set(key, sandboxes.get(key) ?? unclaimed);
    }

    const open: { id: string; liveMs: number }[] = [];
    let unpriced = false;

    for (const [key, charge] of sandboxes) {
      const id = key.slice(p.name.length + 1);
      const end = gone.get(key) ?? cutoff;

      // Never observed gone, whatever its delete returned: still a liability at the cutoff.
      if (!gone.has(key)) open.push({ id, liveMs: Math.round(cutoff - charge.since) });

      const usd = chargeBeyond(charge, end);

      if (usd === null) unpriced = true;
      else state.estimatedUSD += usd;
    }

    const capUSD = config["provider-max-dollars"][p.name] ?? config["max-dollars"];
    const notes = [state.stop];

    if (unpriced) notes.push("cost of cleanup past the reserve unknown");

    // Compared with a relative margin, so float noise never reads as an overrun.
    if (state.estimatedUSD > capUSD * (1 + 1e-9))
      notes.push(`estimated USD ${state.estimatedUSD} is over the ${capUSD} cap`);

    if (open.length)
      notes.push(
        `${open.length} sandbox(es) not observed gone at return; their cost grows until reaped`,
      );

    const budget: ProviderBudget = {
      created: state.created,
      estimatedUSD: state.estimatedUSD,
      stop: notes.filter((n) => n !== null).join("; ") || null,
      capUSD,
    };

    if (open.length) budget.openLiabilities = open;
    report.budgets[p.name] = budget;
  }

  /** What each provider's final sweep found, priced once every sweep is done. */
  const swept = new Map<string, { ids: Set<string>; remaining: Set<string> }>();

  for (const p of ready) {
    const errors: string[] = [];
    const deletionErrors = new Map<string, string>();
    // Microsandbox creates journaled before they were sent: each becomes a sandbox to delete, goes, or
    // stays unresolved, which keeps its restore's snapshot and source.
    let attemptsUnresolved = false;

    for (const entry of [...owned.values()].filter(
      (v) => v.provider === p.name && v.kind === "allocation-attempt",
    )) {
      try {
        if ((await settleAttempt(p, entry)) === "pending" && entry.parent !== null)
          attemptsUnresolved = true;
      } catch (e) {
        review(p.name, entry.id, errorNote(e), "allocation-attempt");
        errors.push(errorNote(e));

        if (entry.parent !== null) attemptsUnresolved = true;
      }
    }

    const ids = new Set(
      [...owned.values(), ...(report.cleanupReview ?? [])].flatMap((v) =>
        v.provider === p.name && v.kind === "sandbox" ? [v.id] : [],
      ),
    );

    const journaled = [...apps.values()].filter((app) => app.provider === p.name);
    // A Microsandbox tier sweeps only sandboxes carrying its own tier label (the adapter already lists
    // only its own compute.type), so a sandbox labelled for the other tier is never this run's to delete.
    const tier = microsandboxTier(p.name);

    const sweepLabels: Record<string, string> =
      tier === undefined
        ? { "sandbox-bench-run": config.run }
        : { "sandbox-bench-run": config.run, [tierLabel]: tier };

    try {
      const listed = await deadline(config["timeout-ms"], () => p.provider.list(sweepLabels));

      for (const item of listed)
        if (hasRunOwnership(item, config.run, tier)) {
          ids.add(item.id);
          // A sandbox whose create response was lost joins its App's journal entry.
          reconcileDiscovered(journaled, p.name, item);
        }
    } catch (e) {
      errors.push(errorNote(e));
    }

    // Restores whose setup never finished stay tagged pending and out of list() (Modal).
    try {
      for (const item of await deadline(config["timeout-ms"], () =>
        pendingForRun(p.provider, config.run),
      )) {
        pendingOwned.add(`${p.name}/${item.id}`);
        ids.add(item.id);
        reconcileDiscovered(journaled, p.name, item);
        owned.set(`${p.name}/${item.id}`, {
          provider: p.name,
          id: item.id,
          kind: "sandbox",
          parent: null,
        });
      }
    } catch (e) {
      errors.push(errorNote(e));
    }

    await persist();

    const sourceIds = new Set(
      [...owned.values()]
        .filter(
          (v) => v.provider === p.name && (v.kind === "snapshot" || v.kind === "snapshot-source"),
        )
        .flatMap((v) => (v.kind === "snapshot-source" ? [v.id] : v.parent ? [v.parent] : [])),
    );

    // Sandboxes whose reserve ran out are retried too: one left running costs more than a delete.
    for (const id of ids)
      if (!sourceIds.has(id)) {
        try {
          await remove(p, id);
        } catch (e) {
          deletionErrors.set(id, errorNote(e));
        }
      }

    const restoresUnresolved =
      attemptsUnresolved ||
      [...ids].some(
        (id) =>
          !sourceIds.has(id) &&
          (owned.has(`${p.name}/${id}`) ||
            report.cleanupReview?.some(
              (r) => r.provider === p.name && r.id === id && r.kind === "sandbox",
            )),
      );

    for (const item of [...owned.values()].filter(
      (v) => v.provider === p.name && v.kind === "snapshot",
    )) {
      try {
        if (restores.blocksSnapshot(p.name, item.id) || restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");

        const settled = await settleJournaledSnapshot(
          p.name,
          p.provider,
          item,
          config["timeout-ms"],
        );

        if (settled.kind === "exists") {
          let confirmed = item;

          if (item.idempotencyKey !== undefined) {
            const { idempotencyKey: _, ...withoutKey } = item;
            confirmed = withoutKey;
            await persistConfirmedSnapshot(`${p.name}/snapshot/${item.id}`, confirmed);
          }

          // A Microsandbox capture journaled by name: the managed ID settlement found joins the
          // journal before the delete, so a by-name 404 never drops a live snapshot.
          if (settled.id !== item.id) {
            confirmed = { ...confirmed, id: settled.id };
            await persistConfirmedSnapshot(`${p.name}/snapshot/${settled.id}`, confirmed);
          }

          await deleteProvenSnapshot(
            p.name,
            p.provider,
            confirmed.id,
            confirmed.parent,
            confirmed.snapshotProof,
            config.run,
            config["timeout-ms"],
            await snapshotCleaner(p.name, p.provider, confirmed.parent ?? ""),
          );
          owned.delete(`${p.name}/snapshot/${confirmed.id}`);
        }

        owned.delete(`${p.name}/snapshot/${item.id}`);
        report.cleanupReview = report.cleanupReview?.filter(
          (r) => !(r.provider === p.name && r.id === item.id && r.kind === "snapshot"),
        );
        await persist();
      } catch (e) {
        review(p.name, item.id, errorNote(e), "snapshot");
        errors.push(errorNote(e));
      }
    }

    for (const item of [...owned.values()].filter(
      (v) => v.provider === p.name && v.kind === "snapshot-source",
    )) {
      try {
        if (restores.blocksSource(p.name, item.id) || restoresUnresolved)
          throw new Error("Restore cleanup unresolved; snapshot and source retained");
        const proof = snapshotProvenanceSchema.parse(item.snapshotProof);

        if (proof.sourceId !== item.id || proof.runLabel !== config.run)
          throw new Error("Snapshot-source provenance mismatch");
        const sourceCleaner = await snapshotCleaner(p.name, p.provider, item.id);

        for (const snapshot of await deadline(config["timeout-ms"], () =>
          snapshotsFromSource(
            p.name,
            p.provider,
            item.id,
            journaledSnapshots(owned.values(), p.name, item.id),
          ),
        )) {
          await persistConfirmedSnapshot(`${p.name}/snapshot/${snapshot.id}`, {
            provider: p.name,
            id: snapshot.id,
            kind: "snapshot",
            parent: item.id,
            snapshotProof: proof,
          });

          await deleteProvenSnapshot(
            p.name,
            p.provider,
            snapshot.id,
            item.id,
            proof,
            config.run,
            config["timeout-ms"],
            sourceCleaner,
          );
          owned.delete(`${p.name}/snapshot/${snapshot.id}`);

          if (snapshot.name) owned.delete(`${p.name}/snapshot/${snapshot.name}`);
          report.cleanupReview = report.cleanupReview?.filter(
            (r) =>
              !(
                r.provider === p.name &&
                r.kind === "snapshot" &&
                (r.id === snapshot.id || r.id === snapshot.name)
              ),
          );
          await persist();
        }

        owned.delete(`${p.name}/snapshot-source/${item.id}`);
        report.cleanupReview = report.cleanupReview?.filter(
          (r) => !(r.provider === p.name && r.id === item.id && r.kind === "snapshot-source"),
        );
        await persist();
      } catch (e) {
        review(p.name, item.id, errorNote(e), "snapshot-source");
        errors.push(errorNote(e));
      }
    }

    // Drain any in-flight Service promotion/settlement writes from destroy() before sweeping.
    await journal;

    // Microsandbox Services journaled before they were made, whether or not their sandbox is gone.
    const services = [...owned.values()].filter(
      (v) => v.provider === p.name && v.kind === "service",
    );

    for (const [idx, entry] of services.entries()) {
      try {
        const outcome = await cleanService(connectionOf(p.provider, "microsandbox"), {
          id: entry.id,
          parent: entry.parent,
          sandboxName: entry.sandboxName,
          state: entry.serviceState ?? "pending",
          createdAt: entry.serviceCreatedAt,
          superseded: isServiceSuperseded(services, idx),
          onVerified: async (verifiedCreatedAt) => {
            const key = `${p.name}/service/${entry.id}`;
            const current = owned.get(key);

            if (current === undefined) return;
            const nextCreatedAt = verifiedCreatedAt ?? current.serviceCreatedAt;

            if (current.serviceState === "created" && current.serviceCreatedAt === nextCreatedAt)
              return;
            const updated = { ...current, serviceState: "created" as const };

            if (nextCreatedAt !== undefined) updated.serviceCreatedAt = nextCreatedAt;
            await persistConfirmedSnapshot(key, updated);
          },
        });

        if (outcome.kind === "pending") {
          review(p.name, entry.id, outcome.reason, "service");
          errors.push(outcome.reason);
          continue;
        }

        const key = `${p.name}/service/${entry.id}`;

        await persistJournalUpdate((nextOwned) => {
          const current = nextOwned.get(key);

          if (current === undefined) return;
          const entries = [...nextOwned.entries()];
          const entryIndex = entries.findIndex(([k]) => k === key);

          for (let i = 0; i < entryIndex; i++) {
            const other = entries[i]![1];

            if (
              other.provider === p.name &&
              other.kind === "service" &&
              other.parent === current.parent &&
              isRetrySlug(current.id, other.id) &&
              other.serviceSuperseded === undefined
            )
              other.serviceSuperseded = true;
          }

          nextOwned.delete(key);
        });
      } catch (e) {
        review(p.name, entry.id, errorNote(e), "service");
        errors.push(errorNote(e));
      }
    }

    for (const id of ids)
      if (sourceIds.has(id)) {
        if (
          restores.blocksSource(p.name, id) ||
          [...owned.values()].some(
            (v) =>
              v.provider === p.name &&
              ((v.kind === "snapshot" && v.parent === id) ||
                (v.kind === "snapshot-source" && v.id === id)),
          )
        )
          continue;

        try {
          await remove(p, id);
        } catch (e) {
          deletionErrors.set(id, errorNote(e));
        }
      }

    const remaining = new Set<string>();

    try {
      // Native deletion can return while the control plane still lists the VM.
      // Wait only on this run's exact label, then retain unresolved ownership.
      const end = Date.now() + Math.min(config["timeout-ms"], 30_000);

      for (;;) {
        const budget = end - Date.now();

        if (budget <= 0) break;

        const [after, pending] = await deadline(budget, () =>
          Promise.all([p.provider.list(sweepLabels), pendingForRun(p.provider, config.run)]),
        );

        remaining.clear();

        for (const item of after)
          if (hasRunOwnership(item, config.run, tier)) remaining.add(item.id);

        for (const item of pending) remaining.add(item.id);

        if (
          !remaining.size ||
          [...remaining].every(
            (id) =>
              sourceIds.has(id) ||
              report.cleanupReview?.some((v) => v.provider === p.name && v.id === id),
          ) ||
          Date.now() >= end
        )
          break;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Math.min(1000, end - Date.now()))),
        );
      }
    } catch (e) {
      errors.push(errorNote(e));
    }

    await reconcileReviews(p);

    for (const resolution of report.cleanupResolved ?? [])
      if (resolution.provider === p.name) remaining.delete(resolution.id);

    for (const [id, error] of deletionErrors) {
      if (!report.cleanupResolved?.some((r) => r.provider === p.name && r.id === id))
        errors.push(error);
    }

    for (const item of owned.values()) if (item.provider === p.name) remaining.add(item.id);

    if (remaining.size) errors.push("Ownership journal or listing still contains resources");

    if (unsafeProviders.has(p.name))
      errors.push("Pending work did not settle; late creations remain possible");
    report.cleanup.push({
      provider: p.name,
      remaining: [...remaining],
      error: errors.length ? errors.join("; ") : null,
    });
    swept.set(p.name, { ids, remaining });
  }

  for (const sample of report.samples) {
    if (sample.outcome.kind !== "failure" || !sample.outcome.lateSettlement) continue;
    const late = sample.outcome.lateSettlement;

    if (late.unverifiedSandboxId) {
      sample.outcome.unverifiedSandboxId = late.unverifiedSandboxId;
      delete sample.outcome.sandboxId;
      sample.sandboxId = null;
    } else sample.sandboxId ??= late.sandboxId ?? null;

    if (late.sandboxId && !owned.has(`${sample.provider}/${late.sandboxId}`))
      late.cleanupOutcome = "succeeded";
    sample.outcome.cause ??= late.cause;
  }

  for (const sample of report.samples) {
    if (sample.outcome.kind !== "failure") continue;
    const outcome = sample.outcome;
    const id = outcome.unverifiedSandboxId ?? outcome.lateSettlement?.unverifiedSandboxId;

    if (
      !id ||
      report.cleanupReview?.some(
        (r) => r.provider === sample.provider && r.id === id && r.kind === "sandbox",
      ) ||
      !report.cleanupReleased?.some((r) => r.provider === sample.provider && r.id === id)
    )
      continue;
    outcome.ownershipReleased = true;
    outcome.sandboxId = sample.sandboxId = id;
    delete outcome.unverifiedSandboxId;

    if (outcome.lateSettlement) {
      delete outcome.lateSettlement.unverifiedSandboxId;
      outcome.lateSettlement.sandboxId = id;
      outcome.lateSettlement.cleanupOutcome = owned.has(`${sample.provider}/${id}`)
        ? "failed"
        : "succeeded";
    }
  }

  for (const sample of report.samples) {
    if (sample.outcome.kind !== "failure") continue;
    const id = sample.outcome.unverifiedSandboxId ?? sample.sandboxId;

    if (id && report.cleanupResolved?.some((r) => r.provider === sample.provider && r.id === id))
      sample.outcome.cleanupResolved = "absent";
  }

  report.finishedAt = new Date().toISOString();
  report.summaries = summarize(
    report.samples,
    config.seed,
    Object.fromEntries(report.providers.map((p) => [p.name, p.configuredRegion])),
  );
  await persist();
  await journalFiles.writeFile(
    join(runDir, "samples.ndjson"),
    report.samples.map((s) => JSON.stringify(s) + "\n").join(""),
  );

  // Each still-unseen deleted sandbox gets one more exact lookup, then every budget is priced to
  // one cutoff: a sandbox one provider left live kept running while the others cleaned up.
  // The watches stop here (a lookup in flight finishes); the round is bounded like the sweep's
  // listing wait, and a sandbox it cannot see gone stays open.
  stopWatching.abort();
  await Promise.all(watches.values());
  const lookupsEnd = performance.now() + Math.min(config["timeout-ms"], 30_000);

  await Promise.all(
    ready.map(async (p) => {
      for (const key of charges.keys()) {
        const left = Math.min(config["timeout-ms"], lookupsEnd - performance.now());

        if (left <= 0) return;

        if (key.startsWith(`${p.name}/`) && !gone.has(key))
          await observeGone(p, key.slice(p.name.length + 1), left).catch(() => false);
      }
    }),
  );
  const cutoff = performance.now();

  for (const p of ready) {
    const sweep = swept.get(p.name);

    if (sweep) priceBeyondCharges(p, sweep.ids, sweep.remaining, cutoff);
  }

  await save();
  process.off("SIGINT", requestStop);
  process.off("SIGTERM", requestStop);

  return report;
}
