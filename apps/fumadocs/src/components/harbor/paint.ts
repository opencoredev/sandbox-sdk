/*
 * A harbor at dusk, painted with Canvas 2D into a small source image that the
 * halftone pass turns into square pixels. It is built the way the ascii.rest
 * scenes are: a few bold silhouettes against a clean gradient, so every pixel
 * reads. One crane, one ship, a sun setting on a clear horizon, and a dark quay.
 *
 * Everything sits in a 1600 by 800 frame. `t` is play time in seconds and
 * `look` is the pointer's offset from centre (-1..1); near layers shift more.
 */

const W = 1600;
const H = 800;
const HORIZON = 452;
const SUN = { x: 1000, r: 46 };

export interface Look {
  x: number;
  y: number;
}

type Ctx = CanvasRenderingContext2D;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => {
  const c = clamp01(v);
  return c * c * (3 - 2 * c);
};
function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

function glow(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number) {
  if (alpha <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = 1;
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** A sodium lamp striking on: dark, a few uneven flickers, then steady. */
function lamp(t: number, delay: number) {
  const on = t - delay;
  if (on < 0) return 0;
  if (on > 1.2) return 1;
  return hash(Math.floor(t * 18) + delay * 97) > 0.45 ? 0.4 + on * 0.4 : 0.05;
}

/** The providers the crane loads, one per cycle, each in its brand colour. */
export const HARBOR_PROVIDERS = [
  { id: "e2b", name: "E2B", hue: "#ff5a1f" },
  { id: "daytona", name: "Daytona", hue: "#2f6bff" },
  { id: "vercel", name: "Vercel Sandbox", hue: "#e6e6e6" },
  { id: "upstash", name: "Upstash Box", hue: "#00c98d" },
  { id: "box", name: "Boat", hue: "#5a86ff" },
  { id: "railway", name: "Railway", hue: "#8b5cf6" },
  { id: "tenki", name: "Tenki", hue: "#4f86f0" },
  { id: "local", name: "Local", hue: "#e8a33c" },
] as const;

const HUES = HARBOR_PROVIDERS.map((p) => p.hue);

function container(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  hue: string,
  shade: number,
) {
  ctx.fillStyle = hue;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = `rgba(0,0,0,${0.25 + shade * 0.5})`;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  for (let i = x + 5; i < x + w - 3; i += Math.max(5, w / 10))
    if (w < 80) ctx.fillRect(i, y + 2, 1.5, h - 3);
  ctx.fillStyle = "rgba(255,200,140,0.55)";
  ctx.fillRect(x, y, w, 2);
}

/* ---------- layers, back to front ---------- */

const CLOUDS = Array.from({ length: 16 }, (_, i) => ({
  x: hash(i) * 2200,
  y: 250 + hash(i + 30) * 170,
  len: 260 + hash(i + 60) * 420,
  v: 4 + hash(i + 90) * 6,
}));

function sky(ctx: Ctx, t: number) {
  const g = ctx.createLinearGradient(0, -200, 0, HORIZON);
  g.addColorStop(0, "#050608");
  g.addColorStop(0.3, "#16121a");
  g.addColorStop(0.55, "#4a2418");
  g.addColorStop(0.78, "#b0561f");
  g.addColorStop(1, "#ffbc66");
  ctx.fillStyle = g;
  ctx.fillRect(-200, -200, W + 400, HORIZON + 200);
  glow(ctx, SUN.x, HORIZON, 520, "rgba(255,130,50,1)", 0.45);
  // thin cloud bands, lit from below by the sun
  for (const c of CLOUDS) {
    const x = ((c.x + t * c.v) % 2200) - 300;
    const lit = 1 - Math.min(1, Math.abs(x + c.len / 2 - SUN.x) / 900);
    const low = (c.y - 250) / 170;
    const band = ctx.createLinearGradient(x, 0, x + c.len, 0);
    const col = `rgba(255,${140 + low * 50},${70 + low * 30},`;
    band.addColorStop(0, col + "0)");
    band.addColorStop(0.5, col + (0.25 + 0.55 * lit * low).toFixed(3) + ")");
    band.addColorStop(1, col + "0)");
    ctx.fillStyle = band;
    ctx.fillRect(x, c.y, c.len, 3 + low * 5);
  }
  // the sun, half set
  ctx.save();
  ctx.beginPath();
  ctx.rect(SUN.x - 80, HORIZON - 120, 160, 120);
  ctx.clip();
  glow(ctx, SUN.x, HORIZON, 120, "rgba(255,220,150,1)", 0.9);
  ctx.fillStyle = "#fff0c8";
  ctx.beginPath();
  ctx.arc(SUN.x, HORIZON + 8, SUN.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function distance(ctx: Ctx) {
  // low hills on the left horizon and a ship at anchor far out
  ctx.fillStyle = "#2a1610";
  ctx.beginPath();
  ctx.moveTo(-200, HORIZON);
  ctx.lineTo(-200, 400);
  ctx.bezierCurveTo(60, 380, 200, 404, 360, 418);
  ctx.bezierCurveTo(480, 428, 560, 440, 640, HORIZON);
  ctx.fill();
  ctx.fillStyle = "#3a1e14";
  ctx.fillRect(700, HORIZON - 10, 90, 10);
  ctx.fillRect(762, HORIZON - 22, 14, 12);
}

function sea(ctx: Ctx, t: number) {
  const g = ctx.createLinearGradient(0, HORIZON, 0, 640);
  g.addColorStop(0, "#7a3a18");
  g.addColorStop(0.25, "#2c1a14");
  g.addColorStop(1, "#08090b");
  ctx.fillStyle = g;
  ctx.fillRect(-200, HORIZON, W + 400, 200);
  ctx.globalCompositeOperation = "lighter";
  // the sun's reflection: broken bands that wobble and widen toward us
  for (let row = 0; row < 24; row++) {
    const y = HORIZON + 3 + row * 6;
    const w = 50 + row * 7 + Math.sin(t * 1.6 + row * 1.3) * 12;
    const shift = Math.sin(t * 1.1 + row * 0.7) * 8;
    ctx.fillStyle = `rgba(255,214,150,${(0.85 * (1 - row / 24)).toFixed(3)})`;
    ctx.fillRect(SUN.x - w / 2 + shift, y, w * 0.4, 3);
    ctx.fillRect(SUN.x + shift + w * 0.1, y, w * 0.4, 3);
  }
  // glints scattered wider
  for (let i = 0; i < 90; i++) {
    const v = Math.max(0, Math.sin(t * (1.5 + hash(i + 9) * 2) + i)) ** 10;
    if (v < 0.05) continue;
    const d = hash(i);
    ctx.fillStyle = `rgba(255,200,140,${v.toFixed(3)})`;
    ctx.fillRect(SUN.x + (hash(i + 30) - 0.5) * (200 + d * 900), HORIZON + 6 + d * d * 140, 8, 2);
  }
  ctx.globalCompositeOperation = "source-over";
}

/** The ship's deck slots, one of which the crane works. */
const DECK = Array.from({ length: 13 }, (_, i) => ({
  x: 1090 + i * 38,
  tiers: 2 + Math.floor(hash(i + 3) * 3),
  hue: HUES[Math.floor(hash(i + 7) * HUES.length)],
})).filter((d) => d.x < 1250 || d.x > 1390);
const WORKED = DECK[2];

function ship(ctx: Ctx, t: number, emptied: number) {
  ctx.fillStyle = "#0a0b0d";
  ctx.beginPath();
  ctx.moveTo(1060, 520);
  ctx.lineTo(W + 200, 516);
  ctx.lineTo(W + 200, 600);
  ctx.lineTo(1110, 600);
  ctx.closePath();
  ctx.fill();
  for (const d of DECK) {
    const tiers = d === WORKED ? d.tiers - emptied : d.tiers;
    for (let k = 0; k < tiers; k++) container(ctx, d.x, 502 - (k + 1) * 18, 36, 17, d.hue, 0.15);
  }
  // superstructure with lit windows
  ctx.fillStyle = "#121316";
  ctx.fillRect(1262, 360, 116, 160);
  ctx.fillRect(1250, 344, 140, 18);
  ctx.fillRect(1316, 300, 6, 44);
  const on = lamp(t, 0.4);
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 5; c++) {
      if (hash(r * 11 + c * 5) < 0.4) continue;
      ctx.fillStyle = `rgba(255,214,150,${(0.2 + on * 0.75).toFixed(3)})`;
      ctx.fillRect(1274 + c * 21, 374 + r * 19, 12, 7);
    }
  }
  glow(ctx, 1319, 300, 16, "rgba(255,70,50,1)", Math.sin(t * 2.4) > 0.3 ? 1 : 0.2);
  glow(ctx, 1250, 352, 24, "rgba(255,230,180,1)", on * 0.8);
  glow(ctx, 1390, 352, 24, "rgba(255,230,180,1)", on * 0.8);
}

/*
 * The crane's work. Each 8-second cycle it lowers onto the ship, takes the
 * next provider's container, carries it to the next free slot on the quay and
 * sets it down. Containers stay where they land, so the row fills up; once all
 * six slots are taken the quay clears and a new round starts in a fresh,
 * shuffled order.
 */
const CYCLE = 8;
const CARGO = { w: 96, h: 44 };
const BOOM_Y = 190;
const SLOTS = [380, 500, 620, 740, 860];
const ROUND = SLOTS.length * CYCLE;
const LAND = 5.2;

type Provider = (typeof HARBOR_PROVIDERS)[number];

/** The providers in a shuffled order for round `n`, the same every time for the same round. */
/**
 * Picked once per page load, so every visit starts on a different shuffle of
 * providers (the paint itself stays a pure function of time).
 */
const VISIT = Math.floor(Math.random() * 10_000);

function roundOrder(n: number): Provider[] {
  const order = [...HARBOR_PROVIDERS];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(hash(n * 31 + i * 7 + 1) * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

interface Landed {
  x: number;
  provider: Provider;
  opacity: number;
  /** Seconds since it landed: how long its agent has been working. */
  since: number;
  /** Picks what its agent is doing, different per box and per round. */
  seed: number;
}

function craneState(t: number) {
  const round = Math.floor(t / ROUND);
  const within = t - round * ROUND;
  const slot = Math.min(SLOTS.length - 1, Math.floor(within / CYCLE));
  const c = within - slot * CYCLE;
  const order = roundOrder(round + VISIT);
  const provider = order[slot];
  const quayX = SLOTS[slot];
  const seg = (a: number, b: number) => smooth((c - a) / (b - a));
  const shipX = WORKED.x + 18;
  const up = 60;
  const toShip = 502 - WORKED.tiers * 18 - BOOM_Y - 26;
  const toQuay = 600 - CARGO.h - BOOM_Y - 43;
  let x = shipX;
  let rope = up;
  let carrying = false;
  if (c < 0.9) rope = up + (toShip - up) * seg(0, 0.9);
  else if (c < 1.2) rope = toShip;
  else if (c < 2.2) {
    rope = toShip + (up - toShip) * seg(1.2, 2.2);
    carrying = true;
  } else if (c < 4.2) {
    x = shipX + (quayX - shipX) * seg(2.2, 4.2);
    carrying = true;
  } else if (c < LAND) {
    x = quayX;
    rope = up + (toQuay - up) * seg(4.2, LAND);
    carrying = true;
  } else if (c < 6.3) {
    x = quayX;
    rope = toQuay + (up - toQuay) * seg(5.5, 6.3);
  } else x = quayX + (shipX - quayX) * seg(6.3, 7.9);
  // at the end of a round the whole row fades so the next round starts clear
  const clearing = slot === SLOTS.length - 1 ? 1 - seg(6.4, 7.8) : 1;
  const landed: Landed[] = order.slice(0, slot + (c >= LAND ? 1 : 0)).map((p, i) => ({
    x: SLOTS[i],
    provider: p,
    opacity: clearing,
    since: within - (i * CYCLE + LAND),
    seed: (round + VISIT) * 7 + i * 3 + 1,
  }));
  return { x, rope, carrying, emptied: c >= 1.2 && c < 6.3 ? 1 : 0, landed, provider };
}

/** The portal legs stand behind the quay edge and the sandboxes, so neither is cut. */
function craneLegs(ctx: Ctx) {
  ctx.strokeStyle = "#060708";
  ctx.lineWidth = 16;
  line(ctx, 300, 600, 314, BOOM_Y);
  line(ctx, 590, 600, 576, BOOM_Y);
}

function crane(ctx: Ctx, t: number, s: ReturnType<typeof craneState>) {
  const ink = "#060708";
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  // cross bracing between the legs
  ctx.fillRect(284, 470, 322, 18);
  ctx.lineWidth = 7;
  line(ctx, 300, 470, 590, BOOM_Y + 30);
  line(ctx, 590, 470, 300, BOOM_Y + 30);
  // the boom, reaching out over the ship
  ctx.fillRect(40, BOOM_Y, 1500, 24);
  ctx.lineWidth = 3;
  for (let x = 40; x < 1540; x += 44) line(ctx, x, BOOM_Y + 2, x + 22, BOOM_Y + 22);
  // the A-frame and its stays
  ctx.lineWidth = 14;
  line(ctx, 340, BOOM_Y, 430, 40);
  line(ctx, 550, BOOM_Y, 460, 40);
  ctx.lineWidth = 4;
  line(ctx, 445, 40, 1380, BOOM_Y);
  line(ctx, 445, 40, 900, BOOM_Y);
  line(ctx, 445, 40, 90, BOOM_Y);
  // boom lights
  const on = lamp(t, 0.8);
  for (let x = 80; x < 1540; x += 92) {
    glow(ctx, x, BOOM_Y + 30, 26, "rgba(255,180,90,1)", on * 0.9);
    ctx.fillStyle = `rgba(255,226,170,${on.toFixed(3)})`;
    ctx.fillRect(x - 3, BOOM_Y + 26, 7, 5);
  }
  glow(ctx, 1536, BOOM_Y - 6, 18, "rgba(255,60,40,1)", Math.sin(t * Math.PI) > 0.5 ? 1 : 0.15);
  // trolley, ropes, spreader, and the box when carried
  ctx.fillStyle = ink;
  ctx.fillRect(s.x - 26, BOOM_Y + 24, 52, 14);
  const sy = BOOM_Y + 38 + s.rope;
  ctx.strokeStyle = "#16181b";
  ctx.lineWidth = 2;
  line(ctx, s.x - 16, BOOM_Y + 38, s.x - 18, sy);
  line(ctx, s.x + 16, BOOM_Y + 38, s.x + 18, sy);
  ctx.fillStyle = "#e0a832";
  ctx.fillRect(s.x - 22, sy, 44, 5);
  glow(ctx, s.x, sy + 4, 30, "rgba(255,220,150,1)", on * 0.7);
  if (s.carrying) container(ctx, s.x - CARGO.w / 2, sy + 5, CARGO.w, CARGO.h, s.provider.hue, 0);
}

/**
 * A landed container at work. Its doors swing open, the inside lights up, and
 * an agent (a coral spark) types code onto the back wall. When the job is done
 * the doors close again and a green light shows on the front.
 */
const WORK = 4.6;
/** The agent: a four-point spark that turns and pulses as it works. */
function agent(ctx: Ctx, x: number, y: number, since: number, spin: number) {
  const k = 9 + Math.sin(since * 8) * 1.5;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(since * spin);
  ctx.fillStyle = "#ff8a5a";
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const r = i % 2 ? k * 0.34 : k;
    const ang = (i / 8) * Math.PI * 2;
    ctx.lineTo(Math.cos(ang) * r, Math.sin(ang) * r);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * What an agent does inside its box. Each landed box picks one from its seed,
 * so the row never shows the same thing twice in step.
 */
const JOBS = [
  // writing code: three lines type out on the back wall
  (ctx: Ctx, x: number, y: number, t: number, seed: number) => {
    const typed = t * 40;
    let left = typed;
    let end = { x: x + 12, y: y + 11 };
    for (let r = 0; r < 3 && left > 0; r++) {
      const len = 26 + hash(seed + r) * 22;
      const lx = x + 9 + (r === 1 ? 8 : 0);
      const done = Math.min(len, left);
      ctx.fillStyle = r === 1 ? "#ffc46a" : "#fff2d8";
      ctx.fillRect(lx, y + 9 + r * 10, done, 5);
      end = { x: lx + done + 10, y: y + 11 + r * 10 };
      left -= len + 8;
    }
    agent(ctx, Math.min(end.x, x + 84), end.y, t, 1.6);
  },
  // running tests: a grid of checks fills in, the odd red one turns green
  (ctx: Ctx, x: number, y: number, t: number, seed: number) => {
    const ran = Math.floor(t * 6);
    for (let i = 0; i < 24; i++) {
      const cx = x + 9 + (i % 8) * 9;
      const cy = y + 9 + Math.floor(i / 8) * 10;
      if (i > ran) {
        ctx.fillStyle = "#2a2118";
      } else {
        const flaky = hash(seed * 13 + i) < 0.18 && ran - i < 6;
        ctx.fillStyle = flaky ? "#ff5a4a" : "#5cf09a";
      }
      ctx.fillRect(cx, cy, 6, 6);
    }
    const at = Math.min(ran, 23);
    agent(ctx, x + 12 + (at % 8) * 9, y + 4 + Math.floor(at / 8) * 10, t, 2.4);
  },
  // tailing logs: lines of output scroll up past the agent
  (ctx: Ctx, x: number, y: number, t: number, seed: number) => {
    const scroll = t * 14;
    for (let r = -1; r < 5; r++) {
      const n = Math.floor(scroll / 10) + r;
      const ly = y + 34 - r * 10 + (scroll % 10) - 10;
      const len = 14 + hash(seed + n * 1.7) * 40;
      ctx.fillStyle = hash(seed + n * 3.1) < 0.2 ? "#ffc46a" : "#c9b89a";
      ctx.fillRect(x + 26, ly, len, 4);
    }
    agent(ctx, x + 14, y + 22, t, 1.1);
  },
  // building: a progress bar fills while the agent rides its edge
  (ctx: Ctx, x: number, y: number, t: number, seed: number) => {
    const p = Math.min(1, t / (3.2 + hash(seed) * 0.8));
    ctx.fillStyle = "#fff2d8";
    ctx.fillRect(x + 9, y + 9, 30 + hash(seed + 2) * 20, 5);
    ctx.fillStyle = "#2a2118";
    ctx.fillRect(x + 9, y + 24, 70, 8);
    ctx.fillStyle = p < 1 ? "#ffc46a" : "#5cf09a";
    ctx.fillRect(x + 9, y + 24, 70 * p, 8);
    agent(ctx, x + 9 + 70 * p, y + 18, t, 2);
  },
] as const;

function sandbox(ctx: Ctx, x: number, y: number, hue: string, since: number, seed: number) {
  const { w, h } = CARGO;
  const open = smooth(since / 0.5) * (1 - smooth((since - WORK) / 0.5));
  container(ctx, x, y, w, h, hue, 0.05);
  if (open > 0) {
    // the doors open inward from the middle, so the box never changes size
    const gap = (w - 8) * open;
    const ix = x + 4 + (w - 8 - gap) / 2;
    const iy = y + 4;
    const ih = h - 8;
    ctx.fillStyle = "#0e0905";
    ctx.fillRect(ix, iy, gap, ih);
    ctx.save();
    ctx.beginPath();
    ctx.rect(ix, iy, gap, ih);
    ctx.clip();
    // neighbours' seeds differ by 3, so side-by-side boxes never share a job
    const job = JOBS[seed % JOBS.length];
    job(ctx, x, y, Math.max(0, since - 0.5), seed);
    ctx.restore();
  }
  if (since > WORK + 0.5) {
    ctx.fillStyle = "#5cf09a";
    ctx.fillRect(x + w - 12, y + 6, 5, 5);
    glow(ctx, x + w - 10, y + 8, 12, "rgba(92,240,154,1)", 0.8);
  }
}

function quay(ctx: Ctx, t: number, s: ReturnType<typeof craneState>) {
  // dark enough that the halftone leaves it empty: just the quay edge reads
  ctx.fillStyle = "#0b0c0e";
  ctx.fillRect(-200, 600, W + 400, 300);
  ctx.fillStyle = "#c9962e";
  ctx.fillRect(-200, 600, W + 400, 7);
  // the row of sandboxes the crane has set down; an agent works in each one
  for (const box of s.landed) {
    ctx.globalAlpha = box.opacity;
    sandbox(ctx, box.x - CARGO.w / 2, 600 - CARGO.h, box.provider.hue, box.since, box.seed);
    ctx.globalAlpha = 1;
  }
}

/** Where the scene sits in a canvas: cover it, boom near the top edge, the stacks on the bottom edge. */
function frame(width: number, height: number) {
  const s = Math.max(width / W, height / H) * 1.22;
  const ox = (width - W * s) * 0.42;
  // the quay (down to y 640) sits on the bottom edge, so nothing empty shows below it
  const oy = Math.min(0, height - 616 * s);
  return { s, ox, oy };
}

/** A container a label can follow, in the canvas's own pixels. */
export interface CargoMark {
  x: number;
  y: number;
  opacity: number;
  provider: Provider;
  /** Seconds since it landed on the quay; 0 while carried. */
  since: number;
}

/**
 * Where the labels go: the container the crane is carrying, if any, and the
 * row already set down on the quay.
 */
export function harborCargo(width: number, height: number, t: number, look: Look) {
  const { s, ox, oy } = frame(width, height);
  const state = craneState(t);
  const at = (x: number, y: number, depth: number) => ({
    x: ox - look.x * depth * s + x * s,
    y: oy - look.y * depth * 0.5 * s + y * s,
  });
  const carried: CargoMark | null = state.carrying
    ? {
        ...at(state.x, BOOM_Y + 43 + state.rope, 16),
        opacity: 1,
        provider: state.provider,
        since: 0,
      }
    : null;
  const landed: CargoMark[] = state.landed.map((b) => ({
    ...at(b.x, 600 - CARGO.h, 12),
    opacity: b.opacity,
    provider: b.provider,
    since: b.since,
  }));
  return { carried, landed };
}

/** Paint the whole scene at play time `t` into a canvas of any size. */
export function paintHarbor(ctx: Ctx, width: number, height: number, t: number, look: Look) {
  const { s, ox, oy } = frame(width, height);
  const layer = (depth: number, draw: () => void) => {
    ctx.save();
    ctx.setTransform(s, 0, 0, s, ox - look.x * depth * s, oy - look.y * depth * 0.5 * s);
    draw();
    ctx.restore();
  };
  const state = craneState(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#050608";
  ctx.fillRect(0, 0, width, height);
  layer(2, () => sky(ctx, t));
  layer(4, () => {
    distance(ctx);
    sea(ctx, t);
  });
  layer(8, () => ship(ctx, t, state.emptied));
  layer(12, () => {
    craneLegs(ctx);
    quay(ctx, t, state);
  });
  layer(16, () => crane(ctx, t, state));
}
