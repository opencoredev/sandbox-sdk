import type { Provider } from "@/lib/data";
import { providerColor, providerName } from "@/lib/providers";
import { advertised } from "@/lib/sizes";

const ISOLATION_NAMES = {
  kvm: "Virtual machine",
  docker: "Container",
  unreported: "Not reported",
} as const;

const isKnownIsolation = (isolation: string): isolation is keyof typeof ISOLATION_NAMES =>
  Object.hasOwn(ISOLATION_NAMES, isolation);

/** A reader-facing name for how the provider isolates a sandbox; unknown kinds print as reported. */
const isolationName = (isolation: string) =>
  isKnownIsolation(isolation) ? ISOLATION_NAMES[isolation] : isolation;

const rowsOf = (providers: readonly Provider[]) =>
  providers.flatMap((p) =>
    p.hardware
      ? [
          {
            p,
            cpu: p.hardware.cpuModels[0]?.value ?? `${p.hardware.vendor}, model hidden`,
            runsAs: isolationName(p.hardware.isolation),
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
      <ul className="flex flex-col divide-y divide-line border-y border-line sm:hidden">
        {rows.map(({ p, cpu, runsAs, ranIn, note }) => (
          <li key={p.id} className="py-3 text-label leading-snug">
            <p
              className="font-medium text-(--provider)"
              style={{ "--provider": providerColor(p.id) }}
            >
              {providerName(p.id)}
            </p>
            <p className="mt-1">{cpu}</p>
            <p className="mt-0.5 text-muted">
              {runsAs} · {ranIn}
            </p>
            {note ? <p className="mt-1.5 text-note text-muted">{note}</p> : null}
          </li>
        ))}
      </ul>
      <table className="hidden w-full border-collapse text-left text-control sm:table">
        <thead>
          <tr className="border-b border-line text-caption text-muted">
            {["Provider", "CPU", "Runs as", "Ran in"].map((h) => (
              <th key={h} scope="col" className="py-2.5 pr-5 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ p, cpu, runsAs, ranIn, note }) => (
            <tr key={p.id} className="border-b border-line align-top">
              <th
                scope="row"
                className="py-3 pr-5 font-medium text-(--provider)"
                style={{ "--provider": providerColor(p.id) }}
              >
                {providerName(p.id)}
              </th>
              <td className="py-3 pr-5">
                {cpu}
                {note ? (
                  <span className="mt-1 block max-w-lede text-fine text-muted">{note}</span>
                ) : null}
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
