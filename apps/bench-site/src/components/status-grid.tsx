"use client";

import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { stateLook } from "@/lib/status-look";
import type { Cell } from "@/lib/status-look";

export interface Row {
  id: string;
  name: string;
  color: string;
  rate: string;
  cells: readonly Cell[];
}

/**
 * The status grid: one tab stop, arrow keys move between cells, and the
 * line under it reads out the cell under the pointer or focus, so nothing
 * depends on a hover tooltip.
 */
export function StatusGrid({ rows }: { rows: readonly Row[] }) {
  const [at, setAt] = useState<[number, number]>([0, 0]);
  const [shown, setShown] = useState<[number, number] | null>(null);
  const refs = useRef(new Map<string, HTMLTableCellElement>());
  const width = rows[0]?.cells.length ?? 0;

  const move = (r: number, c: number) => {
    const next: [number, number] = [Math.max(0, Math.min(rows.length - 1, r)), Math.max(0, Math.min(width - 1, c))];
    setAt(next);
    setShown(next);
    refs.current.get(`${next[0]}:${next[1]}`)?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const [r, c] = at;
    const to = {
      ArrowRight: [r, c + 1],
      ArrowLeft: [r, c - 1],
      ArrowDown: [r + 1, c],
      ArrowUp: [r - 1, c],
      Home: [r, 0],
      End: [r, width - 1],
    }[event.key];
    if (!to) return;
    event.preventDefault();
    move(to[0] ?? r, to[1] ?? c);
  };

  const readout = shown ? rows[shown[0]] : undefined;
  const cell = shown ? readout?.cells[shown[1]] : undefined;

  return (
    <>
      <div className="relative -mx-5 overflow-x-auto px-5 sm:mx-0 sm:px-0">
        <table role="grid" aria-label="Status by provider and test. Use the arrow keys to move between tests." onKeyDown={onKeyDown} className="w-full min-w-[640px] border-separate border-spacing-y-1.5 text-[13px]">
          <thead>
            <tr className="text-left text-[11px] text-[var(--muted)]">
              <th scope="col" className="w-[8.5rem] pb-1 font-normal">Provider</th>
              <th scope="col" colSpan={width} className="pb-1 font-normal">Each test, in page order</th>
              <th scope="col" className="w-[6.5rem] pb-1 text-right font-normal">Succeeded</th>
            </tr>
          </thead>
          <tbody onMouseLeave={() => setShown(null)}>
            {rows.map((row, r) => (
              <tr key={row.id}>
                <th scope="row" className="pr-3 text-left font-medium" style={{ color: row.color }}>
                  {row.name}
                </th>
                {row.cells.map((c, i) => {
                  const current = at[0] === r && at[1] === i;
                  return (
                    <td
                      key={c.id}
                      ref={(el) => {
                        if (el) refs.current.set(`${r}:${i}`, el);
                      }}
                      tabIndex={current ? 0 : -1}
                      aria-label={`${row.name}, ${c.name}: ${c.text}`}
                      onFocus={() => {
                        setAt([r, i]);
                        setShown([r, i]);
                      }}
                      onMouseEnter={() => setShown([r, i])}
                      className="px-[1.5px] outline-none focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-[var(--foreground)]"
                    >
                      <span aria-hidden className={`block h-6 min-w-2 rounded-[3px] ${stateLook[c.state].className}`} />
                    </td>
                  );
                })}
                <td className="pl-3 text-right font-mono text-[12px] tabular-nums">{row.rate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p aria-live="polite" className="mt-2 min-h-[1.25rem] text-[12.5px] text-[var(--muted)]">
        {readout && cell ? (
          <>
            <span className="font-medium" style={{ color: readout.color }}>
              {readout.name}
            </span>{" "}
            · {cell.name}: {cell.text}
          </>
        ) : (
          "Point at or tab to a cell to see its counts."
        )}
      </p>
    </>
  );
}
