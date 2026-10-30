"use client";

/*
 * The /v2 diagrams: pixel-art scenes, one idea each, drawn on a coarse grid by
 * PixelCanvas. Every scene is a loop with a written timeline (in seconds) and
 * a still frame for reduced motion. Labels are real text laid over the canvas.
 */
import Image from "next/image";
import type { ReactNode } from "react";

import { inOut, out, PixelCanvas, span, type Grid } from "./pixel-canvas";
import styles from "./diagrams.module.css";

const C = {
  panel: "#111216",
  edge: "#2a2c33",
  dim: "#3a3d44",
  mid: "#5b5f69",
  text: "#e6eaf0",
  amber: "#efa43b",
  amberLight: "#ffd08a",
  amberDark: "#a86a1e",
  amberDeep: "#5a4220",
  green: "#8fbf8a",
  red: "#c98585",
  cool: "#9cb8e6",
  coolDark: "#4f5f80",
};

function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;

  return s - Math.floor(s);
}

/** A sandbox: an amber block with a lit top edge, a shaded side and a lid seam. */
function box(g: Grid, x: number, y: number, s: number, alpha = 1) {
  g.rect(x, y, s, s, C.amber, alpha);
  g.rect(x, y, s, 2, C.amberLight, alpha);
  g.rect(x + s - 2, y + 2, 2, s - 2, C.amberDark, alpha);
  g.rect(x, y + Math.round(s * 0.3), s - 2, 1, C.amberDark, alpha);
}

/** A one-unit outline. */
function frame(g: Grid, x: number, y: number, w: number, h: number, color: string, alpha = 1) {
  g.rect(x, y, w, 1, color, alpha);
  g.rect(x, y + h - 1, w, 1, color, alpha);
  g.rect(x, y, 1, h, color, alpha);
  g.rect(x + w - 1, y, 1, h, color, alpha);
}

/** A dashed one-unit outline: `on` units drawn, `gap` skipped. */
function dashed(
  g: Grid,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  on = 3,
  gap = 2,
) {
  for (let i = 0; i < w; i += on + gap) {
    g.rect(x + i, y, Math.min(on, w - i), 1, color);
    g.rect(x + i, y + h - 1, Math.min(on, w - i), 1, color);
  }

  for (let j = 0; j < h; j += on + gap) {
    g.rect(x, y + j, 1, Math.min(on, h - j), color);
    g.rect(x + w - 1, y + j, 1, Math.min(on, h - j), color);
  }
}

/** A small cloud, drawn from three overlapping blocks. */
function cloud(g: Grid, x: number, y: number, color: string) {
  g.rect(x + 3, y, 6, 3, color);
  g.rect(x + 1, y + 2, 12, 3, color);
  g.rect(x, y + 4, 14, 3, color);
}

/** A label laid over the canvas, positioned in grid units. */
function Tag({
  x,
  y,
  cols,
  rows,
  children,
  align = "center",
  tone,
  minor = false,
}: {
  x: number;
  y: number;
  cols: number;
  rows: number;
  children: ReactNode;
  align?: "left" | "center";
  tone?: "ok" | "fail" | "lit";
  /** Hidden on narrow screens, where the canvas is too small for every label. */
  minor?: boolean;
}) {
  return (
    <span
      className={`${styles.tag} ${align === "center" ? styles.center : ""} ${tone ? styles[tone] : ""} ${minor ? styles.minor : ""}`}
      style={{ "--x": `${(x / cols) * 100}%`, "--y": `${(y / rows) * 100}%` }}
    >
      {children}
    </span>
  );
}

/* ---------- swap: same code, the switch sends it to a different provider ---------- */

const STATIONS = [
  { name: "E2B", logo: "/providers/e2b.svg", color: "#ff6a2b" },
  { name: "Vercel Sandbox", logo: "/providers/vercel.svg", color: "#f5f5f5" },
  { name: "Daytona", logo: "/providers/daytona.svg", color: "#5aa0ff" },
  { name: "Upstash Box", logo: "/providers/upstash.svg", color: "#00c98d" },
  { name: "Docker", logo: "/providers/docker.svg", color: "#3b82f6" },
] as const;

const SW = { cols: 240, rows: 80, cycle: 2.8, travel: 1.3 };
const SWITCH_X = 104;
const DOCK_X = 178;
const stationY = (k: number) => 12 + k * 14;

/** The track to station k as a list of grid points, about one unit apart. */
const TRACKS = STATIONS.map((_, k) => {
  const pts: [number, number][] = [];
  const y = stationY(k);

  for (let x = 70; x < SWITCH_X; x++) pts.push([x, 40]);

  // an S-curve out of the switch onto the station's row
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const e = u * u * (3 - 2 * u);
    pts.push([SWITCH_X + u * 40, 40 + (y - 40) * e]);
  }

  // on into the middle of the dock, where the sandbox parks
  for (let x = SWITCH_X + 41; x <= DOCK_X + 9; x++) pts.push([x, y]);

  return pts;
});

function drawSwap(g: Grid, t: number) {
  const k = Math.floor(t / SW.cycle) % STATIONS.length;
  const c = t % SW.cycle;
  const go = inOut(c / SW.travel);
  const track = TRACKS[k];
  const at = Math.round(go * (track.length - 1));

  // your code: a panel whose lines never change
  g.rect(12, 18, 54, 44, C.panel);
  frame(g, 12, 18, 54, 44, C.edge);
  [30, 22, 38, 26, 34, 18].forEach((w, i) =>
    g.rect(18, 25 + i * 5, w, 2, i === 0 ? C.amberDeep : C.dim),
  );

  // every track, dotted; the chosen one lit up to where the sandbox has reached
  TRACKS.forEach((pts, i) => {
    for (let p = 0; p < pts.length; p += 2)
      if (pts[p][0] < DOCK_X) g.rect(pts[p][0], pts[p][1], 1, 1, i === k ? C.amberDeep : C.edge);
  });

  for (let p = 0; p <= at; p++)
    if (track[p][0] < DOCK_X) g.rect(track[p][0], track[p][1], 1, 1, C.amber);

  // the switch, with its lever pointing at the chosen track
  const lever = Math.sign(stationY(k) - 40);
  g.rect(SWITCH_X - 2, 38, 5, 5, C.panel);
  frame(g, SWITCH_X - 2, 38, 5, 5, C.amber);
  g.rect(SWITCH_X + 3, 40 + lever * 2, 2, 1, C.amber);

  STATIONS.forEach((s, i) => {
    const y = stationY(i);
    const here = i === k;
    const arrived = here ? span(c, SW.travel, SW.travel + 0.25) : 0;
    frame(g, DOCK_X, y - 5, 18, 11, here ? s.color : C.edge, here ? 0.4 + arrived * 0.6 : 1);

    if (arrived > 0) g.rect(DOCK_X + 1, y - 4, 16, 9, s.color, arrived * 0.18);
  });

  // the sandbox, with a short trail while it moves
  const [px, py] = track[at];

  if (go < 1) {
    for (let tr = 1; tr <= 3; tr++) {
      const q = track[Math.max(0, at - tr * 4)];
      g.rect(q[0] - 1, q[1] - 1, 2, 2, C.amber, 0.5 - tr * 0.14);
    }
  }

  const fade = 1 - span(c, SW.cycle - 0.25, SW.cycle);
  box(g, px - 4, py - 4, 8, fade);
}

export function SwapDiagram() {
  return (
    <PixelCanvas
      className={styles.swap}
      cols={SW.cols}
      rows={SW.rows}
      draw={drawSwap}
      stillAt={SW.travel + 0.6}
      step={(t) =>
        (Math.floor(t / SW.cycle) % STATIONS.length) * 2 + (t % SW.cycle >= SW.travel ? 1 : 0)
      }
      label="The same code, sent by a switch to E2B, Vercel Sandbox, Daytona, Upstash Box or Docker in turn."
      overlay={(k) => (
        <>
          <Tag x={39} y={12} cols={SW.cols} rows={SW.rows}>
            your code
          </Tag>
          <Tag x={39} y={68} cols={SW.cols} rows={SW.rows} minor>
            unchanged
          </Tag>
          <Tag x={SWITCH_X} y={50} cols={SW.cols} rows={SW.rows} minor>
            adapter
          </Tag>
          {STATIONS.map((st, i) => {
            const lit = i * 2 + 1 === k;

            return (
              <span
                key={st.name}
                className={`${styles.logo} ${lit ? styles.logoLit : ""}`}
                style={{
                  "--x": `${((DOCK_X + 24) / SW.cols) * 100}%`,
                  "--y": `${((stationY(i) - 6) / SW.rows) * 100}%`,
                  "--w": `${(12 / SW.cols) * 100}%`,
                }}
              >
                <Image src={st.logo} alt="" width={48} height={48} unoptimized />
              </span>
            );
          })}
          {k % 2 === 1 && (
            <Tag
              x={DOCK_X + 40}
              y={stationY(Math.floor(k / 2))}
              cols={SW.cols}
              rows={SW.rows}
              align="left"
              tone="lit"
              minor
            >
              {STATIONS[Math.floor(k / 2)].name}
            </Tag>
          )}
        </>
      )}
    />
  );
}

/* ---------- run: a command drops in, output streams out, the result lights ---------- */

const RUN = { cols: 96, rows: 72, cycle: 4.4 };
const OUTPUT = [26, 16, 32, 20, 12];

function drawRun(g: Grid, t: number) {
  const c = t % RUN.cycle;
  const fail = Math.floor(t / RUN.cycle) % 2 === 1;
  const fade = 1 - span(c, RUN.cycle - 0.3, RUN.cycle);

  // the command, with a caret that blinks until it is sent
  g.rect(28, 4, 40, 10, "#17181c");
  frame(g, 28, 4, 40, 10, C.edge);

  if (c < 0.35 && Math.floor(t * 4) % 2 === 0) g.rect(62, 7, 2, 4, C.text);

  // it drops into the sandbox
  const drop = out(span(c, 0.35, 0.8));

  if (c > 0.35 && c < 0.85) g.rect(47, 15 + drop * 10, 3, 3, C.amber);

  const working = c > 0.8 && c < 3.0;
  box(g, 40, 26, 16, working ? 1 : 0.35);

  if (working) {
    // the work inside: cells flicker on a fast clock
    for (let i = 0; i < 4; i++) {
      if (hash(Math.floor(t * 9) * 7 + i) > 0.45)
        g.rect(43 + (i % 2) * 6, 33 + Math.floor(i / 2) * 4, 3, 2, C.amberLight);
    }
  }

  // output streams out under it, one line at a time; the last line says how it ended
  OUTPUT.forEach((w, i) => {
    const appear = out(span(c, 1.0 + i * 0.32, 1.25 + i * 0.32));

    if (appear <= 0) return;
    const last = i === OUTPUT.length - 1;
    g.rect(
      22,
      47 + i * 4,
      Math.round(w * appear),
      2,
      last ? (fail ? C.red : C.green) : C.dim,
      fade,
    );
  });

  // the result lamp on the sandbox
  const lamp = span(c, 2.9, 3.1) * fade;

  if (lamp > 0) g.rect(46, 20, 4, 3, fail ? C.red : C.green, lamp);
}

export function RunDiagram() {
  return (
    <PixelCanvas
      cols={RUN.cols}
      rows={RUN.rows}
      draw={drawRun}
      stillAt={3.4}
      step={(t) => {
        const c = t % RUN.cycle;

        if (c < 2.9 || c > RUN.cycle - 0.3) return 0;

        return Math.floor(t / RUN.cycle) % 2 === 1 ? 2 : 1;
      }}
      label="A command goes into the sandbox, output streams out, and the result comes back as ok or ok: false."
      overlay={(s) => (
        <>
          <Tag x={46} y={9} cols={RUN.cols} rows={RUN.rows}>
            bun test
          </Tag>
          {s > 0 && (
            <Tag x={48} y={69} cols={RUN.cols} rows={RUN.rows} tone={s === 1 ? "ok" : "fail"}>
              {s === 1 ? "exit 0 · ok: true" : "exit 1 · ok: false"}
            </Tag>
          )}
        </>
      )}
    />
  );
}

/* ---------- files: files arc into the sandbox, commits push to the remote ---------- */

const FILES = { cols: 96, rows: 72, cycle: 5 };

function drawFiles(g: Grid, t: number) {
  const c = t % FILES.cycle;
  const fade = 1 - span(c, FILES.cycle - 0.4, FILES.cycle);

  // your machine: a folder
  g.rect(8, 14, 9, 3, C.mid);
  g.rect(8, 16, 22, 15, C.dim);
  g.rect(8, 16, 22, 2, C.mid);

  // the sandbox, flashing an outline as each file lands
  box(g, 66, 13, 20);

  for (let i = 0; i < 3; i++) {
    const flash =
      span(c, 0.95 + i * 0.45, 1.0 + i * 0.45) * (1 - span(c, 1.0 + i * 0.45, 1.3 + i * 0.45));

    if (flash > 0) frame(g, 64, 11, 24, 24, C.amberLight, flash);
  }

  // three files arc across
  for (let i = 0; i < 3; i++) {
    const k = inOut(span(c, 0.3 + i * 0.45, 0.95 + i * 0.45));

    if (k <= 0 || k >= 1) continue;
    const x = 19 + (70 - 19) * k;
    const y = 18 - Math.sin(k * Math.PI) * 12;
    g.rect(x, y, 6, 8, C.text);
    g.rect(x + 4, y, 2, 2, C.mid);
  }

  // git: commits appear on a branch, then a push travels to the remote
  g.rect(8, 54, 62, 1, C.edge);

  for (let j = 0; j < 4; j++) {
    const on = out(span(c, 1.9 + j * 0.3, 2.1 + j * 0.3));
    frame(g, 9 + j * 16, 52, 5, 5, on > 0 ? C.amber : C.edge, on > 0 ? fade : 1);

    if (on > 0) g.rect(10 + j * 16, 53, 3, 3, C.amber, on * fade);
  }

  const push = inOut(span(c, 3.3, 3.9));

  if (push > 0 && push < 1) g.rect(60 + push * 18, 53, 3, 3, C.amberLight);
  cloud(g, 78, 49, span(c, 3.9, 4.1) * fade > 0.5 ? C.amber : C.dim);
}

export function FilesDiagram() {
  return (
    <PixelCanvas
      cols={FILES.cols}
      rows={FILES.rows}
      draw={drawFiles}
      stillAt={4.2}
      label="Files travel from your machine into the sandbox, then commits push out to the remote."
      overlay={() => (
        <>
          <Tag x={19} y={37} cols={FILES.cols} rows={FILES.rows}>
            your machine
          </Tag>
          <Tag x={76} y={39} cols={FILES.cols} rows={FILES.rows}>
            sandbox
          </Tag>
          <Tag x={36} y={64} cols={FILES.cols} rows={FILES.rows}>
            commits
          </Tag>
          <Tag x={85} y={64} cols={FILES.cols} rows={FILES.rows}>
            remote
          </Tag>
        </>
      )}
    />
  );
}

/* ---------- lifecycle: create, run, snapshot, pause, resume, destroy ---------- */

const LIFE = { cols: 96, rows: 72, cycle: 7.2 };
const STATES = ["created", "running", "paused", "running", "destroyed"] as const;

/** The state index (0 to 4), plus 10 while the snapshot outline is on screen. */
const lifeStep = (t: number) => {
  const c = t % LIFE.cycle;
  const state = c < 1.4 ? 0 : c < 3.4 ? 1 : c < 4.8 ? 2 : c < 5.6 ? 3 : 4;

  return state + (c >= 2.5 && c < 6.4 ? 10 : 0);
};

function drawLife(g: Grid, t: number) {
  const c = t % LIFE.cycle;
  const x0 = 32;
  const y0 = 22;
  const state = lifeStep(t) % 10;

  // the snapshot: a copy slides out while it runs, and stays as an outline until the end
  const snap = inOut(span(c, 2.1, 2.8));
  const gone = span(c, 6.2, 6.8);

  if (snap > 0 && gone < 1) {
    const sx = Math.round(x0 + snap * 34);

    if (snap < 1) box(g, sx, y0, 16, 0.35);
    dashed(g, sx, y0, 16, 16, C.amberDark, 2, 2);

    if (gone > 0) g.rect(sx, y0, 16, 16, "#0a0a0c", gone);
  }

  // the sandbox, as a 4 by 4 grid of blocks so it can assemble and break apart
  for (let by = 0; by < 4; by++) {
    for (let bx = 0; bx < 4; bx++) {
      const n = by * 4 + bx;
      let x = x0 + bx * 4;
      let y = y0 + by * 4;
      let alpha = 1;

      if (state === 0) {
        // assemble: each block flies in from a scattered start
        const k = out(span(c, n * 0.04, n * 0.04 + 0.7));
        x += (hash(n) - 0.5) * 70 * (1 - k);
        y += (hash(n + 30) - 0.5) * 40 * (1 - k);
        alpha = k;
      } else if (state === 4) {
        // destroy: blocks fall away and fade
        const k = span(c, 5.6 + hash(n) * 0.3, 6.6);
        x += (hash(n + 60) - 0.5) * 30 * k;
        y += k * k * 36;
        alpha = 1 - k;
      }

      const cool = state === 2;
      const top = by === 0;
      const side = bx === 3;

      const color = cool
        ? top
          ? "#d6e2f7"
          : side
            ? C.coolDark
            : C.cool
        : top
          ? C.amberLight
          : side
            ? C.amberDark
            : C.amber;

      g.rect(x, y, 4, 4, color, alpha);
    }
  }

  // running: a light sweeps across it; paused: a pause mark sits above it
  if (state === 1 || state === 3)
    g.rect(x0 + Math.round(((c * 1.6) % 1) * 14), y0 + 6, 2, 8, "#fff4de", 0.7);

  if (state === 2) {
    g.rect(x0 + 5, y0 - 8, 2, 5, C.text);
    g.rect(x0 + 9, y0 - 8, 2, 5, C.text);
  }
}

export function LifecycleDiagram() {
  return (
    <PixelCanvas
      cols={LIFE.cols}
      rows={LIFE.rows}
      draw={drawLife}
      stillAt={2.9}
      step={lifeStep}
      label="A sandbox is created, runs, takes a snapshot, pauses, resumes and is destroyed."
      overlay={(s) =>
        s >= 10 && (
          <Tag x={74} y={44} cols={LIFE.cols} rows={LIFE.rows}>
            snapshot
          </Tag>
        )
      }
      below={(s) => (
        <div className={styles.timeline}>
          {STATES.map((name, i) => (
            <span key={i} className={i === s % 10 ? styles.now : undefined}>
              {name}
            </span>
          ))}
        </div>
      )}
    />
  );
}

/* ---------- tests: the memory sandbox inside the test process, no network ---------- */

const TESTS = { cols: 112, rows: 64, cycle: 4.6 };
const TEST_W = [30, 22, 34];

const passed = (t: number) => {
  const c = t % TESTS.cycle;

  return TEST_W.filter((_, i) => c > 1.0 + i * 0.8).length;
};

function drawTests(g: Grid, t: number) {
  const c = t % TESTS.cycle;
  const reset = 1 - span(c, TESTS.cycle - 0.35, TESTS.cycle);
  dashed(g, 2, 6, 76, 50, C.amberDark);
  box(g, 10, 24, 14);

  TEST_W.forEach((w, i) => {
    const y = 18 + i * 12;
    const running = c > 0.5 + i * 0.8 && c <= 1.0 + i * 0.8;
    const done = c > 1.0 + i * 0.8;
    g.rect(38, y + 1, w, 2, C.dim);

    if (running) g.rect(32, y, 4, 4, C.amber, 0.5 + 0.5 * Math.sin(t * 18));
    else if (done) g.rect(32, y, 4, 4, C.green, reset);
    else frame(g, 32, y, 4, 4, C.edge);
  });

  // the network: outside the boundary, with the cable cut
  for (let x = 79; x < 92; x += 3) g.rect(x, 31, 2, 1, C.edge);
  const blink = Math.floor(t * 1.5) % 2 === 0 ? 1 : 0.4;

  for (const [dx, dy] of [
    [0, -2],
    [2, -2],
    [1, -1],
    [0, 0],
    [2, 0],
  ])
    g.rect(84 + dx, 31 + dy, 1, 1, C.red, blink);
  cloud(g, 94, 27, C.dim);
}

export function TestsDiagram() {
  return (
    <PixelCanvas
      className={styles.tests}
      cols={TESTS.cols}
      rows={TESTS.rows}
      draw={drawTests}
      stillAt={3.8}
      step={passed}
      label="Three tests pass against the memory sandbox inside the test process, with the network cut off."
      overlay={(n) => (
        <>
          <Tag x={5} y={2} cols={TESTS.cols} rows={TESTS.rows} align="left">
            your test process
          </Tag>
          <Tag x={101} y={41} cols={TESTS.cols} rows={TESTS.rows}>
            network
          </Tag>
          <Tag x={40} y={61} cols={TESTS.cols} rows={TESTS.rows} tone={n === 3 ? "ok" : undefined}>
            {`${n} pass · 0 fail`}
          </Tag>
        </>
      )}
    />
  );
}
