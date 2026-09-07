/**
 * Canvas dither field: a soft blurred gradient bloom with an ordered-dither
 * (Bayer 8x8) dot layer painted over it, like a halftone print of a light
 * source. Client-only leaf; every window/document access is guarded so the
 * prerender pass does not crash.
 */

import { useEffect, useRef } from "react";

export type DitherPalette =
  | "ember"
  | "teal"
  | "indigo"
  | "magma"
  | "moss"
  | "slate"
  | "gold"
  | "crimson"
  | "violet";

export type DitherVariant = "bloom" | "bars" | "ring" | "drift";

/**
 * Explicit blob placement, in normalised element coordinates. Supplying this
 * replaces the seed-hashed arrangement, and the horizontal axis is corrected
 * for the element aspect so a blob stays round on a wide band instead of
 * smearing edge to edge.
 */
export interface DitherBlob {
  cx: number;
  cy: number;
  gain: number;
  falloff: number;
}

/**
 * The artboard's CTA arrangement: one dominant centre bloom and two weak
 * wings. Pass to DitherField as `blobs` for the full-bleed band.
 */
export const CTA_BLOOM: readonly DitherBlob[] = [
  { cx: 0.5, cy: 0.58, gain: 1.0, falloff: 3.4 },
  { cx: 0.18, cy: 0.35, gain: 0.45, falloff: 9 },
  { cx: 0.85, cy: 0.4, gain: 0.45, falloff: 9 },
];

export interface DitherFieldProps {
  palette: DitherPalette;
  variant?: DitherVariant;
  seed?: number;
  /** Run the animation loop. Static single frame when false. */
  animate?: boolean;
  /** Dither cell size in CSS pixels. Default 8. */
  cell?: number;
  /** Brightness multiplier. Default 1. */
  level?: number;
  /** "edges" melts the field into the page background at every border. */
  fade?: "none" | "edges";
  /** Explicit blob placement. Defaults to a seed-hashed arrangement. */
  blobs?: readonly DitherBlob[];
  className?: string;
}

type Vec3 = readonly [number, number, number];

const PALETTES: Record<DitherPalette, readonly Vec3[]> = {
  ember: [
    [16, 8, 3],
    [122, 45, 5],
    [249, 115, 22],
    [255, 217, 160],
  ],
  teal: [
    [3, 17, 17],
    [10, 74, 68],
    [66, 203, 183],
    [199, 255, 244],
  ],
  indigo: [
    [7, 5, 24],
    [42, 29, 122],
    [109, 91, 208],
    [205, 196, 255],
  ],
  magma: [
    [22, 3, 11],
    [143, 15, 60],
    [244, 63, 94],
    [255, 199, 221],
  ],
  moss: [
    [4, 18, 11],
    [11, 61, 37],
    [31, 157, 99],
    [184, 240, 207],
  ],
  slate: [
    [9, 11, 15],
    [45, 55, 72],
    [125, 140, 165],
    [225, 232, 242],
  ],
  gold: [
    [18, 12, 2],
    [120, 82, 10],
    [234, 179, 8],
    [255, 236, 170],
  ],
  crimson: [
    [20, 4, 6],
    [127, 19, 29],
    [239, 68, 68],
    [255, 205, 200],
  ],
  violet: [
    [14, 4, 20],
    [88, 22, 129],
    [192, 82, 235],
    [240, 205, 255],
  ],
};

const BAYER_8 = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60,
  28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47,
  7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

/** Page background. The field dissolves into this at faded borders. */
const BG = "#0A0A0C";
const BG_RGB: Vec3 = [10, 10, 12];

/**
 * Cells of field sampled outside the canvas on every side. The blur needs real
 * data past the border, otherwise it pulls in transparency and leaves a dark
 * rim around the element.
 */
const MARGIN = 4;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ss = (t: number) => t * t * (3 - 2 * t);

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = ss(x - xi);
  const ty = ss(y - yi);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

function fbm(x: number, y: number, seed: number): number {
  return (
    valueNoise(x, y, seed) * 0.55 +
    valueNoise(x * 2.1, y * 2.1, seed + 11) * 0.3 +
    valueNoise(x * 4.3, y * 4.3, seed + 23) * 0.15
  );
}

/** 256-entry rgb ramp interpolated across the palette stops. */
function buildRamp(stops: readonly Vec3[]): Uint8ClampedArray {
  const ramp = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const lo = Math.min(stops.length - 2, Math.floor(t));
    const f = t - lo;
    for (let c = 0; c < 3; c++) {
      ramp[i * 3 + c] = stops[lo][c] + (stops[lo + 1][c] - stops[lo][c]) * f;
    }
  }
  return ramp;
}

interface Blob {
  /** Anchor, orbit radius, orbit rate, and phase per axis. */
  ax: number;
  ay: number;
  rx: number;
  ry: number;
  wx: number;
  wy: number;
  px: number;
  py: number;
  gain: number;
  falloff: number;
  /** Explicit blobs correct for aspect; hashed ones keep the 1.25 y squash. */
  useAspect: boolean;
}

/** Explicit blobs drift on a small orbit so the field still breathes. */
function placeBlobs(specs: readonly DitherBlob[]): Blob[] {
  return specs.map((spec, i) => ({
    ax: spec.cx,
    ay: spec.cy,
    rx: 0.022,
    ry: 0.018,
    wx: 0.21 + i * 0.07,
    wy: 0.17 + i * 0.05,
    px: i * 2.4,
    py: i * 1.7,
    gain: spec.gain,
    falloff: spec.falloff,
    useAspect: true,
  }));
}

function makeBlobs(seed: number, count: number): Blob[] {
  const blobs: Blob[] = [];
  for (let i = 0; i < count; i++) {
    const r = (k: number) => hash(i * 7 + k, seed * 13 + k * 3, 91 + seed);
    blobs.push({
      ax: 0.28 + r(1) * 0.44,
      ay: 0.3 + r(2) * 0.4,
      rx: 0.1 + r(3) * 0.2,
      ry: 0.08 + r(4) * 0.16,
      wx: 0.25 + r(5) * 0.5,
      wy: 0.2 + r(6) * 0.45,
      px: r(7) * Math.PI * 2,
      py: r(8) * Math.PI * 2,
      gain: 0.75 + r(9) * 0.5,
      falloff: 12 + r(10) * 8,
      useAspect: false,
    });
  }
  return blobs;
}

function blobField(
  blobs: readonly Blob[],
  x: number,
  y: number,
  t: number,
  aspect: number,
): number {
  let v = 0;
  for (const b of blobs) {
    const cx = b.ax + Math.sin(t * b.wx + b.px) * b.rx;
    const cy = b.ay + Math.cos(t * b.wy + b.py) * b.ry;
    const dx = (x - cx) * (b.useAspect ? aspect : 1);
    const dy = (y - cy) * (b.useAspect ? 1 : 1.25);
    v += b.gain * Math.exp(-(dx * dx + dy * dy) * b.falloff);
  }
  return v;
}

interface BarSpec {
  u: number;
  height: number;
  width: number;
}

function makeBars(seed: number): BarSpec[] {
  const bars: BarSpec[] = [];
  for (let i = 0; i < 42; i++) {
    const r = (k: number) => hash(i * 3 + k, seed * 17 + k, 57);
    bars.push({
      u: 0.08 + r(1) * 0.84,
      height: 0.2 + r(2) * 0.55,
      width: r(3) < 0.15 ? 2 : 1,
    });
  }
  return bars;
}

/** ~30fps. Half of a 60Hz budget is plenty for a dot field. */
const FRAME_MS = 33;

/** Everything the render engine reads. Held in a ref so a prop change never
 *  tears the canvas down. */
interface FieldConfig {
  palette: DitherPalette;
  variant: DitherVariant;
  seed: number;
  animate: boolean;
  cell: number;
  level: number;
  fadeEdges: boolean;
  blobs?: readonly DitherBlob[];
}

export function DitherField({
  palette,
  variant = "bloom",
  seed = 1,
  animate = false,
  cell = 8,
  level = 1,
  fade = "none",
  blobs: blobSpecs,
  className,
}: DitherFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef<FieldConfig>({
    palette,
    variant,
    seed,
    animate,
    cell,
    level,
    fadeEdges: fade === "edges",
    blobs: blobSpecs,
  });
  configRef.current = {
    palette,
    variant,
    seed,
    animate,
    cell,
    level,
    fadeEdges: fade === "edges",
    blobs: blobSpecs,
  };
  const blobKey = blobSpecs ? JSON.stringify(blobSpecs) : "";

  // Set by the mount effect, called by the config effect below. The engine
  // lives for the lifetime of the element.
  const syncRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Offscreen buffer holds the smooth layer at cell resolution. The upscale
    // to the main canvas does the heavy lifting, the blur filter hides the
    // bilinear seams.
    const smooth = document.createElement("canvas");
    const smoothCtx = smooth.getContext("2d");
    if (!smoothCtx) return;

    // Scratch copy of the visible bitmap, used to carry pixels across a
    // resize. Resizing a canvas clears it, and the card animates its width
    // for 700ms, so without this the field blanks on most frames of a slide
    // change.
    const keep = document.createElement("canvas");
    const keepCtx = keep.getContext("2d");
    if (!keepCtx) return;

    const shapeOf = (config: FieldConfig) =>
      config.blobs
        ? placeBlobs(config.blobs)
        : makeBlobs(config.seed, config.variant === "ring" ? 2 : 3);
    const keyOf = (config: FieldConfig) =>
      `${config.seed}:${config.variant}:${config.blobs ? JSON.stringify(config.blobs) : ""}`;

    let ramp = buildRamp(PALETTES[configRef.current.palette]);
    let blobs = shapeOf(configRef.current);
    let bars = configRef.current.variant === "bars" ? makeBars(configRef.current.seed) : [];
    let rampKey = configRef.current.palette;
    let shapeKey = keyOf(configRef.current);
    let cellKey = configRef.current.cell;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let cols = 0;
    let rows = 0;
    let gridCols = 0;
    let gridRows = 0;
    let detail = new Float32Array(0);
    let smoothImage: ImageData | null = null;
    let painted = false;
    /** Field time of the last painted frame. Static redraws reuse it so a
     *  config change never snaps the field back to its start pose. */
    let currentT = configRef.current.seed * 7.31;

    const rampAt = (v: number) => Math.min(255, Math.round(v * 255)) * 3;

    /**
     * Reconciles the backing buffers with the element size and the cell size.
     * Touches canvas.width only when the device-pixel size really changed:
     * assigning it clears the canvas, which is what caused the black flash.
     */
    const resize = () => {
      const { cell: cellSize } = configRef.current;
      const rect = canvas.getBoundingClientRect();
      const cssW = Math.max(1, Math.round(rect.width));
      const cssH = Math.max(1, Math.round(rect.height));
      const nextDpr = Math.min(2, window.devicePixelRatio || 1);
      const pxW = Math.round(cssW * nextDpr);
      const pxH = Math.round(cssH * nextDpr);

      const sizeChanged = canvas.width !== pxW || canvas.height !== pxH;
      if (sizeChanged) {
        if (painted && canvas.width > 0 && canvas.height > 0) {
          keep.width = canvas.width;
          keep.height = canvas.height;
          keepCtx.setTransform(1, 0, 0, 1, 0, 0);
          keepCtx.drawImage(canvas, 0, 0);
          canvas.width = pxW;
          canvas.height = pxH;
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.drawImage(keep, 0, 0, keep.width, keep.height, 0, 0, pxW, pxH);
        } else {
          canvas.width = pxW;
          canvas.height = pxH;
        }
      }
      width = cssW;
      height = cssH;
      dpr = nextDpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const nextCols = Math.max(1, Math.ceil(cssW / cellSize));
      const nextRows = Math.max(1, Math.ceil(cssH / cellSize));
      if (nextCols !== cols || nextRows !== rows || !smoothImage) {
        cols = nextCols;
        rows = nextRows;
        gridCols = cols + MARGIN * 2;
        gridRows = rows + MARGIN * 2;
        smooth.width = gridCols;
        smooth.height = gridRows;
        detail = new Float32Array(cols * rows);
        smoothImage = smoothCtx.createImageData(gridCols, gridRows);
      }
      return sizeChanged;
    };

    /**
     * Washes the page background back over each border. The field is already
     * masked, but the bloom blur carries hot interior light outward, so the
     * border needs a second pass to land exactly on the page background.
     */
    const paintEdgeFade = () => {
      if (!configRef.current.fadeEdges) return;
      const stops = (gradient: CanvasGradient) => {
        for (let k = 0; k <= 8; k++) {
          const t = k / 8;
          gradient.addColorStop(t, `rgba(10,10,12,${(1 - ss(t)).toFixed(4)})`);
        }
        return gradient;
      };
      const top = Math.ceil(height * 0.14);
      const left = Math.ceil(width * 0.05);
      const right = Math.ceil(width * 0.06);

      ctx.fillStyle = stops(ctx.createLinearGradient(0, 0, 0, top));
      ctx.fillRect(0, 0, width, top);
      ctx.fillStyle = stops(ctx.createLinearGradient(0, height, 0, height - top));
      ctx.fillRect(0, height - top, width, top);
      ctx.fillStyle = stops(ctx.createLinearGradient(0, 0, left, 0));
      ctx.fillRect(0, 0, left, height);
      ctx.fillStyle = stops(ctx.createLinearGradient(width, 0, width - right, 0));
      ctx.fillRect(width - right, 0, right, height);
    };

    /** 1 in the interior, 0 at every border when fade is "edges". */
    const edgeMask = (x: number, y: number): number => {
      if (!configRef.current.fadeEdges) return 1;
      return (
        ss(clamp01(y / 0.14)) *
        ss(clamp01((1 - y) / 0.14)) *
        ss(clamp01(x / 0.05)) *
        ss(clamp01((1 - x) / 0.06))
      );
    };

    const rawField = (x: number, y: number, t: number): number => {
      const shape = configRef.current.variant;
      const aspect = height > 0 ? width / height : 1;
      let v: number;
      if (shape === "drift") {
        v =
          0.42 +
          0.4 * Math.sin((x * 1.5 - y * 0.9) * Math.PI + t * 0.6) * 0.5 +
          blobField(blobs, x, y, t, aspect) * 0.55;
      } else if (shape === "bars") {
        v =
          0.32 +
          0.34 * Math.sin((x * 1.2 + y * 1.6) * Math.PI + t * 0.5) * 0.5 +
          blobField(blobs, x, y, t, aspect) * 0.75;
      } else {
        v = blobField(blobs, x, y, t, aspect);
        if (shape === "ring") {
          const dx = x - 0.5;
          const dy = (y - 0.5) * 1.3;
          const d = Math.sqrt(dx * dx + dy * dy);
          v *= ss(Math.min(1, Math.abs(d - 0.18) * 4.5)) * 0.9 + 0.25;
        }
      }
      return v;
    };

    const draw = (t: number) => {
      if (!smoothImage || width === 0 || height === 0) return;
      currentT = t;
      painted = true;
      const { cell: cellSize, level: gain, seed: fieldSeed } = configRef.current;
      const px = smoothImage.data;

      for (let gj = 0; gj < gridRows; gj++) {
        const j = gj - MARGIN;
        const y = j / rows;
        for (let gi = 0; gi < gridCols; gi++) {
          const i = gi - MARGIN;
          const x = i / cols;
          const mask = edgeMask(x, y);
          const v = clamp01(rawField(x, y, t) * mask * gain);

          // Lerp to the page background so a faded border has no seam: the
          // darkest palette stop is never exactly #0A0A0C.
          const c = rampAt(v);
          const o = (gj * gridCols + gi) * 4;
          px[o] = ramp[c] * mask + BG_RGB[0] * (1 - mask);
          px[o + 1] = ramp[c + 1] * mask + BG_RGB[1] * (1 - mask);
          px[o + 2] = ramp[c + 2] * mask + BG_RGB[2] * (1 - mask);
          px[o + 3] = 255;

          if (i >= 0 && i < cols && j >= 0 && j < rows) {
            const n = fbm(x * 3.4 + Math.sin(t) * 0.15, y * 3.4 + Math.cos(t) * 0.1, fieldSeed);
            detail[j * cols + i] = clamp01(v * (0.45 + 0.85 * n));
          }
        }
      }
      smoothCtx.putImageData(smoothImage, 0, 0);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, width, height);

      // Smooth bloom layer.
      // Canvas filter lengths are device pixels, so scale with the ratio.
      ctx.filter = `blur(${(cellSize * 2.2 * dpr).toFixed(2)}px)`;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        smooth,
        0,
        0,
        gridCols,
        gridRows,
        -MARGIN * cellSize,
        -MARGIN * cellSize,
        gridCols * cellSize,
        gridRows * cellSize,
      );
      ctx.filter = "none";

      // Dot layer.
      const dot = Math.max(1, cellSize - 3);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const v = detail[j * cols + i];
          const threshold = BAYER_8[(i & 7) + ((j & 7) << 3)] / 64;
          if (v <= threshold * 0.92 + 0.05) continue;
          // Hot cores stay smooth instead of turning into speckle.
          const alpha = v > 0.86 ? 0.35 : 0.85;
          const c = rampAt(v + 0.22);
          ctx.globalAlpha = alpha;
          ctx.fillStyle = `rgb(${ramp[c]},${ramp[c + 1]},${ramp[c + 2]})`;
          ctx.fillRect(i * cellSize + 1, j * cellSize + 1, dot, dot);
        }
      }
      ctx.globalAlpha = 1;

      // Hairlines hanging from the top edge. Kept light and low contrast so
      // they read as a texture over the bloom rather than dark gashes across
      // it: no near-black fill, thin lines, a soft tip.
      for (const bar of bars) {
        const x0 = Math.round(bar.u * width);
        const bh = Math.round(height * bar.height);
        ctx.fillStyle = "rgba(255,236,244,0.07)";
        ctx.fillRect(x0, 0, bar.width, bh);
        ctx.fillStyle = "rgba(255,236,244,0.34)";
        ctx.fillRect(x0, Math.max(0, bh - 2), bar.width, 2);
      }

      paintEdgeFade();
    };

    let frame = 0;
    let last = 0;
    let running = false;
    let onScreen = true;
    /** Wall-clock seconds the loop has actually advanced. Pausing and
     *  resuming must not jump the field forward by the paused duration. */
    let elapsed = 0;
    let originMs = 0;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    const loop = (now: number) => {
      frame = window.requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      if (originMs === 0) originMs = now;
      const t = configRef.current.seed * 7.31 + (elapsed + (now - originMs) / 1000) * 0.6;
      draw(t);
    };

    const stopLoop = () => {
      if (!running) return;
      if (frame) window.cancelAnimationFrame(frame);
      if (originMs !== 0) elapsed += (last - originMs) / 1000;
      frame = 0;
      originMs = 0;
      running = false;
    };

    const startLoop = () => {
      if (running) return;
      running = true;
      last = 0;
      originMs = 0;
      frame = window.requestAnimationFrame(loop);
    };

    /**
     * Applies the current config. Rebuilds only what genuinely changed, then
     * starts or stops the loop. Never clears the canvas: a stopped engine
     * keeps its last painted frame until the redraw below overwrites it.
     */
    const sync = () => {
      const config = configRef.current;
      let dirty = false;

      if (config.palette !== rampKey) {
        ramp = buildRamp(PALETTES[config.palette]);
        rampKey = config.palette;
        dirty = true;
      }
      const nextShapeKey = keyOf(config);
      if (nextShapeKey !== shapeKey) {
        blobs = shapeOf(config);
        bars = config.variant === "bars" ? makeBars(config.seed) : [];
        shapeKey = nextShapeKey;
        currentT = config.seed * 7.31;
        elapsed = 0;
        dirty = true;
      }
      if (config.cell !== cellKey) {
        cellKey = config.cell;
        resize();
        dirty = true;
      }

      const wanted = config.animate && onScreen && !reduceMotion.matches;
      if (wanted && !running) {
        startLoop();
        return;
      }
      if (!wanted && running) {
        stopLoop();
        draw(currentT);
        return;
      }
      // A running loop repaints on its own; only a stopped one needs a nudge.
      if (dirty && !running) draw(currentT);
    };

    syncRef.current = sync;

    resize();
    draw(currentT);

    const resizeObserver = new ResizeObserver(() => {
      const sizeChanged = resize();
      if (!running && sizeChanged) draw(currentT);
    });
    resizeObserver.observe(canvas);

    const intersectionObserver = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        sync();
      },
      { rootMargin: "120px" },
    );
    intersectionObserver.observe(canvas);

    reduceMotion.addEventListener("change", sync);
    sync();

    return () => {
      syncRef.current = null;
      stopLoop();
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      reduceMotion.removeEventListener("change", sync);
    };
  }, []);

  // Push prop changes into the live engine instead of rebuilding it.
  useEffect(() => {
    syncRef.current?.();
  }, [palette, variant, seed, animate, cell, level, fade, blobKey]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}
