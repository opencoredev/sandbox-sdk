"use client";

import { useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * A bordered card with a band of tabs along its top, as on Artificial
 * Analysis. Panels are pre-rendered; arrow keys, Home and End move between tabs.
 */
export function TabCard({ tabs, label }: { tabs: readonly Tab[]; label: string }) {
  const [active, setActive] = useState(tabs[0]?.id);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();
  const select = (index: number) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    setActive(tab.id);
    buttons.current[tabs.indexOf(tab)]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    const next = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--surface)]">
      <div
        role="tablist"
        aria-label={label}
        className="flex gap-1 overflow-x-auto rounded-t-xl border-b border-[var(--line)] bg-[var(--band)] p-2 [scrollbar-width:none]"
      >
        {tabs.map((tab, index) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              id={`${base}-${tab.id}-tab`}
              role="tab"
              type="button"
              tabIndex={selected ? 0 : -1}
              aria-selected={selected}
              aria-controls={`${base}-${tab.id}`}
              onClick={() => setActive(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-[13px] whitespace-nowrap transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-[var(--foreground)]/60 motion-reduce:transition-none ${
                selected
                  ? "bg-[var(--chip)] font-medium text-[var(--foreground)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${base}-${tab.id}`}
          role="tabpanel"
          tabIndex={0}
          aria-labelledby={`${base}-${tab.id}-tab`}
          hidden={tab.id !== active}
          className="rounded-b-xl p-5 outline-none focus-visible:ring-2 focus-visible:ring-[var(--foreground)]/60 focus-visible:ring-inset sm:p-7"
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}

/** The same card without tabs. */
export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-7 ${className}`}>{children}</div>
);
