import { Link } from "@tanstack/react-router";
import { BrandGlyph } from "./primitives";

const repoUrl = "https://github.com/opencoredev/sandbox-sdk";

const linkClass =
  "font-pixel text-[14px] text-[var(--landing-body)] transition-colors hover:text-[var(--landing-ink)]";

/** Full-bleed nav: the content rail starts below it, at the hero. */
export function LandingNav() {
  return (
    <nav className="flex h-[68px] items-center justify-between border-b border-[var(--landing-line)] px-6 min-[900px]:px-16">
      <Link
        className="flex items-center gap-3 font-pixel text-[15px] text-[var(--landing-ink)]"
        to="/"
      >
        <BrandGlyph />
        Sandbox SDK
      </Link>

      <div className="hidden items-center gap-9 min-[1024px]:flex">
        <Link className={linkClass} params={{ _splat: "" }} to="/docs/$">
          Docs
        </Link>
        <Link className={linkClass} params={{ _splat: "examples" }} to="/docs/$">
          Examples
        </Link>
        <Link className={linkClass} to="/compatibility">
          Compatibility
        </Link>
        <Link className={linkClass} to="/security">
          Security
        </Link>
      </div>

      <a
        className="inline-flex h-[38px] items-center border border-[rgba(255,255,255,0.16)] bg-transparent px-5 font-pixel text-[14px] text-[var(--landing-ink)] transition-colors hover:border-[rgba(255,255,255,0.32)]"
        href={repoUrl}
        rel="noreferrer"
        target="_blank"
      >
        GitHub
      </a>
    </nav>
  );
}
