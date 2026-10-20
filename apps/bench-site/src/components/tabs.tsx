"use client";

import { useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

/** A row of text tabs over pre-rendered panels, with arrow-key navigation. */
export function Tabs({ tabs, label }: { tabs: readonly Tab[]; label: string }) {
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
    <div>
      <div
        role="tablist"
        aria-label={label}
        className="-mx-1 mb-6 flex flex-wrap gap-x-1 gap-y-1 border-b border-[var(--line)] pb-px"
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
              className={`-mb-px border-b-2 px-2.5 py-2 text-[13px] transition-colors duration-150 motion-reduce:transition-none ${
                selected
                  ? "border-[var(--foreground)] text-[var(--foreground)]"
                  : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]"
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
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
