/**
 * Writes every logo SVG for the site and docs from `marks.ts`. The PNGs and
 * social images come from `render.sh`, which reads the files written here.
 * Usage: bun apps/web/brand/build.ts [mark]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { AMBER, CREAM, DEV, INK, isMarkName, logo, markPath, marks, type MarkName } from "./marks";
import { wordmark } from "./wordmark";

const arg = process.argv[2];

if (arg !== undefined && !isMarkName(arg)) {
  console.error(`Unknown mark "${arg}". Use one of: ${Object.keys(marks).join(", ")}`);
  process.exit(1);
}

const name: MarkName = arg ?? logo;
const mark = marks[name];

const web = join(import.meta.dirname, "..");
const docs = join(web, "..", "docs");

function write(path: string, svg: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${svg.trim()}\n`);
  console.log(path.slice(web.length - "apps/web".length));
}

const svg = (viewBox: string, label: string, body: string, size = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"${size} role="img" aria-label="${label}">\n  ${body}\n</svg>`;

const markFile = (color: string, size = "") =>
  svg("0 0 32 32", "Sandbox SDK", markPath(name, color), size);

const lockup = (markColor: string, textColor: string) =>
  svg(
    "0 0 193 32",
    "Sandbox SDK",
    `${markPath(name, markColor)}\n  <path fill="${textColor}" d="${wordmark}"/>`,
    ` width="772" height="128"`,
  );

const tile = (tone: { tile: string; glyph: string }) =>
  `<rect fill="${tone.tile}" width="32" height="32"/>\n  <path fill="${tone.glyph}" d="${mark.faviconGlyph}"/>`;

// follows the browser's colour scheme, for tabs that only read one icon
const adaptiveFavicon = svg(
  "0 0 32 32",
  "Sandbox SDK",
  `<style>
    .tile { fill: ${mark.favicon.light.tile}; }
    .glyph { fill: ${mark.favicon.light.glyph}; }
    @media (prefers-color-scheme: dark) {
      .tile { fill: ${mark.favicon.dark.tile}; }
      .glyph { fill: ${mark.favicon.dark.glyph}; }
    }
  </style>
  <rect class="tile" width="32" height="32"/>
  <path class="glyph" d="${mark.faviconGlyph}"/>`,
);

const brand = join(web, "public", "brand");

write(join(brand, "sandbox-sdk-mark.svg"), markFile(AMBER));

write(join(brand, "sandbox-sdk-mark-cream.svg"), markFile(CREAM));

write(join(brand, "sandbox-sdk-mark-dark.svg"), markFile(INK));

write(join(brand, "sandbox-sdk-nav.svg"), markFile(AMBER, ` width="20" height="20"`));

write(join(brand, "sandbox-sdk-lockup.svg"), lockup(AMBER, CREAM));

write(join(brand, "sandbox-sdk-lockup-cream.svg"), lockup(CREAM, CREAM));

write(join(brand, "sandbox-sdk-lockup-dark.svg"), lockup(INK, INK));

write(join(web, "public", "logo.svg"), markFile(AMBER));

write(join(web, "public", "favicon.svg"), adaptiveFavicon);

write(
  join(web, "public", "favicon-light.svg"),
  svg("0 0 32 32", "Sandbox SDK", tile(mark.favicon.light)),
);

write(
  join(web, "public", "favicon-dark.svg"),
  svg("0 0 32 32", "Sandbox SDK", tile(mark.favicon.dark)),
);

write(
  join(web, "public", "favicon-development.svg"),
  svg("0 0 32 32", "Sandbox SDK development", tile({ tile: DEV, glyph: INK })),
);

write(join(web, "src", "app", "icon.svg"), adaptiveFavicon);

write(join(docs, "public", "logo.svg"), markFile(AMBER));

write(join(docs, "public", "favicon.svg"), adaptiveFavicon);
