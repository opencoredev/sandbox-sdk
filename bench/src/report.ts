import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Report } from "./model.js";

const fixed = (value: number | null) => (value === null ? "—" : value.toFixed(4));
const cell = (value: string) => value.replaceAll("|", "\\|").replaceAll("\n", " ");

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function markdown(report: Report): string {
  const rows = [
    "# Sandbox SDK provider benchmark",
    "",
    `SDK ${report.sdkVersion} · ${report.timestamp}`,
    `${report.machine.cpu} · ${report.machine.logicalCpus} logical CPUs · ${(report.machine.ramBytes / 1024 ** 3).toFixed(1)} GiB RAM · ${report.machine.os} · ${report.machine.arch} · ${report.machine.runtime}`,
    "",
    `Runs: ${report.config.runs}; warmups: ${report.config.warmup}; concurrency: ${report.config.concurrency}.`,
    "",
    "| Provider | Scenario | Unit | n | Fail | Skip | p50 | p95 | p99 | Mean | Min | Max |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const provider of report.providers) {
    if (provider.kind === "skipped") {
      rows.push(
        `| ${cell(provider.name)} | Skipped: ${cell(provider.note)} | | 0 | 0 | 1 | — | — | — | — | — | — |`,
      );
      continue;
    }

    for (const metric of provider.metrics)
      rows.push(
        `| ${cell(provider.name)} | ${metric.scenario} | ${metric.unit} | ${metric.stats.count} | ${metric.failures.length} | ${metric.skipped.length} | ${[metric.stats.p50, metric.stats.p95, metric.stats.p99, metric.stats.mean, metric.stats.min, metric.stats.max].map(fixed).join(" | ")} |`,
      );
  }

  rows.push("", "## Notes", "");

  for (const [key, value] of Object.entries(report.methodology)) rows.push(`- ${key}: ${value}`);

  for (const provider of report.providers)
    if (provider.kind === "measured") {
      rows.push(`- ${provider.name} region: ${provider.region ?? "unknown"}.`);

      for (const metric of provider.metrics)
        for (const message of new Set([...metric.skipped, ...metric.failures]))
          rows.push(`- ${provider.name}/${metric.scenario}: ${message}`);

      for (const message of [
        ...(provider.notes ?? []),
        ...provider.warmupFailures,
        ...provider.cleanupFailures,
      ])
        rows.push(`- ${provider.name}: ${message}`);
    }

  return rows.join("\n") + "\n";
}

/** Report direction: SDK amber on charcoal; system sans + monospace numbers.
 * A compact scientific report with p50 bars and p95 ticks, separate unit panels,
 * and no dependencies, hero artwork, decorative cards, or animation.
 */
export function html(report: Report): string {
  const measured = report.providers.filter((provider) => provider.kind === "measured");

  const sections = ["ms", "cpu-ms/call"]
    .map((unit) => {
      const rows = measured.flatMap((provider) =>
        provider.metrics
          .filter((metric) => metric.unit === unit && metric.stats.p50 !== null)
          .map((metric) => ({ name: `${provider.name} / ${metric.scenario}`, metric })),
      );

      const max = Math.max(0.000001, ...rows.map((row) => row.metric.stats.p95 ?? 0));

      return `<section><h2>${unit === "ms" ? "Wall latency (ms)" : "Process CPU (ms per call)"}</h2><p>p50 bars · p95 markers · independent scale per panel</p>${rows.map(({ name, metric }) => `<div class="row"><span>${escape(name)}</span><div class="track"><div class="bar" style="width:${Math.max(0, ((metric.stats.p50 ?? 0) / max) * 100)}%"></div><i style="left:${Math.max(0, ((metric.stats.p95 ?? 0) / max) * 100)}%"></i></div><code>${fixed(metric.stats.p50)} / ${fixed(metric.stats.p95)}</code></div>`).join("")}</section>`;
    })
    .join("");

  const notes = report.providers.flatMap((provider) =>
    provider.kind === "skipped"
      ? [`${provider.name}: ${provider.note}`]
      : [
          `${provider.name} region: ${provider.region ?? "unknown"}`,
          ...provider.metrics.flatMap((metric) =>
            [...new Set([...metric.failures, ...metric.skipped])].map(
              (message) => `${provider.name}/${metric.scenario}: ${message}`,
            ),
          ),
          ...(provider.notes ?? []),
          ...provider.warmupFailures,
          ...provider.cleanupFailures,
        ],
  );

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandbox SDK benchmark</title><style>
  :root{color-scheme:light dark}*{box-sizing:border-box}body{font:15px system-ui,sans-serif;color:var(--foreground,#e8e8ec);background:var(--background,#101115);margin:0;padding:32px;max-width:1200px}h1{font-size:28px;margin:0 0 12px}h2{font-size:20px}p{color:var(--muted-foreground,#aaaeb9);line-height:1.5}section{margin:32px 0}.row{display:grid;grid-template-columns:240px 1fr 190px;align-items:center;gap:16px;margin:18px 0;font-size:14px}.track{position:relative;height:18px;background:var(--muted,#292b32)}.bar{height:100%;background:var(--chart-1,#efa43b);min-width:2px}i{position:absolute;top:-3px;height:24px;width:2px;background:var(--foreground,#fff)}code{font-size:12px}details{margin-top:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.6}@media(max-width:650px){body{padding:18px}.row{grid-template-columns:1fr 140px;gap:8px}.track{grid-row:2;grid-column:1/-1}.row span{overflow-wrap:anywhere}h1{font-size:24px}}</style></head><body><h1>Sandbox SDK benchmark</h1><p>SDK ${escape(report.sdkVersion)} · ${escape(report.timestamp)}<br>${escape(report.machine.cpu)} · ${report.machine.logicalCpus} CPUs · ${(report.machine.ramBytes / 1024 ** 3).toFixed(1)} GiB · ${escape(report.machine.os)}<br>${report.config.runs} measured runs · ${report.config.warmup} warmups · concurrency ${report.config.concurrency}</p>${sections}<p>Memory is an offline fake. These results do not predict cloud performance. CPU uses mocked native calls and process-wide counters; negative overhead can occur from measurement noise.</p><ul>${notes.map((message) => `<li>${escape(message)}</li>`).join("")}</ul><details><summary>Full results and methodology</summary><pre>${escape(markdown(report))}</pre></details></body></html>`;
}

export async function writeReport(report: Report, directory: string) {
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(join(directory, "results.json"), JSON.stringify(report, null, 2) + "\n"),
    writeFile(join(directory, "results.md"), markdown(report)),
    writeFile(join(directory, "index.html"), html(report)),
  ]);
}
