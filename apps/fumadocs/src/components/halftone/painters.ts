import { providerScenes } from "@/components/harbor/provider-scenes";
import type { Painter } from "./halftone-canvas";

/** A soft light in a glow field, positioned in 0..1 of the canvas. */
interface Light {
  x: number;
  y: number;
  r: number;
  color: string;
  /** How far it wanders, in 0..1 of the canvas. */
  drift: number;
}

interface GlowField {
  base: string;
  lights: Light[];
  /** Vertical streaks falling through the field, like rain on glass. */
  streaks?: string;
}

function hash(n: number) {
  const s = Math.sin(n * 127.1) * 43758.5453;
  return s - Math.floor(s);
}

/** Slow drifting lights over a dark base: the art behind each provider card and the closing call to action. */
export function glowField({ base, lights, streaks }: GlowField): Painter {
  return (ctx, w, h, t) => {
    const m = Math.max(w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "lighter";
    lights.forEach((l, i) => {
      const x = (l.x + Math.sin(t * 0.21 + i * 1.7) * l.drift) * w;
      const y = (l.y + Math.cos(t * 0.17 + i * 2.3) * l.drift * 0.6) * h;
      const r = l.r * m * 1.5 * (1 + Math.sin(t * 0.33 + i) * 0.06);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, l.color);
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    });
    if (streaks) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = streaks;
      for (let i = 0; i < 26; i++) {
        const x = hash(i) * w;
        const len = (0.2 + hash(i + 40) * 0.6) * h;
        const y = ((t * (0.04 + hash(i + 80) * 0.05) + hash(i + 120)) % 1.4) * h - len * 0.6;
        ctx.fillRect(x, Math.max(0, y), Math.max(1, w * 0.004), len);
      }
    }
    ctx.globalCompositeOperation = "source-over";
  };
}

export interface ProviderArt {
  id: string;
  name: string;
  /** What it is best for, from the provider overview in the docs. */
  line: string;
  href: string;
  paint: Painter;
}

export const providerArt: ProviderArt[] = [
  {
    id: "local",
    name: "Local",
    line: "Runs on your machine in an AgentOS VM. No account, no API key.",
    href: "/docs/providers/local",
    paint: providerScenes.local,
  },
  {
    id: "e2b",
    name: "E2B",
    line: "Short-lived Linux sandboxes for coding agents.",
    href: "/docs/providers/e2b",
    paint: providerScenes.e2b,
  },
  {
    id: "daytona",
    name: "Daytona",
    line: "Persistent workspaces, with GPUs when you need them.",
    href: "/docs/providers/daytona",
    paint: providerScenes.daytona,
  },
  {
    id: "vercel",
    name: "Vercel Sandbox",
    line: "Persistent sandboxes for coding agents, with public previews.",
    href: "/docs/providers/vercel",
    paint: providerScenes.vercel,
  },
  {
    id: "upstash",
    name: "Upstash Box",
    line: "Durable serverless boxes with filesystem snapshots.",
    href: "/docs/providers/upstash",
    paint: providerScenes.upstash,
  },
  {
    id: "boat",
    name: "Boat",
    line: "Persistent cloud VMs for long-running agents.",
    href: "/docs/providers/box",
    paint: providerScenes.boat,
  },
  {
    id: "railway",
    name: "Railway",
    line: "Durable jobs and private networking on Linux VMs.",
    href: "/docs/providers/railway",
    paint: providerScenes.railway,
  },
  {
    id: "tenki",
    name: "Tenki",
    line: "Coding agents on full Linux VMs, with disk and memory snapshots.",
    href: "/docs/providers/tenki",
    paint: providerScenes.tenki,
  },
];

/** The ember glow behind the closing call to action. */
export const emberField = glowField({
  base: "#0b0a09",
  lights: [
    { x: 0.5, y: 0.55, r: 0.42, color: "rgba(214,110,40,0.85)", drift: 0.03 },
    { x: 0.25, y: 0.45, r: 0.3, color: "rgba(140,64,22,0.6)", drift: 0.06 },
    { x: 0.78, y: 0.5, r: 0.3, color: "rgba(140,64,22,0.6)", drift: 0.06 },
  ],
});
