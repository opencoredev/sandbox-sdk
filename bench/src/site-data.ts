import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { priceAtSize, pricing } from "./pricing.js";
import { allocationEvidence } from "./allocation.js";
import { hourly } from "./publication-report.js";
import { publicationTrack, reliability, type MergedSample, type PublicationReport, type Suite } from "./merge.js";
import { statistics } from "./stats.js";
import type { Fingerprint } from "./fingerprint.js";

// Compact, chart-ready view of a merged publication report for apps/bench-site.
// Every number here is derived from results.json; the site never hard-codes measurements.

export type Better = "lower" | "higher";
export interface MetricDef {
  id: string;
  suite: Suite;
  scenario: string;
  label: string;
  unit: "s" | "ops/s" | "MB/s" | "IOPS" | "ms";
  better: Better;
  /** Converts the stored value (ms for latency) into the display unit. */
  scale: number;
  comparable?: boolean;
}

const latency = (id: string, suite: Suite, scenario: string, label: string): MetricDef => ({
  id,
  suite,
  scenario,
  label,
  unit: "s",
  better: "lower",
  scale: 1 / 1000,
});
const rate = (id: string, scenario: string, label: string, unit: MetricDef["unit"]): MetricDef => ({
  id,
  suite: "main",
  scenario,
  label,
  unit,
  better: "higher",
  scale: 1,
});

export const metricDefs: MetricDef[] = [
  latency("cold", "main", "cold", "Cold start"),
  latency("command", "main", "command", "Run a command"),
  latency("files-1kb", "main", "files-1kb", "Write + read 1 KB"),
  latency("files-10mb", "main", "files-10mb", "Write + read 10 MB"),
  latency("reconnect", "main", "reconnect", "Reconnect"),
  latency("pause-resume", "main", "pause-resume", "Pause + resume"),
  latency("destroy", "main", "destroy", "Destroy"),
  latency("snapshot", "snapshot", "snapshot", "Take snapshot"),
  latency("create-from-snapshot", "snapshot", "create-from-snapshot", "Start from snapshot"),
  latency("git-clone", "main", "git-clone", "git clone"),
  latency("npm-install", "main", "npm-install", "npm install"),
  latency("pip-install", "main", "pip-install", "pip install"),
  latency("dev-server", "main", "dev-server", "Dev server ready"),
  latency("preview-first-byte", "main", "preview-first-byte", "Preview URL first byte"),
  latency("edit-loop", "main", "edit-loop", "Edit, rebuild, reload"),
  latency("tool-replay", "main", "tool-replay", "Agent tool replay"),
  latency("burst-10", "burst", "burst-10/all-ready", "10 at once, all ready"),
  latency("burst-25", "burst", "burst-25/all-ready", "25 at once, all ready"),
  rate("cpu-single", "cpu-single", "CPU, one core", "ops/s"),
  rate("cpu-all", "cpu-all", "CPU, all cores", "ops/s"),
  rate("memory", "memory-mbps", "Memory bandwidth", "MB/s"),
  rate("disk-write", "disk-write-mbps", "Disk write", "MB/s"),
  rate("disk-read", "disk-read-mbps", "Disk read", "MB/s"),
  rate("iops-write", "disk-4k-write-iops", "4K random write", "IOPS"),
  rate("iops-read", "disk-4k-read-iops", "4K random read", "IOPS"),
  { ...rate("network", "network-mbps", "Download speed", "MB/s"), comparable: false },
  {
    ...latency("tcp", "main", "tcp-ms", "TCP connect"),
    unit: "ms",
    scale: 1,
  },
];

const egressText = (egress: Fingerprint["egress"], key: string) => {
  const value = egress?.[key];
  return typeof value === "string" && value ? value : null;
};

function cpuVendor(fp: Fingerprint) {
  if (fp.flags.includes("asimd") || fp.flags.includes("fp") || /arm|graviton|neoverse/i.test(fp.cpuModel))
    return { vendor: "Arm", arch: "arm64" };
  if (/intel/i.test(fp.cpuModel) || fp.flags.includes("vmx")) return { vendor: "Intel", arch: "x86_64" };
  if (/amd/i.test(fp.cpuModel) || fp.flags.includes("svm")) return { vendor: "AMD", arch: "x86_64" };
  return { vendor: "Unknown", arch: "unknown" };
}

const cleanCpu = (model: string) =>
  /^[\d/]+$|^unknown$/i.test(model.trim())
    ? null
    : model.replace(/\(R\)|\(TM\)/g, "").replace(/\s+/g, " ").trim();

const counts = (xs: string[]) =>
  [...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count }));

function hardware(r: PublicationReport, provider: string) {
  const fps = r.samples
    .filter((s) => s.provider === provider && s.scenario === "fingerprint")
    .flatMap((s) => (s.fingerprint ? [s.fingerprint] : []));
  const first = fps[0];
  if (!first) return null;
  const vcpu = counts(fps.map((f) => String(Math.min(f.nproc, f.quotaCpus ?? f.nproc))));
  const vendor = cpuVendor(first);
  return {
    fingerprints: fps.length,
    vcpu: Number(vcpu[0]?.value),
    visibleCpus: counts(fps.map((f) => String(f.nproc))).map((c) => Number(c.value)),
    cpuQuota: first.quotaCpus,
    memoryGiB: first.memoryBytes / 1024 ** 3,
    diskGiB: first.diskBytes / 1024 ** 3,
    cpuModels: counts(fps.flatMap((f) => cleanCpu(f.cpuModel) ?? [])),
    vendor: vendor.vendor,
    arch: vendor.arch,
    isolation: first.virtualization || (first.hypervisor ? "VM" : "unreported"),
    hypervisor: first.hypervisor,
    host: first.dmi || null,
    kernel: first.kernel.replace(/^Linux \S+ /, "").split(" ")[0] ?? null,
    location: counts(
      fps.flatMap((f) => {
        const city = egressText(f.egress, "city");
        const country = egressText(f.egress, "country");
        return city || country ? [[city, country].filter(Boolean).join(", ")] : [];
      }),
    ),
    network: counts(fps.flatMap((f) => egressText(f.egress, "org") ?? [])),
  };
}

/** The first sentence of a failure note, without HTML or the generic advice that follows it. For a traceback, its final exception line. */
export function shortReason(note: string) {
  const title = /<title>([^<]+)<\/title>/i.exec(note)?.[1];
  if (title) return title.trim();
  // A Python traceback: the last line is the exception that ended it.
  if (/Traceback \(most recent call last\)/.test(note)) {
    const last = note.trim().split("\n").filter((l) => l.trim()).at(-1)?.trim();
    if (last) return last.length > 140 ? `${last.slice(0, 137)}...` : last;
  }
  const text = note.replace(/\s+/g, " ").trim();
  const first = text.split(/(?<=[.!?])\s/)[0] ?? text;
  return first.length > 140 ? `${first.slice(0, 137)}...` : first;
}

const label = (sample: Pick<MergedSample, "suite" | "scenario">) =>
  metricDefs.find((d) => d.suite === sample.suite && d.scenario === sample.scenario)?.label ??
  sample.scenario.replace(/^burst-(\d+)\/.*$/, "$1 at once");

type FailureInput = Pick<MergedSample, "provider" | "suite" | "scenario" | "outcome" | "failureClass"> &
  Partial<Pick<MergedSample, "sourceRunId" | "iterationNamespace" | "sourceIteration">>;

/**
 * Failures the site does not pin on the provider: ones our own harness
 * caused, and ones we can't tell apart from our side (a timeout in our SDK
 * while waiting on the provider, or the SDK's generic error wrapper). The
 * site leaves them out of attempts and the failure list and discloses how
 * many; the raw report keeps them. Each rule says why it is set aside.
 */
const ourFailureRules: readonly { test: (s: FailureInput) => boolean; reason: string }[] = [
  {
    // The machine probe uses Python multiprocessing, which needs /dev/shm. Every traceback shows the SemLock failing.
    test: (s) => s.provider === "superserve" && s.outcome.kind === "failure" && /SemLock|\/dev\/shm/.test(s.outcome.note),
    reason: "Our machine probe needs /dev/shm, which Superserve's VMs don't have",
  },
  {
    test: (s) =>
      s.scenario === "files-10mb" &&
      s.outcome.kind === "failure" &&
      /^(boxd request timed out|Request deadline exceeded|Freestyle request failed\.)/.test(s.outcome.note),
    reason: "Our SDK timed out or wrapped the error moving 10 MB, so we can't tell whose side failed",
  },
  {
    test: (s) => s.outcome.kind === "failure" && s.outcome.note.startsWith("Process cancellation could not be confirmed"),
    reason: "Our SDK could not confirm its own cleanup, so we can't tell whose side failed",
  },
];

/** Why a failure is set aside, or null when it counts against the provider. */
export const ourFailure = (s: FailureInput) => ourFailureRules.find((r) => r.test(s))?.reason ?? null;

const skipped = new Set(["network-mbps", "snapshot-total"]);

/**
 * Every failure for one provider, grouped by cause: what went wrong, on how
 * many runs, and which tests it hit. One run can fail several derived tests
 * (one machine probe feeds eight metrics), so runs count each sandbox once.
 */
export function failureReasons(samples: readonly FailureInput[], provider: string) {
  const groups = new Map<string, { kind: string; reason: string; count: number; runs: Set<string>; tests: Set<string> }>();
  for (const s of samples) {
    // snapshot-total repeats the snapshot row it is derived from; download speed is off the site.
    if (s.provider !== provider || s.outcome.kind !== "failure" || skipped.has(s.scenario) || ourFailure(s)) continue;
    const evidence = s.outcome.cause;
    const attribution = [s.outcome.code, evidence?.httpStatus ? `HTTP ${evidence.httpStatus}` : null, evidence?.providerCode,
      evidence?.operation ? `operation=${evidence.operation}` : null, evidence?.requestId ? `requestId=${evidence.requestId}` : null].filter(Boolean);
    const reason = shortReason(s.outcome.note) + (attribution.length ? ` (${attribution.join(", ")})` : "");
    const kind = s.failureClass ?? "provider-operation";
    const key = `${kind}|${reason}`;
    const group = groups.get(key) ?? { kind, reason, count: 0, runs: new Set<string>(), tests: new Set<string>() };
    group.count += 1;
    group.runs.add(`${s.sourceRunId}:${s.iterationNamespace}:${s.sourceIteration}`);
    group.tests.add(label(s));
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.runs.size - a.runs.size || b.count - a.count)
    .map((g) => ({ kind: g.kind, reason: g.reason, count: g.count, runs: g.runs.size, tests: [...g.tests] }));
}

/** Failures set aside rather than counted, grouped by reason, with the runs they hit. */
export function ourFailures(samples: readonly FailureInput[], provider: string) {
  const groups = new Map<string, { reason: string; count: number; runs: Set<string> }>();
  for (const s of samples) {
    if (s.provider !== provider || skipped.has(s.scenario)) continue;
    const reason = ourFailure(s);
    if (!reason) continue;
    const group = groups.get(reason) ?? { reason, count: 0, runs: new Set<string>() };
    group.count += 1;
    group.runs.add(`${s.sourceRunId}:${s.iterationNamespace}:${s.sourceIteration}`);
    groups.set(reason, group);
  }
  return [...groups.values()].map((g) => ({ reason: g.reason, count: g.count, runs: g.runs.size }));
}

/** Median pause and median resume, in seconds, when the samples record them separately. */
type PauseInput = Pick<MergedSample, "provider" | "scenario" | "outcome" | "phases">;

export function pauseSplit(samples: readonly PauseInput[], provider: string) {
  const phase = (key: string) =>
    samples.flatMap((s) => {
      const v = s.provider === provider && s.scenario === "pause-resume" && s.outcome.kind === "sample" ? s.phases?.[key] : undefined;
      return typeof v === "number" ? [v / 1000] : [];
    });
  const pause = statistics(phase("pauseMs"));
  const resume = statistics(phase("resumeReadyMs"));
  return pause.p50 === null || resume.p50 === null ? null : { pause: pause.p50, resume: resume.p50, n: pause.count };
}

export function siteData(input: PublicationReport, track: "default" | "same-spec" = "default") {
  const r = publicationTrack(input, track);
  const names = [...new Set(r.sources.flatMap((s) => s.providers.map((p) => p.name)))];
  for (const provider of names) {
    const allocations = new Set(r.samples.filter(s => s.provider === provider).map(s => JSON.stringify([s.requestedSize ?? null, s.template ?? null])));
    if (allocations.size > 1) throw new Error(`${provider}: multiple allocations in ${track}; merge each allocation separately before site-data`);
  }
  const metrics = metricDefs.map((def) => ({
    ...def,
    comparable: def.comparable ?? true,
    values: names.flatMap((provider) => {
      const s = r.summaries.find(
        (x) => x.suite === def.suite && x.provider === provider && x.scenario === def.scenario,
      );
      if (!s) return [];
      const scaled = (v: number | null | undefined) => (v == null ? null : v * def.scale);
      // Our own failures are not attempts against the provider.
      const ours = r.samples.filter(
        (x) => x.suite === def.suite && x.provider === provider && x.scenario === def.scenario && ourFailure(x),
      ).length;
      return [
        {
          provider,
          n: s.stats.count,
          p50: scaled(s.stats.p50),
          p95: scaled(s.stats.p95),
          min: scaled(s.stats.min),
          ciLow: scaled(s.stats.p50CI?.low),
          ciHigh: scaled(s.stats.p50CI?.high),
          successes: s.reliability.successes,
          failures: s.reliability.failures - ours,
          ourFailures: ours,
          limitFailures: s.reliability.classes["provider-account-limit"],
        },
      ];
    }),
  }));
  const providers = names.map((name) => {
    const rel = reliability(r.samples.filter((s) => s.provider === name));
    const price = pricing[name];
    const hw = hardware(r, name);
    const hour = hourly(r, name);
    const allocation = allocationEvidence(r.samples, name);
    return {
      id: name,
      track,
      requestedAllocation: {...allocation.requested, compute: allocation.requestedCompute, provisioned: allocation.provisioned},
      measuredAllocations: allocation.measured,
      equalSpec: allocation.equalSpec,
      currency: price?.currency ?? null,
      hourly: hour,
      commonHourly: priceAtSize(name, { cpu: 4, memoryGiB: 8 }),
      perVcpuHour: hour != null && allocation.pricingAllocation ? hour / allocation.pricingAllocation.cpu : null,
      pricingAllocation: allocation.pricingAllocation,
      allocationVerification: {verified: allocation.verified, mismatches: allocation.mismatches},
      // Audited resource rates, size tiers and availability; tiered CPU has no per-vCPU rate.
      rates: price
        ? {
            vcpuHour: price.tiers ? null : price.cpuSecond * 3600,
            memoryGiBHour: price.memoryGiBSecond * 3600,
            fixed: price.fixed,
            fixedHour: price.fixedHour,
            tiers: price.tiers,
            offeredSizes: price.offeredSizes,
          }
        : null,
      pricingSource: price?.source ?? null,
      pricingNotes: price?.notes ?? null,
      reliability: {
        successes: rel.successes,
        failures: rel.failures,
        raw: rel.raw?.rate ?? null,
        adjusted: rel.excludingLimitsAndClient?.rate ?? null,
        accountLimit: rel.classes["provider-account-limit"],
        clientNetwork: rel.classes["client-third-party"],
        provider: rel.classes["provider-operation"],
      },
      hardware: hw,
      failureReasons: failureReasons(r.samples, name),
      ourFailures: ourFailures(r.samples, name),
      pauseSplit: pauseSplit(r.samples, name),
    };
  });
  // Raw successful cold starts, for distribution plots.
  const coldSamples = Object.fromEntries(
    names.map((provider) => [
      provider,
      r.samples
        .filter(
          (s) => s.suite === "main" && s.provider === provider && s.scenario === "cold",
        )
        .flatMap((s) => (s.outcome.kind === "sample" ? [Math.round(s.outcome.value) / 1000] : []))
        .sort((a, b) => a - b),
    ]),
  );
  return {
    track,
    allocations: providers.map(p => ({provider: p.id, track, requested: p.requestedAllocation, measured: p.measuredAllocations, equalSpec: p.equalSpec, verification: p.allocationVerification})),
    generatedFrom: r.runId,
    window: { start: r.timestamp, end: r.finishedAt },
    observations: r.samples.length,
    runs: r.sources.map((s) => ({ id: s.runId, suite: s.suite, samples: s.sampleCount })),
    excluded: r.excludedSources,
    providers,
    metrics,
    coldSamples,
  };
}
export type SiteData = ReturnType<typeof siteData>;

export async function siteDataCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      track: { type: "string", default: "default" },
      report: { type: "string", default: "results/publication-final" },
      out: { type: "string", default: "../apps/bench-site/src/data/benchmark.json" },
    },
  });
  // results.json is written by `bun bench merge`; its shape is PublicationReport by construction.
  const report: PublicationReport = JSON.parse(
    await readFile(join(values.report, "results.json"), "utf8"),
  );
  const track = (await import("./v2-config.js")).trackSchema.parse(values.track);
  await writeFile(values.out, `${JSON.stringify(siteData(report, track), null, 1)}\n`);

  process.stdout.write(`Wrote ${values.out}\n`);
}
