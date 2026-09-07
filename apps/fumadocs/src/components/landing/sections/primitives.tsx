import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Shared structure for the landing page: the centered content rail, its corner
 * plus markers, the hatch divider band, and the small marks reused by sections.
 */

/** Centered 1152px rail with hairline left and right borders. */
export function Rail({
  children,
  className,
  crosses = true,
}: {
  children: ReactNode;
  className?: string;
  crosses?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-6">
      <div className={cn("relative border-x border-[var(--landing-line)]", className)}>
        {crosses ? (
          <>
            <Cross corner="left" />
            <Cross corner="right" />
          </>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** 11x11 plus marker centered on a rail line. */
export function Cross({ corner }: { corner: "left" | "right" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute -top-[5.5px] z-10 block size-[11px]",
        corner === "left" ? "-left-[6px]" : "-right-[6px]",
      )}
    >
      <span className="absolute top-0 left-1/2 h-full w-px -translate-x-1/2 bg-white/40" />
      <span className="absolute top-1/2 left-0 h-px w-full -translate-y-1/2 bg-white/40" />
    </span>
  );
}

/**
 * 45-degree stripes: a 9.9px gradient period with a 1.95px stripe reads as a
 * 14px horizontal period with hairline stripes, matching the artboard.
 */
const hatch =
  "repeating-linear-gradient(45deg, #1A1B1E 0 1.95px, #0A0A0C 1.95px 9.9px)";

/** 56px band of 45-degree stripes. */
export function HatchDivider() {
  return (
    <Rail className="h-[57px] border-y border-[var(--landing-line)]" crosses={false}>
      <span
        aria-hidden="true"
        className="absolute inset-0 block"
        style={{ backgroundImage: hatch }}
      />
    </Rail>
  );
}

/** Two amber viewfinder corners in a 16x16 box. */
export function BrandGlyph({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative block size-4 shrink-0", className)}>
      <span className="absolute top-0 left-0 size-2 border-t-2 border-l-2 border-[var(--landing-accent)]" />
      <span className="absolute top-2 left-2 size-2 border-r-2 border-b-2 border-[var(--landing-accent)]" />
    </span>
  );
}

/** 14x14 amber viewfinder brackets pinned 7px outside a panel. */
export function PanelBrackets() {
  const arm = "absolute block size-[14px] border-[var(--landing-accent)]";
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 block">
      <span className={cn(arm, "-top-[7px] -left-[7px] border-t-2 border-l-2")} />
      <span className={cn(arm, "-top-[7px] -right-[7px] border-t-2 border-r-2")} />
      <span className={cn(arm, "-bottom-[7px] -left-[7px] border-b-2 border-l-2")} />
      <span className={cn(arm, "-right-[7px] -bottom-[7px] border-r-2 border-b-2")} />
    </span>
  );
}

export function ArrowRight({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 16 16"
      width={size}
    >
      <path
        d="M0.75 8h14.4M10.75 3.25 15.5 8l-4.75 4.75"
        stroke="currentColor"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function CheckMark({ className, size = 10 }: { className?: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 10 10"
      width={size}
    >
      <path
        d="M1.8 5.2 4 7.4 8.2 2.9"
        stroke="currentColor"
        strokeLinecap="square"
        strokeWidth="1.5"
      />
    </svg>
  );
}

/** The single call to action used by the hero and the CTA band. */
export function ReadDocsButton({ className }: { className?: string }) {
  return (
    <Link
      className={cn(
        "inline-flex h-[46px] items-center gap-[18px] border border-[rgba(255,255,255,0.16)] bg-[var(--landing-chip)] pr-[7px] pl-5 font-pixel text-[15px] text-[var(--landing-ink)] transition-colors hover:border-[rgba(255,255,255,0.3)]",
        className,
      )}
      params={{ _splat: "" }}
      to="/docs/$"
    >
      Read the docs
      <span className="flex size-8 items-center justify-center bg-[var(--landing-accent)] text-[var(--landing-accent-ink)]">
        <ArrowRight />
      </span>
    </Link>
  );
}

/** Uppercase tracked label used by section chips and column headers. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "font-pixel text-[11px] leading-none tracking-[0.16em] text-[var(--landing-dim)] uppercase",
        className,
      )}
    >
      {children}
    </p>
  );
}
