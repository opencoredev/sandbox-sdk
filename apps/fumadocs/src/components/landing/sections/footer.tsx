import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ArrowRight, BrandGlyph, Label, Rail } from "./primitives";

const repoUrl = "https://github.com/opencoredev/sandbox-sdk";
const npmUrl = "https://www.npmjs.com/package/@opencoredev/sandbox-sdk";

type FooterEntry =
  | { kind: "docs"; label: string; splat: string }
  | { kind: "compatibility" | "security"; label: string }
  | { kind: "external"; label: string; href: string };

const docsColumn: FooterEntry[] = [
  { kind: "docs", label: "Quickstart", splat: "get-started/install" },
  { kind: "docs", label: "Providers", splat: "providers" },
  { kind: "docs", label: "API reference", splat: "api/sandboxes" },
  { kind: "docs", label: "Examples", splat: "examples" },
];

const projectColumn: FooterEntry[] = [
  { kind: "external", label: "GitHub", href: repoUrl },
  { kind: "compatibility", label: "Compatibility" },
  { kind: "security", label: "Security" },
  { kind: "external", label: "Releases", href: `${repoUrl}/releases` },
];

const jumpRow: FooterEntry[] = [
  { kind: "external", label: "GitHub", href: repoUrl },
  { kind: "external", label: "npm", href: npmUrl },
  { kind: "docs", label: "Docs", splat: "" },
];

function EntryLink({
  entry,
  className,
  children,
}: {
  entry: FooterEntry;
  className?: string;
  children?: ReactNode;
}) {
  const content = children ?? entry.label;

  switch (entry.kind) {
    case "docs":
      return (
        <Link className={className} params={{ _splat: entry.splat }} to="/docs/$">
          {content}
        </Link>
      );
    case "compatibility":
      return (
        <Link className={className} to="/compatibility">
          {content}
        </Link>
      );
    case "security":
      return (
        <Link className={className} to="/security">
          {content}
        </Link>
      );
    default:
      return (
        <a className={className} href={entry.href} rel="noreferrer" target="_blank">
          {content}
        </a>
      );
  }
}

const columnLinkClass =
  "font-pixel text-[14px] leading-none text-[var(--landing-body)] transition-colors hover:text-[var(--landing-ink)]";

function FooterColumn({ label, entries }: { label: string; entries: FooterEntry[] }) {
  return (
    <div className="min-w-0 px-6 pt-[52px] pb-[52px] min-[900px]:px-10">
      <Label>{label}</Label>
      <ul className="mt-[21px] flex flex-col gap-[22px]">
        {entries.map((entry) => (
          <li className="text-[14px] leading-none" key={entry.label}>
            <EntryLink className={columnLinkClass} entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LandingFooter() {
  return (
    <footer>
      <Rail className="border-t border-[var(--landing-line)]">
        {/* Column widths follow the artboard: 632 / 260 / 261. */}
        <div className="grid grid-cols-1 divide-y divide-[var(--landing-line)] min-[900px]:grid-cols-[632fr_260fr_261fr] min-[900px]:divide-x min-[900px]:divide-y-0">
          <div className="min-w-0 px-6 pt-[48px] pb-10 min-[900px]:px-16">
            <div className="flex items-center gap-3 font-pixel text-[15px] text-[var(--landing-ink)]">
              <BrandGlyph />
              Sandbox SDK
            </div>
            <p className="mt-[18px] max-w-[300px] font-pixel text-[14px] leading-[20.5px] text-[var(--landing-muted)]">
              One TypeScript sandbox API across nine providers. MIT licensed, built by OpenCore.
            </p>
          </div>

          <FooterColumn entries={docsColumn} label="Docs" />
          <FooterColumn entries={projectColumn} label="Project" />
        </div>

        <div className="grid grid-cols-1 divide-y divide-[var(--landing-line)] border-t border-[var(--landing-line)] min-[900px]:grid-cols-3 min-[900px]:divide-x min-[900px]:divide-y-0">
          {jumpRow.map((entry) => (
            <EntryLink
              className="flex h-16 min-w-0 items-center justify-between px-6 font-pixel text-[14px] text-[var(--landing-body)] transition-colors hover:text-[var(--landing-ink)] min-[900px]:px-8"
              entry={entry}
              key={`jump-${entry.label}`}
            >
              <span>{entry.label}</span>
              <ArrowRight className="text-[var(--landing-muted)]" />
            </EntryLink>
          ))}
        </div>

        <div className="flex h-[260px] items-center justify-center overflow-hidden border-t border-[var(--landing-line)]">
          <span
            aria-hidden="true"
            className="font-pixel-grid text-[100px] leading-none whitespace-nowrap text-[#17181C] min-[700px]:text-[231px]"
            style={{ letterSpacing: "-0.011em" }}
          >
            SANDBOX
          </span>
        </div>

        <div className="flex h-14 items-center justify-between border-t border-[var(--landing-line)] px-6 font-pixel text-[13px] text-[var(--landing-dim)] min-[900px]:px-8">
          <span>2026 OpenCore</span>
          <span>MIT License</span>
        </div>
      </Rail>
    </footer>
  );
}
