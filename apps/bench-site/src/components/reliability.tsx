import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { ChartHead } from "@/components/metric-chart";
import type { Provider } from "@/lib/data";
import { formatCount } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";
import { successRate } from "@/lib/status";

/** Shorter wording for the raw failure messages that need it. */
const plain = (reason: string) =>
  reason
    .replace(/^getaddrinfo ETIMEOUT \S+$/, "DNS lookup for the preview URL timed out")
    .replace(/^Scenario timed out after 600000ms$/, "Hung for 10 minutes")
    .replace(/\.$/, "");

/**
 * Failed attempts per 1,000, fewest first, with every cause behind one
 * disclosure so the section stays a single chart until someone asks.
 */
export function Reliability({ providers }: { providers: readonly Provider[] }) {
  const ranked = providers
    .map((p) => {
      const s = successRate(p);
      return { p, s, perThousand: s.attempts ? ((s.attempts - s.succeeded) / s.attempts) * 1000 : 0 };
    })
    .sort((a, b) => a.perThousand - b.perThousand);
  const columns: Column[] = ranked.map(({ p, s, perThousand }) => ({
    provider: p.id,
    label: perThousand.toFixed(1),
    segments: [{ value: perThousand, color: "oklch(0.68 0.2 25)", variant: "gradient" }],
    detail: [`${formatCount(s.attempts - s.succeeded)} of ${formatCount(s.attempts)} attempts failed`],
  }));
  const rows = ranked.flatMap(({ p }) => p.failureReasons.map((f, i) => ({ p, f, first: i === 0 })));
  const runs = rows.reduce((sum, { f }) => sum + f.runs, 0);

  return (
    <>
      <ChartHead title="Failed attempts" sub="Per 1,000 attempts across the tests on this page · Lower is better" />
      <Columns columns={columns} label="Failed attempts per 1,000" />

      <details className="group mt-6 rounded-lg border border-[var(--line)]">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 px-4 py-3 text-[13.5px] font-medium select-none [&::-webkit-details-marker]:hidden">
          <span>
            Every failure and its cause{" "}
            <span className="font-normal text-[var(--muted)]">
              · {runs} {runs === 1 ? "run" : "runs"} across {new Set(rows.map((r) => r.p.id)).size} providers
            </span>
          </span>
          <span aria-hidden className="text-[var(--muted)] transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none">
            ▾
          </span>
        </summary>
        {/* Phones: one block per provider, every cause on its own lines, nothing cut off. */}
        <ul className="divide-y divide-[var(--line)] border-t border-[var(--line)] sm:hidden">
          {ranked.flatMap(({ p }) =>
            p.failureReasons.length === 0
              ? []
              : [
                  <li key={p.id} className="px-4 py-3">
                    <p className="text-[13.5px] font-medium" style={{ color: providerColor(p.id) }}>
                      {providerName(p.id)}
                    </p>
                    <ul className="mt-1.5 flex flex-col gap-2">
                      {p.failureReasons.map((f) => (
                        <li key={f.reason} className="text-[13px] leading-snug">
                          <span className="font-mono tabular-nums">{f.runs}×</span> {plain(f.reason)}
                          <span className="block text-[12px] text-[var(--muted)]">
                            {f.tests.length > 3 ? `${f.tests.length} tests` : f.tests.join(", ")}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>,
                ],
          )}
        </ul>
        <div className="relative hidden overflow-x-auto border-t border-[var(--line)] sm:block">
          <table className="w-full min-w-[560px] border-collapse text-left text-[12.5px]">
            <thead>
              <tr className="text-[11.5px] text-[var(--muted)]">
                {["Provider", "Runs", "Cause", "Tests"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(({ p, f, first }) => (
                <tr key={`${p.id}${f.reason}`} className={first ? "border-t border-[var(--line)]" : ""}>
                  <th scope="row" className="px-4 py-1.5 align-top font-medium whitespace-nowrap" style={{ color: providerColor(p.id) }}>
                    {first ? providerName(p.id) : <span className="sr-only">{providerName(p.id)}</span>}
                  </th>
                  <td className="px-4 py-1.5 align-top font-mono tabular-nums">{f.runs}</td>
                  <td className="px-4 py-1.5 align-top">
                    {plain(f.reason)}
                  </td>
                  <td className="px-4 py-1.5 align-top text-[var(--muted)]">
                    {f.tests.length > 3 ? `${f.tests.length} tests` : f.tests.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
