/**
 * The Sandbox SDK logo marks, on a 32-unit grid. Every coordinate is even, so
 * the marks land on whole pixels at 16 px and stay crisp as a favicon.
 *
 * `logo` picks the mark the site, docs, favicons and social images use. After
 * changing it, run `bun apps/web/brand/build.ts` and `apps/web/brand/render.sh`.
 */

export const AMBER = "#EFA43B";
export const INK = "#0A0A0C";
export const CREAM = "#ECEBE8";
export const DEV = "#FF6B4A";

type Tone = { tile: string; glyph: string };

interface Mark {
  /** One path in one colour on a transparent ground. */
  path: string;
  rule: "nonzero" | "evenodd";
  /** The glyph drawn on a filled favicon tile. */
  faviconGlyph: string;
  /** Tile and glyph colours for light and dark browser chrome. */
  favicon: { light: Tone; dark: Tone };
}

const sPixels = "M12 6h12v4H12zM8 10h4v4H8zM12 14h8v4h-8zM20 18h4v4h-4zM8 22h12v4H8z";

export const marks = {
  /** Two corner brackets around one lit cell: the landing page's nav brackets with a cell added. */
  brackets: {
    path: "M2 2h12v4H6v8H2zM30 30H18v-4h8v-8h4zM12 12h8v8h-8z",
    rule: "nonzero",
    faviconGlyph: "M4 4h10v4H8v6H4zM28 28H18v-4h6v-6h4zM12 12h8v8h-8z",
    favicon: { light: { tile: INK, glyph: AMBER }, dark: { tile: AMBER, glyph: INK } },
  },
  /** A pixel S cut out of a solid tile, drawn on the same grid as the Geist Pixel headings. */
  tile: {
    path: `M0 0h32v32H0z${sPixels}`,
    rule: "evenodd",
    faviconGlyph: sPixels,
    favicon: { light: { tile: AMBER, glyph: INK }, dark: { tile: AMBER, glyph: INK } },
  },
} as const satisfies Record<string, Mark>;

export type MarkName = keyof typeof marks;

export const logo: MarkName = "tile";

export function isMarkName(name: string): name is MarkName {
  return Object.hasOwn(marks, name);
}

export function markPath(name: MarkName, color: string) {
  const { path, rule } = marks[name];
  return `<path fill="${color}" fill-rule="${rule}" d="${path}"/>`;
}

export function markSvg(name: MarkName, color: string, size: number) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" shape-rendering="crispEdges">${markPath(name, color)}</svg>`;
}
