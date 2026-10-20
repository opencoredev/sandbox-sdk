import type { ReactNode } from "react";

import { BarChart } from "@/components/bar-chart";
import type { RowNotes } from "@/components/bar-chart";
import { Failures } from "@/components/failures";
import { HeroField } from "@/components/hero-field";
import { Ridgelines } from "@/components/ridgelines";
import { Scatter } from "@/components/scatter";
import { SimpleBars } from "@/components/simple-bars";
import { SpecSheet } from "@/components/spec-sheet";
import { Tabs } from "@/components/tabs";
import { cloudProviders, data, metric } from "@/lib/data";
import { formatCount, formatGiB, formatMoney, formatValue } from "@/lib/format";
import { providerName } from "@/lib/providers";

// Reference: Artificial Analysis (one question per chart, plain titles, the
// direction that wins stated up front) and scrapingbench (black page, one hue
// per provider, dithered bars with a solid cap, value beside the bar).
// Palette: paper oklch(0.13 0 0), ink oklch(0.96 0 0), muted oklch(0.68 0 0),
// one fixed colour per provider, red only for failures.
// Type: Geist Sans for reading, Geist Mono for numbers, Geist Pixel for headings.
// Layout: a single column of questions, each answered by one chart.
// Signature: the hero plots every cold start we measured as dithered ridges.
// Avoiding: overall scores, winner badges, card grids, tables as the main view.

const all = data.providers.map((p) => p.id);
const cloud = cloudProviders.map((p) => p.id);
const hw = (id: string) => data.providers.find((p) => p.id === id)?.hardware;
const size = (id: string) => {
  const h = hw(id);
  return h ? `${h.vcpu} vCPU, ${formatGiB(h.memoryGiB)} RAM` : "unknown size";
};

const sections = [
  ["startup", "Start-up"],
  ["everyday", "Everyday calls"],
  ["agent", "Agent work"],
  ["state", "Pause and snapshots"],
  ["scale", "Many at once"],
  ["machines", "Machines"],
  ["reliability", "Reliability"],
  ["cost", "Cost"],
  ["method", "How we tested"],
] as const;

function Section({
  id,
  title,
  lede,
  children,
}: {
  id: string;
  title: string;
  lede: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-20 border-t border-[var(--line)] py-16 sm:py-20">
      <h2 className="font-pixel text-[26px] leading-tight tracking-tight sm:text-[32px]">{title}</h2>
      <p className="mt-3 max-w-[64ch] text-[15px] leading-relaxed text-[var(--muted)]">{lede}</p>
      <div className="mt-10">{children}</div>
    </section>
  );
}

function ChartTitle({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="mb-5">
      <h3 className="text-[16px] font-medium">{title}</h3>
      <p className="mt-1 text-[13px] text-[var(--muted)]">{sub}</p>
    </div>
  );
}

const latencyTabs = (items: [id: string, sub: string, notes?: RowNotes][], providers = all) =>
  items.map(([id, sub, notes]) => {
    const m = metric(id);
    return {
      id,
      label: m.label,
      content: (
        <>
          <ChartTitle title={m.label} sub={sub} />
          <BarChart metric={m} providers={providers} notes={notes} />
        </>
      ),
    };
  });

const rateTabs = (items: [id: string, sub: string][]) =>
  items.map(([id, sub]) => {
    const m = metric(id);
    return {
      id,
      label: m.label,
      content: (
        <>
          <ChartTitle title={m.label} sub={sub} />
          <BarChart metric={m} providers={all} />
        </>
      ),
    };
  });

export default function Page() {
  const cold = metric("cold");
  const coldP50 = (id: string) => cold.values.find((v) => v.provider === id)?.p50 ?? null;
  const scatterPoints = cloudProviders.flatMap((p) => {
    const x = coldP50(p.id);
    return x !== null && p.hourly !== null && p.currency === "USD"
      ? [{ provider: p.id, x, y: p.hourly, currency: p.currency }]
      : [];
  });
  const start = data.window.start ? new Date(data.window.start) : null;
  const day = start?.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

  return (
    <main>
      <header className="relative isolate overflow-hidden">
        <HeroField className="absolute top-0 right-0 -z-10 h-[420px] w-full [mask-image:linear-gradient(to_bottom,black_30%,transparent)] sm:w-[70%]" />
        <div className="mx-auto max-w-[1080px] px-5 pt-8 sm:px-8">
          <nav className="flex items-center justify-between text-[13px] text-[var(--muted)]">
            <span className="font-medium text-[var(--foreground)]">Sandbox SDK bench</span>
            <a className="hover:text-[var(--foreground)]" href="#method">
              Method
            </a>
          </nav>
          <h1 className="mt-24 max-w-[18ch] font-pixel text-[40px] leading-[1.05] tracking-tight sm:mt-32 sm:text-[60px]">
            How fast are cloud sandboxes for agents?
          </h1>
          <p className="mt-5 max-w-[60ch] text-[16px] leading-relaxed text-[var(--muted)]">
            We drove 7 sandbox providers and a local Docker baseline through the same open-source SDK, from the same
            server, on {day}. {formatCount(data.observations)} measurements: start-up, commands, files, real agent
            workloads, bursts, hardware and price. Every failure is counted.
          </p>
        </div>
        <div className="mx-auto max-w-[1080px] px-5 pt-14 pb-16 sm:px-8">
          <ChartTitle
            title="Cold start: from create() to the first command"
            sub="Every successful cold start, one ridge per provider. Further left is faster. The white tick is the median."
          />
          <Ridgelines samples={data.coldSamples} />
        </div>
      </header>

      <div className="sticky top-0 z-20 border-y border-[var(--line)] bg-[var(--background)]/90 backdrop-blur">
        <nav
          aria-label="Sections"
          className="mx-auto flex max-w-[1080px] gap-5 overflow-x-auto px-5 py-3 text-[13px] whitespace-nowrap text-[var(--muted)] sm:px-8"
        >
          {sections.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="hover:text-[var(--foreground)]">
              {label}
            </a>
          ))}
        </nav>
      </div>

      <div className="mx-auto max-w-[1080px] px-5 sm:px-8">
        <section className="py-16 sm:py-20">
          <h2 className="font-pixel text-[26px] tracking-tight sm:text-[32px]">How to read the charts</h2>
          <dl className="mt-8 grid gap-x-12 gap-y-6 text-[14px] leading-relaxed sm:grid-cols-2">
            {[
              ["The bar is the median (p50)", "Half of the runs were faster than this, half slower. It is the typical case."],
              ["The small number is p95", "95 runs out of 100 finished by then. When p95 is far above the median, the provider is sometimes much slower than usual."],
              ["Sorted best first", "Time charts put the shortest bar on top. Throughput and CPU charts put the longest on top. Each chart says which."],
              ["Each provider ran its default size", "We did not ask for bigger machines, so the hardware differs. Daytona gave us 1 vCPU, Boat and Freestyle gave us 4. See Machines."],
            ].map(([term, def]) => (
              <div key={term}>
                <dt className="font-medium">{term}</dt>
                <dd className="mt-1 text-[var(--muted)]">{def}</dd>
              </div>
            ))}
          </dl>
        </section>

        <Section
          id="startup"
          title="Start-up"
          lede="Cold start is the wait before an agent can do anything. Lower is better. Price is what one hour of the default sandbox costs at the provider's published rates."
        >
          <ChartTitle
            title="Cold start against price"
            sub="Median cold start (log scale) against estimated price per sandbox-hour. The shaded corner is faster and cheaper than the middle of the field."
          />
          <Scatter
            points={scatterPoints}
            xTicks={[2, 3, 5, 10, 20]}
            yTicks={[0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3]}
            xLabel="Median cold start, seconds, log scale. Further left is faster."
            yLabel="Estimated price per sandbox-hour at default size. Lower is cheaper."
            quadrantLabel="Faster and cheaper"
          />
          <p className="mt-4 max-w-prose text-[12px] text-[var(--muted)]">
            boxd bills in euros, so it is left off this chart rather than converted: {formatValue(coldP50("boxd") ?? 0, "s")}{" "}
            median cold start at {formatMoney(data.providers.find((p) => p.id === "boxd")?.hourly ?? 0, "EUR")} an hour.
            Prices are list-price estimates for the size each provider gave us, not invoices.
          </p>
        </Section>

        <Section
          id="everyday"
          title="Everyday calls"
          lede="What an agent does hundreds of times per task: run a command, read and write files, reconnect to a sandbox it made earlier. Lower is better."
        >
          <Tabs
            label="Everyday calls"
            tabs={latencyTabs([
              ["command", "Run a no-op command (`true`) and wait for it to finish. Mostly network round trip and API overhead."],
              ["files-1kb", "Write a 1 KB file, then read it back."],
              [
                "files-10mb",
                "Write a 10 MB file, then read it back.",
                {
                  boxd: "boxd's native download cut large files short, so the SDK reads in chunks. This number measures that workaround.",
                  boat: "Uses Boat's signed download URL for the read.",
                },
              ],
              ["reconnect", "Attach to an existing sandbox by ID and run a command."],
              ["destroy", "Delete the sandbox and wait for the provider to confirm."],
            ])}
          />
        </Section>

        <Section
          id="agent"
          title="Agent work"
          lede="Real tasks coding agents run. These depend on the sandbox's CPU, disk and network as much as on the provider's API. Lower is better."
        >
          <Tabs
            label="Agent work"
            tabs={latencyTabs([
              ["tool-replay", "100 tool calls in a row, like a coding agent makes: write, read, edit, list, grep and run a test, over and over."],
              ["npm-install", "npm ci for a small Vite and React app, from the public registry."],
              ["pip-install", "Install requests and numpy (six pinned wheels) from PyPI."],
              ["git-clone", "Shallow clone of a small public GitHub repository, pinned to one commit."],
              ["dev-server", "Start the Vite dev server and wait until it reports ready."],
              ["preview-first-byte", "Fetch the dev server through the provider's public preview URL, from outside."],
              ["edit-loop", "Edit a file, let the dev server rebuild, fetch the page again."],
            ])}
          />
        </Section>

        <Section
          id="state"
          title="Pause and snapshots"
          lede="Agents that wait for a human want to pause instead of paying for idle time. Snapshots let you start many sandboxes from one prepared state. Lower is better."
        >
          <Tabs
            label="Pause and snapshots"
            tabs={latencyTabs([
              [
                "pause-resume",
                "Pause a running sandbox, resume it, and run a command.",
                { tenki: "Almost all of this is the pause. Resuming takes a couple of seconds." },
              ],
              ["snapshot", "Save a prepared sandbox as a snapshot."],
              ["create-from-snapshot", "Start a new sandbox from that snapshot and run a command."],
            ])}
          />
        </Section>

        <Section
          id="scale"
          title="Many at once"
          lede="A burst is K sandboxes created at the same moment, as an agent fanning out sub-tasks would. We time until the last one is ready. Lower is better."
        >
          <Tabs
            label="Bursts"
            tabs={latencyTabs(
              [
                ["burst-10", "10 sandboxes created at once. Time until all 10 run a command. Three or four bursts per provider."],
                [
                  "burst-25",
                  "25 sandboxes created at once. Time until all 25 run a command. Three bursts per provider.",
                  {
                    daytona: "15 of the 25 creates failed with invalid_argument, which looks like a concurrency limit. A rerun could not start because other sandboxes on the account still held capacity.",
                    boat: "Boat's plan allows 12 starts a minute, so 25 at once cannot succeed.",
                  },
                ],
              ],
              cloud,
            )}
          />
          <p className="mt-6 max-w-prose text-[12px] text-[var(--muted)]">
            Boat's plan also allows 200 starts a day. We hit that during the run, so Boat has fewer samples everywhere
            ({formatCount(data.coldSamples.boat?.length ?? 0)} cold starts against about 100 for the others).
          </p>
        </Section>

        <Section
          id="machines"
          title="Machines"
          lede="What each default sandbox actually was, read from inside it with nproc, /proc and the cgroup limits. Providers chose these sizes, so the speed tests below are not like for like."
        >
          <SpecSheet providers={cloudProviders} />
          <p className="mt-4 max-w-prose text-[12px] text-[var(--muted)]">
            vCPU is what the sandbox may use: the cgroup quota when set, otherwise the cores it can see. Location is where
            its outbound traffic appeared to come from, not a guaranteed region.
          </p>
          <div className="mt-16">
            <Tabs
              label="Machine speed"
              tabs={rateTabs([
                ["cpu-single", "One core running a fixed Python loop. Higher is better."],
                ["cpu-all", `Every core the sandbox has. Higher is better. More vCPUs win: ${providerName("boat")} has ${size("boat")}, ${providerName("daytona")} ${size("daytona")}.`],
                ["memory", "Copying 16 MB in memory. Higher is better."],
                ["disk-write", "Writing a 64 MB file in order. Higher is better."],
                ["disk-read", "Reading that file back. It may come from cache. Higher is better."],
                ["iops-write", "Random 4 KB writes per second, each synced to disk. Higher is better."],
                ["iops-read", "Random 4 KB reads per second. Higher is better."],
              ])}
            />
          </div>
        </Section>

        <Section
          id="reliability"
          title="Reliability"
          lede="Every operation that failed, per 1,000 attempts. Fewer is better. We split failures into three kinds: operations that failed, limits on our own accounts, and the outside host we used for the download speed test blocking us."
        >
          <Failures providers={cloudProviders} />
          <p className="mt-6 max-w-prose text-[12px] text-[var(--muted)]">
            Operation failures include ones whose cause we could not pin down, so not every one is the provider's fault.
            The first success rate leaves out our account limits and the blocked test host; the second counts everything.
            Rates count observations, and some observations come from the same sandbox.
          </p>
        </Section>

        <Section
          id="cost"
          title="Cost"
          lede="Estimated from each provider's published prices and the size it gave us. Disk is included where the provider charges for it. Subscriptions, free credits, snapshot storage and data transfer are left out. Lower is better."
        >
          <Tabs
            label="Cost"
            tabs={[
              {
                id: "hour",
                label: "Per sandbox-hour",
                content: (
                  <>
                    <ChartTitle title="Price per sandbox-hour" sub="One default sandbox running for an hour." />
                    <SimpleBars
                      label="Price per sandbox-hour"
                      bars={cloudProviders.flatMap((p) =>
                        p.hourly === null
                          ? []
                          : [
                              {
                                provider: p.id,
                                value: p.hourly,
                                label: formatMoney(p.hourly, p.currency),
                                note: p.currency === "USD" ? size(p.id) : `${size(p.id)}. Billed in euros, so not ranked with the dollar prices.`,
                                unranked: p.currency !== "USD",
                              },
                            ],
                      )}
                    />
                  </>
                ),
              },
              {
                id: "vcpu",
                label: "Per vCPU-hour",
                content: (
                  <>
                    <ChartTitle title="Price per vCPU-hour" sub="The hourly price divided by the vCPUs the sandbox had. Fairer across sizes." />
                    <SimpleBars
                      label="Price per vCPU-hour"
                      bars={cloudProviders.flatMap((p) =>
                        p.perVcpuHour === null
                          ? []
                          : [
                              {
                                provider: p.id,
                                value: p.perVcpuHour,
                                label: formatMoney(p.perVcpuHour, p.currency),
                                note: p.currency === "USD" ? undefined : "Billed in euros, so not ranked with the dollar prices.",
                                unranked: p.currency !== "USD",
                              },
                            ],
                      )}
                    />
                  </>
                ),
              },
            ]}
          />
          <p className="mt-6 max-w-prose text-[12px] text-[var(--muted)]">
            boxd is in euros and Boat is a flat $0.036 an hour. Upstash and boxd estimates are upper bounds because they
            bill for less than the full allocation.
          </p>
        </Section>

        <Section
          id="method"
          title="How we tested"
          lede="Everything ran through Sandbox SDK's single interface, so each provider got the same calls in the same order."
        >
          <div className="grid gap-x-12 gap-y-6 text-[14px] leading-relaxed text-[var(--muted)] sm:grid-cols-2">
            <p>
              One server in Florida drove every run, from {start?.toUTCString().slice(17, 22)} UTC on {day}. Providers took
              turns in round-robin order, so a slow minute on the network hit everyone.
            </p>
            <p>
              The SDK adds no extra calls: run() is one exec on the provider. Each timer starts right before the call and
              stops when the result is back.
            </p>
            <p>
              No outliers were removed. Failures are kept and classified rather than dropped. Bootstrap confidence intervals
              for every median are in the full tables.
            </p>
            <p>
              The download speed test is left out of the charts: the public test host rate-limited several providers, so
              those numbers say more about it than about them.
            </p>
            <p>
              {formatCount(data.observations)} observations from {data.runs.length} runs. One earlier run was discarded in
              full after snapshot timeouts blocked one provider.
            </p>
            <p>
              Every number on this page, with confidence intervals and the failure list, is in the{" "}
              <a className="underline decoration-dotted underline-offset-4 hover:text-[var(--foreground)]" href="results.md">
                full tables
              </a>
              . The raw samples are about 800 MB of JSON, produced by bun bench merge.
            </p>
          </div>
        </Section>
      </div>
      <footer className="border-t border-[var(--line)] py-10 text-center text-[12px] text-[var(--muted)]">
        Sandbox SDK bench, {day}.
      </footer>
    </main>
  );
}
