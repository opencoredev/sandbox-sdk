import { metric, providers, runWindow, runs, timedOperations } from "@/lib/data";
import type { Metric } from "@/lib/data";
import { formatGiB, formatValue, unitName } from "@/lib/format";
import { providerName } from "@/lib/providers";
import { advertised } from "@/lib/sizes";

/** The metrics agents get, in page order, grouped as on the page. */
export const groups = [
  { title: "Start-up", ids: ["cold"] },
  { title: "Agent work", ids: ["tool-replay", "npm-install", "pip-install", "git-clone", "dev-server", "preview-first-byte", "edit-loop"] },
  { title: "Everyday calls", ids: ["command", "files-1kb", "files-10mb", "reconnect", "destroy"] },
  { title: "Pause and snapshots", ids: ["pause-resume", "snapshot", "create-from-snapshot"] },
  { title: "Bursts", ids: ["burst-10", "burst-25"] },
  { title: "Machine speed", ids: ["cpu-single", "cpu-all", "memory", "disk-write", "disk-read", "iops-write", "iops-read"] },
] as const;

const round = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

const results = (m: Metric) =>
  providers
    .map((p) => {
      const v = m.values.find((x) => x.provider === p.id);
      return {
        provider: p.id,
        median: round(v?.p50 ?? null),
        p95: round(v?.p95 ?? null),
        attempts: v ? v.n + v.failures : 0,
        failed: v?.failures ?? 0,
      };
    })
    .sort((a, b) =>
      a.median === null ? 1 : b.median === null ? -1 : (m.better === "lower" ? 1 : -1) * (a.median - b.median),
    );

/** Everything on the page as one JSON document, for agents and scripts. */
export function agentData() {
  return {
    about:
      "Sandbox SDK bench: seven cloud sandbox providers driven through one open-source SDK from one server in Florida, US. Medians and p95s per provider; every failure kept.",
    run: { start: runWindow.start, end: runWindow.end, runs: runs.map((r) => r.id), timedOperations },
    howToRead:
      "median and p95 are in `unit`. `better` says which direction wins. Results are sorted best first. attempts counts every try, failed included; failed tries have no time. A null median means the provider does not support the test or every attempt failed.",
    providers: providers.map((p) => ({
      id: p.id,
      name: providerName(p.id),
      advertisedSize: { vcpu: advertised[p.id].vcpu, memoryGiB: advertised[p.id].memoryGiB, diskGiB: advertised[p.id].diskGiB, source: advertised[p.id].source },
      sizeNote: advertised[p.id].note,
      measuredSize: p.hardware ? { vcpu: p.hardware.vcpu, memoryGiB: round(p.hardware.memoryGiB), diskGiB: round(p.hardware.diskGiB) } : null,
      ranIn: p.hardware?.location[0]?.value ?? null,
      cpu: p.hardware?.cpuModels[0]?.value ?? null,
      price: { currency: p.currency, perHour: round(p.hourly), perVcpuHour: round(p.perVcpuHour), source: p.pricingSource },
      reliability: { attempts: p.reliability.successes + p.reliability.failures, failed: p.reliability.failures, successRateExcludingOurLimits: p.reliability.adjusted },
      failures: p.failureReasons,
      pauseSplit: p.pauseSplit,
    })),
    metrics: groups.flatMap((g) =>
      g.ids.map((id) => {
        const m = metric(id);
        return { id, group: g.title, label: m.label, unit: m.unit, better: m.better, results: results(m) };
      }),
    ),
  };
}

const cell = (v: number | null, m: Metric) => (v === null ? "n/a" : formatValue(v, m.unit));

/** The same results as Markdown tables, one per metric, best first. */
export function agentMarkdown() {
  const d = agentData();
  const lines = [
    "# Sandbox SDK bench results",
    "",
    d.about,
    "",
    `Run: ${d.run.start} to ${d.run.end}, ${d.run.timedOperations} timed operations. JSON: /results.json. Guide: /llms.txt.`,
    "",
    d.howToRead,
    "",
    "## Providers",
    "",
    "| Provider | Advertised size | Ran in | Price per hour | Success rate |",
    "| --- | --- | --- | --- | --- |",
    ...d.providers.map(
      (p) =>
        `| ${p.name} | ${p.advertisedSize.vcpu} vCPU, ${formatGiB(p.advertisedSize.memoryGiB)} RAM, ${p.advertisedSize.diskGiB === null ? "disk not stated" : `${formatGiB(p.advertisedSize.diskGiB)} disk`} | ${p.ranIn ?? "not reported"} | ${p.price.perHour === null ? "n/a" : `${p.price.currency} ${p.price.perHour}`} | ${p.reliability.successRateExcludingOurLimits === null ? "n/a" : `${(p.reliability.successRateExcludingOurLimits * 100).toFixed(2)}%`} |`,
    ),
    "",
    ...d.providers.flatMap((p) => (p.sizeNote ? [`Note on ${p.name}: ${p.sizeNote}`, ""] : [])),
  ];
  for (const g of groups) {
    lines.push(`## ${g.title}`, "");
    for (const id of g.ids) {
      const m = metric(id);
      lines.push(
        `### ${m.label}`,
        "",
        `Median ${unitName[m.unit]}, ${m.better} is better.`,
        "",
        "| Rank | Provider | Median | p95 | Attempts | Failed |",
        "| --- | --- | --- | --- | --- | --- |",
        ...results(m).map(
          (r, i) => `| ${r.median === null ? "-" : i + 1} | ${providerName(r.provider)} | ${cell(r.median, m)} | ${cell(r.p95, m)} | ${r.attempts} | ${r.failed} |`,
        ),
        "",
      );
    }
  }
  lines.push("## What failed", "");
  for (const p of d.providers) {
    lines.push(`- ${p.name}: ${p.failures.length === 0 ? "nothing failed." : p.failures.map((f) => `${f.count}x ${f.reason} (${f.kind}; ${f.tests.join(", ")})`).join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The llms.txt guide: what the site is and where agents find each piece. */
export function llmsTxt() {
  const d = agentData();
  return `# Sandbox SDK bench

> ${d.about}

Measured ${d.run.start.slice(0, 10)}. Providers: ${d.providers.map((p) => p.name).join(", ")}.

## Data

- [results.json](/results.json): every metric per provider (median, p95, attempts, failed), sizes, prices, regions and failure reasons. Start here.
- [results.md](/results.md): the same numbers as Markdown tables, one per metric, best first.

## How to read it

${d.howToRead}

Each provider ran its default sandbox size, so machine speed is not like for like. Every call starts in Florida, so providers hosted in Europe (Boat in France, boxd in Germany) pay a transatlantic round trip per call.

## Metrics

${groups.map((g) => `- ${g.title}: ${g.ids.map((id) => `${metric(id).label} (\`${id}\`)`).join(", ")}`).join("\n")}
`;
}
