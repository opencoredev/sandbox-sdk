import { resources } from "./fingerprint.js";
import { estimateCost, pricing } from "./pricing.js";
import { distribution } from "./v2-stats.js";
import {
  discardedRun,
  publicationRuns,
  reliability,
  type MergedSample,
  type PublicationReport,
  type PublicationSummary,
  type Suite,
} from "./merge.js";

// Reference: scientific benchmark supplements; compact, annotated evidence before narrative.
// Palette: white paper, #171a20 ink, #526170 secondary, #174ea6 links, #596778 observations.
// Type: system sans for reading, system monospace for measurements; no network fonts.
// Layout: summary first, then expandable scenario strips and auditable source tables.
// Signature: every successful observation is a dot, with the median and its bootstrap interval.
// Avoiding: winner badges, composite scores, decorative gradients, and cross-currency rankings.
const esc = (value: unknown) =>
  String(value ?? "unknown")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const fmt = (value: number | null | undefined, digits = 2) =>
  value == null ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: digits });
const money = (value: number | null | undefined, currency: string) =>
  value == null ? "unknown" : `${currency} ${value.toFixed(5)}`;
const pct = (value: number | undefined) =>
  value === undefined ? "—" : `${(value * 100).toFixed(2)}%`;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const providers = (r: PublicationReport) => [
  ...new Set(r.sources.flatMap((s) => s.providers.map((p) => p.name))),
];
const summary = (r: PublicationReport, provider: string, scenario: string, suite: Suite = "main") =>
  r.summaries.find((s) => s.suite === suite && s.provider === provider && s.scenario === scenario);
const latency = (s: PublicationSummary | undefined, tail = false) =>
  s?.stats.p50 == null
    ? "—"
    : `${fmt(s.stats.p50 / 1000)}${tail ? ` / ${fmt((s.stats.p95 ?? 0) / 1000)}` : ""}`;
function table(headers: string[], rows: string[][], caption: string) {
  return `<table><caption>${esc(caption)}</caption><thead><tr>${headers.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, i) => `<td data-label="${esc(headers[i])}">${esc(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function mdTable(headers: string[], rows: string[][]) {
  const safe = (cell: string) => cell.replaceAll("|", "\\|").replaceAll("\n", " ");
  return [
    `| ${headers.map(safe).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(safe).join(" | ")} |`),
  ].join("\n");
}
function costs(r: PublicationReport) {
  return r.sources.flatMap((source) =>
    source.providers.map((p) => {
      const lifetimes = r.samples.filter(
        (s) =>
          s.sourceRunId === source.runId &&
          s.provider === p.name &&
          /(^|\/)sandbox-lifetime$/.test(s.scenario),
      );
      const known = lifetimes.flatMap((s) => (s.estimatedCost === null ? [] : [s.estimatedCost]));
      return {
        provider: p.name,
        sourceRunId: source.runId,
        currency: source.pricing[p.name]?.currency ?? "unknown",
        known: sum(known),
        missing: lifetimes.length - known.length,
        lifetimes: lifetimes.length,
      };
    }),
  );
}
export function hourly(r: PublicationReport, provider: string) {
  const fingerprints = r.samples
    .filter((s) => s.provider === provider && s.scenario === "fingerprint")
    .flatMap((s) => (s.fingerprint ? [s.fingerprint] : []));
  const values = fingerprints.flatMap((fp) => {
    const value = estimateCost(provider, 3600000, resources(fp));
    return value === null ? [] : [value];
  });
  return distribution(values).p50;
}
export function headline(r: PublicationReport) {
  const headers = [
    "Provider",
    "Cold p50 / p95 (s)",
    "Command p50 (s)",
    "10 MiB round trip (s)",
    "Pause/resume (s)",
    "Snapshot / restore (s)",
    "Preview byte (s)",
    "npm install (s)",
    "Tool replay (s)",
    "K=25 all ready (s)",
    "Raw / adjusted success",
    "Est. sandbox-hour",
  ];
  const rows = providers(r).map((p) => {
    const rel = reliability(r.samples.filter((s) => s.provider === p));
    return [
      p,
      latency(summary(r, p, "cold"), true),
      latency(summary(r, p, "command")),
      latency(summary(r, p, "files-10mb")),
      latency(summary(r, p, "pause-resume")),
      `${latency(summary(r, p, "snapshot", "snapshot"))} / ${latency(summary(r, p, "create-from-snapshot", "snapshot"))}`,
      latency(summary(r, p, "preview-first-byte")),
      latency(summary(r, p, "npm-install")),
      latency(summary(r, p, "tool-replay")),
      latency(summary(r, p, "burst-25/all-ready", "burst")),
      `${pct(rel.raw?.rate)} / ${pct(rel.excludingLimitsAndClient?.rate)}`,
      money(hourly(r, p), pricing[p]?.currency ?? "unknown"),
    ];
  });
  return { headers, rows };
}
function failureRows(r: PublicationReport) {
  const groups = new Map<string, { sample: MergedSample; count: number; sources: Set<string> }>();
  for (const s of r.samples) {
    if (s.outcome.kind !== "failure") continue;
    const key = JSON.stringify([s.provider, s.scenario, s.failureClass, s.outcome.note]);
    const entry = groups.get(key) ?? { sample: s, count: 0, sources: new Set<string>() };
    entry.count++;
    entry.sources.add(s.sourceRunId);
    groups.set(key, entry);
  }
  return [...groups.values()].map(({ sample: s, count, sources }) => [
    s.provider,
    s.scenario,
    s.failureClass ?? "unknown",
    String(count),
    s.outcome.kind === "failure" ? s.outcome.note : "",
    [...sources].join(", "),
  ]);
}
function reliabilityRows(r: PublicationReport) {
  return providers(r).map((p) => {
    const rel = reliability(r.samples.filter((s) => s.provider === p));
    const interval = (v: typeof rel.raw) =>
      v ? `${pct(v.rate)} [${pct(v.low)}, ${pct(v.high)}]; n=${v.total}` : "—";
    return [
      p,
      interval(rel.raw),
      interval(rel.excludingLimitsAndClient),
      String(rel.classes["provider-account-limit"]),
      String(rel.classes["client-third-party"]),
      String(rel.classes["provider-operation"]),
      String(rel.blocked),
      String(rel.skipped),
    ];
  });
}
function hardwareRows(r: PublicationReport) {
  return providers(r).map((p) => {
    const fps = r.samples
      .filter((s) => s.provider === p && /(^|\/)fingerprint$/.test(s.scenario))
      .flatMap((s) => (s.fingerprint ? [s.fingerprint] : []));
    const unique = (xs: string[]) => [...new Set(xs)].join("; ") || "unknown";
    const range = (ns: number[]) =>
      ns.length ? `${fmt(Math.min(...ns))}–${fmt(Math.max(...ns))}` : "unknown";
    return [
      p,
      String(fps.length),
      unique(fps.map((f) => f.cpuModel)),
      unique(fps.map((f) => `${f.nproc} visible / ${f.quotaCpus ?? "unlimited"} quota`)),
      range(fps.map((f) => f.memoryBytes / 1024 ** 3)),
      range(fps.map((f) => f.diskBytes / 1024 ** 3)),
      unique(
        fps.map((f) => `${f.virtualization || "unreported"}; hypervisor=${f.hypervisor}; ${f.dmi}`),
      ),
      unique(
        fps.map((f) =>
          f.kernel
            .replace(/^Linux \S+ /, "")
            .split(" ")
            .slice(0, 2)
            .join(" "),
        ),
      ),
      unique(
        fps.map((f) =>
          f.egress
            ? [f.egress.city, f.egress.region, f.egress.country, f.egress.org]
                .filter(Boolean)
                .join(", ")
            : "unknown",
        ),
      ),
    ];
  });
}
const hardwareHeaders = [
  "Provider",
  "Fingerprints",
  "CPU models observed",
  "nproc / cgroup vCPU",
  "RAM GiB range",
  "Disk GiB range",
  "Virtualization / DMI",
  "Kernel",
  "Observed egress / ASN",
];
const reliabilityHeaders = [
  "Provider",
  "Raw success [Wilson 95% CI]",
  "Excluding limits/client [Wilson 95% CI]",
  "Account-limit failures",
  "Client/third-party failures",
  "Operation failures",
  "Blocked",
  "Skipped",
];
function costTables(r: PublicationReport) {
  const rows = costs(r);
  const totals = providers(r).map((p) => {
    const selected = rows.filter((c) => c.provider === p);
    const currency = selected[0]?.currency ?? "unknown";
    const missing = sum(selected.map((c) => c.missing));
    const hour = hourly(r, p);
    const command = summary(r, p, "command")?.stats.p50;
    return [
      p,
      money(sum(selected.map((c) => c.known)), currency),
      String(missing),
      money(hour, currency),
      hour && command ? fmt(3600000 / command / hour, 0) : "not applicable",
      currency,
    ];
  });
  return {
    perRun: rows.map((c) => [
      c.provider,
      c.sourceRunId,
      money(c.known, c.currency),
      String(c.lifetimes),
      String(c.missing),
    ]),
    totals,
  };
}
const costHeaders = [
  "Provider",
  "Known lifetime estimate total",
  "Unpriced lifetimes",
  "Median est. sandbox-hour",
  "Command operations / native currency",
  "Currency",
];
const perRunCostHeaders = [
  "Provider",
  "Source run",
  "Known lifetime estimate subtotal",
  "Lifetimes",
  "Unpriced lifetimes",
];
function burstRows(r: PublicationReport) {
  return r.sources
    .filter((s) => s.suite === "burst")
    .flatMap((source) =>
      source.providers.flatMap((p) =>
        source.config.bursts.map((k) => {
          const member = r.samples.filter(
            (s) =>
              s.sourceRunId === source.runId &&
              s.provider === p.name &&
              s.scenario === `burst-${k}/cold`,
          );
          const cohorts = r.samples.filter(
            (s) =>
              s.sourceRunId === source.runId &&
              s.provider === p.name &&
              s.scenario === `burst-${k}/all-ready`,
          );
          const values = distribution(
            cohorts.flatMap((s) => (s.outcome.kind === "sample" ? [s.outcome.value] : [])),
          );
          return [
            p.name,
            source.runId,
            String(k),
            String(member.length),
            String(member.filter((s) => s.outcome.kind === "sample").length),
            String(cohorts.filter((s) => s.outcome.kind === "sample").length),
            String(cohorts.filter((s) => s.outcome.kind === "failure").length),
            String(cohorts.filter((s) => s.outcome.kind === "skipped").length),
            fmt(values.p50 === null ? null : values.p50 / 1000),
            p.note,
          ];
        }),
      ),
    );
}
const burstHeaders = [
  "Provider",
  "Run",
  "K",
  "Creates attempted",
  "Creates ready",
  "Cohorts ready",
  "Cohorts failed",
  "Cohorts skipped",
  "All-ready p50 (s)",
  "Provider / admission note",
];
function sourceRows(r: PublicationReport) {
  return r.sources.map((s) => [
    s.runId,
    s.suite,
    String(s.sampleCount),
    `${s.timestamp} → ${s.finishedAt}`,
    s.metadata.harnessCommit,
    s.metadata.sdkCommit,
    `${s.host.cpu}; ${s.host.os}; ${s.host.runtime}; ${JSON.stringify(s.metadata.clientLocation)}`,
    String(s.config.seed),
    s.providers
      .map((p) => `${p.name}: ${p.configuredRegion ?? "unspecified (provider default)"}`)
      .join("; "),
  ]);
}
const sourceHeaders = [
  "Source",
  "Suite",
  "Samples",
  "Collection window UTC",
  "Harness commit",
  "SDK commit",
  "Client host / egress",
  "Seed",
  "Configured regions",
];
function hostRows(r: PublicationReport) {
  return providers(r).map((p) => {
    const rows = r.samples.filter((s) => s.provider === p);
    const cpu = rows.flatMap((s) =>
      s.headroom.hostCpuBusy === null ? [] : [s.headroom.hostCpuBusy],
    );
    return [
      p,
      String(rows.length),
      String(rows.filter((s) => s.headroom.highLoad).length),
      fmt(Math.max(...rows.map((s) => s.headroom.normalizedLoad)), 3),
      pct(cpu.length ? sum(cpu) / cpu.length : undefined),
    ];
  });
}
const hostHeaders = [
  "Provider",
  "Host samples",
  "High-load flags",
  "Max load1 / logical CPUs",
  "Mean sampled host CPU busy",
];
export function disclosures(r: PublicationReport) {
  const notes = [
    "Local is a Docker reference baseline. Host hardware, electricity, networking and administration are excluded from its cost. Default provider images and sizes differ; this is not a resource-matched comparison. No combined overall ranking is calculated.",
    "Main lifecycle runs target 100 iterations per provider and workloads on the first 30. Snapshot scenarios were excluded from publication-002 and collected separately for 30 iterations with a 600-second timeout. Main and snapshot cold creates stay in separate summaries.",
    "The original harness budget bug stopped Tenki at 46, Daytona at 59 and Upstash at 87 main iterations. Top-ups add 54, 41 and 13 respectively using seed 46 and harness commit 49639a2. Each top-up restarted iteration numbering at 0; this merge assigns unique provider iteration identities and retains sourceRunId, sourceSampleIndex, sourceIteration and namespace. The main run used seed 45.",
    "Top-ups used --workload-runs 1. Daytona and Tenki therefore contribute one extra workload observation each (31 total per workload before failures/blocking). Upstash iteration 0 failed cold creation, so no extra workload observation was collected there. The failed cold and unknown lifetime remain in the dataset.",
    "Boat's last 40 main cold creates failed with quota. Its plan allows 12 starts/minute, 60/hour and 200/day, verified in the account dashboard during collection; account spend was only USD 0.49. Boat snapshot-run cold creates also hit quota, so its snapshot capability was not exercised there; Boat does not support snapshots. Burst data includes both successful starts and quota failures. These are start limits, not evidence of a spending cap.",
    "Daytona's first K=25 cohort had 15 invalid_argument create failures among 25 attempts, consistent with an account concurrency limit, but the provider error does not prove the cause. Later original cohorts were prevented by the budget bug. In the fixed rerun, K=10 succeeded in all 3 cohorts. K=25 was never attempted: results.json provider notes record cap 25 with 1, 1 and 5 existing SDK sandboxes, leaving only 24, 24 and 20 slots. No rerun was performed for this report.",
    "network-mbps is not comparable and is not ranked or charted: the Cloudflare speed test returned HTTP 429 on local, Tenki and boxd, and connection resets on Daytona. Raw observations and distributions remain in the dataset. Only those specific network errors are classified client/third-party; other network operation errors remain operation failures.",
    "Raw success and success excluding provider/account-limit and client/third-party failures are shown together. Both omit skipped and blocked rows from their denominator. Aggregate rates count recorded observations, including derived guest metrics and cohort aggregates; they are not independent trial probabilities and not a provider ranking. Operation failures include unresolved causes rather than asserting provider fault in every case.",
    "Dependent scenarios share sandboxes. Failed prerequisites block later work, so successful latency distributions are conditional on reaching and completing each scenario. No missing trial is imputed. Failures, blocked rows and skips remain in raw data. Boat resume is unsupported; boxd snapshots are unsupported. A dash means no successful measurement, not zero latency.",
    `Dots show every successful observation, solid marker p50, horizontal interval the seeded 95% bootstrap CI. Statistics use nearest-rank percentiles, population SD and 2000 bootstrap resamples from the existing stats code; Wilson intervals describe success rates. Seed ${r.bootstrapSeed} drives merged bootstrap intervals. No outliers or warmups are removed. Small burst cohorts and extreme percentiles have substantial uncertainty; correlated observations are not made independent by bootstrapping.`,
    "Cold, reconnect, resume and restore run through a successful true command using the client monotonic clock. Pause/resume includes both operations. Snapshot is native API duration; snapshot-total includes setup/journaling. Preview first byte is each HTTP attempt, so retries can produce more than one row per workload iteration. Burst all-ready is time to the last successful ready create when all K succeed, not teardown time.",
    "Guest CPU is CPython fixed LCG iterations/s, single and all-core; all-core workers use ceil(min(nproc, quota)), capped at 64. Memory copy is 16 MiB. Disk is buffered 64 MiB sequential I/O plus 256 random 4 KiB queue-depth-1 operations; writes fsync, reads may be cached, no O_DIRECT. Runtime versions, shared CPU and cache state are confounders. MB/s is decimal; file payload is 10 MiB.",
    "Hardware tables show observed fingerprint ranges and CPU variants, including burst allocations. nproc can expose host CPUs; cgroup quota is shown separately. RAM and disk can describe a shared host filesystem or ceiling rather than dedicated allocation. Egress city/region/ASN is not a placement guarantee. All configured regions here are unspecified/provider default, unless a source table says otherwise.",
    "Host-load observations are retained per sample. High load means load1/logical CPUs >=1 or sampled host CPU busy >=90%. Overlapping samples share counters; traffic and CPU must not be summed as provider-attributable use. Collection is from the recorded client host and network only, with uncontrolled CDN and provider caches.",
    "Costs use existing published pricing and measured sandbox-lifetime estimates, which already include restored sandbox lifetime. Scenario allocations are not added again. Unknown billed lifetimes remain unknown; displayed subtotals cover known estimates only. Allocated CPU/RAM/disk estimates for Upstash and boxd are upper bounds. Subscription minimums, credits, transfer, snapshot retention and some storage are excluded. Boat is USD 0.036/hour; boxd stays EUR, with no FX conversion or cross-currency ranking. These are estimates, not invoices.",
    "Command operations per native currency = (3,600,000 / successful command p50 in ms) / median estimated sandbox-hour price. It describes hypothetical continuous commands at that median latency, excludes setup/idle time and is not an overall score. Local's zero marginal provider charge makes this ratio undefined.",
    `${discardedRun.runId}: ${discardedRun.reason}`,
    `Sample conservation: ${r.samples.length} merged observations = ${r.inputSampleCount} included input observations across ${r.sources.length} runs. Every source results.json was compared with its samples.ndjson before merging. No cloud calls were made by the merge.`,
  ];
  const isFullPublication = publicationRuns.every((id) =>
    r.sources.some((source) => source.runId === id),
  );
  return notes.filter((_, i) => isFullPublication || i < 1 || i > 6);
}
function metricRows(r: PublicationReport) {
  return r.summaries.map((s) => [
    s.suite,
    s.provider,
    s.scenario,
    s.unit,
    String(s.stats.count),
    fmt(s.stats.p50),
    s.stats.p50CI ? `${fmt(s.stats.p50CI.low)}–${fmt(s.stats.p50CI.high)}` : "—",
    fmt(s.stats.p95),
    fmt(s.stats.p99),
    fmt(s.stats.mean),
    pct(s.reliability.raw?.rate),
    pct(s.reliability.excludingLimitsAndClient?.rate),
    String(s.reliability.failures),
    String(s.reliability.blocked),
    String(s.reliability.skipped),
    s.comparable ? "yes" : "not comparable",
  ]);
}
const metricHeaders = [
  "Suite",
  "Provider",
  "Scenario",
  "Unit",
  "n success",
  "p50",
  "95% CI p50",
  "p95",
  "p99",
  "Mean",
  "Raw success",
  "Excl. limits/client",
  "Failures",
  "Blocked",
  "Skipped",
  "Comparable",
];
function chart(r: PublicationReport, suite: Suite, scenario: string, unit: string) {
  const groups = r.summaries.filter(
    (s) => s.suite === suite && s.scenario === scenario && s.unit === unit,
  );
  const order = providers(r);
  groups.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));
  const samples = r.samples.filter(
    (s) => s.suite === suite && s.scenario === scenario && s.unit === unit,
  );
  const values = samples.flatMap((s) => (s.outcome.kind === "sample" ? [s.outcome.value] : []));
  const min = Math.min(...values),
    max = Math.max(...values);
  const log = min > 0 && max / min > 20;
  const transform = (v: number) => (log ? Math.log10(v) : v);
  const lo = values.length ? (log ? transform(min) : 0) : 0;
  const hi = values.length ? transform(max) : 1;
  const position = (v: number) => 6 + (608 * (transform(v) - lo)) / (hi - lo || 1);
  const lines = groups
    .map((s) => {
      const rows = samples.filter((row) => row.provider === s.provider);
      const dots = rows
        .flatMap((row) => (row.outcome.kind === "sample" ? [row] : []))
        .map((row, i) => {
          const v = row.outcome.kind === "sample" ? row.outcome.value : 0;
          return `<circle cx="${position(v)}" cy="${13 + (((i * 7) % 13) - 6)}" r="2" fill="#596778" opacity=".7"><title>${esc(`${row.provider}: ${fmt(v)} ${unit}; ${row.sourceRunId} iteration ${row.sourceIteration}`)}</title></circle>`;
        })
        .join("");
      const ci = s.stats.p50CI;
      const median = s.stats.p50;
      return `<div class="strip"><div class="strip-label"><strong>${esc(s.provider)}</strong><span>${fmt(median)} ${esc(unit)} · n=${s.stats.count} · ${s.reliability.failures} fail</span></div><svg viewBox="0 0 620 26" preserveAspectRatio="none" role="img" aria-label="${esc(`${s.provider}: median ${fmt(median)} ${unit}, 95% CI ${fmt(ci?.low)} to ${fmt(ci?.high)}, ${s.stats.count} successful measurements`)}"><line x1="6" x2="614" y1="13" y2="13" stroke="#dfe3e8"/>${dots}${ci ? `<line x1="${position(ci.low)}" x2="${position(ci.high)}" y1="13" y2="13" stroke="#171a20" stroke-width="3"/>` : ""}${median !== null ? `<line x1="${position(median)}" x2="${position(median)}" y1="4" y2="22" stroke="#171a20" stroke-width="3"/>` : ""}</svg></div>`;
    })
    .join("");
  const ticks = Array.from({ length: 5 }, (_, i) => {
    const t = lo + ((hi - lo) * i) / 4;
    return `<span>${fmt(log ? 10 ** t : t)} </span>`;
  }).join("");
  return `<details class="chart" ${["cold", "cpu-single"].includes(scenario) && suite === "main" ? "open" : ""}><summary>${esc(scenario)} <span>${esc(suite)} · ${esc(unit)} · ${log ? "logarithmic" : "linear"} scale</span></summary><div class="chart-body"><p class="chart-note">${unit === "ms" ? "Lower is faster." : "Higher is faster."} Dots: successful observations. Marker: p50. Line: bootstrap 95% CI. Failures remain in the reliability table.</p>${lines}<div class="axis">${ticks}</div></div></details>`;
}
export function publicationMarkdown(r: PublicationReport) {
  const head = headline(r),
    cost = costTables(r);
  return [
    "# Sandbox provider publication report",
    "",
    `Collection: ${r.timestamp} through ${r.finishedAt}. ${r.samples.length} observations; ${r.sources.length} included runs.`,
    "",
    mdTable(head.headers, head.rows),
    "",
    "All latency cells are seconds and p50 unless stated. Raw/adjusted success counts all observations; see reliability denominators below. Cost is the median estimated observed allocation per sandbox-hour. — means no successful measurement.",
    "",
    "## Reliability",
    "",
    mdTable(reliabilityHeaders, reliabilityRows(r)),
    "",
    "## Hardware",
    "",
    mdTable(hardwareHeaders, hardwareRows(r)),
    "",
    "## Cost estimates",
    "",
    mdTable(costHeaders, cost.totals),
    "",
    mdTable(perRunCostHeaders, cost.perRun),
    "",
    ...providers(r).map(
      (p) =>
        `${p}: ${pricing[p]?.notes ?? "Pricing unknown"} Source: ${pricing[p]?.source}; retrieved ${pricing[p]?.retrieved}.`,
    ),
    "",
    "## Bursts",
    "",
    mdTable(burstHeaders, burstRows(r)),
    "",
    "## Methodology and disclosures",
    "",
    ...disclosures(r).flatMap((n) => [n, ""]),
    "## Source metadata",
    "",
    mdTable(sourceHeaders, sourceRows(r)),
    "",
    ...r.sources.flatMap((s) => [
      `### ${s.runId}`,
      "",
      `Flags/config: ${JSON.stringify(s.config)}`,
      "",
      `Metadata: ${JSON.stringify(s.metadata)}`,
      "",
      `Budget diagnostics: ${JSON.stringify(s.budgets)}`,
      "",
      `Cleanup: ${JSON.stringify(s.cleanup)}`,
      "",
    ]),
    "## Client host load",
    "",
    mdTable(hostHeaders, hostRows(r)),
    "",
    "## Failure inventory",
    "",
    mdTable(["Provider", "Scenario", "Class", "Count", "Error", "Sources"], failureRows(r)),
    "",
    "## All scenario statistics",
    "",
    mdTable(metricHeaders, metricRows(r)),
    "",
    "## Merged schema",
    "",
    ...Object.entries(r.schema).flatMap(([k, v]) => [`${k}: ${v}`, ""]),
    "Reproduce offline from the repository root: `bun bench merge`. Optional: `bun bench merge results/run-a results/run-b --out results/merged --exclude publication-001 --seed 45`. Paths are relative to bench/. Output cannot overwrite an input. An existing output directory is replaced only for the four generated filenames. No provider is loaded or invoked by the merge command.",
    "",
  ].join("\n");
}
export function publicationHtml(r: PublicationReport) {
  const head = headline(r),
    cost = costTables(r);
  const scenarioGroups = [
    ...new Map(
      r.summaries
        .filter((s) => s.scenario !== "network-mbps")
        .map((s) => [JSON.stringify([s.suite, s.scenario, s.unit]), s]),
    ).values(),
  ];
  const perf = new Set([
    "cpu-single",
    "cpu-all",
    "memory-mbps",
    "disk-write-mbps",
    "disk-read-mbps",
    "disk-4k-write-iops",
    "disk-4k-read-iops",
  ]);
  const charts = (guest: boolean) =>
    scenarioGroups
      .filter((s) => perf.has(s.scenario) === guest)
      .map((s) => chart(r, s.suite, s.scenario, s.unit))
      .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'"><title>Sandbox provider benchmark | Publication report</title><style>
:root{color-scheme:light;--ink:#171a20;--muted:#526170;--paper:#fff;--line:#dfe3e8;--link:#174ea6}*{box-sizing:border-box}html{background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,sans-serif;-webkit-font-smoothing:antialiased}body{margin:0}main{max-width:1600px;margin:auto;padding:40px 32px 80px}h1{font-size:clamp(28px,4vw,44px);line-height:1.15;margin:8px 0 12px;letter-spacing:-.025em}header p{max-width:none}#headline td:first-child,#headline th:first-child{min-width:90px;overflow-wrap:normal}h2{font-size:26px;margin:48px 0 16px}h3{font-size:19px}p{max-width:78ch}p,li{text-wrap:pretty}a{overflow-wrap:anywhere;color:var(--link);text-underline-offset:3px}nav{display:flex;gap:8px 24px;flex-wrap:wrap;margin:24px 0}nav a{padding-block:8px}.eyebrow,.muted,.chart-note{color:var(--muted)}.eyebrow{font:13px ui-monospace,monospace;letter-spacing:.05em}.note{padding:16px 20px;background:#f4f6f8;max-width:none}.table-wrap:before{content:"Table scrolls horizontally when wider than the page.";display:block;color:var(--muted);font-size:12px;margin-bottom:8px}.table-wrap{max-width:100%;overflow-x:auto;margin-block:20px}.table-hint{color:var(--muted);font-size:13px}table{width:100%;min-width:1200px;table-layout:fixed;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;text-align:start}caption{text-align:start;font-weight:600;padding-bottom:12px;font-size:15px}th,td{text-align:start;vertical-align:top;padding:10px 9px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th:first-child{width:100px}#hardware table{min-width:1500px}#hardware th:nth-child(2){width:85px}#hardware th:nth-child(3){width:230px}#hardware th:nth-child(8){width:260px}#hardware th:nth-child(9){width:220px}th{font-weight:600;background:#f4f6f8}td:first-child{font-weight:600}#headline th,#headline td{padding:12px 7px}details{margin-block:12px;border:1px solid var(--line)}summary{padding:14px 16px;cursor:pointer;font-weight:600;min-height:44px}summary span{font-weight:400;color:var(--muted);font-size:13px;margin-inline-start:12px}.chart-body{padding:0 20px 18px}.chart-note{font-size:13px;margin:0 0 20px}.strip{margin:14px 0}.strip-label{display:flex;justify-content:space-between;gap:12px;font-size:13px;flex-wrap:wrap}.strip-label span{color:var(--muted);font-variant-numeric:tabular-nums}.strip svg{display:block;width:100%;height:30px}.axis{display:flex;justify-content:space-between;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}.axis span{min-width:0;overflow-wrap:anywhere}.axis span:last-child{text-align:end}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;padding:16px;background:#f4f6f8;margin:0}code{font:13px ui-monospace,monospace}section{scroll-margin-top:20px}.columns{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 24px}.columns>details{align-self:start;min-width:0}.disclosures li{margin-block:16px;max-width:90ch}.downloads{font-size:14px}.skip{position:absolute;inset-block-start:-100px}.skip:focus{inset-block-start:0;background:white;padding:12px;z-index:1}:focus-visible{outline:2px solid var(--link);outline-offset:3px}footer{border-top:1px solid var(--line);margin-top:40px;padding-top:20px;font-size:13px;color:var(--muted)}@media(max-width:65rem){.columns{grid-template-columns:minmax(0,1fr)}}@media(max-width:45rem){main{padding:24px 16px 56px}h2{font-size:23px}summary span{display:block;margin:4px 0 0 20px}.chart-body{padding-inline:12px}table{min-width:0!important;table-layout:auto}table,tbody,tr,td{display:block;width:100%}thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}tr{padding-block:12px;border-bottom:1px solid var(--line)}td{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;padding:7px 0!important;border:0;font-size:13px}td:before{content:attr(data-label);color:var(--muted);font-weight:400}td:first-child{font-size:15px}caption{display:block;width:100%}.table-wrap{overflow:visible}.table-wrap:before{display:none}.table-hint{display:none}.note{padding:14px}.axis{font-size:11px}.disclosures{padding-inline-start:20px}nav{gap:4px 20px}}
</style></head><body><a class="skip" href="#headline">Skip to summary</a><main><header><div class="eyebrow">SANDBOX SDK · PUBLICATION DATASET · ${esc(r.timestamp?.slice(0, 7) ?? "COLLECTION")}</div><h1>Sandbox provider benchmark</h1><p class="muted">${esc(r.timestamp)} to ${esc(r.finishedAt)} · ${r.samples.length.toLocaleString()} observations · ${r.sources.length} source runs · ${providers(r).length} providers</p></header>
<section id="headline"><div class="table-wrap">${table(head.headers, head.rows, "Provider summary · successful p50 latencies in seconds unless stated")}</div><p class="table-hint">Wide table: scroll horizontally if needed. On narrow screens, each provider becomes a labelled row group.</p><p class="note">Read by scenario. Local is a reference baseline; provider sizes differ. A dash means no successful measurement. Raw and adjusted success are observation-level rates, including correlated metrics. Snapshot and burst figures come from their separate suites. Estimated prices stay in native currency.</p></section>
<nav aria-label="Report sections"><a href="#scenarios">Scenarios</a><a href="#hardware">Hardware</a><a href="#guest">Guest performance</a><a href="#cost">Cost estimates</a><a href="#bursts">Bursts</a><a href="#reliability">Reliability</a><a href="#methodology">Methodology</a><a href="#sources">Sources</a></nav>
<p class="downloads"><a href="results.json">Merged results JSON</a> · <a href="samples.ndjson">All raw samples NDJSON</a> · <a href="results.md">Markdown report</a></p>
<section id="scenarios"><h2>Scenario distributions</h2><p>Expand each scenario for every successful observation, the p50 and its 95% bootstrap interval. Shared axes within each chart; logarithmic scales are labelled. The network throughput metric is <strong>not comparable</strong> because of Cloudflare HTTP 429 responses and Daytona connection resets. It remains in raw data and the statistics appendix, without a chart or rank.</p><div class="columns">${charts(false)}</div></section>
<section id="hardware"><h2>Observed hardware</h2><p>Ranges include source and burst fingerprints. Visible CPUs can exceed the cgroup quota. Disk may describe a shared filesystem. Egress location and ASN do not establish physical placement. Full kernels, runtime versions, tools and CPU flags are preserved in raw fingerprints.</p><div class="table-wrap">${table(hardwareHeaders, hardwareRows(r), "Guest fingerprints · observed variants and ranges")}</div></section>
<section id="guest"><h2>Guest performance</h2><p>CPU iterations/s, memory copy and buffered disk throughput describe the supplied guest environment. Python versions and caches differ. All-core worker counts follow the harness quota policy; these results are not normalized per vCPU.</p><div class="columns">${charts(true)}</div></section>
<section id="cost"><h2>Cost estimates and command efficiency</h2><p>These are marginal usage estimates, not invoices. Subtotals include known sandbox lifetimes only; unpriced lifetimes make the actual run total unknown. Restored lifetimes are already included. Estimates exclude subscription minimums, credits, transfer and retained snapshot storage. Upstash and boxd allocated-resource costs are upper bounds.</p><div class="table-wrap">${table(costHeaders, cost.totals, "Per-provider estimated totals · no currency conversion")}</div><p>Command operations per native currency assumes continuous commands at the successful median latency: (3,600,000 / command p50 ms) / estimated sandbox-hour price. It excludes setup and idle time. Local has no defined ratio because its marginal provider price is zero.</p><details><summary>Estimated cost by source run</summary><div class="table-wrap">${table(perRunCostHeaders, cost.perRun, "Known lifetime subtotals and unpriced counts")}</div></details>${providers(
    r,
  )
    .map(
      (p) =>
        `<details><summary>${esc(p)} pricing assumptions</summary><p>${esc(pricing[p]?.notes)}</p><p>Source: <a href="${esc(pricing[p]?.source)}">${esc(pricing[p]?.source)}</a>; retrieved ${esc(pricing[p]?.retrieved)}. Original per-source pricing is retained in results.json.</p></details>`,
    )
    .join("")}</section>
<section id="bursts"><h2>Burst readiness</h2><p>All-ready time requires all K creates to become ready. Failed and unattempted cohorts have no latency percentile. Source cohorts are shown separately. Provider admission notes explain account-cap skips; the methodology records the publication-specific quota and concurrency constraints.</p><div class="table-wrap">${table(burstHeaders, burstRows(r), "K=10 and K=25 · every source and configured cohort size")}</div></section>
<section id="reliability"><h2>Reliability and failure causes</h2><p>Raw = successes / (successes + failures). Adjusted = successes / (successes + operation failures), excluding account-limit and client/third-party failures. Skips and blocked dependencies are shown separately. Derived metrics and cohort aggregates share underlying failures; do not interpret these rates as independent sandbox trial probabilities.</p><div class="table-wrap">${table(reliabilityHeaders, reliabilityRows(r), "Raw and adjusted observation success · Wilson 95% intervals")}</div><details><summary>Every distinct failure and its classification</summary><div class="table-wrap">${table(["Provider", "Scenario", "Class", "Count", "Error", "Source runs"], failureRows(r), "Failure inventory · no failures removed")}</div></details></section>
<section id="methodology"><h2>Methodology and disclosures</h2><ol class="disclosures">${disclosures(
    r,
  )
    .map((n) => `<li>${esc(n)}</li>`)
    .join(
      "",
    )}</ol><h3>Collection host load</h3><div class="table-wrap">${table(hostHeaders, hostRows(r), "Client headroom · overlapping counters are not additive")}</div></section>
<section id="sources"><h2>Source metadata and reproducibility</h2><div class="table-wrap">${table(sourceHeaders, sourceRows(r), "Collection windows, commits, host, seed and configured regions")}</div>${r.sources.map((s) => `<details><summary>${esc(s.runId)} · flags, metadata, admission and cleanup</summary><pre>${esc(JSON.stringify({ config: s.config, metadata: s.metadata, providers: s.providers, budgets: s.budgets, cleanup: s.cleanup, iterationMappings: s.iterationMappings }, null, 2))}</pre></details>`).join("")}<h3>Reproduce offline</h3><pre>bun bench merge
bun bench merge results/run-a results/run-b --out results/merged --exclude publication-001 --seed 45</pre><p>Run from the repository root. Paths are relative to bench/. The default includes the seven publication runs and excludes the aborted publication-001. No provider calls are made.</p><details><summary>Documented merged schema</summary><dl>${Object.entries(
    r.schema,
  )
    .map(([k, v]) => `<dt><strong>${esc(k)}</strong></dt><dd>${esc(v)}</dd>`)
    .join(
      "",
    )}</dl></details><details><summary>All scenario statistics, including unranked network data</summary><div class="table-wrap">${table(metricHeaders, metricRows(r), "Successful distributions, raw reliability and comparability")}</div></details></section><footer>Sandbox SDK benchmark · publication-merge-v1 · self-contained HTML: no external scripts, fonts, or chart services. All source observations retained.</footer></main></body></html>`;
}
