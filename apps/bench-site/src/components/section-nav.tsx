"use client";

import { useEffect, useId, useRef, useState } from "react";

import { useScrollFade } from "@/components/tabs";

type Sections = readonly (readonly [id: string, label: string])[];

/** The section whose top has passed a line just under the sticky header, or the last one at the bottom of the page. */
function useCurrentSection(sections: Sections) {
  const [current, setCurrent] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      const line = 120;
      let found: string | null = null;
      for (const [id] of sections) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) found = id;
      }
      // At the bottom the last section may never reach the line; it is the one in view.
      const bottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setCurrent(bottom ? (sections.at(-1)?.[0] ?? found) : found);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [sections]);
  return current;
}

/**
 * Section navigation. Wide screens get a row of pills with the current one
 * filled; narrower screens get one button naming the current section that
 * opens a full-width menu, so nothing hides off the edge.
 */
export function SectionNav({ sections, extra }: { sections: Sections; extra?: { href: string; label: string } }) {
  const current = useCurrentSection(sections);
  const scroller = useScrollFade<HTMLElement>();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useId();
  const currentLabel = sections.find(([id]) => id === current)?.[1] ?? "Sections";

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      const outside = !(event.target instanceof Node && menu.current?.contains(event.target));
      if (event instanceof KeyboardEvent ? event.key === "Escape" : outside) {
        setOpen(false);
        if (event instanceof KeyboardEvent) button.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("pointerdown", close);
    };
  }, [open]);

  return (
    <>
      <nav ref={scroller} aria-label="Sections" className="scroll-fade hidden min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] lg:block">
        <div className="mx-auto flex w-max gap-0.5 rounded-full border border-[var(--line)] bg-[var(--band)] p-1">
          {sections.map(([id, label]) => {
            const active = id === current;
            return (
              <a
                key={id}
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

      <div ref={menu} className="ml-auto lg:hidden">
        <button
          ref={button}
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((o) => !o)}
          className="flex h-10 items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--band)] px-4 text-[13.5px] font-medium"
        >
          <span className="max-w-[11rem] truncate">{currentLabel}</span>
          <span aria-hidden className={`text-[var(--muted)] transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`}>
            ▾
          </span>
          <span className="sr-only">, open the section menu</span>
        </button>
        {open ? (
          <div id={panel} className="absolute inset-x-0 top-full border-b border-[var(--line)] bg-[var(--background)] px-4 pt-2 pb-4 shadow-[0_16px_32px_rgb(0_0_0/0.6)] sm:px-6">
            <nav aria-label="Sections">
              <ul className="grid grid-cols-2 gap-1">
                {sections.map(([id, label]) => (
                  <li key={id}>
                    <a
                      href={`#${id}`}
                      onClick={() => setOpen(false)}
                      aria-current={id === current ? "location" : undefined}
                      className={`flex h-11 items-center rounded-lg px-3 text-[14.5px] ${
                        id === current ? "bg-[var(--chip)] font-medium" : "text-[var(--muted)] active:bg-[var(--band)]"
                      }`}
                    >
                      {label}
                    </a>
                  </li>
                ))}
                {extra ? (
                  <li>
                    <a href={extra.href} onClick={() => setOpen(false)} className="flex h-11 items-center rounded-lg px-3 text-[14.5px] text-[var(--muted)] active:bg-[var(--band)]">
                      {extra.label}
                    </a>
                  </li>
                ) : null}
              </ul>
            </nav>
          </div>
        ) : null}
      </div>
    </>
  );
}
