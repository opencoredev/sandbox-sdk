"use client";

/*
 * Direction
 * Reference: Leo's Paper design for Sandbox SDK (hairline grid frame, pixel
 *   display type, square-dot halftones, amber brackets), and the ascii.rest
 *   scenes for the dot art.
 * Palette: ink #0b0b0c, panel #111214, hairline #23252a, text #ecebe8,
 *   muted #8d8e93, amber #e8a33c. Provider art carries its own colour.
 * Type: Geist Pixel Square for display, Geist Sans for prose, Geist Mono for code.
 * Layout: one 1280px frame of hairlines with crosshair joints; sections are
 *   cells in that frame, not floating cards.
 * Signature: the harbor at dusk, drawn in square pixels inside a bracketed
 *   viewport, like looking through a scope.
 * Avoiding: gradient blobs, pill badges, soft shadows, three equal icon cards,
 *   invented numbers.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { HalftoneCanvas } from "@/components/halftone/halftone-canvas";
import type { HalftoneStyle } from "@/components/halftone/halftone";
import { emberField } from "@/components/halftone/painters";

import { Code } from "./code";
import { HarborViewport } from "./harbor-viewport";
import styles from "./landing.module.css";
import { ProvidersCarousel } from "./providers-carousel";

const GITHUB = "https://github.com/opencoredev/sandbox-sdk";
const NPM = "https://www.npmjs.com/package/@opencoredev/sandbox-sdk";
const INSTALL = "bun add @opencoredev/sandbox-sdk";

const INK: readonly [number, number, number] = [0.043, 0.043, 0.047];
const HARBOR_DOTS: HalftoneStyle = {
  cell: 4.2,
  fill: 0.82,
  shape: "square",
  glow: 0.08,
  ground: INK,
};
const CARD_DOTS: HalftoneStyle = { cell: 5, fill: 0.8, shape: "square", glow: 0.12, ground: INK };
const EMBER_DOTS: HalftoneStyle = { cell: 13, fill: 0.62, shape: "square", glow: 0.4, ground: INK };

function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2 11V2h9" fill="none" stroke="currentColor" strokeWidth="3" />
      <path d="M18 9v9H9" fill="none" stroke="currentColor" strokeWidth="3" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.arrowIcon}>
      <path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={styles.githubIcon}>
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
      />
    </svg>
  );
}

function Brackets({ tone = "light" }: { tone?: "light" | "amber" }) {
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

function DocsButton() {
  return (
    <Link href="/docs" className={styles.primary}>
      Read the docs
      <Arrow />
    </Link>
  );
}

function CopyCommand({ command }: { command: string }) {
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

function Nav() {
  return (
    <header className={styles.navBar}>
      <nav className={styles.nav} aria-label="Primary">
        <Link href="/" className={styles.brand} aria-label="Sandbox SDK home">
          <Mark className={styles.brandMark} />
          <span>Sandbox SDK</span>
        </Link>
        <div className={styles.navLinks}>
          <Link href="/docs">Docs</Link>
          <Link href="/docs/providers">Providers</Link>
          <Link href="/compatibility">Compatibility</Link>
          <Link href="/security">Security</Link>
        </div>
        <a href={GITHUB} className={styles.navGithub} target="_blank" rel="noopener noreferrer">
          <GithubMark />
          GitHub
        </a>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <div className={styles.heroText}>
        <h1 id="hero-title" className={styles.display} data-reveal>
          One API for every agent sandbox.
        </h1>
        <p className={styles.lede} data-reveal>
          Run commands, move files, and open ports from TypeScript. Build on Local, then switch to
          E2B, Daytona, Vercel, or four more by changing one line.
        </p>
        <div className={styles.heroActions} data-reveal>
          <DocsButton />
          <a href={GITHUB} className={styles.secondary} target="_blank" rel="noopener noreferrer">
            <GithubMark />
            GitHub
          </a>
        </div>
      </div>

      <HarborViewport style={HARBOR_DOTS} brackets={<Brackets />} />

      <div className={styles.steps}>
        {[
          {
            label: "Install",
            code: INSTALL,
            note: "Local works out of the box. No account, no keys.",
          },
          {
            label: "Create",
            code: "await createSandbox({ provider: local() })",
            note: "await using stops it when the scope ends, even on errors",
          },
          {
            label: "Run",
            code: 'await sandbox.run("bun test")',
            note: "Get stdout, stderr, and the exit code back",
          },
        ].map((step) => (
          <div key={step.label} className={styles.step}>
            <p className={styles.eyebrow}>{step.label}</p>
            <code className={styles.stepCode}>{step.code}</code>
            <p className={styles.stepNote}>{step.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Providers() {
  return (
    <section className={styles.section} aria-labelledby="providers-title">
      <div className={styles.sectionHead}>
        <h2 id="providers-title" className={styles.title}>
          Eight providers. Switch any time.
        </h2>
        <p className={styles.sectionLede}>
          Build against Local on your laptop, then point the same code at E2B, Daytona, Vercel
          Sandbox, Upstash Box, Boat, Railway, or Tenki.
        </p>
      </div>
      <ProvidersCarousel style={CARD_DOTS} brackets={<Brackets />} arrow={<Arrow />} />
    </section>
  );
}

function Swap() {
  return (
    <section className={styles.section} aria-labelledby="swap-title">
      <div className={styles.sectionHead}>
        <h2 id="swap-title" className={styles.title}>
          Change one line. Keep the rest.
        </h2>
        <p className={styles.sectionLede}>
          The provider is the only thing that changes. Every call after createSandbox works the same
          everywhere.
        </p>
      </div>
      <div className={styles.codePair}>
        <div className={styles.panel}>
          <p className={styles.panelTitle}>quickstart.ts</p>
          <Code
            lines={[
              'import { createSandbox } from "@opencoredev/sandbox-sdk";',
              'import { local } from "@opencoredev/sandbox-sdk/local";',
              "",
              "await using sandbox = await createSandbox({ provider: local() });",
              "",
              'const result = await sandbox.run("node --version");',
              "console.log(result.stdout);",
            ]}
          />
        </div>
        <div className={styles.panel}>
          <p className={styles.panelTitle}>move to E2B</p>
          <Code
            lines={[
              '- import { local } from "@opencoredev/sandbox-sdk/local";',
              '+ import { e2b } from "@opencoredev/sandbox-sdk/e2b";',
              "",
              "- await using sandbox = await createSandbox({ provider: local() });",
              "+ await using sandbox = await createSandbox({ provider: e2b() });",
              "",
              'const result = await sandbox.run("node --version");',
              "console.log(result.stdout);",
            ]}
            muted={[6, 7]}
          />
        </div>
      </div>
    </section>
  );
}

const FEATURES: { title: string; body: string; lines: string[]; muted: number[] }[] = [
  {
    title: "Run commands",
    body: "Get stdout, stderr, and the exit code. Set the working directory, environment, timeout, or an abort signal.",
    lines: [
      'const build = await sandbox.run("bun run build", {',
      '  cwd: "app",',
      "  timeout: 60_000,",
      "});",
      "build.exitCode // 0",
    ],
    muted: [4],
  },
  {
    title: "Move files",
    body: "Write, read, list, and remove files, text or binary, with the same calls on every provider.",
    lines: [
      'await sandbox.files.write("src/app.ts", code);',
      'await sandbox.files.text("src/app.ts");',
      'await sandbox.files.list("src");',
      'await sandbox.files.exists("dist");',
    ],
    muted: [],
  },
  {
    title: "Processes and ports",
    body: "Start a dev server, stream its logs, and expose a port to get a preview URL. Each provider declares what it supports.",
    lines: [
      'const dev = await sandbox.processes.start("bun dev");',
      "for await (const event of dev.output()) {}",
      "",
      "const preview = await sandbox.ports.expose(3000);",
      "preview.url",
    ],
    muted: [4],
  },
];

function Features() {
  return (
    <section className={styles.features} aria-label="What the API covers">
      {FEATURES.map((f) => (
        <div key={f.title} className={styles.feature}>
          <div className={styles.featureText}>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
          <div className={styles.featureCode}>
            <Code lines={f.lines} muted={f.muted} />
          </div>
        </div>
      ))}
    </section>
  );
}

function Conformance() {
  return (
    <section className={styles.split} aria-labelledby="conformance-title">
      <div className={styles.splitText}>
        <h2 id="conformance-title" className={styles.title}>
          Proof it works the same everywhere.
        </h2>
        <p className={styles.sectionLede}>
          The package ships a 19-case conformance suite. Run it against any provider before you rely
          on it.
        </p>
        <ul className={styles.checks}>
          {[
            "Files, commands, processes, ports, and snapshots",
            "Unsupported features report as skipped, not failed",
            "Imported from @opencoredev/sandbox-sdk/testing",
          ].map((item) => (
            <li key={item}>
              <span className={styles.check} aria-hidden="true">
                <svg viewBox="0 0 12 12">
                  <path
                    d="M2.5 6.2 5 8.5l4.5-5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                </svg>
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
      <div className={styles.splitArt}>
        <div className={styles.terminal}>
          <Brackets tone="amber" />
          <p className={styles.panelTitle}>bun test</p>
          <ul className={styles.terminalBody}>
            {[
              "create and stop",
              "text files",
              "nonzero exit",
              "background process",
              "ports",
              "snapshot restore",
            ].map((name) => (
              <li key={name}>
                <span className={styles.pass}>✓</span> {name}
              </li>
            ))}
            <li className={styles.terminalMuted}>... 13 more cases</li>
            <li className={styles.terminalMuted}>0 failed on the Local provider</li>
          </ul>
        </div>
      </div>
    </section>
  );
}

function Closing() {
  return (
    <section className={styles.closing} aria-labelledby="closing-title">
      <HalftoneCanvas
        paint={emberField}
        style={EMBER_DOTS}
        fps={15}
        stillAt={2}
        className={styles.closingCanvas}
      />
      <div className={styles.closingText}>
        <h2 id="closing-title" className={styles.title}>
          Start local. Ship anywhere.
        </h2>
        <CopyCommand command={INSTALL} />
        <DocsButton />
      </div>
    </section>
  );
}

/* 5 by 7 bitmap letters for the footer wordmark */
const GLYPHS: Record<string, string[]> = {
  S: [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#", "#...#"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
  B: ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  O: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  X: ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
};

function Wordmark({ text }: { text: string }) {
  return (
    <div className={styles.wordmark} aria-hidden="true">
      {text.split("").map((ch, i) => (
        <div key={i} className={styles.glyph}>
          {(GLYPHS[ch] ?? []).flatMap((row, y) =>
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

function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  const external = href.startsWith("http");
  return external ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <Link href={href}>{children}</Link>
  );
}

function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerTop}>
        <div className={styles.footerBrand}>
          <Link href="/" className={styles.brand}>
            <Mark className={styles.brandMark} />
            <span>Sandbox SDK</span>
          </Link>
          <p>One TypeScript sandbox API across eight providers. MIT licensed, built by OpenCore.</p>
        </div>
        <div className={styles.footerCol}>
          <p className={styles.eyebrow}>Docs</p>
          <FooterLink href="/docs">Quickstart</FooterLink>
          <FooterLink href="/docs/providers">Providers</FooterLink>
          <FooterLink href="/docs/api/sandboxes">API reference</FooterLink>
          <FooterLink href="/docs/integrations">Integrations</FooterLink>
        </div>
        <div className={styles.footerCol}>
          <p className={styles.eyebrow}>Project</p>
          <FooterLink href={GITHUB}>GitHub</FooterLink>
          <FooterLink href="/compatibility">Compatibility</FooterLink>
          <FooterLink href="/security">Security</FooterLink>
          <FooterLink href={`${GITHUB}/releases`}>Releases</FooterLink>
        </div>
      </div>
      <div className={styles.footerRow}>
        {[
          { label: "GitHub", href: GITHUB },
          { label: "npm", href: NPM },
          { label: "Docs", href: "/docs" },
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

export default function HomePage() {
  const root = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = root.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.dataset.motion = "on";
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.setAttribute("data-shown", "");
          io.unobserve(e.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px" },
    );
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);

  return (
    <main ref={root} className={styles.page}>
      <a href="#content" className={styles.skipLink}>
        Skip to content
      </a>
      <Nav />
      <div className={styles.frame} id="content">
        <Hero />
        <div className={styles.hatch} aria-hidden="true" />
        <Providers />
        <Swap />
        <Features />
        <Conformance />
        <div className={styles.hatch} aria-hidden="true" />
        <Closing />
        <Footer />
      </div>
    </main>
  );
}
