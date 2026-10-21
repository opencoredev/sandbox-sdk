import { StatusGrid } from "@/components/status-grid";
import type { Provider } from "@/lib/data";
import { formatPercent } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";
import { boardTests, cellFor, successRate } from "@/lib/status";
import { cellStates, stateLook } from "@/lib/status-look";

const kindName: Record<string, string> = {
  "provider-operation": "provider error",
  "provider-account-limit": "our plan's limit",
  "client-third-party": "third-party host",
};

/**
 * Reliability as a status page: one row per provider, one cell per test,
 * coloured by how many attempts failed. Underneath, every cause of failure.
 */
export function StatusBoard({ providers }: { providers: readonly Provider[] }) {
  const ranked = providers.map((p) => ({ p, s: successRate(p) })).sort((a, b) => (b.s.rate ?? 0) - (a.s.rate ?? 0));
  const rows = ranked.map(({ p, s }) => ({
    id: p.id,
    name: providerName(p.id),
    color: providerColor(p.id),
    rate: s.rate === null ? "n/a" : formatPercent(s.rate, 2),
    cells: boardTests.map((t) => cellFor(p, t)),
  }));
  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[var(--muted)]">
        {cellStates.map((s) => (
          <span key={s} className="flex items-center gap-2">
            <span aria-hidden className={`inline-block size-3 rounded-[3px] ${stateLook[s].className}`} />
            {stateLook[s].label}
          </span>
        ))}
      </div>
      <StatusGrid rows={rows} />
      <p className="mt-1 text-[12px] text-[var(--muted)]">
        Succeeded counts every attempt on these tests, including any stopped by our own plan limits.
      </p>

      <h4 className="mt-8 mb-3 text-[14px] font-medium">What went wrong</h4>
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
                    <span className="font-mono text-[var(--foreground)] tabular-nums">{f.count}×</span> {f.reason}{" "}
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
    </div>
  );
}
