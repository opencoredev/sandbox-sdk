"use client";

import { useEffect, useRef } from "react";

import { createHalftone, type HalftoneStyle, type Scope } from "./halftone";

export interface Look {
  x: number;
  y: number;
}

/** Paints one frame of a scene at play time `t` into a source canvas. */
export type Painter = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  t: number,
  look: Look,
) => void;

/** One drawn frame: play time, parallax, and the canvas size in CSS pixels. */
export interface FrameInfo {
  t: number;
  look: Look;
  width: number;
  height: number;
}

/** Where the scope sits, in CSS pixels relative to the canvas, or null for no scope. */
export type ScopeSource = () => { x: number; y: number; r: number } | null;

interface HalftoneCanvasProps {
  paint: Painter;
  style: HalftoneStyle;
  fps?: number;
  /** The play time shown as a still to readers who prefer reduced motion. */
  stillAt?: number;
  /** Follow the mouse with a little parallax. */
  parallax?: boolean;
  scope?: ScopeSource;
  zoom?: number;
  /** Called after every drawn frame, for HTML overlays that follow the scene. */
  onFrame?: (frame: FrameInfo) => void;
  className?: string;
}

/** A painted scene drawn as an animated halftone. Pauses off screen and in hidden tabs. */
export function HalftoneCanvas({
  paint,
  style,
  fps = 30,
  stillAt = 0,
  parallax = false,
  scope,
  zoom = 2.2,
  onFrame,
  className,
}: HalftoneCanvasProps) {
  const ref = useRef<HTMLDivElement>(null);
  // the latest callbacks, so a parent re-render never restarts the loop
  const paintRef = useRef(paint);
  const scopeRef = useRef(scope);
  const frameRef = useRef(onFrame);
  paintRef.current = paint;
  scopeRef.current = scope;
  frameRef.current = onFrame;

  const { cell, fill, shape, glow, ground } = style;
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    // A fresh canvas every mount: a disposed renderer releases its WebGL context,
    // and asking the same element again would hand back that dead context.
    const canvas = document.createElement("canvas");
    canvas.setAttribute("aria-hidden", "true");
    canvas.style.cssText = "display:block;width:100%;height:100%";
    host.appendChild(canvas);
    const source = document.createElement("canvas");
    const sctx = source.getContext("2d");
    if (!sctx) {
      canvas.remove();
      return;
    }
    let halftone = createHalftone(canvas, { cell, fill, shape, glow, ground });
    let lost = false;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let dpr = 1;
    const size = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      // the source needs only a few texels a cell; magnifying in the scope wants a few more
      const scale = Math.min(1, (scopeRef.current ? 1100 : 640) / Math.max(w, h));
      source.width = Math.max(1, Math.round(w * scale));
      source.height = Math.max(1, Math.round(h * scale));
      if (halftone) halftone.resize(w, h, dpr);
      else {
        canvas.width = source.width;
        canvas.height = source.height;
      }
    };

    const look: Look = { x: 0, y: 0 };
    const aim: Look = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      aim.x = (e.clientX / window.innerWidth) * 2 - 1;
      aim.y = (e.clientY / window.innerHeight) * 2 - 1;
    };

    const draw = (t: number) => {
      if (lost) return;
      look.x += (aim.x - look.x) * 0.06;
      look.y += (aim.y - look.y) * 0.06;
      paintRef.current(sctx, source.width, source.height, t, look);
      if (halftone) {
        const s = scopeRef.current?.() ?? null;
        const lens: Scope | null = s && { x: s.x * dpr, y: s.y * dpr, r: s.r * dpr };
        halftone.render(source, lens, zoom);
      } else canvas.getContext("2d")?.drawImage(source, 0, 0);
      frameRef.current?.({ t, look, width: canvas.clientWidth, height: canvas.clientHeight });
    };

    // a lost context (GPU reset, memory pressure) pauses drawing; a restored one gets a fresh renderer
    const onLost = (e: Event) => {
      e.preventDefault();
      lost = true;
    };
    const onRestored = () => {
      lost = false;
      halftone = createHalftone(canvas, { cell, fill, shape, glow, ground });
      size();
      draw(stillAt);
    };
    canvas.addEventListener("webglcontextlost", onLost);
    canvas.addEventListener("webglcontextrestored", onRestored);
    const unlisten = () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
    };

    size();
    const ro = new ResizeObserver(() => {
      size();
      if (still) draw(stillAt);
    });
    ro.observe(canvas);
    const detach = () => canvas.remove();

    if (still) {
      draw(stillAt);
      return () => {
        ro.disconnect();
        unlisten();
        halftone?.dispose();
        detach();
      };
    }

    // paint the first frame straight away so nothing is ever blank
    draw(stillAt);
    if (parallax) window.addEventListener("pointermove", onPointer, { passive: true });

    // the loop runs only while the canvas is on screen and the tab is open, so play time pauses too
    let t = stillAt > 4 ? 0 : stillAt;
    let last = 0;
    let acc = 1;
    let raf = 0;
    let visible = false;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      t += dt;
      acc += dt;
      if (acc < 1 / fps) return;
      acc %= 1 / fps;
      draw(t);
    };
    const sync = () => {
      const run = visible && !document.hidden;
      if (run && !raf) {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      } else if (!run && raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };
    const io = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      sync();
    });
    io.observe(canvas);
    document.addEventListener("visibilitychange", sync);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", sync);
      unlisten();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onPointer);
      halftone?.dispose();
      detach();
    };
  }, [cell, fill, shape, glow, ground, fps, stillAt, parallax, zoom]);

  return <div ref={ref} className={className} aria-hidden="true" />;
}
