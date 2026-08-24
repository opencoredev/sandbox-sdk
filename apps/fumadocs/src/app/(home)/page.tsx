"use client";

import { useGSAP } from "@gsap/react";
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Folder01Icon,
  GithubIcon,
  Globe02Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Image from "next/image";
import Link from "next/link";
import { useRef } from "react";

import { BrandMark } from "@/components/brand-mark";
import { JsonLd } from "@/components/json-ld";
import { faqs, faqSchema } from "@/lib/seo";

import styles from "./landing.module.css";

const providerCards = [
  {
    name: "Local",
    href: "/docs/providers/local",
    runtime: "AgentOS VM",
    blurb: "Development, CI, and self-hosting with no hosted provider account.",
  },
  {
    name: "E2B",
    href: "/docs/providers/e2b",
    runtime: "Hosted Linux sandbox",
    blurb: "Coding agents and isolated jobs on E2B infrastructure.",
  },
  {
    name: "Daytona",
    href: "/docs/providers/daytona",
    runtime: "Cloud workspace",
    blurb: "Persistent projects and GPU-backed workspaces.",
  },
  {
    name: "Vercel Sandbox",
    href: "/docs/providers/vercel",
    runtime: "Hosted Linux sandbox",
    blurb: "Coding agents and persistent workspaces on Fluid Compute.",
  },
  {
    name: "Upstash Box",
    href: "/docs/providers/upstash",
    runtime: "Durable cloud container",
    blurb: "Serverless agents and long-lived state.",
  },
  {
    name: "Ascii Box",
    href: "/docs/providers/box",
    runtime: "Persistent cloud VM",
    blurb: "Full VMs and protected application previews.",
  },
  {
    name: "Railway",
    href: "/docs/providers/railway",
    runtime: "Ephemeral cloud VM",
    blurb: "Durable jobs and private networking.",
  },
];

gsap.registerPlugin(useGSAP, ScrollTrigger);

export default function HomePage() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduceMotion) return;

      gsap.from("[data-hero-reveal]", {
        y: 28,
        opacity: 0,
        duration: 1,
        stagger: 0.09,
        ease: "power4.out",
      });

      gsap.to("[data-hero-bg]", {
        scale: 1.035,
        yPercent: -1.5,
        ease: "none",
        scrollTrigger: {
          trigger: "[data-hero]",
          start: "top top",
          end: "bottom top",
          scrub: 1,
        },
      });
    },
    { scope: root },
  );

  return (
    <main ref={root} className={styles.page}>
      <a href="#content" className={styles.skipLink}>
        Skip to content
      </a>

      <section className={styles.hero} data-hero>
        <div className={styles.heroBackground} data-hero-bg aria-hidden="true" />
        <div className={styles.heroShade} aria-hidden="true" />

        <nav className={styles.nav} aria-label="Primary navigation" data-hero-reveal>
          <Link href="/" className={styles.navBrand} aria-label="Sandbox SDK home">
            <BrandMark className={styles.navLogo} />
            <span>Sandbox SDK</span>
          </Link>
          <div className={styles.navMenu}>
            <Link href="/docs">Docs</Link>
            <Link href="/docs/providers">Providers</Link>
            <Link href="/docs/integrations">Integrations</Link>
          </div>
          <div className={styles.navActions}>
            <Link href="/docs" className={styles.navCta}>
              Get started <span aria-hidden="true">↗</span>
            </Link>
          </div>
        </nav>

        <div className={styles.productHunt} data-hero-reveal>
          <a
            href="https://www.producthunt.com/products/sandbox-sdk?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-sandbox-sdk"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="View Sandbox SDK on Product Hunt"
          >
            <Image
              src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1197855&theme=neutral&t=1784182645832"
              alt="Sandbox SDK — One TypeScript SDK for every sandbox provider on Product Hunt"
              width={250}
              height={54}
              unoptimized
            />
          </a>
        </div>

        <div className={styles.heroContent} id="content">
          <p className={styles.heroKicker} data-hero-reveal>
            Sandbox SDK
          </p>
          <h1 data-hero-reveal>
            One sandbox API.
            <br />
            Every provider.
          </h1>
          <p className={styles.heroCopy} data-hero-reveal>
            Sandbox SDK is the open-source TypeScript SDK for running code in isolated sandboxes.
            Run commands, stream processes, move files, and expose ports through one typed interface
            — on Local, E2B, Daytona, Vercel Sandbox, Upstash Box, Ascii Box, or Railway.
          </p>
          <div className={styles.heroActions} data-hero-reveal>
            <a
              href="https://github.com/opencoredev/sandbox-sdk"
              className={styles.secondaryButton}
              target="_blank"
              rel="noopener noreferrer"
            >
              <HugeiconsIcon icon={GithubIcon} size={17} strokeWidth={2} aria-hidden="true" />
              GitHub
              <span aria-hidden="true">›</span>
            </a>
            <Link href="/docs" className={styles.primaryButton}>
              Start building <HugeiconsIcon icon={ArrowRight01Icon} size={18} strokeWidth={2} />
            </Link>
          </div>
        </div>
      </section>

      <section className={styles.statement} id="capabilities">
        <p className={styles.kicker}>The contract stays put</p>
        <h2>
          Switch the runtime.
          <br />
          Not your application.
        </h2>
        <p className={styles.statementCopy}>
          Sandbox SDK gives every provider the same small, typed vocabulary while preserving the
          native SDK underneath.
        </p>
      </section>

      <section className={styles.proofGrid} aria-label="SDK capabilities">
        <article className={`${styles.proofPanel} ${styles.codePanel}`}>
          <div className={styles.panelTop}>
            <span>one interface</span>
            <span>TypeScript</span>
          </div>
          <pre>
            <code>
              <span>await using</span> sandbox = <span>await</span> createSandbox({`{`}
              {"\n"}
              {"  "}provider: e2b(),{"\n"}
              {`}`});
              {"\n"}
              <i>const</i> result = <span>await</span> sandbox.run({"\n"}
              {"  "}
              <b>&quot;pnpm test&quot;</b>,{"\n"}
              );
            </code>
          </pre>
          <div className={styles.codeResult}>
            <HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} strokeWidth={2} /> same API,
            native runtime
          </div>
        </article>

        <article className={`${styles.proofPanel} ${styles.switchPanel}`}>
          <p>Change one line.</p>
          <div className={styles.switchCode}>
            <del>local()</del>
            <HugeiconsIcon icon={ArrowRight01Icon} size={17} />
            <ins>e2b()</ins>
          </div>
          <span>No application rewrite.</span>
        </article>

        <article className={styles.proofPanel}>
          <HugeiconsIcon icon={TerminalIcon} size={28} strokeWidth={1.5} />
          <h3>Processes</h3>
          <p>Real exit codes, byte streams, abort signals, and idempotent cleanup.</p>
        </article>
        <article className={styles.proofPanel}>
          <HugeiconsIcon icon={Folder01Icon} size={28} strokeWidth={1.5} />
          <h3>Files</h3>
          <p>Read, write, seed, resolve, and remove paths across every runtime.</p>
        </article>
        <article className={styles.proofPanel}>
          <HugeiconsIcon icon={Globe02Icon} size={28} strokeWidth={1.5} />
          <h3>Sessions</h3>
          <p>Expose ports, inspect capabilities, and keep lifecycle ownership explicit.</p>
        </article>
      </section>

      <section className={styles.providers} id="providers" aria-labelledby="providers-heading">
        <p className={styles.kicker}>Supported providers</p>
        <h2 id="providers-heading">Every sandbox provider, one SDK.</h2>
        <p className={styles.sectionCopy}>
          Local ships with the package. Cloud providers use their official SDKs and your own
          credentials, so nothing is proxied through us.
        </p>
        <ul className={styles.providerGrid}>
          {providerCards.map((provider) => (
            <li key={provider.href}>
              <Link href={provider.href}>
                <h3>{provider.name}</h3>
                <span>{provider.runtime}</span>
                <p>{provider.blurb}</p>
              </Link>
            </li>
          ))}
        </ul>
        <div className={styles.sectionLinks}>
          <Link href="/compatibility">Compatibility matrix</Link>
          <Link href="/docs/integrations">AI SDK &amp; agent integrations</Link>
          <Link href="/security">Security model</Link>
        </div>
      </section>

      <section className={styles.faq} aria-labelledby="faq-heading">
        <JsonLd data={faqSchema} />
        <p className={styles.kicker}>Questions</p>
        <h2 id="faq-heading">Sandbox SDK, answered.</h2>
        <div className={styles.faqList}>
          {faqs.map((faq) => (
            <details className={styles.faqItem} key={faq.question}>
              <summary>
                <h3>{faq.question}</h3>
              </summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </section>

      <footer className={styles.footer}>
        <div className={styles.footerCta}>
          <h2>
            Pick the runtime.
            <br />
            Keep the code.
          </h2>
          <Link href="/docs" className={styles.footerButton}>
            Read the docs <HugeiconsIcon icon={ArrowRight01Icon} size={20} strokeWidth={2} />
          </Link>
        </div>
        <div className={styles.footerBar}>
          <Link href="/" className={styles.brand}>
            <BrandMark className={styles.brandMark} />
            <span className={styles.wordmark}>Sandbox</span>
          </Link>
          <div>
            <Link href="/docs">Documentation</Link>
            <Link href="/docs/providers">Providers</Link>
            <Link href="/docs/integrations">Integrations</Link>
            <Link href="/compatibility">Compatibility</Link>
            <Link href="/security">Security</Link>
            <a href="https://github.com/opencoredev/sandbox-sdk">GitHub</a>
            <a href="https://www.npmjs.com/package/@opencoredev/sandbox-sdk">npm</a>
          </div>
          <span>MIT licensed</span>
        </div>
      </footer>
    </main>
  );
}
