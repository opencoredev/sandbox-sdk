import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReportV2 } from "./v2-model.js";
import { projectCosts } from "./projection.js";
import { headroom } from "./publication.js";
import { pricing } from "./pricing.js";
const f = (v: number | null) => (v === null ? "unknown" : v.toPrecision(5));
const esc = (v: string) =>
  v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function clientHeadroomRows(r: ReportV2) {
  const mean = (xs: (number | null)[]) => { const ns = xs.filter((n) => n !== null); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null; };
  return r.providers.map((p) => {
    const values = r.samples.filter((s) => s.provider === p.name).map((s) => headroom(s.hostBefore, s.hostAfter));
    return { provider: p.name, count: values.length, flagged: values.filter((v) => v.highLoad).length,
      busy: mean(values.map((v) => v.hostCpuBusy)), maxLoad: values.length ? Math.max(...values.map((v) => v.normalizedLoad)) : null,
      rx: mean(values.map((v) => v.rxBytesPerSecond)), tx: mean(values.map((v) => v.txBytesPerSecond)) };
  });
}
export function markdownV2(r: ReportV2) {
  const rows = [
    `# Sandbox provider benchmark ${r.runId}`,
    "",
    `Schema v2 · ${r.timestamp} · seed ${r.config.seed} · track ${r.config.track}`,
    ...r.providers.map(p => `Allocation ${p.name}: requested ${JSON.stringify(p.requestedSize ?? null)}; template ${p.template ?? "default"}`),
    `Collection: ${r.timestamp} through ${r.finishedAt || "in progress"}`,
    `Host: ${r.host.cpu}; ${r.host.os}; ${r.host.runtime}`,
    `Metadata: ${JSON.stringify(r.metadata)}`,
    ...r.providers.map((p) => `Configured region ${p.name}: ${p.configuredRegion ?? "unspecified"}`),
    "",
    `cleanupReview: ${JSON.stringify(r.cleanupReview ?? [])}`,
    `cleanupReleased: ${JSON.stringify(r.cleanupReleased ?? [])}`,
    "",
    `admissionStopped: ${JSON.stringify(r.admissionStopped ?? [])}`,
    "",
    "Estimates exclude credits, subscriptions and some storage/transfer charges. Local is a reference baseline.",
    "",
    "| Provider | Scenario | Unit | n | Fail | Blocked | Skip | p50 [95% CI] | p95 | p99 | Mean [95% CI] | Min | Max | SD | Success [Wilson CI] | Est. cost |",
    "|---|---|---|---:|---:|---:|---:|---|---:|---:|---|---:|---:|---:|---|---:|",
  ];
  for (const s of r.summaries) {
    const ci = (c: { low: number; high: number } | null) =>
      c ? `[${f(c.low)}, ${f(c.high)}]` : "[unknown]";
    rows.push(
      `|${s.provider}|${s.scenario}|${s.unit}|${s.stats.count}|${s.failures}|${s.blocked}|${s.skipped}|${f(s.stats.p50)} ${ci(s.stats.p50CI)}|${f(s.stats.p95)}|${f(s.stats.p99)}|${f(s.stats.mean)} ${ci(s.stats.meanCI)}|${f(s.stats.min)}|${f(s.stats.max)}|${f(s.stats.stddev)}|${s.success ? `${(s.success.rate * 100).toFixed(1)}% ${ci(s.success)}` : "unknown"}|${f(s.estimatedCost)} ${pricing[s.provider]?.currency ?? ""}|`,
    );
  }
  rows.push(
    "",
    "## Hardware",
    "",
    "| Provider | CPU | nproc | quota | RAM GiB | Disk GiB | Kernel | Egress |",
    "|---|---|---:|---:|---:|---:|---|---|",
  );
  for (const p of r.providers) {
    const fingerprints = r.samples
      .filter((s) => s.provider === p.name && s.scenario === "fingerprint" && s.fingerprint)
      .map((s) => s.fingerprint);
    const seen = new Set<string>();
    for (const h of fingerprints) {
      if (!h) continue;
      const key = JSON.stringify(h);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(
        `|${p.name}|${h.cpuModel}|${h.nproc}|${h.quotaCpus ?? "unlimited"}|${f(h.memoryBytes / 1024 ** 3)}|${f(h.diskBytes / 1024 ** 3)}|${h.kernel}|${JSON.stringify(h.egress)}|`,
      );
    }
  }
  rows.push(
    "",
    "## Estimated cost",
    "",
    "| Provider | Currency | Lifecycle observed total | per 1000 sandbox lifetimes | Source and retrieval date | Caveats |",
    "|---|---|---:|---:|---|---|",
  );
  for (const p of r.providers) {
    const price = pricing[p.name],
      life = r.summaries.find((s) => s.provider === p.name && s.scenario === "sandbox-lifetime");
    rows.push(
      `|${p.name}|${price?.currency ?? "unknown"}|${f(life?.estimatedCost ?? null)}|${f(life?.per1000 ?? null)}|${price?.source ?? "unavailable"} (${price?.retrieved ?? "unknown"})|${price?.notes ?? p.note}|`,
    );
  }
  rows.push(
    "",
    "## Full-run planning estimates",
    "",
    "100 lifecycle/command/files/fingerprint/performance iterations; 30 of each workload; K=10 and K=25 with the configured number of burst cohorts. These are extrapolations, not quotes. Unsupported work is excluded. Larger cohorts require account capacity.",
    "",
    "| Provider | Currency | Normal 100 (including restore overlap) | Each workload 30 | Burst 10 | Burst 25 | Total |",
    "|---|---|---:|---:|---:|---:|---:|",
  );
  for (const p of projectCosts(r))
    rows.push(
      `|${p.provider}|${p.currency}|${f(p.normal100)}|${f(p.eachWorkload30)}|${f(p.burst10)}|${f(p.burst25)}|${f(p.total)}|`,
    );
  rows.push("", "## Client headroom", "", "Host CPU/load/network describe the harness host during each sample. High-load flag: normalized load >=1 or host busy fraction >=0.90. Network includes all host traffic; overlapping samples are not additive.", "", "| Provider | Samples flagged / total | Mean host CPU busy | Max normalized load | Mean RX B/s | Mean TX B/s |", "|---|---:|---:|---:|---:|---:|");
  for (const v of clientHeadroomRows(r))
    rows.push(`|${v.provider}|${v.flagged}/${v.count}|${f(v.busy)}|${f(v.maxLoad)}|${f(v.rx)}|${f(v.tx)}|`);
  rows.push("", "Flagged samples:", ...r.samples.filter((s) => headroom(s.hostBefore, s.hostAfter).highLoad).map((s) => `- ${s.provider}/${s.scenario} iteration ${s.iteration} at ${s.startedAt}: high host load`));
  rows.push("", "## Run notes", "");
  for (const p of r.providers) rows.push(`- ${p.name}: ${p.note}`);
  for (const [provider, b] of Object.entries(r.budgets))
    rows.push(
      `- ${provider}: ${b.created} sandbox attempts, estimated budget USD ${f(b.estimatedUSD)}; ${b.stop ?? "budget not hit"}.`,
    );
  for (const c of r.cleanup)
    rows.push(
      `- Cleanup ${c.provider}: ${c.remaining.length} remaining; ${c.error ?? "label listing verified"}.`,
    );
  for (const s of r.samples)
    if (s.outcome.kind !== "sample")
      rows.push(
        `- ${s.provider}/${s.scenario} ${s.outcome.kind}: ${s.outcome.note.replaceAll("\n", " ").replaceAll("|", "\\|")}`,
      );
  rows.push("", "## Methodology", "", ...r.methodology.map((s) => `- ${s}`));
  return rows.join("\n") + "\n";
}
/** Reference: scientific dot plots, existing charcoal/amber SDK report. Palette #101115/#e8e8ec/#efa43b.
 * System UI with tabular monospace values; stacked scenario panels; raw dots plus p50/bootstrap CI.
 * Avoid decorative cards, shared scales across units, and animation. */
export function htmlV2(r: ReportV2) {
  const panels = [...new Set(r.summaries.map((s) => s.scenario))]
    .map((scenario) => {
      const sums = r.summaries.filter((s) => s.scenario === scenario),
        max = Math.max(1, ...sums.map((s) => s.stats.max ?? 0));
      return `<section><h2>${esc(scenario)} <small>${esc(sums[0]?.unit ?? "")}</small></h2><p>Raw observations · ● p50 · line: bootstrap 95% CI. Failures are listed below.</p>${sums
        .map((s) => {
          const raw = r.samples
            .filter((v) => v.provider === s.provider && v.scenario === scenario)
            .flatMap((v) => (v.outcome.kind === "sample" ? [v.outcome.value] : []));
          const ci = s.stats.p50CI;
          return `<div class="plotrow"><strong>${esc(s.provider)}</strong><svg viewBox="0 0 600 36" role="img" aria-label="${esc(s.provider)} median ${f(s.stats.p50)}, ${s.failures} failures"><line x1="0" y1="18" x2="600" y2="18" stroke="#54565f"/>${raw.map((v, i) => `<circle cx="${(v / max) * 590 + 5}" cy="${10 + (i % 4) * 5}" r="2" fill="#aaaeb9"><title>${v}</title></circle>`).join("")}${ci ? `<line x1="${(ci.low / max) * 590 + 5}" x2="${(ci.high / max) * 590 + 5}" y1="18" y2="18" stroke="#efa43b" stroke-width="4"/>` : ""}${s.stats.p50 !== null ? `<circle cx="${(s.stats.p50 / max) * 590 + 5}" cy="18" r="5" fill="#efa43b"/>` : ""}</svg><span>${f(s.stats.p50)} · ${s.stats.count} OK / ${s.failures} fail / ${s.blocked} blocked / ${s.skipped} skip</span></div>`;
        })
        .join("")}<div class="scale">0 <span>${f(max)}</span></div></section>`;
    })
    .join("");
  const perf = r.summaries.filter(
    (s) => s.scenario === "cpu-single" && s.performancePerDollar !== null,
  );
  const max = Math.max(1, ...perf.map((s) => s.performancePerDollar ?? 0));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Benchmark ${esc(r.runId)}</title><style>*{box-sizing:border-box}body{margin:0 auto;padding:32px;max-width:1300px;background:#101115;color:#e8e8ec;font:15px system-ui;line-height:1.5}h1{font-size:28px}h2{font-size:20px}small,p{color:#b9bcc5}section{border-top:1px solid #54565f;margin-top:32px;padding-top:16px}.plotrow{display:grid;grid-template-columns:100px minmax(100px,1fr) 280px;gap:16px;align-items:center;margin:12px 0}svg{width:100%;height:36px}span,pre{font-variant-numeric:tabular-nums}.scale{margin:0 296px 0 116px;display:flex;justify-content:space-between;color:#b9bcc5}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.7 ui-monospace,monospace}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}th:first-child,td:first-child{white-space:nowrap}th,td{padding:10px;border-bottom:1px solid #54565f;text-align:left;overflow-wrap:anywhere}a{color:#efa43b}@media(max-width:650px){body{padding:16px}.plotrow{grid-template-columns:1fr}.plotrow svg{grid-row:auto}.scale{margin:0}table{font-size:12px}}</style></head><body><h1>Sandbox provider benchmark</h1><p>${esc(r.runId)} · ${esc(r.timestamp)} · seed ${r.config.seed}<br>${esc(r.host.cpu)}<br>Local: Docker reference baseline. Costs are estimates. No provider ranking combines different units.</p><h2>Hardware summary</h2><div class="table-scroll"><table><tr><th>Provider</th><th>Configured region</th><th>CPU models</th><th>vCPU quota / nproc</th><th>RAM GiB</th></tr>${r.providers
    .map((p) => {
      const hs = r.samples
        .filter((s) => s.provider === p.name && s.scenario === "fingerprint")
        .flatMap((s) => (s.fingerprint ? [s.fingerprint] : []));
      return `<tr><td>${esc(p.name)}</td><td>${esc(p.configuredRegion ?? "unspecified")}</td><td>${esc([...new Set(hs.map((h) => h.cpuModel))].join("; ") || p.note)}</td><td>${esc([...new Set(hs.map((h) => `${h.quotaCpus ?? "unlimited"} / ${h.nproc}`))].join("; "))}</td><td>${esc([...new Set(hs.map((h) => f(h.memoryBytes / 1024 ** 3)))].join("; "))}</td></tr>`;
    })
    .join(
      "",
    )}</table></div><h2>Cost estimates</h2><div class="table-scroll"><table><tr><th>Provider</th><th>Lifetime total</th><th>1000 runs</th><th>Official rate source</th></tr>${r.providers
    .map((p) => {
      const s = r.summaries.find((s) => s.provider === p.name && s.scenario === "sandbox-lifetime"),
        price = pricing[p.name];
      return `<tr><td>${esc(p.name)}</td><td>${f(s?.estimatedCost ?? null)} ${price?.currency ?? ""}</td><td>${f(s?.per1000 ?? null)}</td><td>${price ? `<a href="${esc(price.source)}">${esc(price.source)}</a><br>Retrieved ${esc(price.retrieved)}` : "unknown"}</td></tr>`;
    })
    .join(
      "",
    )}</table></div><section><h2>Single-thread iterations per estimated ${"currency unit"}</h2><p>Throughput divided by estimated allocation cost per second. Zero-cost local baseline is excluded. EUR and USD are separate currencies and must not be ranked together.</p>${perf.map((s) => `<p>${esc(s.provider)} (${pricing[s.provider]?.currency}) · ${f(s.performancePerDollar)}<svg viewBox="0 0 600 20"><rect width="${((s.performancePerDollar ?? 0) / max) * 600}" height="16" fill="#efa43b"/></svg></p>`).join("") || "<p>No costed performance observations.</p>"}</section>${panels}<section><h2>Client headroom and collection metadata</h2><p>High-load flag: load1 / logical CPUs ≥ 1 or sampled host CPU busy ≥ 90%. Very short windows can be noisy. Host counters include unrelated traffic and overlap; do not sum them as provider-attributable usage.</p><div class="table-scroll"><table><tr><th>Provider</th><th>Flagged / total</th><th>Host CPU busy</th><th>Max normalized load</th><th>Mean RX B/s</th><th>Mean TX B/s</th></tr>${clientHeadroomRows(r).map((v) => `<tr><td>${esc(v.provider)}</td><td>${v.flagged} / ${v.count}</td><td>${v.busy === null ? "unknown" : (v.busy * 100).toFixed(1) + "%"}</td><td>${f(v.maxLoad)}</td><td>${f(v.rx)}</td><td>${f(v.tx)}</td></tr>`).join("")}</table></div><details><summary>Flagged samples</summary><ul>${r.samples.filter((s) => headroom(s.hostBefore, s.hostAfter).highLoad).map((s) => `<li>${esc(s.provider)}/${esc(s.scenario)} · iteration ${s.iteration} · ${esc(s.startedAt)}</li>`).join("")}</ul></details><p>Collection ${esc(r.timestamp)} through ${esc(r.finishedAt || "in progress")}</p><pre>${esc(JSON.stringify(r.metadata, null, 2))}</pre></section><section><h2>Methodology, raw hardware, failures and limitations</h2><pre>${esc(markdownV2(r))}</pre></section></body></html>`;
}
export async function writeV2(r: ReportV2, out: string) {
  await mkdir(out, { recursive: true });
  await Promise.all([
    writeFile(
      join(out, "results.json"),
      JSON.stringify({ ...r, pricing, projection: projectCosts(r) }, null, 2) + "\n",
    ),
    writeFile(join(out, "results.md"), markdownV2(r)),
    writeFile(join(out, "index.html"), htmlV2(r)),
  ]);
}
