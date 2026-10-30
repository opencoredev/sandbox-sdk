"use client";

/** Pieces of the landing page: links, the logo, buttons and the footer. */

import Link from "next/link";
import { useCallback, useState, type ReactNode } from "react";

import { logo, marks } from "../../../brand/marks";

import styles from "./landing.module.css";
import { DOCS, GITHUB, NPM, SECURITY } from "./site";

/** The logo mark picked in brand/marks.ts. */
export function Mark({ className }: { className?: string }) {
  const { path, rule } = marks[logo];

  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <path fill="currentColor" fillRule={rule} d={path} />
    </svg>
  );
}

export function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.arrowIcon}>
      <path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.githubIcon}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

export function Brackets({ tone = "light" }: { tone?: "light" | "amber" }) {
  return (
    <span
      className={`${styles.brackets} ${tone === "amber" ? styles.bracketsAmber : ""}`}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export function DocsButton() {
  return (
    <Link href={DOCS.quickstart} className={styles.primary}>
      Read the docs
      <Arrow />
    </Link>
  );
}

export function CopyCommand({ command }: { command: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setState("copied");
    } catch {
      // no clipboard access: say so, the command stays selectable
      setState("failed");
    }

    window.setTimeout(() => setState("idle"), 2000);
  }, [command]);

  return (
    <button type="button" className={styles.command} onClick={copy} aria-label={`Copy: ${command}`}>
      <span>{command}</span>
      <span className={styles.commandHint} aria-live="polite">
        {state === "copied" ? "copied" : state === "failed" ? "select to copy" : "copy"}
      </span>
    </button>
  );
}

export function Nav() {
  return (
    <header className={styles.navBar}>
      <nav className={styles.nav} aria-label="Primary">
        <Link href="/" className={styles.brand} aria-label="Sandbox SDK home">
          <Mark className={styles.brandMark} />
          <span>Sandbox SDK</span>
        </Link>
        <div className={styles.navLinks}>
          <Link href={DOCS.quickstart}>Docs</Link>
          <Link href={DOCS.providers}>Providers</Link>
          <a href={SECURITY} target="_blank" rel="noopener noreferrer">
            Security
          </a>
        </div>
        <a href={GITHUB} className={styles.navGithub} target="_blank" rel="noopener noreferrer">
          <GithubMark />
          GitHub
        </a>
      </nav>
    </header>
  );
}

/* 5 by 7 bitmap letters for the footer wordmark */
const GLYPHS = {
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
} as const satisfies Record<string, readonly string[]>;

type GlyphLetter = keyof typeof GLYPHS;

function isGlyphLetter(letter: string): letter is GlyphLetter {
  return Object.hasOwn(GLYPHS, letter);
}

/** The rows of one letter, or none for a letter the wordmark has no glyph for. */
function glyphRows(letter: string): readonly string[] {
  return isGlyphLetter(letter) ? GLYPHS[letter] : [];
}

export function Wordmark({ text }: { text: string }) {
  return (
    <div className={styles.wordmark} aria-hidden="true">
      {text.split("").map((ch, i) => (
        <div key={i} className={styles.glyph}>
          {glyphRows(ch).flatMap((row, y) =>
            row
              .split("")
              .map((c, x) => (
                <span key={`${x}-${y}`} className={c === "#" ? styles.on : undefined} />
              )),
          )}
        </div>
      ))}
    </div>
  );
}

export function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");

  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <Link href={href}>{children}</Link>
  );
}

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerTop}>
        <div className={styles.footerBrand}>
          <Link href="/" className={styles.brand}>
            <Mark className={styles.brandMark} />
            <span>Sandbox SDK</span>
          </Link>
          <p>
            A TypeScript SDK for sandboxes on Docker, agentOS, E2B, Vercel, Daytona, Upstash,
            Railway, Boat, Tenki, boxd, and Freestyle. MIT licensed, built by OpenCore.
          </p>
        </div>
        <div className={styles.footerCol}>
          <p className={styles.eyebrow}>Docs</p>
          <FooterLink href={DOCS.quickstart}>Quickstart</FooterLink>
          <FooterLink href={DOCS.providers}>Providers</FooterLink>
        </div>
        <div className={styles.footerCol}>
          <p className={styles.eyebrow}>Project</p>
          <FooterLink href={GITHUB}>GitHub</FooterLink>
          <FooterLink href={SECURITY}>Security</FooterLink>
          <FooterLink href={`${GITHUB}/releases`}>Releases</FooterLink>
        </div>
      </div>
      <div className={styles.footerRow}>
        {[
          { label: "GitHub", href: GITHUB },
          { label: "npm", href: NPM },
          { label: "Docs", href: DOCS.quickstart },
        ].map((l) => (
          <FooterLink key={l.label} href={l.href}>
            {l.label}
            <Arrow />
          </FooterLink>
        ))}
      </div>
      <Wordmark text="SANDBOX" />
      <div className={styles.footerBase}>
        <span>2026 OpenCore</span>
        <span>MIT License</span>
      </div>
    </footer>
  );
}
