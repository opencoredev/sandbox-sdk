import { Columns } from "@/components/columns";
import type { Column } from "@/components/columns";
import { ChartHead } from "@/components/metric-chart";
import type { Provider } from "@/lib/data";
import { formatCount } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";
import { successRate } from "@/lib/status";

const kindName: Record<string, string> = {
  "provider-operation": "provider error",
  "provider-account-limit": "our plan's limit",
  "client-third-party": "third-party host",
};

/** Failed attempts per 1,000, fewest first, then every cause of failure in plain words. */
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
  return (
    <>
      <ChartHead title="Failed attempts" sub="Per 1,000 attempts across every test on this page · Lower is better" />
      <Columns columns={columns} label="Failed attempts per 1,000" />
      <h4 className="mt-8 text-[14px] font-medium">What went wrong</h4>
      <p className="mt-1 mb-3 text-[12px] text-[var(--muted)]">Each cause with the number of runs it hit. One run can fail several tests at once.</p>
      <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
        {ranked.map(({ p }) => (
          <div key={p.id} className="text-[12.5px] leading-snug">
            <p className="font-medium" style={{ color: providerColor(p.id) }}>
              {providerName(p.id)}
            </p>
            {p.failureReasons.length === 0 ? (
              <p className="mt-1 text-[var(--muted)]">Nothing failed.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1 text-[var(--muted)]">
                {p.failureReasons.map((f) => (
                  <li key={`${f.kind}${f.reason}`}>
                    <span className="font-mono text-[var(--foreground)] tabular-nums">{f.runs}×</span> {f.reason}{" "}
                    <span className="text-[11.5px]">
                      ({kindName[f.kind] ?? f.kind}; {f.tests.length > 3 ? `${f.tests.length} tests` : f.tests.join(", ")})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
