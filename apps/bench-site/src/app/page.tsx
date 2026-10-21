import type { ReactNode } from "react";

import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { Lockup } from "@/components/brand";
import { MachineSizes } from "@/components/machine-sizes";
import { PauseChart, PausePart } from "@/components/pause-chart";
import { ProviderStrip } from "@/components/provider-strip";
import { SectionNav } from "@/components/section-nav";
import { Reliability } from "@/components/reliability";
import { ChartHead, Footnotes, MetricChart, Who, metricSubtitle } from "@/components/metric-chart";
import type { Notes } from "@/components/metric-chart";
import { Ridgelines } from "@/components/ridgelines";
import { Scatter } from "@/components/scatter";
import type { ScatterPoint } from "@/components/scatter";
import { SpecSheet } from "@/components/spec-sheet";
import { Card, TabCard } from "@/components/tabs";
import type { Tab } from "@/components/tabs";
import { coldSamples, metric, provider, providers, runWindow, runs, timedOperations } from "@/lib/data";
import type { Provider } from "@/lib/data";
import { formatCount, formatGiB, formatMoney } from "@/lib/format";
import { providerColor } from "@/lib/providers";
import { advertised, sizeOf } from "@/lib/sizes";
import { conversionNote, usdPrice } from "@/lib/fx";
import type { PriceKey } from "@/lib/fx";
import type { ProviderId } from "@/lib/providers";

// Reference: Artificial Analysis for structure (short header, three headline
// charts, then one bordered card per topic with a tab band, every chart titled
// with what it measures and which way is better, an attractive-quadrant
// scatter). scrapingbench and dithercn for the look (black page, one hue per
// provider, dithered fills with a solid cap).
// Palette: page oklch(0.13 0 0), cards oklch(0.16 0 0), ink oklch(0.96 0 0),
// muted oklch(0.7 0 0), one fixed colour per provider, red only for failures.
// Type: Geist Pixel for page and section titles, Geist Sans for labels, Geist Mono for numbers.
// Signature: vertical dithered columns, densest at the top, value printed above.
// Avoiding: intro paragraphs, overall scores, winner badges, a heavy filled quadrant.

const sections = [
  ["startup", "Start-up"],
  ["agent", "Agent work"],
  ["everyday", "Everyday calls"],
  ["state", "Snapshots"],
  ["scale", "Bursts"],
  ["machines", "Machines"],
  ["reliability", "Reliability"],
  ["cost", "Cost"],
  ["method", "Method"],
] as const;

const start = new Date(runWindow.start);
const end = new Date(runWindow.end);
const longDate = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const sameDay = start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10);
/** "October 19, 2026", or "October 19, 2026, completed October 21" when top-up runs finished later. */
const day = sameDay
  ? longDate(start)
  : `${longDate(start)}, completed ${end.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}`;

/** The advertised default size, as people know it: "4 vCPU, 8 GB RAM". */
const size = (p: Provider | undefined) =>
  p ? `${sizeOf(p).vcpu ?? "?"} vCPU, ${formatGiB(sizeOf(p).memoryGiB ?? 0)} RAM` : "size not reported";

function Section({ id, title, lede, children }: { id: string; title: string; lede: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 pt-16 sm:pt-24">
      <h2 id={`${id}-title`} className="flex items-center gap-3 font-pixel text-[28px] leading-none tracking-tight sm:text-[34px]">
        <span aria-hidden className="size-3.5 shrink-0 bg-[var(--foreground)]" />
        {title}
      </h2>
      <p className="mt-3 mb-6 max-w-[72ch] text-[14px] leading-relaxed text-[var(--muted)]">{lede}</p>
      {children}
    </section>
  );
}

/** One tab per metric, each a column chart with its own subtitle and notes. */
const metricTabs = (items: readonly { id: string; what: string; tab?: string; notes?: Notes; only?: readonly ProviderId[] }[]): Tab[] =>
  items.map(({ id, what, tab, notes, only }) => {
    const m = metric(id);
    return { id, label: tab ?? m.label, content: <MetricChart metric={m} what={what} notes={notes} only={only} /> };
  });

const per = (k: PriceKey) => (k === "hourly" ? "an hour" : "per vCPU-hour");

/** Dollar prices as columns, cheapest first. Euro prices are converted and marked with a footnote. */
function priceColumns(key: PriceKey) {
  const priced = providers.flatMap((p) => {
    const price = usdPrice(p, key);
    return price ? [{ p, ...price }] : [];
  });
  const columns: Column[] = priced
    .sort((a, b) => a.usd - b.usd)
    .map(({ p, usd, converted, original }) => ({
      provider: p.id,
      label: formatMoney(usd, "USD"),
      mark: converted ? 1 : undefined,
      segments: [{ value: usd, color: providerColor(p.id), variant: "gradient" }],
      detail: [`${formatMoney(usd, "USD")} ${per(key)}${converted ? ` (${original})` : ""}`, size(p)],
    }));
  return { columns, converted: priced.filter((x) => x.converted) };
}

function PriceChart({ k, title, what }: { k: PriceKey; title: string; what: string }) {
  const { columns, converted } = priceColumns(k);
  return (
    <>
      <ChartHead title={title} sub={`${what} · US dollars · Lower is better`} />
      <Columns columns={columns} label={title} />
      <Footnotes
        items={[
          ...converted.map(({ p, original }) => ({ mark: 1, text: <><Who id={p.id} /> {conversionNote(original, per(k))}</> })),
          { text: "List-price estimates for the size each provider gave us, not invoices. Boat is a flat rate. Upstash and boxd are upper bounds: they bill for less than the full allocation." },
        ]}
      />
    </>
  );
}

// The machine probe runs under Python multiprocessing; Superserve's VMs have no /dev/shm for its locks.
const machineNotes: Notes = {
  superserve: "every attempt failed: the VM has no /dev/shm, so Python's multiprocessing could not create a lock",
};

/** A note for each provider whose bursts did not all finish, counted from the data. */
function partialBursts(id: string): Notes {
  return Object.fromEntries(
    metric(id).values.flatMap((v) => {
      if (v.n === 0 || v.failures === 0) return [];
      const limits = v.limitFailures === v.failures ? "hit our plan's start limit" : `failed, ${v.limitFailures} on our plan's start limit`;
      const these = v.n === 1 ? "This is that one burst." : `These are those ${v.n}.`;
      return [[v.provider, `only ${v.n} of ${v.n + v.failures} bursts finished; the other ${v.failures} ${limits}. ${these}`]];
    }),
  );
}

function Headline({ marker, title, sub, children }: { marker: string; title: string; sub: string; children: ReactNode }) {
  return (
    <Card className="min-w-0 !p-5">
      <h2 className="flex items-center gap-2.5 font-pixel text-[21px] leading-none tracking-tight">
        <span aria-hidden className="size-3 shrink-0" style={{ backgroundColor: marker }} />
        {title}
      </h2>
      <p className="mt-2 mb-3 text-[12px] text-[var(--muted)]">{sub}</p>
      {children}
    </Card>
  );
}

export default function Page() {
  const cold = metric("cold");
  const replay = metric("tool-replay");
  const boxd = provider("boxd");
  const coldP50 = (id: ProviderId) => cold.values.find((v) => v.provider === id)?.p50 ?? null;
  const scatterPoints: ScatterPoint[] = providers.flatMap((p) => {
    const x = coldP50(p.id);
    const price = usdPrice(p, "hourly");
    return x !== null && price ? [{ provider: p.id, x, y: price.usd, currency: "USD" }] : [];
  });
  const boxdHour = boxd ? usdPrice(boxd, "hourly") : null;
  const boat = provider("boat");
  const daytona = provider("daytona");

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[var(--background)]/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-4 py-3 sm:px-6">
          <a href="#top" className="shrink-0" aria-label="Sandbox bench, back to top">
            <Lockup />
          </a>
          <SectionNav sections={sections} />
          <a
            href="llms.txt"
            className="hidden shrink-0 rounded-full border border-[var(--line)] px-3.5 py-1.5 text-[13px] text-[var(--muted)] transition-colors duration-150 hover:text-[var(--foreground)] motion-reduce:transition-none md:block"
          >
            For agents ↗
          </a>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <div className="grid gap-10 pt-14 pb-12 sm:pt-20 lg:grid-cols-[1fr_360px] lg:items-end">
          <div>
            <h1 className="font-pixel text-[44px] leading-[0.95] tracking-tight sm:text-[72px]">
              Cloud sandboxes,
              <br />
              measured
            </h1>
            <p className="mt-5 max-w-[46ch] text-[16px] leading-snug">
              {providers.length} sandbox providers through one open-source SDK, under the same conditions.
            </p>
          </div>
          <dl className="divide-y divide-[var(--line)] border-y border-[var(--line)] text-[14px]">
            {[
              ["Run", day],
              ["From", "One server in Florida, US. Providers took turns."],
              ["Data", `${formatCount(timedOperations)} timed operations. Every failure kept.`],
            ].map(([term, value]) => (
              <div key={term} className="grid grid-cols-[4rem_1fr] gap-3 py-3">
                <dt className="text-[12px] text-[var(--muted)]">{term}</dt>
                <dd className="leading-snug">{value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Headline marker="var(--dither-color-blue)" title="Cold start" sub={metricSubtitle(cold, "create() to first command")}>
            <MetricChart metric={cold} what="" compact />
          </Headline>
          <Headline marker="var(--dither-color-orange)" title="Agent work" sub={metricSubtitle(replay, "100 agent tool calls")}>
            <MetricChart metric={replay} what="" compact />
          </Headline>
          <Headline marker="var(--dither-color-green)" title="Price per hour" sub="Default sandbox, list price · US dollars · Lower is better">
            <Columns columns={priceColumns("hourly").columns} label="Price per sandbox-hour" compact />
            {boxdHour?.converted ? <p className="mt-1 text-[11px] text-[var(--muted)]"><sup>1</sup> boxd bills in euros; converted at the ECB rate.</p> : null}
          </Headline>
        </div>

        <div className="mt-4">
          <ProviderStrip providers={providers} />
        </div>

        <Section id="startup" title="Start-up" lede="Cold start is the wait before an agent can do anything: from create() until the first command returns.">
          <TabCard
            label="Start-up"
            tabs={[
              ...metricTabs([{ id: "cold", what: "create() to first command", tab: "Cold start" }]),
              {
                id: "cold-vs-price",
                label: "Cold start vs price",
                content: (
                  <>
                    <ChartHead
                      title="Cold start vs price"
                      sub="Median cold start against list price per sandbox-hour · Both lower is better"
                    />
                    <Scatter
                      points={scatterPoints}
                      xTicks={[2, 3, 5, 10, 20]}
                      yTicks={[0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]}
                      xTitle="Median cold start, seconds (log scale)"
                      yTitle="Price per sandbox-hour (USD)"
                    />
                    {boxdHour?.converted ? (
                      <Footnotes items={[{ text: <><Who id="boxd" /> {conversionNote(boxdHour.original, "an hour")}</> }]} />
                    ) : null}
                  </>
                ),
              },
              {
                id: "cold-all",
                label: "Every cold start",
                content: (
                  <>
                    <ChartHead title="Every cold start" sub="Each successful cold start, one ridge per provider · Log scale · Further left is faster" />
                    <Ridgelines samples={coldSamples} />
                  </>
                ),
              },
            ]}
          />
        </Section>

        <Section
          id="agent"
          title="Agent work"
          lede={
            <>
              Real coding-agent tasks. They depend on the sandbox&apos;s CPU, disk and network as much as on the API. Every call starts in Florida, so{" "}
              <Who id="boat" /> (France) and <Who id="boxd" /> (Germany) pay an ocean crossing on each one.
            </>
          }
        >
          <TabCard
            label="Agent work"
            tabs={metricTabs([
              { id: "tool-replay", tab: "Tool replay", what: "100 tool calls in a row: write, read, edit, list, grep, run a test" },
              { id: "npm-install", what: "npm ci for a small Vite and React app" },
              { id: "pip-install", what: "requests and numpy from PyPI" },
              { id: "git-clone", what: "Shallow clone of a small pinned repo" },
              { id: "dev-server", what: "Start Vite and wait until it is ready" },
              { id: "preview-first-byte", tab: "Preview URL", what: "Fetch the dev server through the public preview URL" },
              { id: "edit-loop", tab: "Edit loop", what: "Edit a file, rebuild, fetch the page again" },
            ])}
          />
        </Section>

        <Section id="everyday" title="Everyday calls" lede="What an agent does hundreds of times per task: run a command, move files, reattach to a sandbox.">
          <TabCard
            label="Everyday calls"
            tabs={metricTabs([
              { id: "command", what: "A no-op command, mostly network and API overhead" },
              { id: "files-1kb", tab: "1 KB file", what: "Write a 1 KB file and read it back" },
              {
                id: "files-10mb",
                tab: "10 MB file",
                what: "Write a 10 MB file and read it back",
                notes: {
                  boxd: "its download cut large files short, so the SDK reads in chunks. This measures that workaround.",
                  boat: "the read uses Boat's signed download URL.",
                },
              },
              { id: "reconnect", what: "Attach to an existing sandbox by ID and run a command" },
              { id: "destroy", what: "Delete the sandbox and wait for confirmation" },
            ])}
          />
        </Section>

        <Section id="state" title="Pause and snapshots" lede="Pausing stops paying for idle time while an agent waits on a human. Snapshots start many sandboxes from one prepared state.">
          <TabCard
            label="Pause and snapshots"
            tabs={[
              { id: "pause-resume", label: "Pause + resume", content: <PauseChart /> },
              ...(providers.some((p) => p.pauseSplit)
                ? [
                    { id: "resume", label: "Resume", content: <PausePart part="resume" /> },
                    { id: "pause", label: "Pause", content: <PausePart part="pause" /> },
                  ]
                : []),
              ...metricTabs([
              { id: "snapshot", what: "Save a prepared sandbox as a snapshot" },
              { id: "create-from-snapshot", tab: "Start from snapshot", what: "New sandbox from that snapshot, then a command" },
              ]),
            ]}
          />
        </Section>

        <Section id="scale" title="Bursts" lede="K sandboxes created at the same moment, as an agent fanning out sub-tasks would. Timed until the last one is ready.">
          <TabCard
            label="Bursts"
            tabs={metricTabs([
              {
                id: "burst-10",
                tab: "10 at once",
                what: "10 creates at once, until all 10 run a command",
                notes: partialBursts("burst-10"),
              },
              {
                id: "burst-25",
                tab: "25 at once",
                what: "25 creates at once, until all 25 run a command",
                notes: {
                  daytona: "not run: our Daytona account's concurrency limit refused the creates, on both attempts",
                  boat: "not run: our Boat plan allows 12 starts a minute",
                },
              },
            ])}
          />
        </Section>

        <Section
          id="machines"
          title="Machines"
          lede="Each provider's default sandbox. Sizes differ a lot, so the speed tests are not like for like."
        >
          <TabCard
            label="Machines"
            tabs={[
              {
                id: "size",
                label: "Size",
                content: (
                  <>
                    <ChartHead title="Who gives you the biggest machine" sub="Advertised size of each provider's default sandbox · Hover for what we measured inside" />
                    <MachineSizes providers={providers} />
                    <Footnotes items={[{ text: <><Who id="e2b" />: {advertised.e2b.note}</> }]} />
                  </>
                ),
              },
              {
                id: "details",
                label: "CPU",
                content: (
                  <>
                    <ChartHead title="What it ran on" sub="Read from inside each sandbox" />
                    <SpecSheet providers={providers} />
                  </>
                ),
              },
              ...metricTabs([
                { id: "cpu-single", what: "One core running a fixed Python loop", notes: machineNotes },
                {
                  id: "cpu-all",
                  what: `Every core the sandbox has, so more vCPUs win: Boat has ${size(boat)}, Daytona ${size(daytona)}`,
                  notes: machineNotes,
                },
                { id: "memory", tab: "Memory", what: "Copying 16 MB in memory", notes: machineNotes },
                { id: "disk-write", what: "Writing a 64 MB file in order", notes: machineNotes },
                { id: "disk-read", what: "Reading that file back, possibly from cache", notes: machineNotes },
                { id: "iops-write", tab: "Random write", what: "4 KB writes, each synced to disk", notes: machineNotes },
                { id: "iops-read", tab: "Random read", what: "4 KB random reads", notes: machineNotes },
              ]),
            ]}
          />
        </Section>

        <Section id="reliability" title="Reliability" lede="Every attempt counts. Failures were kept, never dropped as outliers, and each one is listed with its cause.">
          <Card>
            <Reliability providers={providers} />
          </Card>
        </Section>

        <Section id="cost" title="Cost" lede="From each provider's published prices and the size it gave us. Subscriptions, free credits, snapshot storage and transfer are left out.">
          <TabCard
            label="Cost"
            tabs={[
              { id: "hour", label: "Per sandbox-hour", content: <PriceChart k="hourly" title="Price per sandbox-hour" what="One default sandbox for an hour" /> },
              { id: "vcpu", label: "Per vCPU-hour", content: <PriceChart k="perVcpuHour" title="Price per vCPU-hour" what="Hourly price divided by vCPUs, fairer across sizes" /> },
            ]}
          />
        </Section>

        <Section id="method" title="Method" lede="Everything ran through Sandbox SDK's single interface, so each provider got the same calls in the same order.">
          <Card>
            <div className="grid gap-x-12 gap-y-5 text-[14px] leading-relaxed text-[var(--muted)] md:grid-cols-2">
              <p>
                One server in Florida drove every run, from {day}. Providers took turns in round-robin order, so a slow minute on the network hit everyone.
              </p>
              <p>The SDK adds no extra calls: run() is one exec on the provider. Each timer starts right before the call and stops when the result is back.</p>
              <p>
                No outliers were removed. Failures are kept and classified. Every number on this page is in the{" "}
                <a className="text-[var(--foreground)] underline decoration-dotted underline-offset-4" href="results.md">
                  results tables
                </a>
                .
              </p>
              <p>
                Every provider got 100 attempts per quick test, 30 per agent workload and snapshot test, and 3 bursts per size. Missing attempts were rerun; extra ones were cut to the first ones in time order. Attempts our own plan limits blocked were rerun; provider failures count.
              </p>
              <p>
                Download speed is left out: the public test host rate-limited several providers. {formatCount(timedOperations)} timed operations from {runs.length} runs. One early run was
                discarded in full after snapshot timeouts blocked a provider.
              </p>
            </div>
          </Card>
        </Section>
      </main>

      <footer className="mx-auto mt-24 max-w-[1200px] px-4 sm:px-6">
        <p className="border-t border-[var(--line)] py-8 text-[12px] text-[var(--muted)]">Sandbox bench · {day}</p>
      </footer>
    </>
  );
}
