"use client";

/*
 * A small pixel-art canvas: scenes draw on a coarse grid (one unit is one
 * pixel) and the browser scales it up without smoothing, so every shape stays
 * a crisp square block, like the Geist Pixel headings. It animates only while
 * on screen and holds a single frame under prefers-reduced-motion.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import styles from "./diagrams.module.css";

export type Draw = (g: Grid, t: number) => void;

/** Drawing helpers on the grid. Coordinates are whole grid units. */
export interface Grid {
  ctx: CanvasRenderingContext2D;
  cols: number;
  rows: number;
  rect(x: number, y: number, w: number, h: number, color: string, alpha?: number): void;
}

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribeMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED);
  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
}

interface Props {
  cols: number;
  rows: number;
  draw: Draw;
  /** Seconds into the loop to show when motion is reduced. */
  stillAt: number;
  /** Maps play time to a step the overlay depends on; the overlay re-renders only when it changes. */
  step?: (t: number) => number;
  /** Labels laid over the canvas, positioned in percent of it. */
  overlay?: (step: number) => ReactNode;
  /** Content under the canvas. */
  below?: (step: number) => ReactNode;
  label: string;
  className?: string;
}

export function PixelCanvas({
  cols,
  rows,
  draw,
  stillAt,
  step,
  overlay,
  below,
  label,
  className,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [current, setCurrent] = useState(() => (step ? step(stillAt) : 0));

  const still = useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );

  // the latest callbacks, so a parent re-render never restarts the loop
  const drawRef = useRef(draw);
  const stepRef = useRef(step);

  useEffect(() => {
    drawRef.current = draw;
    stepRef.current = step;
  });

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");

    if (!canvas || !ctx) return;
    canvas.width = cols;
    canvas.height = rows;

    const grid: Grid = {
      ctx,
      cols,
      rows,
      rect(x, y, w, h, color, alpha = 1) {
        if (alpha <= 0 || w <= 0 || h <= 0) return;
        ctx.globalAlpha = Math.min(1, alpha);
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
        ctx.globalAlpha = 1;
      },
    };

    let last = Number.NaN;

    const frame = (t: number) => {
      ctx.clearRect(0, 0, cols, rows);
      drawRef.current(grid, t);
      const s = stepRef.current?.(t);

      // only tell React when the step actually changes, not on every frame
      if (s !== undefined && s !== last) {
        last = s;
        setCurrent(s);
      }
    };

    if (still) {
      frame(stillAt);

      return;
    }

    let raf = 0;
    let visible = false;
    let start = 0;
    let shown = 0;

    const loop = (now: number) => {
      if (!start) start = now - shown * 1000;
      shown = (now - start) / 1000;
      frame(shown);
      raf = visible ? requestAnimationFrame(loop) : 0;
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;

      if (visible && !raf) {
        start = 0;
        raf = requestAnimationFrame(loop);
      }
    });

    io.observe(canvas);
    frame(0);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [cols, rows, still, stillAt]);

  return (
    <div className={`${styles.pixel} ${className ?? ""}`}>
      <div className={styles.stage}>
        <canvas
          ref={ref}
          role="img"
          aria-label={label}
          className={styles.pixelCanvas}
          style={{ "--ratio": `${cols} / ${rows}` }}
        />
        {overlay?.(current)}
      </div>
      {below?.(current)}
    </div>
  );
}

/* timing helpers shared by the scenes */
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Strong ease-in-out for things that travel on screen. */
export const inOut = (v: number) => {
  const c = clamp01(v);

  return c < 0.5 ? 4 * c * c * c : 1 - (-2 * c + 2) ** 3 / 2;
};

/** Strong ease-out for things that arrive or appear. */
export const out = (v: number) => 1 - (1 - clamp01(v)) ** 3;

/** 0..1 progress of `t` through the window [a, b]. */
export const span = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));
