/**
 * The site data file for "Docker and services inside the sandbox" (services.json) and its table.
 * Per provider: what the guest probe found, whether a daemon really ran and how, and each path's
 * attempts with raw samples, failures and medians. Rankings are per path and say so: a compose
 * time and a no-Docker time are never in one list.
 */
import { isolation, nestedVirt, rootlessPrerequisites, type Probe } from "./probe.js";
import {
  images,
  serverVersions,
  expectedTests,
  composePlugin,
  dockerStatic,
  node,
} from "./pins.js";
import { servicePaths, type AttemptRecord, type ServicePath } from "./record.js";
import { nativeServiceDoc, type NativeServiceDoc } from "./docs.js";

export interface RunInfo {
  readonly id: string;
  readonly sdkCommit: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly location: string;
  /** Per-provider settings the run used, such as `{ modal: "runtime=vm" }`. */
  readonly settings: Readonly<Record<string, string>>;
  /** Effective timing settings and placement; null or absent in runs from before they were recorded. */
  readonly conditions?: {
    readonly attemptTimeoutMs: number;
    readonly daemonReadyMs: number;
    /** Per provider: each placement variable its adapter reads, and its value. */
    readonly placement?: Readonly<Record<string, Readonly<Record<string, string | null>>>>;
  } | null;
  readonly artifacts: { readonly node: string; readonly fixture: string; readonly native: string };
}

const seconds = (ms: number | null) => (ms === null ? null : Math.round(ms) / 1000);

/** Nearest-rank median of the values present; null when there are none. */
export function median(values: readonly (number | null)[]): number | null {
  const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);

  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? (sorted[mid] ?? null)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Distinct values with how often each appeared, most common first. */
function tally(values: readonly string[]) {
  const counts = new Map<string, number>();

  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  return [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

function sample(record: AttemptRecord) {
  const m = record.metrics;

  return {
    runId: record.runId,
    attempt: record.attempt,
    attemptId: record.attemptId,
    servicesUpS: seconds(m.servicesUpMs),
    readyToGreenS: seconds(m.readyToGreenMs),
    createS: seconds(m.createMs),
    uploadS: seconds(m.uploadMs),
    daemonReadyS: seconds(m.daemonReadyMs),
    imagePullS: seconds(m.imagePullMs),
    servicesStartS: seconds(m.servicesStartMs),
    servicesReadyS: seconds(m.servicesReadyMs),
    testsS: seconds(m.testsMs),
    method: record.daemon?.method ?? null,
    config: record.daemon?.config ?? null,
  };
}

type Sample = ReturnType<typeof sample>;

const medianOf = (
  samples: readonly Sample[],
  key: keyof Omit<Sample, "runId" | "attempt" | "attemptId" | "method" | "config">,
) => median(samples.map((s) => s[key]));

/**
 * What a path's row stands for: `measured` with at least one green attempt; `unsupported` when every
 * attempt is conclusive evidence that the path cannot run there (the reason says why); `failed`
 * when attempts ran and none went green otherwise; `not-run` with no attempt.
 */
export type PathStatus = "measured" | "unsupported" | "failed" | "not-run";

/**
 * Why one compose attempt shows the sandbox cannot run Docker; null when it shows no such thing.
 * Its ladder must have finished without a daemon, and every try that failed must be conclusive:
 * skips are probe facts, and a failed try counts only when it found no daemon on the socket or
 * its log or storage error refused a named prerequisite (attempt.ts prerequisiteRefusals). Any
 * other failure (a download, checksum, transport, timeout, full disk) makes it inconclusive.
 */
function noDocker(record: AttemptRecord): string | null {
  const daemon = record.daemon;

  if (
    record.outcome.kind !== "failed" ||
    record.outcome.stage !== "daemon" ||
    !daemon?.finished ||
    daemon.method !== null
  )
    return null;
  const failed = daemon.tries.filter((t) => !t.ok);

  if (failed.some((t) => !t.conclusive)) return null;

  return [
    "No Docker daemon started",
    daemon.skipped.length
      ? `ruled out: ${daemon.skipped.map((s) => `${s.method}: ${s.reason}`).join("; ")}`
      : null,
    failed.length
      ? `tried and refused: ${failed.map((t) => `${t.method}/${t.config}: ${t.error ?? "?"}`).join("; ")}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(". ");
}

/** Why an attempt is a result about the provider rather than a failure; null otherwise. */
function unsupportedReasonOf(record: AttemptRecord): string | null {
  if (record.outcome.kind === "unsupported")
    return `${record.outcome.reason}: ${record.outcome.detail}`;

  return record.path === "compose" ? noDocker(record) : null;
}

function pathSummary(records: readonly AttemptRecord[]) {
  const green = records.flatMap((r) => (r.outcome.kind === "green" ? [sample(r)] : []));

  // Each attempt that is evidence the path cannot run there, kept per attempt and apart from
  // failures, whatever the rest of the row did.
  const unsupported = records.flatMap((r) => {
    const reason = unsupportedReasonOf(r);

    return reason === null
      ? []
      : [{ runId: r.runId, attempt: r.attempt, attemptId: r.attemptId, reason }];
  });

  // One attempt is its run plus its ID: two runs (Boat's batches) reuse the same ordinals.
  const unsupportedIds = new Set(unsupported.map((u) => `${u.runId}/${u.attemptId}`));

  const reasons = unsupported.map((u) => u.reason);

  // Only when every attempt is conclusive: one inconclusive failure keeps the row `failed`.
  const unsupportedReason =
    reasons.length > 0 && reasons.length === records.length
      ? tally(reasons)
          .map((u) => u.value)
          .join("; ")
      : null;

  const status: PathStatus =
    records.length === 0
      ? "not-run"
      : green.length > 0
        ? "measured"
        : unsupportedReason !== null
          ? "unsupported"
          : "failed";

  const failures = records.flatMap((r) =>
    r.outcome.kind === "failed" && !unsupportedIds.has(`${r.runId}/${r.attemptId}`)
      ? [
          {
            runId: r.runId,
            attempt: r.attempt,
            attemptId: r.attemptId,
            stage: r.outcome.stage,
            reason: r.outcome.reason,
          },
        ]
      : [],
  );

  return {
    status,
    /** Why the path cannot run on this provider; set only when `status` is `unsupported`. */
    unsupportedReason: status === "unsupported" ? unsupportedReason : null,
    attempts: records.length,
    green: green.length,
    failures,
    unsupported,
    /**
     * Attempts whose sandbox or Compose project was not confirmed gone: separate from the outcome,
     * so a green attempt can be listed here.
     */
    cleanupUnconfirmed: records.flatMap((r) =>
      r.cleanup === "unconfirmed"
        ? [{ runId: r.runId, attempt: r.attempt, attemptId: r.attemptId }]
        : [],
    ),
    samples: green,
    medians: {
      servicesUpS: medianOf(green, "servicesUpS"),
      readyToGreenS: medianOf(green, "readyToGreenS"),
      createS: medianOf(green, "createS"),
      uploadS: medianOf(green, "uploadS"),
      daemonReadyS: medianOf(green, "daemonReadyS"),
      imagePullS: medianOf(green, "imagePullS"),
      servicesStartS: medianOf(green, "servicesStartS"),
      servicesReadyS: medianOf(green, "servicesReadyS"),
      testsS: medianOf(green, "testsS"),
    },
  };
}

export type PathSummary = ReturnType<typeof pathSummary>;

/** What the probes and the compose attempts say, for the capability table. */
function capability(provider: string, records: readonly AttemptRecord[]) {
  const probes = records.flatMap((r) => (r.probe ? [r.probe] : []));
  const facts = <K extends keyof Probe>(key: K) => tally(probes.map((p) => String(p[key] ?? "")));
  const first = (key: keyof Probe) => facts(key)[0]?.value ?? null;
  const compose = records.filter((r) => r.path === "compose");

  // A daemon that answered started, whatever its workload did and whether its ladder then
  // finished: a storage fallback that cleared `method`, even one cut short, keeps that start in
  // `answered`. A row from before `answered` existed counts only once its ladder finished.
  const worked = compose.flatMap((r) =>
    r.daemon?.finished && r.daemon.method
      ? [`${r.daemon.method}/${r.daemon.config ?? "?"}`]
      : r.daemon?.answered
        ? [r.daemon.answered]
        : [],
  );

  // Negative evidence only from a ladder that finished with no daemon ever answering: a sandbox
  // that vanished or timed out, or a row from before `finished` existed, says nothing.
  const neverAnswered = compose.filter(
    (r) => r.daemon?.finished === true && !r.daemon.method && !r.daemon.answered,
  ).length;

  const tried = compose.flatMap((r) => r.daemon?.tries ?? []);

  const failedTries = tried.flatMap((t) =>
    t.ok ? [] : [`${t.method}/${t.config}: ${t.error ?? "?"}`],
  );

  const skipped = compose
    .flatMap((r) => r.daemon?.skipped ?? [])
    .map((s) => `${s.method}: ${s.reason}`);

  const docker =
    compose.length === 0
      ? "not-tried"
      : worked.length > 0 && neverAnswered === 0
        ? "works"
        : worked.length > 0
          ? "flaky"
          : neverAnswered > 0
            ? "fails"
            : "not-reached";

  return {
    probes: probes.length,
    isolation: tally(probes.map(isolation)),
    user: first("user"),
    root: first("sudo"),
    os: first("os"),
    kernel: first("kernel"),
    arch: first("arch"),
    nestedVirt: tally(probes.map(nestedVirt)),
    cgroup: first("cgroupFs"),
    capSysAdmin: first("capSysAdmin"),
    overlayFs: first("overlayFs"),
    dockerCliPreinstalled: first("dockerCli"),
    daemonRunningAtStart: first("dockerInfo"),
    dockerdPreinstalled: first("dockerd"),
    composePreinstalled: first("composePlugin"),
    podman: first("podman"),
    rootlessPrerequisites: tally(probes.map((p) => rootlessPrerequisites(p) ?? "present")),
    dockerHub: first("dockerHub"),
    /** From real daemon starts in the compose attempts, not from the probe. */
    docker,
    dockerMethods: tally(worked),
    daemonFailures: tally(failedTries),
    skippedMethods: tally(skipped),
    composeSource: tally(compose.flatMap((r) => (r.daemon?.compose ? [r.daemon.compose] : []))),
    /** From the provider's docs, not a guest probe; null when not researched. */
    nativeServices: nativeServiceDoc(provider),
  };
}

/** A provider a run skipped, or stopped before its planned attempts ended, from the run's notes. */
export interface NotRun {
  readonly runId: string;
  readonly provider: string;
  readonly reason: string;
}

/** A planned attempt with no result, listed when a partial run is published. */
export interface Missing {
  readonly runId: string;
  readonly provider: string;
  readonly path: ServicePath;
  readonly attempt: number;
}

export interface ServicesSite {
  readonly schema: 1;
  readonly generatedAt: string;
  readonly runs: readonly RunInfo[];
  /**
   * Set only when runs that did not complete were published on purpose (summary --partial): which
   * runs, and every planned attempt without a result.
   */
  readonly partial: {
    readonly incomplete: readonly string[];
    readonly missing: readonly Missing[];
  } | null;
  readonly tracks: readonly string[];
  readonly fixture: {
    readonly name: string;
    readonly postgres: string;
    readonly redis: string;
    readonly tests: number;
    readonly images: typeof images;
    readonly node: string;
    readonly docker: string;
    readonly compose: string;
  };
  /** One row per provider, track and run settings (Modal's runtime): never pooled across them. */
  readonly providers: readonly {
    readonly provider: string;
    readonly track: string;
    /** This provider's run setting these attempts shared, such as `runtime=vm`; empty for none. */
    readonly settings: string;
    readonly capability: ReturnType<typeof capability>;
    readonly compose: PathSummary;
    readonly native: PathSummary;
  }[];
  /**
   * One ranking per path and track, by median servicesUpS over green attempts. Paths are never
   * merged, and rows from different tracks are never ranked together.
   */
  readonly rankings: {
    readonly [P in ServicePath]: readonly {
      readonly track: string;
      readonly entries: readonly {
        provider: string;
        settings: string;
        medianServicesUpS: number;
        green: number;
        attempts: number;
      }[];
    }[];
  };
  /** Providers a run skipped or stopped early (no credentials, spend cap), with the reason. */
  readonly notRun: readonly NotRun[];
  readonly notes: readonly string[];
}

export function servicesSiteData(input: {
  records: readonly AttemptRecord[];
  runs: readonly RunInfo[];
  notRun?: readonly NotRun[];
  generatedAt?: string;
  partial?: { readonly incomplete: readonly string[]; readonly missing: readonly Missing[] };
}): ServicesSite {
  const settingsOf = new Map<string, ReadonlyMap<string, string>>();

  // One summary is one measurement setup: the same harness commit, pinned artifacts, runner
  // location and timing settings (a shorter daemon budget can pick another rung; a farther runner
  // slows every upload and round trip). Runs that differ are published from separate summaries,
  // never pooled into one median.
  const setups = new Set(
    input.runs.map((r) =>
      JSON.stringify([
        r.sdkCommit,
        r.artifacts.node,
        r.artifacts.fixture,
        r.artifacts.native,
        r.location,
        r.conditions ? [r.conditions.attemptTimeoutMs, r.conditions.daemonReadyMs] : null,
      ]),
    ),
  );

  if (setups.size > 1)
    throw new Error(
      `Runs differ in SDK commit, artifacts, runner location or timing settings (${input.runs.map((r) => `${r.id}: ${r.sdkCommit.slice(0, 7)} at ${r.location}, ${r.conditions ? `attempt ${r.conditions.attemptTimeoutMs} ms, daemon ${r.conditions.daemonReadyMs} ms` : "timing not recorded"}`).join("; ")}); summarize them separately`,
    );

  // Upload and round-trip times depend on where the runner sits: a public summary names it.
  const unplaced = input.runs.filter((r) => !r.location || r.location === "unknown");

  if (unplaced.length)
    throw new Error(
      `Runs ${unplaced.map((r) => r.id).join(", ")} have no runner location; collect with --location NAME so runs from different places are never pooled`,
    );

  // A provider placed differently (another region or target) is another measurement.
  const placements = new Map<string, { runId: string; value: string }>();

  for (const run of input.runs)
    for (const [provider, vars] of Object.entries(run.conditions?.placement ?? {})) {
      const value = JSON.stringify(vars);
      const earlier = placements.get(provider);

      if (earlier && earlier.value !== value)
        throw new Error(
          `${provider} was placed differently in ${earlier.runId} (${earlier.value}) and ${run.id} (${value}); summarize them separately`,
        );
      placements.set(provider, { runId: run.id, value });
    }

  for (const run of input.runs) {
    if (settingsOf.has(run.id)) throw new Error(`Run ${run.id} appears twice`);
    settingsOf.set(run.id, new Map(Object.entries(run.settings)));
  }

  const seen = new Set<string>();

  const groups = new Map<
    string,
    { provider: string; track: string; settings: string; records: AttemptRecord[] }
  >();

  for (const record of input.records) {
    const run = input.runs.find((r) => r.id === record.runId);

    // An attempt is published only under the artifacts it actually ran with.
    if (
      run &&
      (record.artifacts.node !== run.artifacts.node ||
        record.artifacts.fixture !== run.artifacts.fixture ||
        record.artifacts.native !== (record.path === "native" ? run.artifacts.native : null))
    )
      throw new Error(`Attempt ${record.attemptId} ran other artifacts than run ${run.id} records`);
    const runSettings = settingsOf.get(record.runId);

    if (runSettings === undefined)
      throw new Error(`Attempt ${record.attemptId} names run ${record.runId}, which was not given`);
    const settings = runSettings.get(record.provider) ?? "";
    const id = `${record.runId}/${record.attemptId}`;

    if (seen.has(id)) throw new Error(`Attempt ${id} appears twice`);
    seen.add(id);
    const key = `${record.provider}\u0000${record.track}\u0000${settings}`;

    const group = groups.get(key) ?? {
      provider: record.provider,
      track: record.track,
      settings,
      records: [],
    };

    group.records.push(record);
    groups.set(key, group);
  }

  const providers = [...groups.values()]
    .sort(
      (a, b) =>
        a.provider.localeCompare(b.provider) ||
        a.track.localeCompare(b.track) ||
        a.settings.localeCompare(b.settings),
    )
    .map(({ provider, track, settings, records }) => ({
      provider,
      track,
      settings,
      capability: capability(provider, records),
      compose: pathSummary(records.filter((r) => r.path === "compose")),
      native: pathSummary(records.filter((r) => r.path === "native")),
    }));

  const tracks = [...new Set(providers.map((p) => p.track))].sort();

  const ranking = (path: ServicePath) =>
    tracks.map((track) => ({
      track,
      entries: providers
        .flatMap((p) => {
          const summary = p[path];
          const up = summary.medians.servicesUpS;

          return p.track !== track || up === null
            ? []
            : [
                {
                  provider: p.provider,
                  settings: p.settings,
                  medianServicesUpS: up,
                  green: summary.green,
                  attempts: summary.attempts,
                },
              ];
        })
        .sort((a, b) => a.medianServicesUpS - b.medianServicesUpS),
    }));

  return {
    schema: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runs: input.runs,
    tracks,
    fixture: {
      name: "services-api",
      postgres: serverVersions.postgres,
      redis: serverVersions.redis,
      tests: expectedTests,
      images,
      node: node.version,
      docker: dockerStatic.version,
      compose: composePlugin.version,
    },
    providers,
    rankings: { compose: ranking("compose"), native: ranking("native") },
    notRun: input.notRun ?? [],
    partial: input.partial ?? null,
    notes: [
      "servicesUpS: compose path from the first daemon step (including fetching Docker when the image has none) to Postgres answering SELECT 1 and Redis answering PING; no-Docker path from the bundle upload to the same check.",
      "readyToGreenS: from the first upload after the probe to all fixture tests passing; sandbox creation and the measurement-only probe are excluded.",
      "The compose path fetches Docker and pulls images from the internet inside the sandbox; the no-Docker path uploads its bundle from the harness host. Their transfer sources differ, so the two rankings are separate.",
      "Medians are over green attempts only; failures are listed with the stage they stopped at.",
      "A row is unsupported only when every attempt is conclusive evidence: a guest architecture without pinned artifacts, or a finished daemon ladder whose every failed try found no daemon on the socket or refused a named prerequisite (root, iptables, an overlay mount, a writable cgroup, user namespaces). Download, checksum, transport, timeout and disk-space failures keep a row failed. unsupportedReason says what ruled each method out; unsupported lists every such attempt, also in rows that are measured or failed.",
      "cleanupUnconfirmed lists attempts whose sandbox deletion, or whose Compose project's removal on a daemon that may outlive the sandbox, was not confirmed. It is separate from the outcome: a green attempt can be listed.",
    ],
  };
}

const cell = (value: number | null) => (value === null ? "–" : value.toFixed(1));

const greenCell = (p: PathSummary) =>
  p.status === "unsupported"
    ? `unsupported (${p.green}/${p.attempts})`
    : p.status === "not-run"
      ? "not run"
      : `${p.green}/${p.attempts}`;

export function summaryMarkdown(site: ServicesSite): string {
  const lines = [
    `# Docker and services inside the sandbox`,
    "",
    `Runs: ${site.runs.map((r) => `${r.id} (${r.sdkCommit.slice(0, 7)})`).join(", ")}. Track: ${site.tracks.join(", ")}. Postgres ${site.fixture.postgres}, Redis ${site.fixture.redis}, ${site.fixture.tests} tests.`,
    "",
    "| Provider | Isolation | Root | Docker (real start) | How | Compose green | Compose up s | No-Docker green | No-Docker up s | No-Docker to green s |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const p of site.providers)
    lines.push(
      `| ${p.provider}${p.settings ? ` (${p.settings})` : ""}${site.tracks.length > 1 ? ` [${p.track}]` : ""} | ${p.capability.isolation[0]?.value ?? "?"} | ${p.capability.root ?? "?"} | ${p.capability.docker} | ${p.capability.dockerMethods.map((m) => m.value).join(", ") || "–"} | ${greenCell(p.compose)} | ${cell(p.compose.medians.servicesUpS)} | ${greenCell(p.native)} | ${cell(p.native.medians.servicesUpS)} | ${cell(p.native.medians.readyToGreenS)} |`,
    );

  // Which run an entry came from, once there is more than one (Boat's batches reuse ordinals).
  const from = (runId: string) => (site.runs.length > 1 ? ` (${runId})` : "");

  lines.push("", "## Unsupported", "");

  for (const p of site.providers)
    for (const path of servicePaths) {
      const row = p[path];

      if (row.unsupportedReason) lines.push(`- ${p.provider} ${path}: ${row.unsupportedReason}`);
      else
        for (const u of row.unsupported)
          lines.push(`- ${p.provider} ${path} #${u.attempt}${from(u.runId)}: ${u.reason}`);
    }

  lines.push("", "## Not run", "");

  for (const n of site.notRun) lines.push(`- ${n.provider} (${n.runId}): ${n.reason}`);

  lines.push("", "## Failures", "");

  for (const p of site.providers)
    for (const path of servicePaths)
      for (const f of p[path].failures)
        lines.push(
          `- ${p.provider} ${path} #${f.attempt}${from(f.runId)}: ${f.stage}: ${f.reason}`,
        );

  lines.push("", "## Cleanup unconfirmed", "");

  for (const p of site.providers)
    for (const path of servicePaths)
      for (const c of p[path].cleanupUnconfirmed)
        lines.push(`- ${p.provider} ${path} #${c.attempt}${from(c.runId)}: ${c.attemptId}`);

  if (site.partial) {
    lines.push("", "## Did not complete", "");

    for (const run of site.partial.incomplete) lines.push(`- ${run}`);

    for (const m of site.partial.missing)
      lines.push(`- ${m.provider} ${m.path} #${m.attempt} (${m.runId}): no result`);
  }

  lines.push("", "## Daemon tries that failed", "");

  for (const p of site.providers)
    for (const f of p.capability.daemonFailures)
      lines.push(`- ${p.provider} (${f.count}x): ${f.value}`);

  return `${lines.join("\n")}\n`;
}

export type { NativeServiceDoc };
