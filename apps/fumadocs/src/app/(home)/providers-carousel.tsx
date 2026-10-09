"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { HalftoneCanvas } from "@/components/halftone/halftone-canvas";
import type { HalftoneStyle } from "@/components/halftone/halftone";
import { providerArt } from "@/components/halftone/painters";

import styles from "./landing.module.css";

const N = providerArt.length;
// three copies of the cards: the reader always sits in the middle one, and
// when a scroll settles in an outer copy the track jumps back by one set
const COPIES = 3;
const SLIDES = Array.from({ length: N * COPIES }, (_, i) => i);
const DOT_PITCH = 28;

interface Props {
  style: HalftoneStyle;
  brackets: ReactNode;
  arrow: ReactNode;
}

/** The provider cards as an endless, scroll-snapped carousel. */
export function ProvidersCarousel({ style, brackets, arrow }: Props) {
  const track = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLSpanElement>(null);
  const [current, setCurrent] = useState(N + 1);
  const currentRef = useRef(current);
  currentRef.current = current;
  const active = current % N;

  /** Card geometry, measured from the first two slides. */
  const geometry = useCallback(() => {
    const el = track.current;
    const a = el?.children[0];
    const b = el?.children[1];
    if (!el || !(a instanceof HTMLElement) || !(b instanceof HTMLElement)) return null;
    const pitch = b.offsetLeft - a.offsetLeft;
    const inset = (el.clientWidth - a.clientWidth) / 2;
    return { el, pitch, start: a.offsetLeft - inset };
  }, []);

  const go = useCallback(
    (index: number, smooth = true) => {
      const g = geometry();
      if (!g) return;
      const motion = smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      g.el.scrollTo({ left: g.start + index * g.pitch, behavior: motion ? "smooth" : "auto" });
    },
    [geometry],
  );

  /** Go to provider `n` by the shortest way round from where we are. */
  const goTo = useCallback(
    (n: number) => {
      const here = currentRef.current;
      let target = here - (here % N) + n;
      if (target - here > N / 2) target -= N;
      if (here - target > N / 2) target += N;
      go(target);
    },
    [go],
  );

  useEffect(() => {
    const g = geometry();
    if (!g) return;
    const { el } = g;
    el.scrollLeft = g.start + (N + 1) * g.pitch;

    let frame = 0;
    let settle = 0;
    const update = () => {
      frame = 0;
      const m = geometry();
      if (!m) return;
      const pos = (el.scrollLeft - m.start) / m.pitch;
      // fade and shrink each card by its distance from the centre, continuously
      Array.from(el.children).forEach((c, i) => {
        if (c instanceof HTMLElement)
          c.style.setProperty("--d", Math.min(1, Math.abs(i - pos)).toFixed(3));
      });
      if (indicator.current) {
        const wrapped = ((pos % N) + N) % N;
        // past the last dot, slide back toward the first instead of overshooting
        const x = wrapped > N - 1 ? (N - 1) * (N - wrapped) : wrapped;
        indicator.current.style.transform = `translateX(${(x * DOT_PITCH).toFixed(1)}px)`;
      }
      const nearest = Math.round(pos);
      if (nearest !== currentRef.current) setCurrent(nearest);
    };
    const recentre = () => {
      const m = geometry();
      if (!m) return;
      const nearest = Math.round((el.scrollLeft - m.start) / m.pitch);
      if (nearest < N || nearest >= 2 * N) {
        const shift = nearest < N ? N : -N;
        el.scrollLeft += shift * m.pitch;
        setCurrent(nearest + shift);
      }
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
      window.clearTimeout(settle);
      settle = window.setTimeout(recentre, 160);
    };
    update();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(settle);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [geometry]);

  return (
    <>
      <div
        className={styles.carousel}
        ref={track}
        tabIndex={0}
        role="region"
        aria-roledescription="carousel"
        aria-label="Providers"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") go(current + 1);
          if (e.key === "ArrowLeft") go(current - 1);
        }}
      >
        {SLIDES.map((i) => {
          const p = providerArt[i % N];
          const isCurrent = i === current;
          const clone = Math.floor(i / N) !== 1;
          return (
            <article
              key={i}
              className={`${styles.card} ${isCurrent ? styles.cardActive : ""}`}
              aria-roledescription="slide"
              aria-label={`${(i % N) + 1} of ${N}: ${p.name}`}
              aria-hidden={clone || undefined}
            >
              <div className={styles.cardArt}>
                {/* only the cards in view get a WebGL canvas, so the page holds at most five */}
                {Math.abs(i - current) <= 1 && (
                  <HalftoneCanvas
                    paint={p.paint}
                    style={style}
                    fps={30}
                    stillAt={3}
                    className={styles.cardCanvas}
                  />
                )}
              </div>
              <div className={styles.cardText}>
                <p className={styles.cardName}>{p.name}</p>
                <p className={styles.cardLine}>{p.line}</p>
                <Link href={p.href} className={styles.cardLink} tabIndex={isCurrent ? 0 : -1}>
                  Provider guide {arrow}
                </Link>
              </div>
              {isCurrent ? (
                brackets
              ) : (
                <button
                  type="button"
                  className={styles.cardSelect}
                  onClick={() => go(i)}
                  aria-label={`Show ${p.name}`}
                  tabIndex={clone ? -1 : 0}
                />
              )}
            </article>
          );
        })}
      </div>
      <div className={styles.dots} role="group" aria-label="Choose a provider">
        <span ref={indicator} className={styles.dotIndicator} aria-hidden="true" />
        {providerArt.map((p, n) => (
          <button
            key={p.id}
            type="button"
            className={styles.dot}
            aria-label={p.name}
            aria-current={n === active}
            onClick={() => goTo(n)}
          />
        ))}
      </div>
    </>
  );
}
