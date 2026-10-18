/*
 * One small scene per provider: something the company is known for, made out
 * of sandboxes.
 *   Local    your own machine: a laptop with one sandbox cube inside a dashed boundary
 *   E2B      Firecracker microVMs: firecrackers bursting into rings of tiny sandboxes
 *   Daytona  speed: light trails racing to a blue horizon, each led by a tiny sandbox
 *   Vercel   the triangle over a grid floor, sandboxes rising and sinking beside it
 *   Upstash  a box: the lid opens, data rises, a snapshot copy slides out
 *   Boat     boats: a lighthouse sweeping a dashed-line sea, sailboats and barrels
 *   Railway  a train crossing under Railway's purple night sky
 *   Tenki    their isometric cube, built from sandboxes that snap in fast and lift away
 * Drawn in a 480 by 400 frame; the wrapper zooms so the subject, around y 170,
 * fills the top of the card above its caption.
 */

import type { Painter } from "@/components/halftone/halftone-canvas";

const W = 480;
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

function fill(ctx: Ctx, stops: [number, string][], y0: number, y1: number) {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [at, c] of stops) g.addColorStop(at, c);
  ctx.fillStyle = g;
  ctx.fillRect(-60, y0, W + 120, y1 - y0);
}

function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

/** An isometric cube centred on its top-front corner: colours are top, left, right. */
function isoCube(
  ctx: Ctx,
  cx: number,
  cy: number,
  a: number,
  colors: [string, string, string],
  alpha: number,
  edge?: string,
) {
  const k = 0.87 * a;
  const faces: [number, number][][] = [
    [
      [cx, cy - a],
      [cx + k, cy - a / 2],
      [cx, cy],
      [cx - k, cy - a / 2],
    ],
    [
      [cx - k, cy - a / 2],
      [cx, cy],
      [cx, cy + a],
      [cx - k, cy + a / 2],
    ],
    [
      [cx, cy],
      [cx + k, cy - a / 2],
      [cx + k, cy + a / 2],
      [cx, cy + a],
    ],
  ];
  ctx.globalAlpha = alpha;
  faces.forEach((pts, i) => {
    ctx.beginPath();
    pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = colors[i];
    ctx.fill();
    if (edge) {
      ctx.strokeStyle = edge;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
}

/** Zoom the frame so y 170 sits 40% down the card, and calm the caption area. */
function scene(draw: (ctx: Ctx, t: number) => void): Painter {
  return (ctx, w, h, t) => {
    const s = Math.max(w / W, h / 400) * 1.2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#08080a";
    ctx.fillRect(0, 0, w, h);
    ctx.setTransform(s, 0, 0, s, w / 2 - 240 * s, h * 0.4 - 170 * s);
    draw(ctx, t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    const fade = ctx.createLinearGradient(0, h * 0.6, 0, h);
    fade.addColorStop(0, "rgba(8,8,10,0)");
    fade.addColorStop(1, "rgba(8,8,10,0.85)");
    ctx.fillStyle = fade;
    ctx.fillRect(0, h * 0.6, w, h * 0.4);
  };
}

/* Local: the sandbox runs on your own machine. A laptop, and on its screen one amber cube inside a dashed boundary. */
const local = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#0a0704"],
      [1, "#1c1309"],
    ],
    -60,
    460,
  );
  glow(ctx, 240, 150, 240, "rgba(232,163,60,1)", 0.25);
  // the laptop: lid, screen, base
  ctx.fillStyle = "#6a4a22";
  ctx.fillRect(116, 52, 248, 166);
  ctx.fillStyle = "#0b0805";
  ctx.fillRect(126, 62, 228, 146);
  ctx.fillStyle = "#a07636";
  ctx.beginPath();
  ctx.moveTo(96, 218);
  ctx.lineTo(384, 218);
  ctx.lineTo(408, 236);
  ctx.lineTo(72, 236);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#6a4a22";
  ctx.fillRect(214, 222, 52, 4);
  // the boundary: a dashed square that marches, isolating what runs inside
  const dash = (t * 18) % 12;
  ctx.fillStyle = "#e8a33c";
  for (let d = -dash; d < 120; d += 12) {
    const s = Math.max(0, d);
    const e = Math.min(120, d + 6);
    if (e <= s) continue;
    ctx.fillRect(180 + s, 74, e - s, 2);
    ctx.fillRect(300 - e, 194, e - s, 2);
    ctx.fillRect(180, 194 - e, 2, e - s);
    ctx.fillRect(298, 74 + s, 2, e - s);
  }
  // the sandbox itself, breathing a little
  const lift = Math.sin(t * 1.4) * 4;
  isoCube(ctx, 240, 128 + lift, 34, ["#ffd08a", "#e8a33c", "#a86a1e"], 1);
  glow(ctx, 240, 134, 70, "rgba(255,190,100,1)", 0.35);
  // a prompt in the corner of the screen, typing
  ctx.fillStyle = "#e8a33c";
  ctx.fillRect(136, 72, 5, 5);
  ctx.fillRect(146, 72, ((t * 20) % 30) + 4, 5);
  if (Math.sin(t * 6) > 0) ctx.fillRect(152 + ((t * 20) % 30), 71, 4, 7);
});

/* E2B: its sandboxes are Firecracker microVMs. Firecrackers go up and burst into a ring of tiny sandboxes. */
const e2b = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#050403"],
      [1, "#140a05"],
    ],
    -60,
    460,
  );
  glow(ctx, 240, 300, 260, "rgba(255,90,30,1)", 0.18);
  // the ground, and a launch tube under each shell
  ctx.fillStyle = "#24160e";
  ctx.fillRect(-60, 286, W + 120, 174);
  const CYCLE = 3.6;
  const shells = [
    { x: 240, y: 126, at: 0 },
    { x: 128, y: 164, at: 1.2 },
    { x: 356, y: 150, at: 2.4 },
  ];
  ctx.globalCompositeOperation = "lighter";
  shells.forEach((sh, si) => {
    const run = Math.floor((t - sh.at) / CYCLE);
    const c = t - sh.at - run * CYCLE;
    if (c < 0) return;
    const seed = run * 3 + si;
    // the tube glows as it fires and cools after
    const heat = Math.max(0, 1 - c / 0.9);
    ctx.fillStyle = "#5a3018";
    ctx.fillRect(sh.x - 14, 254, 28, 32);
    ctx.fillStyle = "#ff5a1f";
    ctx.fillRect(sh.x - 14, 254, 28, 4);
    glow(ctx, sh.x, 254, 60, "rgba(255,110,40,1)", 0.25 + heat * 0.8);
    const bx = sh.x + (hash(seed) - 0.5) * 30;
    const by = sh.y + (hash(seed + 9) - 0.5) * 30;
    if (c < 0.7) {
      // the fuse: a bright head climbing on a short trail
      const k = smooth(c / 0.7);
      const x = sh.x + (bx - sh.x) * k;
      const y = 254 - (254 - by) * k;
      ctx.fillStyle = "rgba(255,150,80,0.6)";
      ctx.fillRect(x - 2, y, 4, Math.min(56, (254 - by) * k));
      ctx.fillStyle = "#fff1dc";
      ctx.fillRect(x - 5, y - 5, 10, 10);
      glow(ctx, x, y, 34, "rgba(255,120,50,1)", 0.9);
      return;
    }
    // the burst: a flash, then a ring of sandboxes flying out and falling as they fade
    const b = c - 0.7;
    glow(ctx, bx, by, 150, "rgba(255,110,40,1)", Math.max(0, 1 - b * 1.2));
    glow(ctx, bx, by, 50, "rgba(255,230,200,1)", Math.max(0, 1 - b * 3));
    const n = 18;
    const fade = 1 - clamp01((b - 1.4) / 1.2);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + hash(seed + 3) * 6;
      const speed = 84 + hash(seed * 31 + i) * 34;
      const r = (speed * (1 - Math.exp(-b * 2.6))) / 1.1;
      const x = bx + Math.cos(a) * r;
      const y = by + Math.sin(a) * r + b * b * 16;
      const size = 15 - b * 3.5;
      if (size <= 1 || fade <= 0) continue;
      // a short spark trail back toward the centre
      ctx.strokeStyle = `rgba(255,120,50,${0.5 * fade})`;
      ctx.lineWidth = 3;
      line(ctx, x, y, x - Math.cos(a) * 24, y - Math.sin(a) * 24 - 3);
      ctx.globalAlpha = fade;
      ctx.fillStyle = i % 3 === 0 ? "#fff1dc" : "#ff5a1f";
      ctx.fillRect(x - size / 2, y - size / 2, size, size);
      ctx.fillStyle = "#3a1406";
      ctx.fillRect(x - size / 2 + 3, y - size / 2 + 3, Math.max(0, size - 6), 2);
      ctx.globalAlpha = 1;
    }
  });
  ctx.globalCompositeOperation = "source-over";
});

/* Daytona: speed. Light trails race to a blue horizon, each led by a tiny sandbox. */
const daytona = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#02040a"],
      [1, "#0a1a3a"],
    ],
    -60,
    170,
  );
  fill(
    ctx,
    [
      [0, "#06101f"],
      [1, "#010204"],
    ],
    170,
    460,
  );
  glow(ctx, 240, 170, 300, "rgba(40,120,255,1)", 0.7);
  glow(ctx, 240, 170, 80, "rgba(190,220,255,1)", 1);
  ctx.strokeStyle = "rgba(90,160,255,1)";
  ctx.lineWidth = 4;
  for (const s of [-1, 1]) line(ctx, 240, 172, 240 + s * 420, 460);
  for (let i = 0; i < 10; i++) {
    const k = ((i / 10 + t * 0.9) % 1) ** 2;
    ctx.fillStyle = `rgba(200,220,255,${0.3 + k * 0.7})`;
    ctx.fillRect(240 - 1 - k * 3, 172 + k * 290, 2 + k * 6, 4 + k * 26);
  }
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 26; i++) {
    const lane = (hash(i) - 0.5) * 2;
    const k = ((hash(i + 20) + t * (0.5 + hash(i + 40) * 0.6)) % 1) ** 2;
    const back = Math.max(0, k - 0.05 - k * 0.25);
    const red = i % 3 === 0;
    ctx.strokeStyle = red ? "rgba(255,90,90,0.9)" : "rgba(120,180,255,0.9)";
    ctx.lineWidth = 2 + k * 9;
    const hx = 240 + lane * 340 * k;
    const hy = 172 + 290 * k;
    line(ctx, 240 + lane * 340 * back, 172 + 290 * back, hx, hy);
    const s = 3 + k * 12;
    ctx.fillStyle = red ? "#ffd0d0" : "#e8f2ff";
    ctx.fillRect(hx - s / 2, hy - s / 2, s, s);
  }
  ctx.globalCompositeOperation = "source-over";
});

/* Vercel Sandbox: the triangle over a grid floor, sandboxes rising and sinking on either side. */
const vercel = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#000000"],
      [1, "#0a0a0a"],
    ],
    -60,
    214,
  );
  fill(
    ctx,
    [
      [0, "#0d0d0d"],
      [1, "#000000"],
    ],
    214,
    460,
  );
  for (let i = 0; i < 36; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.6 * Math.abs(Math.sin(t * 0.6 + i))})`;
    ctx.fillRect(hash(i) * W, hash(i + 60) * 150 - 30, 2, 2);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.2;
  for (let i = -12; i <= 12; i++) line(ctx, 240 + i * 16, 214, 240 + i * 70, 460);
  for (let i = 0; i < 7; i++) {
    const y = 214 + i * i * 6;
    line(ctx, -60, y, W + 60, y);
  }
  // cubes rising from the floor, like levels on a meter
  for (let i = 0; i < 6; i++) {
    for (const side of [-1, 1]) {
      const x = 240 + side * (112 + i * 26);
      const h =
        10 + (0.5 + 0.5 * Math.sin(t * 2.2 + i * 0.9 + (side > 0 ? 1.7 : 0))) * (60 - i * 7);
      const g = ctx.createLinearGradient(0, 214 - h, 0, 214);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(1, "#6a6a6a");
      ctx.fillStyle = g;
      ctx.fillRect(x - 9, 214 - h, 18, h);
      ctx.fillStyle = "rgba(255,255,255,0.15)";
      ctx.fillRect(x - 9, 216, 18, h * 0.4);
    }
  }
  // reflection, then the triangle
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(170, 214);
  ctx.lineTo(310, 214);
  ctx.lineTo(240, 320);
  ctx.fill();
  ctx.globalAlpha = 1;
  glow(ctx, 240, 150, 160, "rgba(255,255,255,1)", 0.2);
  const face = ctx.createLinearGradient(0, 74, 0, 214);
  face.addColorStop(0, "#ffffff");
  face.addColorStop(1, "#bdbdbd");
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.moveTo(240, 76);
  ctx.lineTo(320, 214);
  ctx.lineTo(160, 214);
  ctx.closePath();
  ctx.fill();
});

/* Upstash Box: an emerald cube floating over its reflection. The lid opens, data rises, a snapshot copy slides out. */
const upstash = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#010a06"],
      [1, "#03170e"],
    ],
    -60,
    460,
  );
  glow(ctx, 240, 150, 220, "rgba(0,233,163,1)", 0.22);
  const c = t % 8;
  const float = Math.sin(t * 1.2) * 6;
  const open = smooth((c - 0.8) / 1.2) * (1 - smooth((c - 5.6) / 1.2));
  const cube = (cx: number, cy: number, a: number, alpha: number, outline: boolean) => {
    const k = 0.87 * a;
    const top: [number, number][] = [
      [cx, cy - a],
      [cx + k, cy - a / 2],
      [cx, cy],
      [cx - k, cy - a / 2],
    ];
    const left: [number, number][] = [
      [cx - k, cy - a / 2],
      [cx, cy],
      [cx, cy + a],
      [cx - k, cy + a / 2],
    ];
    const right: [number, number][] = [
      [cx, cy],
      [cx + k, cy - a / 2],
      [cx + k, cy + a / 2],
      [cx, cy + a],
    ];
    const face = (pts: [number, number][], color: string) => {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      if (outline) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
    };
    ctx.globalAlpha = alpha;
    face(left, "#00a874");
    face(right, "#00744f");
    return { top, face, reset: () => (ctx.globalAlpha = 1) };
  };
  // shadow on the floor
  ctx.globalAlpha = 0.5 - float * 0.02;
  ctx.fillStyle = "#00e9a3";
  ctx.beginPath();
  ctx.ellipse(240, 262, 70 - float, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  // the snapshot: a copy slides out to the right and fades
  const snap = c > 2.6 && c < 5.4 ? (c - 2.6) / 2.8 : 0;
  if (snap > 0) {
    const ghost = cube(240 + smooth(snap) * 150, 150 + float, 56, 1 - snap, true);
    ghost.face(ghost.top, "#5fffc9");
    ghost.reset();
  }
  const main = cube(240, 150 + float, 56, 1, false);
  main.reset();
  // inside, then the lid lifted by `open`
  main.face(main.top, "#02331f");
  for (let i = 0; i < 18; i++) {
    const k = (t * 0.7 + hash(i)) % 1;
    if (open < 0.2) break;
    ctx.globalAlpha = open * (1 - k);
    ctx.fillStyle = "#7affd2";
    ctx.fillRect(228 + hash(i + 4) * 24, 120 + float - k * 90, 4, 4);
  }
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.translate(0, -open * 34);
  main.face(main.top, "#5fffc9");
  ctx.restore();
});

/* Boat: a lighthouse sweeping a dashed-line sea, sailboats with blue flags, barrels bobbing. */
const boat = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#04060a"],
      [1, "#141a24"],
    ],
    -60,
    205,
  );
  fill(
    ctx,
    [
      [0, "#0c111a"],
      [1, "#030406"],
    ],
    205,
    460,
  );
  glow(ctx, 380, 40, 40, "rgba(240,244,255,1)", 0.7);
  // the sea as rows of dashes, like boat.dev's
  ctx.fillStyle = "rgba(210,220,240,0.55)";
  for (let r = 0; r < 14; r++) {
    const y = 210 + r * r * 1.4 + r * 6;
    const gap = 10 + r * 2;
    const drift = (t * (8 + r * 2)) % (gap * 2);
    for (let x = -40 + drift + (r % 2) * gap; x < W + 40; x += gap * 2)
      ctx.fillRect(x, y, gap, 1.5 + r * 0.15);
  }
  // rock and lighthouse
  ctx.fillStyle = "#06080c";
  ctx.beginPath();
  ctx.moveTo(40, 214);
  ctx.lineTo(80, 192);
  ctx.lineTo(160, 188);
  ctx.lineTo(196, 214);
  ctx.fill();
  ctx.fillStyle = "#e8ebf2";
  ctx.beginPath();
  ctx.moveTo(100, 192);
  ctx.lineTo(136, 192);
  ctx.lineTo(128, 96);
  ctx.lineTo(108, 96);
  ctx.fill();
  ctx.fillStyle = "#2a3550";
  ctx.fillRect(104, 128, 28, 9);
  ctx.fillRect(102, 160, 32, 9);
  ctx.fillStyle = "#0a0d14";
  ctx.fillRect(104, 78, 28, 18);
  ctx.fillRect(100, 74, 36, 4);
  // the beam sweeps across the water and back
  const a = Math.sin(t * 0.7);
  const tip = 118 + a * 360;
  ctx.globalCompositeOperation = "lighter";
  const beam = ctx.createLinearGradient(118, 87, tip, 87);
  beam.addColorStop(0, "rgba(255,248,220,0.85)");
  beam.addColorStop(1, "rgba(255,248,220,0)");
  ctx.fillStyle = beam;
  ctx.beginPath();
  ctx.moveTo(118, 87);
  ctx.lineTo(tip, 62);
  ctx.lineTo(tip, 116);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  glow(ctx, 118, 87, 30 + (1 - Math.abs(a)) * 50, "rgba(255,250,230,1)", 1);
  // sailboats with blue flags
  for (let i = 0; i < 2; i++) {
    const x = ((t * (14 + i * 6) + i * 260) % (W + 200)) - 60;
    const y = 214 + i * 34;
    const s = 1 + i * 0.35;
    const bob = Math.sin(t * 1.6 + i * 2) * 2;
    ctx.fillStyle = "#eef1f7";
    ctx.beginPath();
    ctx.moveTo(x, y - 4 * s + bob);
    ctx.lineTo(x + 2 * s, y - 52 * s + bob);
    ctx.lineTo(x + 30 * s, y - 6 * s + bob);
    ctx.fill();
    ctx.fillStyle = "#3b6cff";
    ctx.fillRect(x + 2 * s, y - 60 * s + bob, 12 * s, 7 * s);
    ctx.fillStyle = "#cfd6e4";
    ctx.fillRect(x - 10 * s, y - 2 * s + bob, 46 * s, 5 * s);
  }
  // barrels
  for (let i = 0; i < 3; i++) {
    const x = 300 + i * 60 + Math.sin(t * 0.5 + i) * 6;
    const y = 236 + i * 16 + Math.sin(t * 1.8 + i * 3) * 3;
    ctx.fillStyle = "#b8c0d0";
    ctx.fillRect(x, y, 16, 12);
    ctx.fillStyle = "#4a5568";
    ctx.fillRect(x, y + 3, 16, 1.5);
    ctx.fillRect(x, y + 8, 16, 1.5);
  }
});

/* Railway: a train crossing a bridge under a purple night sky and drifting clouds. */
const railway = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#0a0620"],
      [0.7, "#2a1650"],
      [1, "#4a2a78"],
    ],
    -60,
    230,
  );
  fill(
    ctx,
    [
      [0, "#140a28"],
      [1, "#05030c"],
    ],
    230,
    460,
  );
  for (let i = 0; i < 50; i++) {
    const tw = 0.3 + 0.7 * Math.abs(Math.sin(t * (0.5 + hash(i) * 1.5) + i));
    ctx.fillStyle = `rgba(230,220,255,${tw})`;
    ctx.fillRect(hash(i + 3) * W, hash(i + 77) * 170 - 50, 2, 2);
  }
  // soft purple clouds, drifting
  for (let i = 0; i < 9; i++) {
    const x = ((hash(i) * 700 + t * (6 + hash(i + 4) * 6)) % 700) - 110;
    const y = 60 + hash(i + 8) * 120;
    glow(ctx, x, y, 70 + hash(i + 2) * 50, "rgba(150,110,210,1)", 0.45);
    glow(ctx, x + 20, y + 12, 40 + hash(i + 2) * 30, "rgba(200,170,250,1)", 0.35);
  }
  // bridge
  ctx.fillStyle = "#0c0718";
  ctx.strokeStyle = "#0c0718";
  ctx.lineWidth = 3;
  ctx.fillRect(-60, 200, W + 120, 8);
  for (let x = -40; x < W + 40; x += 70) {
    ctx.fillRect(x, 208, 8, 140);
    line(ctx, x, 208, x + 35, 260);
    line(ctx, x + 70, 208, x + 35, 260);
  }
  // the train
  const head = ((t * 70) % (W + 600)) - 100;
  for (let i = 0; i < 6; i++) {
    const x = head - i * 86;
    if (x < -90 || x > W + 20) continue;
    ctx.fillStyle = i === 0 ? "#6a4aa8" : "#4e3488";
    ctx.fillRect(x, 160, 82, 40);
    ctx.fillStyle = "#ffe2a8";
    for (let k = 0; k < 5; k++) ctx.fillRect(x + 6 + k * 15, 170, 10, 12);
    glow(ctx, x + 40, 176, 50, "rgba(255,210,150,1)", 0.35);
    if (i === 0) glow(ctx, x + 86, 186, 70, "rgba(255,245,220,1)", 1);
  }
  ctx.fillStyle = "#8b5cf6";
  ctx.fillRect(-60, 199, W + 120, 2);
});

/* Tenki: their isometric cube, built out of sandboxes. Small cubes snap in fast, the whole one pulses, then they lift away and it rebuilds. */
const tenki = scene((ctx, t) => {
  fill(
    ctx,
    [
      [0, "#020a1c"],
      [1, "#061634"],
    ],
    -60,
    460,
  );
  glow(ctx, 240, 150, 240, "rgba(47,107,255,1)", 0.3);
  const a = 24;
  const kx = 0.87 * a;
  const ky = a / 2;
  const cx = 240;
  const cy = 150;
  // the floor: an isometric grid under the cube
  const floor = (i: number, j: number): [number, number] => [
    cx + (i - j) * kx,
    cy + a + (i + j) * ky,
  ];
  ctx.strokeStyle = "rgba(90,140,255,0.45)";
  ctx.lineWidth = 1.5;
  for (let n = -2; n <= 5; n++) {
    line(ctx, ...floor(n, -2), ...floor(n, 5));
    line(ctx, ...floor(-2, n), ...floor(5, n));
  }
  const c = t % 7;
  const voxels: { i: number; j: number; k: number; n: number }[] = [];
  for (let k = 0; k < 3; k++)
    for (let s = 0; s <= 4; s++)
      for (let i = 0; i < 3; i++) {
        const j = s - i;
        if (j >= 0 && j < 3) voxels.push({ i, j, k, n: voxels.length });
      }
  const whole = smooth((c - 2.3) / 0.3) * (1 - smooth((c - 4.2) / 0.3));
  if (whole > 0) glow(ctx, cx, cy, 170, "rgba(120,170,255,1)", whole * 0.5);
  for (const v of voxels) {
    // arrive one after another, bottom layer first; leave top layer first
    const arrive = clamp01((c - v.n * 0.075) / 0.35);
    const leave = clamp01((c - 4.4 - (26 - v.n) * 0.06) / 0.6);
    if (arrive <= 0 || leave >= 1) continue;
    const land = 1 - (1 - arrive) ** 3;
    const drop = (1 - land) * 140;
    const rise = leave * leave * 220;
    const x = cx + (v.i - v.j) * kx;
    const y = cy + (v.i + v.j) * ky - v.k * a - drop - rise;
    const fresh = 1 - clamp01((c - v.n * 0.075 - 0.35) / 0.3);
    const top = fresh > 0 || whole > 0.5 ? "#e2ecff" : "#9cc0ff";
    // dark seams on every face, so each sandbox reads on its own
    isoCube(
      ctx,
      x,
      y,
      a,
      [top, "#2f6bff", "#1b45b8"],
      (1 - leave) * Math.min(1, arrive * 3),
      "#020a1c",
    );
  }
});

export const providerScenes = {
  local,
  e2b,
  daytona,
  vercel,
  upstash,
  boat,
  railway,
  tenki,
} satisfies Record<string, Painter>;
