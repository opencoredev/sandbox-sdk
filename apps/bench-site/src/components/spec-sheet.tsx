import type { Provider } from "@/lib/data";
import { providerColor, providerName } from "@/lib/providers";
import { advertised } from "@/lib/sizes";

const isolationName: Record<string, string> = {
  kvm: "Virtual machine",
  docker: "Container",
  unreported: "Not reported",
};

const rowsOf = (providers: readonly Provider[]) =>
  providers.flatMap((p) =>
    p.hardware
      ? [
          {
            p,
            cpu: p.hardware.cpuModels[0]?.value ?? `${p.hardware.vendor}, model hidden`,
            runsAs: isolationName[p.hardware.isolation] ?? p.hardware.isolation,
            ranIn: p.hardware.location[0]?.value ?? "Not reported",
            note: advertised[p.id].note,
          },
        ]
      : [],
  );

/**
 * What each default sandbox ran on, read from inside it. A table on wide
 * screens; one stacked card per provider on phones so no column hides off
 * the edge. Sizes are in MachineSizes.
 */
export function SpecSheet({ providers }: { providers: readonly Provider[] }) {
  const rows = rowsOf(providers);
  return (
    <>
      <ul className="flex flex-col divide-y divide-[var(--line)] border-y border-[var(--line)] sm:hidden">
        {rows.map(({ p, cpu, runsAs, ranIn, note }) => (
          <li key={p.id} className="py-3 text-[13.5px] leading-snug">
            <p className="font-medium" style={{ color: providerColor(p.id) }}>
              {providerName(p.id)}
            </p>
            <p className="mt-1">{cpu}</p>
            <p className="mt-0.5 text-[var(--muted)]">
              {runsAs} · {ranIn}
            </p>
            {note ? <p className="mt-1.5 text-[12.5px] text-[var(--muted)]">{note}</p> : null}
          </li>
        ))}
      </ul>
      <table className="hidden w-full border-collapse text-left text-[13px] sm:table">
        <thead>
          <tr className="border-b border-[var(--line)] text-[12px] text-[var(--muted)]">
            {["Provider", "CPU", "Runs as", "Ran in"].map((h) => (
              <th key={h} scope="col" className="py-2.5 pr-5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, cpu, runsAs, ranIn, note }) => (
            <tr key={p.id} className="border-b border-[var(--line)] align-top">
              <th scope="row" className="py-3 pr-5 font-medium" style={{ color: providerColor(p.id) }}>
                {providerName(p.id)}
              </th>
              <td className="py-3 pr-5">
                {cpu}
                {note ? <span className="mt-1 block max-w-[52ch] text-[11.5px] text-[var(--muted)]">{note}</span> : null}
              </td>
              <td className="py-3 pr-5 whitespace-nowrap">{runsAs}</td>
              <td className="py-3 pr-5 whitespace-nowrap">{ranIn}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
