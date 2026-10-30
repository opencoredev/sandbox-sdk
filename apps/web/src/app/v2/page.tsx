/*
 * Direction
 * Reference: the "Landing Page" artboard in Leo's Paper file "sandbox sdk",
 *   ported section by section, with the code samples moved to the 1.0 API.
 * Palette: the file's tokens. Ink #0a0a0c, surface #111216, hairline white 9%,
 *   body #c7cdd6, dim #697180, amber #efa43b.
 * Type: Geist Pixel Square for headings, Geist for prose, Geist Mono for code.
 * Layout: one 1154px hairline frame; each section is a cell in it, joined by
 *   crosshairs and hatched dividers.
 * Signature: the provider carousel behind amber-cornered brackets, and the
 *   ember halftone under the closing call to action.
 * Avoiding: gradient blobs, pill badges, soft shadows, invented numbers.
 */
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import landing from "../(home)/landing.module.css";
import { Arrow, Brackets, Footer, Nav } from "../(home)/parts";
import { CARD_DOTS, DOCS, INSTALL } from "../(home)/site";
import { ProvidersCarousel } from "../(home)/providers-carousel";
import { Closing } from "./closing";
import { FilesDiagram, LifecycleDiagram, RunDiagram, SwapDiagram, TestsDiagram } from "./diagrams";
import { Actions } from "./actions";
import styles from "./v2.module.css";

export const metadata: Metadata = {
  title: "Give your agent a sandbox",
  // a preview of the Paper design; the landing page at / stays canonical
  robots: { index: false, follow: false },
};

function Hero() {
  return (
    <section className={styles.hero} aria-labelledby="hero-title">
      <Link href={DOCS.quickstart} className={styles.intro}>
        <span className={styles.introDot} aria-hidden="true" />
        Introducing Sandbox SDK 1.0
        <Arrow />
      </Link>
      <h1 id="hero-title" className={styles.display}>
        Give your agent a sandbox.
      </h1>
      <p className={styles.heroLede}>
        Add an isolated sandbox to your app with one import. Commands, files, and git on 13
        providers.
      </p>
      <Actions />
    </section>
  );
}

const STEPS = [
  { label: "Install", code: INSTALL, note: "One package, every adapter included" },
  {
    label: "Create",
    code: "await using box = await createSandbox(e2b())",
    note: "Deleted when the scope exits",
  },
  { label: "Run", code: "await box.$`bun test`", note: "Commands, files, and git inside the VM" },
] as const;

/** Just enough highlighting for the one-line commands in the steps band: keywords, calls, strings and punctuation. */
const TOKEN =
  /(`[^`]*`|"[^"]*"|@[\w./-]+)|\b(await|using|const|bun|add)\b|([A-Za-z_$][\w$]*)(?=\()|([()=.;$])/g;

function highlight(code: string) {
  const parts: { text: string; kind: "str" | "kw" | "fn" | "punct" | "plain" }[] = [];
  let last = 0;

  for (const m of code.matchAll(TOKEN)) {
    if (m.index > last) parts.push({ text: code.slice(last, m.index), kind: "plain" });
    const kind = m[1] ? "str" : m[2] ? "kw" : m[3] ? "fn" : "punct";
    parts.push({ text: m[0], kind });
    last = m.index + m[0].length;
  }

  if (last < code.length) parts.push({ text: code.slice(last), kind: "plain" });

  return parts.map((p, i) => (
    <span key={i} className={styles[p.kind]}>
      {p.text}
    </span>
  ));
}

function Steps() {
  return (
    <div className={styles.steps}>
      {STEPS.map((s) => (
        <div key={s.label} className={styles.step}>
          <p className={styles.eyebrow}>{s.label}</p>
          <code className={styles.chip}>{highlight(s.code)}</code>
          <p className={styles.note}>{s.note}</p>
        </div>
      ))}
    </div>
  );
}

function Providers() {
  return (
    <section className={styles.cell} aria-labelledby="providers-title">
      <div className={styles.head}>
        <h2 id="providers-title" className={styles.title}>
          Local, cloud, or in-memory.
        </h2>
        <p className={styles.lede}>
          Develop on your machine with Docker, test in memory, ship to E2B, Daytona, Vercel,
          Upstash, Railway, Tenki and more. The API stays the same.
        </p>
      </div>
      <ProvidersCarousel dots={CARD_DOTS} brackets={<Brackets />} arrow={<Arrow />} />
    </section>
  );
}

function Swap() {
  return (
    <section className={styles.cell} aria-labelledby="swap-title">
      <div className={styles.head}>
        <h2 id="swap-title" className={styles.title}>
          Swap the adapter, keep the code.
        </h2>
        <p className={styles.lede}>
          Every adapter passes the same conformance suite. Moving providers is an import change, not
          a rewrite.
        </p>
      </div>
      <SwapDiagram />
    </section>
  );
}

const FEATURES: readonly { title: string; body: string; diagram: ReactNode }[] = [
  {
    title: "Run commands",
    body: "Shell commands with safe interpolation, streamed output and timeouts. A non-zero exit comes back as ok: false, not a throw.",
    diagram: <RunDiagram />,
  },
  {
    title: "Move files and repos",
    body: "Read, write, edit, search, upload and watch files. Clone and push with the token kept out of logs.",
    diagram: <FilesDiagram />,
  },
  {
    title: "Control the lifecycle",
    body: "Create, reconnect by id, list what is running, pause, snapshot or destroy. Each adapter declares what it supports.",
    diagram: <LifecycleDiagram />,
  },
];

function Features() {
  return (
    <section className={styles.trio} aria-label="What a sandbox can do">
      {FEATURES.map((f) => (
        <div key={f.title} className={styles.feature}>
          <div className={styles.featureHead}>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </div>
          {f.diagram}
        </div>
      ))}
    </section>
  );
}

function Tests() {
  return (
    <section className={styles.split} aria-labelledby="tests-title">
      <div className={styles.splitText}>
        <h2 id="tests-title" className={styles.title}>
          Tests run in-process.
        </h2>
        <p className={styles.lede}>
          memory() keeps the sandbox API inside your test process. Nothing to boot, nothing to pay
          for.
        </p>
        <ul className={styles.checks}>
          {[
            "The same API as the cloud adapters",
            "No API key and no network in CI",
            "Files, commands and processes, all in memory",
          ].map((item) => (
            <li key={item}>
              <span className={styles.check} aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="1.8" />
                </svg>
              </span>
              {item}
            </li>
          ))}
        </ul>
      </div>
      <TestsDiagram />
    </section>
  );
}

export default function V2Page() {
  return (
    <main className={`${landing.page} ${styles.page}`}>
      <a href="#content" className={landing.skipLink}>
        Skip to content
      </a>
      <Nav />
      <div className={landing.frame} id="content">
        <Hero />
        <Steps />
        <div className={landing.hatch} aria-hidden="true" />
        <Providers />
        <Swap />
        <Features />
        <Tests />
        <div className={landing.hatch} aria-hidden="true" />
        <Closing />
        <Footer />
      </div>
    </main>
  );
}
