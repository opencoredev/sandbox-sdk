"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The section pills in the header. The section under the header is marked
 * current and its pill scrolled into view on narrow screens.
 */
export function SectionNav({ sections }: { sections: readonly (readonly [id: string, label: string])[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    const update = () => {
      // The last section whose top has passed a line just under the sticky header.
      const line = 120;
      let found: string | null = null;
      for (const [id] of sections) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) found = id;
      }
      setCurrent(found);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [sections]);

  useEffect(() => {
    if (current) links.current.get(current)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current]);

  return (
    <nav aria-label="Sections" className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]">
      <div className="mx-auto flex w-max gap-0.5 rounded-full border border-[var(--line)] bg-[var(--band)] p-1">
        {sections.map(([id, label]) => {
          const active = id === current;
          return (
            <a
              key={id}
              ref={(el) => {
                if (el) links.current.set(id, el);
              }}
              href={`#${id}`}
              aria-current={active ? "location" : undefined}
              className={`rounded-full px-3 py-1 text-[13px] whitespace-nowrap transition-colors duration-150 motion-reduce:transition-none ${
                active
                  ? "bg-[var(--foreground)] font-medium text-[var(--background)]"
                  : "text-[var(--muted)] hover:bg-[var(--chip)] hover:text-[var(--foreground)]"
              }`}
            >
              {label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}
