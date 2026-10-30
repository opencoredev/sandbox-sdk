/**
 * The social images and the README banner, laid out in the browser so they use
 * the landing page's fonts and its real halftone renderer. `render.sh`
 * screenshots each one at its exact size.
 * Query: ?card=<name>&mark=<mark>; the mark defaults to `logo` in marks.ts.
 */
import { createHalftone } from "../src/components/halftone/halftone";
import { glowField } from "../src/components/halftone/painters";
import { AMBER, isMarkName, logo, markSvg } from "./marks";

interface Light {
  x: number;
  y: number;
  r: number;
  color: string;
}

interface Card {
  width: number;
  height: number;
  /** "left" hangs the copy from the top left above a band holding the buttons; "center" stacks it over the dither. */
  layout: "left" | "center";
  /** Type size relative to the 630 px OG card. */
  type: number;
  /** Glows behind the halftone, in 0..1 of the card. */
  lights: Light[];
  /** CSS mask that fades the halftone out toward the copy. */
  mask: string;
  /** Show the grid of provider logos. */
  providers?: boolean;
}

const TITLE = "Sandboxes for your agents and your users.";
const LINE =
  "Run commands, edit files and serve previews on E2B, Vercel, Daytona, Docker and more, with one TypeScript API.";
const SHORT_LINE = "Run commands, edit files and serve previews with one TypeScript API.";
/** The 1.0 providers, as named in the docs sidebar, with their icon in apps/docs/public/integrations. */
const PROVIDERS = [
  ["e2b", "E2B"],
  ["vercel", "Vercel"],
  ["daytona", "Daytona"],
  ["upstash", "Upstash"],
  ["railway", "Railway"],
  ["tenki", "Tenki"],
  ["docker", "Docker"],
  ["freestyle", "Freestyle"],
  ["superserve", "Superserve"],
  ["boxd", "boxd"],
  ["boat", "Boat"],
  ["sandboxer", "Sandboxer"],
  ["agentos", "agentOS"],
] as const;
// the landing page's arrow and GitHub mark, at 16 units
const ARROW = `<svg viewBox="0 0 16 16" width="{s}" height="{s}"><path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const GITHUB = `<svg viewBox="0 0 16 16" width="{s}" height="{s}"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const corner: Pick<Card, "lights" | "mask"> = {
  lights: [
    { x: 0.86, y: 0.95, r: 0.36, color: "rgba(214,110,40,0.95)" },
    { x: 0.66, y: 1, r: 0.26, color: "rgba(140,64,22,0.7)" },
  ],
  mask: "radial-gradient(ellipse 52% 80% at 90% 100%,#000 30%,transparent 100%)",
};

const cards: Record<string, Card> = {
  og: { width: 1200, height: 630, layout: "left", type: 1, ...corner },
  social: { width: 1280, height: 640, layout: "left", type: 640 / 630, ...corner },
  // the landing page's closing section: an ember rising from the bottom edge
  banner: {
    width: 1280,
    height: 720,
    layout: "center",
    type: 0.92,
    providers: true,
    lights: [
      { x: 0.5, y: 1.12, r: 0.42, color: "rgba(214,110,40,0.95)" },
      { x: 0.22, y: 1.08, r: 0.3, color: "rgba(140,64,22,0.75)" },
      { x: 0.78, y: 1.08, r: 0.3, color: "rgba(140,64,22,0.75)" },
    ],
    mask: "linear-gradient(to top,#000 0%,#000 14%,transparent 30%)",
  },
};

const params = new URLSearchParams(location.search);
const card = cards[params.get("card") ?? "og"] ?? cards.og;
const asked = params.get("mark") ?? "";
const mark = isMarkName(asked) ? asked : logo;
const { width: W, height: H } = card;
const u = card.type;
const rail = 64;
const lineColor = "rgb(255 255 255 / 9%)";

const root = document.getElementById("card")!;
root.style.cssText = `position:relative;width:${W}px;height:${H}px;overflow:hidden;background:#0A0A0C`;

// the dither: the landing page's halftone over warm glows, faded toward the copy
const art = document.createElement("canvas");
art.style.cssText = `position:absolute;inset:0;width:${W}px;height:${H}px;-webkit-mask-image:${card.mask}`;
root.append(art);
const source = document.createElement("canvas");
source.width = Math.round(W / 2);
source.height = Math.round(H / 2);
const paint = glowField({ base: "#0b0a09", lights: card.lights.map((l) => ({ ...l, drift: 0 })) });
paint(source.getContext("2d")!, source.width, source.height, 0, { x: 0, y: 0 });
const halftone = createHalftone(art, {
  cell: 13 * u,
  fill: 0.62,
  shape: "square",
  glow: 0.4,
  ground: [0.039, 0.039, 0.047],
});
if (halftone) {
  // draw at device resolution, so the 2x banner gets crisp dots
  const dpr = window.devicePixelRatio || 1;
  halftone.resize(Math.round(W * dpr), Math.round(H * dpr), dpr);
  halftone.render(source, null, 1);
}

// rails and crosshairs, as on the landing page
const plus = (x: number, y: number) =>
  `<div style="position:absolute;left:${x - 6}px;top:${y - 6}px;width:13px;height:13px;background:linear-gradient(${lineColor},${lineColor}) center/1px 100% no-repeat,linear-gradient(${lineColor},${lineColor}) center/100% 1px no-repeat"></div>`;
const rule = (y: number) =>
  `<div style="position:absolute;left:0;right:0;top:${y}px;height:1px;background:${lineColor}"></div>${plus(rail, y)}${plus(W - rail - 1, y)}`;
const band = H - 150;
const frame = document.createElement("div");
frame.style.cssText = "position:absolute;inset:0;pointer-events:none";
frame.innerHTML = `
  <div style="position:absolute;left:${rail}px;top:0;bottom:0;width:1px;background:${lineColor}"></div>
  <div style="position:absolute;right:${rail}px;top:0;bottom:0;width:1px;background:${lineColor}"></div>
  ${card.layout === "left" ? rule(band) : rule(88)}
`;
root.append(frame);

const lockup = `
  <div style="display:flex;align-items:center;gap:${Math.round(14 * u)}px">
    ${markSvg(mark, AMBER, Math.round(32 * u))}
    <span style="font:500 ${Math.round(26 * u)}px/1 Geist;color:#fff;letter-spacing:-0.01em">Sandbox SDK</span>
  </div>`;

/** The landing page's hero buttons: amber "Read the docs" and a dark GitHub button. */
function actions(height: number) {
  const icon = (svg: string) => svg.replaceAll("{s}", String(Math.round(18 * u)));
  const button = `display:inline-flex;align-items:center;gap:${Math.round(12 * u)}px;height:${height}px;padding:0 ${Math.round(26 * u)}px;font:500 ${Math.round(19 * u)}px/1 Geist`;
  return `
    <div style="display:flex;gap:${Math.round(14 * u)}px">
      <span style="${button};color:#1a1206;background:${AMBER}">Read the docs ${icon(ARROW)}</span>
      <span style="${button};color:#ECEBE8;background:rgb(17 18 20 / 0.85);border:1px solid #34363c">${icon(GITHUB)} GitHub</span>
    </div>`;
}

const copy = document.createElement("div");
const pad = rail + 56;
const h1 = (top: number, maxWidth: number, size = 84) =>
  `<h1 style="margin:${Math.round(top * u)}px 0 0;font:400 ${Math.round(size * u)}px/1.04 'Geist Pixel Square';letter-spacing:-0.02em;color:#fff;text-wrap:balance;max-width:${Math.round(maxWidth * u)}px">${TITLE}</h1>`;
if (card.layout === "left") {
  const pill = Math.round(60 * u);
  copy.style.cssText = `position:absolute;left:${pad}px;right:${pad}px;top:64px;display:flex;flex-direction:column`;
  copy.innerHTML = `
    ${lockup}
    ${h1(96, 900)}
    <p style="margin:${Math.round(28 * u)}px 0 0;font:400 ${Math.round(28 * u)}px/1.35 Geist;color:#C7CDD6;text-wrap:balance;max-width:${Math.round(780 * u)}px">${LINE}</p>
    <div style="position:absolute;left:0;top:${band - 64 + Math.round((150 - pill) / 2)}px">${actions(pill)}</div>
  `;
} else {
  // the lockup sits in the top strip; the headline, line, providers and buttons stack over the dither
  copy.style.cssText =
    "position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;text-align:center";
  copy.innerHTML = `
    <div style="height:88px;display:flex;align-items:center">${lockup}</div>
    ${h1(48, 980, 74)}
    <p style="margin:${Math.round(22 * u)}px 0 0;font:400 ${Math.round(26 * u)}px/1.35 Geist;color:#C7CDD6;text-wrap:balance;max-width:${Math.round(980 * u)}px">${card.providers ? SHORT_LINE : LINE}</p>
    ${card.providers ? `<div id="providers" style="margin-top:${Math.round(44 * u)}px;display:flex;flex-direction:column;align-items:center"></div>` : ""}
    <div style="margin-top:${Math.round(48 * u)}px">${actions(Math.round(56 * u))}</div>
  `;
}
root.append(copy);

/** The providers in their own colours, as an open strip under a small label. */
async function providerGrid() {
  const size = Math.round(34 * u);
  const icons = await Promise.all(
    PROVIDERS.map(async ([file]) => {
      const svg = await (await fetch(`integrations/${file}.svg`)).text();
      return svg.replace("<svg ", `<svg width="${size}" height="${size}" style="flex:none" `);
    }),
  );
  const logo = (icon: string, name: string) =>
    `<div style="display:flex;align-items:center;gap:${Math.round(12 * u)}px;color:#ECEBE8;font:500 ${Math.round(21 * u)}px/1 Geist;letter-spacing:-0.01em">${icon}<span>${name}</span></div>`;
  return `
    <div style="font:400 ${Math.round(14 * u)}px/1 'Geist Mono';letter-spacing:0.12em;text-transform:uppercase;color:#697180">Works with</div>
    <div style="display:flex;flex-wrap:wrap;justify-content:center;gap:${Math.round(26 * u)}px ${Math.round(40 * u)}px;max-width:${Math.round(1080 * u)}px;margin-top:${Math.round(24 * u)}px">
      ${PROVIDERS.map(([, name], i) => logo(icons[i], name)).join("")}
    </div>`;
}

const grid = document.getElementById("providers");
Promise.all([document.fonts.ready, grid ? providerGrid() : Promise.resolve("")]).then(
  ([, html]) => {
    if (grid) grid.innerHTML = html;
    root.dataset.ready = "1";
  },
);
