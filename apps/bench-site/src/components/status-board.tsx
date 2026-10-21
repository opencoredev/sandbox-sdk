import { metric } from "@/lib/data";
import type { Provider } from "@/lib/data";
import { formatCount, formatPercent } from "@/lib/format";
import { providerColor, providerName } from "@/lib/providers";

// The tests on the board, in page order. The machine tests all run in one
// probe, so one cell stands for them.
const tests = [
  ["cold", "Cold start"],
  ["command", "Command"],
  ["files-1kb", "1 KB file"],
  ["files-10mb", "10 MB file"],
  ["reconnect", "Reconnect"],
  ["pause-resume", "Pause"],
  ["destroy", "Destroy"],
  ["snapshot", "Snapshot"],
  ["create-from-snapshot", "From snapshot"],
  ["git-clone", "git clone"],
  ["npm-install", "npm install"],
  ["pip-install", "pip install"],
  ["dev-server", "Dev server"],
  ["preview-first-byte", "Preview URL"],
  ["edit-loop", "Edit loop"],
  ["tool-replay", "Tool replay"],
  ["cpu-single", "Machine tests"],
  ["burst-10", "10 at once"],
  ["burst-25", "25 at once"],
] as const;

const states = ["ok", "some", "many", "limit", "none"] as const;
type State = (typeof states)[number];

const look = {
  ok: { label: "All succeeded", className: "bg-[var(--ok)]" },
  some: { label: "Under 5% failed", className: "bg-[var(--warn)]" },
  many: { label: "5% or more failed", className: "bg-[var(--bad)]" },
  limit: { label: "Stopped by our plan's limit", className: "bg-[repeating-linear-gradient(135deg,var(--muted)_0_2px,transparent_2px_5px)]" },
  none: { label: "Not supported or not run", className: "border border-[var(--grid)]" },
} as const satisfies Record<State, { label: string; className: string }>;

function cell(provider: Provider, id: string) {
  const v = metric(id).values.find((x) => x.provider === provider.id);
  const attempts = v ? v.n + v.failures : 0;
  if (!v || attempts === 0) return { state: "none" as const, text: "not supported or not run" };
  const own = v.failures - v.limitFailures;
  const text = `${formatCount(v.n)} of ${formatCount(attempts)} succeeded`;
  if (v.failures === 0) return { state: "ok" as const, text };
  if (own === 0) return { state: "limit" as const, text: `${text}; the rest hit our plan's limit` };
  return { state: own / attempts < 0.05 ? ("some" as const) : ("many" as const), text };
}

const kindName: Record<string, string> = {
  "provider-operation": "Provider error",
  "provider-account-limit": "Our plan's limit",
  "client-third-party": "Third-party host",
};

/**
 * Reliability as a status page: one row per provider, one cell per test,
 * coloured by how many attempts failed. Underneath, what actually went wrong.
 */
export function StatusBoard({ providers }: { providers: readonly Provider[] }) {
  return (
    <div>
      <div className="mb-5 flex flex-wrap gap-x-5 gap-y-2 text-[12px] text-[var(--muted)]">
        {states.map((s) => (
          <span key={s} className="flex items-center gap-2">
            <span aria-hidden className={`inline-block size-3 rounded-[3px] ${look[s].className}`} />
            {look[s].label}
          </span>
        ))}
      </div>
      <div role="region" aria-label="Status by provider and test" tabIndex={0} className="relative -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[640px] border-separate border-spacing-y-1.5 text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-[var(--muted)]">
              <th scope="col" className="w-[8.5rem] pb-1 font-normal">Provider</th>
              <th scope="col" className="pb-1 font-normal">
                Each test, in page order <span className="sr-only">(hover a cell for its counts)</span>
              </th>
              <th scope="col" className="w-[6.5rem] pb-1 text-right font-normal">Succeeded</th>
            </tr>
          </thead>
          <tbody>
            {[...providers]
              .sort((a, b) => (b.reliability.adjusted ?? 0) - (a.reliability.adjusted ?? 0))
              .map((p) => {
                const cells = tests.map(([id, name]) => ({ id, name, ...cell(p, id) }));
                return (
                  <tr key={p.id}>
                    <th scope="row" className="pr-3 text-left font-medium" style={{ color: providerColor(p.id) }}>
                      {providerName(p.id)}
                    </th>
                    <td>
                      <ul className="flex gap-[3px]" aria-label={`${providerName(p.id)} by test`}>
                        {cells.map((c) => (
                          <li
                            key={c.id}
                            title={`${c.name}: ${c.text}`}
                            className={`h-6 min-w-2 flex-1 rounded-[3px] ${look[c.state].className}`}
                          >
                            <span className="sr-only">{`${c.name}: ${c.text}.`}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td className="pl-3 text-right font-mono text-[12px] tabular-nums">
                      {formatPercent(p.reliability.adjusted ?? 0, 2)}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>

      <h4 className="mt-8 mb-3 text-[14px] font-medium">What went wrong</h4>
      <div className="grid gap-x-10 gap-y-5 md:grid-cols-2">
        {providers.map((p) => (
          <div key={p.id} className="text-[12.5px] leading-snug">
            <p className="font-medium" style={{ color: providerColor(p.id) }}>
              {providerName(p.id)}
            </p>
            {p.failureReasons.length === 0 ? (
              <p className="mt-1 text-[var(--muted)]">Nothing failed.</p>
            ) : (
              <ul className="mt-1 flex flex-col gap-1 text-[var(--muted)]">
                {p.failureReasons.slice(0, 4).map((f) => (
                  <li key={`${f.kind}${f.reason}`}>
                    <span className="font-mono text-[var(--foreground)] tabular-nums">{f.count}×</span>{" "}
                    {f.reason}{" "}
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
