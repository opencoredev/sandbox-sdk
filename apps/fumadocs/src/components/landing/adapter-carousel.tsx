/**
 * Focus-shift carousel. A side card, the focused card, and a second side card
 * fill the content rail edge to edge with a 24px gap between them.
 *
 * The approved design is defined at a 1152px stage: 322 + 24 + 460 + 24 + 322.
 * That puts the three slot centres on a uniform 415px pitch. The rail is fluid
 * (min(1152, 100vw - 48)), so the stage width is measured at runtime and the
 * horizontal geometry scales by that ratio, which keeps the row flush to both
 * rail lines at every viewport without ever widening the document.
 *
 * Vertical geometry is fixed, not scaled, so the block height matches the
 * artboard at every viewport. Card top 65.5, card box 330, dots 437.5, block
 * 509.5. Those live in styles/app.css.
 *
 * Layout classes live in styles/app.css.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { DitherField, type DitherPalette, type DitherVariant } from "./dither-field";

export interface AdapterSlide {
  id: string;
  /** Provider display name, e.g. "E2B". */
  name: string;
  /** One-line pitch shown on the focused card only. */
  headline: string;
  palette: DitherPalette;
  variant: DitherVariant;
  seed: number;
}

export interface AdapterCarouselProps {
  slides: AdapterSlide[];
  className?: string;
}

/** Stage geometry, in CSS pixels, at the reference stage width. */
const REFERENCE_WIDTH = 1152;
/** Distance between slot centres: 161, 576, 991. */
const SLOT_PITCH = 415;
const FOCUSED_WIDTH = 460;
const SIDE_WIDTH = 322;
const AUTOPLAY_MS = 3500;

type SlotState = "focused" | "side" | "parked";

interface Slot {
  state: SlotState;
  x: number;
  width: number;
  opacity: number;
}

/** Shortest signed distance from the focused index, wrapping both ways. */
function signedOffset(index: number, focus: number, count: number): number {
  const half = Math.floor(count / 2);
  return ((index - focus + count + half) % count) - half;
}

/**
 * Slot box for one card. The row leaves no margin inside the rail, so cards
 * beyond the visible three park just past the stage edge and slide in under
 * the rail line. The stage clips, so they never widen the document.
 */
function slotOf(offset: number, stageWidth: number, scale: number): Slot {
  const focusedWidth = FOCUSED_WIDTH * scale;
  const sideWidth = SIDE_WIDTH * scale;
  const centre = stageWidth / 2;

  if (offset === 0) {
    return { state: "focused", x: centre - focusedWidth / 2, width: focusedWidth, opacity: 1 };
  }
  if (offset === -1 || offset === 1) {
    const x = centre + offset * SLOT_PITCH * scale - sideWidth / 2;
    return { state: "side", x, width: sideWidth, opacity: 0.45 };
  }
  return {
    state: "parked",
    x: offset < 0 ? -sideWidth : stageWidth,
    width: sideWidth,
    opacity: 0,
  };
}

export function AdapterCarousel({ slides, className }: AdapterCarouselProps) {
  const count = slides.length;
  const [focus, setFocus] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  // Server render and first paint use the reference width, so the prerendered
  // markup already carries the approved geometry.
  const [stageWidth, setStageWidth] = useState(REFERENCE_WIDTH);
  const rootRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const labelId = useId();

  const go = useCallback(
    (next: number) => {
      if (count === 0) return;
      setFocus(((next % count) + count) % count);
    },
    [count],
  );

  useEffect(() => {
    if (focus >= count) setFocus(0);
  }, [count, focus]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof window === "undefined") return;
    const observer = new ResizeObserver(() => {
      setStageWidth(Math.max(1, Math.round(stage.getBoundingClientRect().width)));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof window === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "80px" },
    );
    observer.observe(root);

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncMotion = () => setReduceMotion(media.matches);
    syncMotion();
    media.addEventListener("change", syncMotion);

    return () => {
      observer.disconnect();
      media.removeEventListener("change", syncMotion);
    };
  }, []);

  const paused = hovered || focusWithin;

  useEffect(() => {
    if (count < 2 || paused || !onScreen || reduceMotion) return;
    const timer = window.setInterval(() => {
      setFocus((current) => (current + 1) % count);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [count, paused, onScreen, reduceMotion]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      go(focus + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(focus - 1);
    }
  };

  if (count === 0) return <div className={className} />;

  // Never scale past the approved size; only down, as the rail narrows.
  const scale = Math.min(1, stageWidth / REFERENCE_WIDTH);

  return (
    <section
      ref={rootRef}
      className={className}
      role="region"
      aria-roledescription="carousel"
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocusWithin(true)}
      onBlur={() => setFocusWithin(false)}
    >
      <h2 id={labelId} className="sr-only">
        Sandbox provider adapters
      </h2>

      <div className="adapter-stage" ref={stageRef}>
        <ul className="adapter-track" aria-live={paused ? "polite" : "off"}>
          {slides.map((slide, index) => {
            const offset = signedOffset(index, focus, count);
            const slot = slotOf(offset, stageWidth, scale);
            const isFocused = slot.state === "focused";
            const distance = Math.abs(offset);
            // The three visible cards all animate. One rank further out stays
            // mounted and static so an entering card is already painted.
            const mountsField = distance <= 2;
            return (
              <li
                key={slide.id}
                className="adapter-card"
                data-state={slot.state}
                aria-roledescription="slide"
                aria-label={`${index + 1} of ${count}`}
                aria-hidden={slot.state === "parked" ? true : undefined}
                style={
                  {
                    "--adapter-x": `${slot.x}px`,
                    "--adapter-w": `${slot.width}px`,
                    "--adapter-o": slot.opacity,
                  } as React.CSSProperties
                }
              >
                <div className="adapter-frame">
                  <div className="adapter-art">
                    {mountsField ? (
                      <DitherField
                        palette={slide.palette}
                        variant={slide.variant}
                        seed={slide.seed}
                        animate={distance <= 1}
                        cell={8}
                      />
                    ) : null}
                  </div>

                  <div className="adapter-copy adapter-copy-side" aria-hidden={isFocused}>
                    <span className="adapter-name-side font-pixel">{slide.name}</span>
                  </div>

                  <div className="adapter-copy adapter-copy-focused" aria-hidden={!isFocused}>
                    <div className="adapter-scrim" />
                    <div className="adapter-text">
                      <p className="adapter-name font-pixel">{slide.name}</p>
                      <p className="adapter-headline font-pixel">{slide.headline}</p>
                    </div>
                  </div>

                  {slot.state === "side" ? (
                    <button type="button" className="adapter-hit" onClick={() => go(index)}>
                      <span className="sr-only">{`Show ${slide.name}`}</span>
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="adapter-dots">
          {slides.map((slide, index) => (
            <button
              key={slide.id}
              type="button"
              className="adapter-dot"
              aria-current={index === focus}
              onClick={() => go(index)}
            >
              <span className="sr-only">{`Show ${slide.name}`}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
