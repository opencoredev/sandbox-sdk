import type { ReactNode } from "react";

import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { Lockup } from "@/components/brand";
import { MachineSizes } from "@/components/machine-sizes";
import { PauseChart, PausePart } from "@/components/pause-chart";
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
import { coldSamples, metric, providers, runWindow } from "@/lib/data";
import type { Provider } from "@/lib/data";
import { formatGiB, formatMoney } from "@/lib/format";
import { providerColor } from "@/lib/providers";
import { advertised, sizeOf } from "@/lib/sizes";
import { excluded, notRun } from "@/lib/agent-data";
import { commonPrice, commonSize, conversionNote, usdPrice } from "@/lib/fx";
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
  ["state", "Pause & snapshots"],
  ["scale", "Bursts"],
  ["machines", "Machines"],
  ["reliability", "Reliability"],
  ["cost", "Cost"],
  ["method", "Method"],
] as const;

const start = new Date(runWindow.start);
const end = new Date(runWindow.end);
const short = (d: Date, opts: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...opts, timeZone: "UTC" });
/** "Oct 19, 2026", or "Oct 19–21, 2026" when runs span several days in one month. */
const day =
  start.toISOString().slice(0, 10) === end.toISOString().slice(0, 10)
    ? short(start, { month: "short", day: "numeric", year: "numeric" })
    : start.getUTCMonth() === end.getUTCMonth()
      ? `${short(start, { month: "short", day: "numeric" })}–${short(end, { day: "numeric" })}, ${start.getUTCFullYear()}`
      : `${short(start, { month: "short", day: "numeric" })} – ${short(end, { month: "short", day: "numeric", year: "numeric" })}`;

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

/** Price of the same machine everywhere, cheapest first. */
function commonColumns() {
  const priced = providers.flatMap((p) => {
    const price = commonPrice(p);
    return price ? [{ p, ...price }] : [];
  });
  const columns: Column[] = priced
    .sort((a, b) => a.usd - b.usd)
    .map(({ p, usd }) => ({
      provider: p.id,
      label: formatMoney(usd, "USD"),
      segments: [{ value: usd, color: providerColor(p.id), variant: "gradient" }],
      detail: [`${formatMoney(usd, "USD")} an hour`, commonSize.label],
    }));
  return { columns };
}

function CommonPriceChart() {
  const { columns } = commonColumns();
  return (
    <>
      <ChartHead title={`Price of a ${commonSize.label} sandbox`} sub="Per hour at each provider's published rates · US dollars · Lower is better" />
      <Columns columns={columns} label={`Price of a ${commonSize.label} sandbox`} />
      <Footnotes
        items={[
          ...providers.filter((p) => commonPrice(p) === null).map((p) => ({ text: <><Who id={p.id} /> does not list a {commonSize.label} machine, so no price is shown.</> })),
          { text: "Compute only, at list price. Disk, transfer, subscriptions and free credits are left out. Upstash charges a rate per box size but only while the CPU is busy, so its figure is an upper bound. Boat charges a flat rate per size." },
        ]}
      />
    </>
  );
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
          { text: "Compute-only list-price estimates for the size each provider gave us, not invoices. Boat is a flat rate per size. Upstash and boxd are upper bounds: they bill for less than the full allocation. Tenki uses measured usable RAM because its default allocation is undocumented." },
        ]}
      />
    </>
  );
}

// The machine probe runs under Python multiprocessing; Superserve's VMs have no /dev/shm for its locks.
const machineNotes: Notes = {
  superserve: "not measured: our machine probe needs /dev/shm, which Superserve's VMs don't have",
};

const coldNotes: Notes = {
  superserve: "includes setup our SDK runs after Superserve's create returns (settings, a check for Python, two small uploads), so it overstates Superserve's own start.",
  e2b: "ran on E2B's 512 MB base template; E2B's advertised default is 4 GiB.",
};

// Providers hosted in Europe: every call from Florida crosses the Atlantic.
const farNotes: Notes = {
  boat: "runs in France, so every call from our Florida server crosses the Atlantic.",
  boxd: "runs in Germany, so every call from our Florida server crosses the Atlantic.",
};

// Adapters that need more than one provider call per command.
const execNotes: Notes = {
  daytona: "our adapter opens a session, runs the command through a small Python helper and cleans up, so each command is several Daytona calls.",
  tenki: "our adapter launches the command, polls for its output, reads its exit code and removes its marker files, so each command is several Tenki calls.",
};

const methodRows = [
  ["One SDK", "Every provider ran through Sandbox SDK, our own TypeScript SDK, which we will publish soon. Each adapter uses the provider's official SDK or API, and times include the adapter's own work (noted where it adds calls)."],
  ["Independent", "No provider paid for these results or had any say in them. Some may have seen an early copy to check for errors. We may work with some of these companies; that did not change how tests ran or how results are reported."],
  ["One location", "Every run started from one server in Florida, US. Distance to each provider's region affects every call; the Hardware tab under Machines shows where each sandbox ran."],
  ["Default sizes", "Each provider ran the sandbox it gives you by default, so machines differ. E2B ran its 512 MB base template, below its advertised 4 GiB default."],
  ["Attempts", "100 per quick test, 30 per agent task and snapshot test, 3 bursts per size. Missing attempts were rerun on Oct 21; extras beyond the target were dropped, keeping the earliest."],
  ["Failures", "Only failures the provider caused count against it. Two kinds are left out: our machine probe, which can't run on Superserve (it needs /dev/shm), and failures where our own SDK timed out or couldn't confirm its cleanup, so we can't tell whose side failed. Attempts blocked by our own plan limits were rerun. results.json lists every set-aside failure."],
  ["Ties", "Medians within each other's 95% confidence intervals are effectively tied. Focus or hover a bar for its interval and attempt count."],
  ["Left out", "Download speed, because the public test host rate-limited several providers. One early run was discarded in full after snapshot timeouts blocked a provider."],
] as const;

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
  // Cost per task, as Artificial Analysis does it: the hourly price of the machine each provider ran on times its median time.
  const replayPoints: ScatterPoint[] = providers.flatMap((p) => {
    const t = replay.values.find((v) => v.provider === p.id)?.p50 ?? null;
    const price = usdPrice(p, "hourly");
    return t !== null && price
      ? [{ provider: p.id, x: t, y: (price.usd * t * 1000) / 3600, currency: "USD", tag: `${sizeOf(p).vcpu ?? "?"} vCPU` }]
      : [];
  });

  return (
    <>
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-[color-mix(in_oklch,var(--background)_88%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex max-w-[1200px] items-center gap-4 px-4 py-3 sm:px-6">
          <a href="#top" className="-my-2 shrink-0 py-2.5" aria-label="Sandbox bench, back to top">
            <Lockup />
          </a>
          <SectionNav sections={sections} extra={{ href: "llms.txt", label: "For agents ↗" }} />
          <a
            href="llms.txt"
            className="hidden shrink-0 rounded-full border border-[var(--line)] px-3.5 py-1.5 text-[13px] text-[var(--muted)] transition-colors duration-150 hover:text-[var(--foreground)] motion-reduce:transition-none lg:block"
          >
            For agents ↗
          </a>
        </div>
      </header>

      <main id="top" className="mx-auto max-w-[1200px] px-4 sm:px-6">
        <div className="pt-14 pb-10 sm:pt-20">
          <h1 className="font-pixel text-[44px] leading-[0.95] tracking-tight sm:text-[72px]">
            Cloud sandboxes,
            <br />
            measured
          </h1>
          <p className="mt-5 max-w-[52ch] text-[16px] leading-snug">
            {providers.length} cloud sandbox providers for AI agents, timed on the same tests from one server.
          </p>
          <p className="mt-4 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[12px] text-[var(--muted)]">
            {[day, "Florida, US", `${providers.length} providers`, "100 runs per test"].map((fact, i, all) => (
              // The separator rides at the end of each fact, so a wrapped line never starts with one.
              <span key={fact} className="whitespace-nowrap">
                {fact}
                {i < all.length - 1 ? <span aria-hidden className="ml-2">·</span> : null}
              </span>
            ))}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Headline marker="var(--dither-color-blue)" title="Cold start" sub={metricSubtitle(cold, "create() to first command")}>
            <MetricChart metric={cold} what="" compact />
          </Headline>
          <Headline marker="var(--dither-color-orange)" title="Agent work" sub={metricSubtitle(replay, "Tool replay, 100 calls")}>
            <MetricChart metric={replay} what="" compact />
          </Headline>
          <Headline marker="var(--dither-color-green)" title="Price per hour" sub={`Same machine everywhere: ${commonSize.label} · US dollars · Lower is better`}>
            <Columns columns={commonColumns().columns} label={`Price of a ${commonSize.label} sandbox`} compact />
          </Headline>
        </div>

        <Section id="startup" title="Start-up" lede="Cold start is the wait before an agent can do anything: from create() until the first command returns.">
          <TabCard
            label="Start-up"
            tabs={[
              ...metricTabs([{ id: "cold", what: "create() to first command", tab: "Cold start", notes: coldNotes }]),
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
              Real coding-agent tasks, so CPU, disk and network count as much as the API.
            </>
          }
        >
          <TabCard
            label="Agent work"
            tabs={metricTabs([
              { id: "tool-replay", tab: "Tool replay", what: "100 tool calls in a row: write, read, edit, list, grep, run a test", notes: { ...farNotes, ...execNotes } },
              { id: "npm-install", what: "npm ci for a small Vite and React app", notes: { ...farNotes, e2b: "ran on E2B's 512 MB base template; E2B's advertised default is 4 GiB." } },
              { id: "pip-install", what: "requests and numpy from PyPI", notes: farNotes },
              { id: "git-clone", what: "Shallow clone of a small pinned repo", notes: farNotes },
              { id: "dev-server", what: "Start Vite and wait until it is ready", notes: farNotes },
              { id: "preview-first-byte", tab: "Preview URL", what: "Fetch the dev server through the public preview URL", notes: farNotes },
              { id: "edit-loop", tab: "Edit loop", what: "Edit a file, rebuild, fetch the page again", notes: farNotes },
            ])}
          />
        </Section>

        <Section id="everyday" title="Everyday calls" lede="What an agent does hundreds of times per task: run a command, move files, reattach to a sandbox.">
          <TabCard
            label="Everyday calls"
            tabs={metricTabs([
              { id: "command", what: "A no-op command, mostly network and API overhead", notes: execNotes },
              { id: "files-1kb", tab: "1 KB file", what: "Write a 1 KB file and read it back" },
              {
                id: "files-10mb",
                tab: "10 MB file",
                what: "Write a 10 MB file and read it back",
                only: providers.flatMap((p) => (excluded["files-10mb"]?.[p.id] ? [] : [p.id])),
                notes: {
                  boxd: `left out: ${excluded["files-10mb"]?.boxd ?? ""}`,
                  boat: "the read takes several calls: a size check, a copy, a signed URL, then the download.",
                },
              },
              { id: "reconnect", what: "Attach to an existing sandbox by ID and run a command" },
              { id: "destroy", what: "Delete the sandbox and wait for confirmation" },
            ])}
          />
        </Section>

        <Section id="state" title="Pause & snapshots" lede="Pausing stops paying for idle time while an agent waits on a human. Snapshots start many sandboxes from one prepared state.">
          <TabCard
            label="Pause & snapshots"
            tabs={[
              ...(providers.some((p) => p.pauseSplit)
                ? [
                    { id: "resume", label: "Resume", content: <PausePart part="resume" /> },
                    { id: "pause", label: "Pause", content: <PausePart part="pause" /> },
                  ]
                : []),
              { id: "pause-resume", label: "Pause + resume", content: <PauseChart /> },
              ...metricTabs([
              { id: "snapshot", what: "Save a prepared sandbox as a snapshot" },
              { id: "create-from-snapshot", tab: "Start from snapshot", what: "New sandbox from that snapshot, then a command" },
              ]),
            ]}
          />
        </Section>

        <Section id="scale" title="Bursts" lede="10 or 25 sandboxes started at once, as an agent fanning out would, timed until the last one runs a command. Three bursts per size, so treat these as indicative.">
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
                notes: Object.fromEntries(Object.entries(notRun["burst-25"] ?? {}).map(([id, why]) => [id, why.replace(/^not-run: /, "not run: ")])),
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
                    <ChartHead title="Default machine size" sub="Advertised size of each provider's default sandbox · Tap or focus a bar for what we measured inside" />
                    <MachineSizes providers={providers} />
                    <Footnotes items={[{ text: <><Who id="e2b" />: {advertised.e2b.note}</> }]} />
                  </>
                ),
              },
              {
                id: "details",
                label: "Hardware",
                content: (
                  <>
                    <ChartHead title="Hardware inside each sandbox" sub="Read from inside each sandbox" />
                    <SpecSheet providers={providers} />
                  </>
                ),
              },
              ...metricTabs([
                { id: "cpu-single", what: "One core running a fixed Python loop", notes: machineNotes },
                {
                  id: "cpu-all",
                  what: "Every core at once, so bigger machines win",
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

        <Section id="reliability" title="Reliability" lede="How often each provider failed, and why.">
          <Card>
            <Reliability providers={providers} />
          </Card>
        </Section>

        <Section id="cost" title="Cost" lede="Published prices on the same machine and on each default machine, and what a task costs.">
          <TabCard
            label="Cost"
            tabs={[
              { id: "common", label: commonSize.label, content: <CommonPriceChart /> },
              { id: "hour", label: "Default sandbox", content: <PriceChart k="hourly" title="Price of each default sandbox" what="The machine each provider gives you by default, so sizes differ" /> },
            ]}
          />
          <Card className="mt-4">
            <ChartHead
              title="Agent work vs cost per task"
              sub="Median tool replay time against what 1,000 tool replays cost on the machine that ran them · Both lower is better"
            />
            <Scatter
              points={replayPoints}
              xTicks={[10, 20, 50, 100]}
              yTicks={[0, 0.5, 1, 1.5, 2, 2.5, 3]}
              xTitle="Median tool replay, seconds (log scale)"
              yTitle="Cost of 1,000 tool replays (USD)"
            />
            <Footnotes
              items={[
                { text: "Cost is the hourly list price of each provider's default machine times its median time, so a bigger machine that finishes sooner can cost less per task. Labels show the vCPUs it ran on." },
                { text: <><Who id="boat" /> and <Who id="boxd" /> run in Europe, so every call from our Florida server crosses the Atlantic. <Who id="upstash" /> bills only busy CPU; its cost and boxd's full-memory estimate are upper bounds.</> },
              ]}
            />
          </Card>
        </Section>

        <Section id="method" title="Method" lede="How the numbers were made, and what could bias them.">
          <Card>
            <dl className="grid gap-x-12 gap-y-5 text-[14px] leading-relaxed md:grid-cols-2">
              {methodRows.map(([term, text]) => (
                <div key={term}>
                  <dt className="font-medium">{term}</dt>
                  <dd className="mt-1 text-[var(--muted)]">{text}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </Section>
      </main>

      <footer className="mx-auto mt-24 max-w-[1200px] px-4 sm:px-6">
        <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-[var(--line)] py-8 text-[12px] text-[var(--muted)]">
          <span>Sandbox bench · {day}</span>
          <span aria-hidden>·</span>
          <span>
            Data:{" "}
            {["llms.txt", "results.json", "results.md"].map((f, i) => (
              <span key={f}>
                {i > 0 ? " · " : ""}
                <a className="-my-2 inline-block py-2 underline decoration-dotted underline-offset-4 hover:text-[var(--foreground)]" href={f}>
                  {f}
                </a>
              </span>
            ))}
          </span>
        </p>
      </footer>
    </>
  );
}
