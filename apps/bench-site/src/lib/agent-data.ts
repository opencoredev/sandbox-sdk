import { metric, providers, runWindow, runs, timedOperations } from "@/lib/data";
import type { Metric } from "@/lib/data";
import { formatGiB, formatMoney, formatPercent, formatValue } from "@/lib/format";
import { providerName } from "@/lib/providers";
import type { ProviderId } from "@/lib/providers";
import { advertised, sizeOf } from "@/lib/sizes";
import { eurUsd, usdPrice } from "@/lib/fx";
import { successRate } from "@/lib/status";

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

// Tests we chose not to run, with the reason; the same reasons appear on the page's footnotes.
export const notRun: Partial<Record<string, Partial<Record<ProviderId, string>>>> = {
  "burst-25": {
    daytona: "not-run: our Daytona account's concurrency limit refused the creates, on both attempts",
    boat: "not-run: our Boat plan allows 12 starts a minute",
  },
};

/** Why a result is blank, so an agent never has to guess. */
function statusOf(id: string, provider: ProviderId, v: Metric["values"][number] | undefined) {
  const skipped = notRun[id]?.[provider];
  if (skipped && (!v || v.n === 0)) return skipped;
  if (!v) return "unsupported";
  if (v.n > 0) return "measured";
  if (v.ourFailures > 0 && v.failures === 0) return "not-measured: our harness could not run this test on this provider";
  if (v.failures > 0 && v.limitFailures === v.failures) return "not-run: our account or plan limit";
  if (v.failures > 0) return "all-failed";
  return "unsupported";
}

const results = (m: Metric) =>
  providers
    .map((p) => {
      const v = m.values.find((x) => x.provider === p.id);
      return {
        provider: p.id,
        median: round(v?.p50 ?? null),
        p95: round(v?.p95 ?? null),
        ci95: v && v.ciLow !== null && v.ciHigh !== null ? [round(v.ciLow), round(v.ciHigh)] : null,
        attempts: v ? v.n + v.failures : 0,
        failed: v?.failures ?? 0,
        status: statusOf(m.id, p.id, v),
      };
    })
    .sort((a, b) =>
      a.median === null ? 1 : b.median === null ? -1 : (m.better === "lower" ? 1 : -1) * (a.median - b.median),
    );

/** Who wins each common question, straight from the data. */
export function quickPicks() {
  const best = (id: string) => {
    const m = metric(id);
    return results(m).filter((r) => r.median !== null).slice(0, 2);
  };
  const name = (id: ProviderId) => providerName(id);
  const timed = (id: string, label: string) => {
    const [a, b] = best(id);
    return { need: label, pick: a ? `${name(a.provider)} ${formatValue(a.median ?? 0, metric(id).unit)}` : "n/a", runnerUp: b ? `${name(b.provider)} ${formatValue(b.median ?? 0, metric(id).unit)}` : "n/a" };
  };
  const cheapest = providers
    .flatMap((p) => {
      const price = usdPrice(p, "hourly");
      return price ? [{ p, usd: price.usd }] : [];
    })
    .sort((a, b) => a.usd - b.usd);
  const reliable = providers.map((p) => ({ p, rate: successRate(p).rate ?? 0 })).sort((a, b) => b.rate - a.rate);
  const biggest = providers
    .map((p) => ({ p, s: sizeOf(p) }))
    .sort((a, b) => (b.s.vcpu ?? 0) - (a.s.vcpu ?? 0) || (b.s.memoryGiB ?? 0) - (a.s.memoryGiB ?? 0));
  const pair = <T,>(xs: T[], f: (x: T) => string) => ({ pick: xs[0] ? f(xs[0]) : "n/a", runnerUp: xs[1] ? f(xs[1]) : "n/a" });
  return [
    timed("cold", "Fastest cold start"),
    timed("tool-replay", "Fastest agent work (tool replay)"),
    timed("burst-25", "Fastest 25-sandbox fan-out"),
    timed("reconnect", "Fastest reconnect"),
    { need: "Cheapest hour", ...pair(cheapest, (x) => `${name(x.p.id)} ${formatMoney(x.usd, "USD")}`) },
    (() => {
      // Several providers can share the top rate; name every one of them.
      const top = reliable.filter((x) => x.rate === reliable[0]?.rate);
      const rest = reliable.slice(top.length);
      return {
        need: "Most reliable",
        pick: `${top.map((x) => name(x.p.id)).join(", ")} ${formatPercent(top[0]?.rate ?? 0, 2)}${top.length > 1 ? " (tied)" : ""}`,
        runnerUp: rest[0] ? `${name(rest[0].p.id)} ${formatPercent(rest[0].rate, 2)}` : "n/a",
      };
    })(),
    { need: "Biggest default machine", ...pair(biggest, (x) => `${name(x.p.id)} ${x.s.vcpu ?? "?"} vCPU / ${formatGiB(x.s.memoryGiB ?? 0)}`) },
  ];
}

/** Everything on the page as one JSON document, for agents and scripts. */
export function agentData() {
  return {
    about:
      "Sandbox bench: cloud sandbox providers for AI agents, timed through one SDK (Sandbox SDK, built by us, to be published soon) from one server in Florida, US. Medians, p95s and 95% confidence intervals per provider; every provider-side failure kept, failures caused by our own code set aside.",
    run: { start: runWindow.start, end: runWindow.end, runs: runs.map((r) => r.id), observations: timedOperations },
    howToRead:
      "median and p95 are in `unit`. `better` says which direction wins. Results are sorted best first. attempts counts every try, failed included; failed tries have no time. A null median means the provider does not support the test or every attempt failed. size is what the provider advertises for its default sandbox, or what we measured inside where it does not say. reliability.successRate counts every attempt on the site's tests, whatever made it fail.",
    providers: providers.map((p) => {
      const rel = successRate(p);
      return {
        id: p.id,
        name: providerName(p.id),
        size: { ...sizeOf(p), advertisedSource: advertised[p.id].source },
        sizeNote: advertised[p.id].note,
        measuredSize: p.hardware ? { vcpu: p.hardware.vcpu, memoryGiB: round(p.hardware.memoryGiB), diskGiB: round(p.hardware.diskGiB) } : null,
        ranIn: p.hardware?.location[0]?.value ?? null,
        cpu: p.hardware?.cpuModels[0]?.value ?? null,
        price: {
          currency: p.currency,
          perHour: round(p.hourly),
          perVcpuHour: round(p.perVcpuHour),
          perHourUsd: round(usdPrice(p, "hourly")?.usd ?? null),
          usdNote: p.currency === "EUR" ? `Converted at the ECB rate of ${eurUsd.rate} USD per EUR on ${eurUsd.date}.` : null,
          source: p.pricingSource,
        },
        reliability: { attempts: rel.attempts, succeeded: rel.succeeded, successRate: round(rel.rate) },
        failures: p.failureReasons,
        setAsideAsOurs: p.ourFailures,
        pauseSplit: p.pauseSplit,
      };
    }),
    quickPicks: quickPicks(),
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
    "# Sandbox bench results",
    "",
    d.about,
    "",
    `Run: ${d.run.start.slice(0, 10)} to ${d.run.end.slice(0, 10)}, from one server in Florida, US. JSON: /results.json. Guide: /llms.txt.`,
    "",
    d.howToRead,
    "",
    "## Quick picks",
    "",
    "| Need | Pick | Runner-up |",
    "| --- | --- | --- |",
    ...d.quickPicks.map((q) => `| ${q.need} | ${q.pick} | ${q.runnerUp} |`),
    "",
    "## Providers",
    "",
    "| Provider | Default size | Ran in | Price per hour | Success rate |",
    "| --- | --- | --- | --- | --- |",
    ...d.providers.map(
      (p) =>
        `| ${p.name} | ${p.size.vcpu ?? "?"} vCPU, ${p.size.memoryGiB === null ? "?" : formatGiB(p.size.memoryGiB)} RAM, ${p.size.diskGiB === null ? "?" : formatGiB(p.size.diskGiB)} disk | ${p.ranIn ?? "not reported"} | ${p.price.perHourUsd === null ? "n/a" : `$${p.price.perHourUsd}${p.price.currency === "EUR" ? ` (EUR ${p.price.perHour})` : ""}`} | ${p.reliability.successRate === null ? "n/a" : `${(p.reliability.successRate * 100).toFixed(2)}%`} |`,
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
        `Median and p95, ${m.better} is better. Each cell carries its unit.`,
        "",
        "| Rank | Provider | Median | p95 | Attempts | Failed | Status |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...results(m).map(
          (r, i) => `| ${r.median === null ? "-" : i + 1} | ${providerName(r.provider)} | ${cell(r.median, m)} | ${cell(r.p95, m)} | ${r.attempts} | ${r.failed} | ${r.status} |`,
        ),
        "",
      );
    }
  }
  lines.push("## What failed", "");
  for (const p of d.providers) {
    lines.push(`- ${p.name}: ${p.failures.length === 0 ? "nothing failed." : p.failures.map((f) => `${f.reason}: ${f.runs} runs, ${f.count} failed tests (${f.kind}; ${f.tests.join(", ")})`).join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The llms.txt guide: what the site is and where agents find each piece. */
export function llmsTxt() {
  const d = agentData();
  return `# Sandbox bench

> ${d.about}

Measured ${d.run.start.slice(0, 10)} to ${d.run.end.slice(0, 10)}. Providers (id → name): ${d.providers.map((p) => `${p.id} → ${p.name}`).join(", ")}.

## Quick picks

${d.quickPicks.map((q) => `- ${q.need}: ${q.pick} (runner-up ${q.runnerUp})`).join("\n")}

## Data

- [results.json](/results.json): every metric per provider (median, p95, attempts, failed), sizes, prices, regions and failure reasons. Start here.
- [results.md](/results.md): the same numbers as Markdown tables, one per metric, best first.

## How to read it

${d.howToRead}

Each provider ran its default sandbox size, so machine speed is not like for like. Prices are USD list prices for that size; boxd is converted from EUR at the ECB rate. Every call starts in Florida, so providers hosted in Europe (Boat in France, boxd in Germany) pay a transatlantic round trip per call.

## Metrics

${groups.map((g) => `- ${g.title}: ${g.ids.map((id) => `${metric(id).label} (\`${id}\`)`).join(", ")}`).join("\n")}
`;
}
