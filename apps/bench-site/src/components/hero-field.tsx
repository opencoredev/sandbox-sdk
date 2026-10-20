"use client";

import { DitherShader } from "@/lib/dither";

// Lanes of light racing left to right at different speeds, like sandboxes
// booting side by side. Dense at the leading edge, thinning into a trail.
const FIELD = `
float field(vec2 uv, vec2 res, float t) {
  float lanes = 14.0;
  float lane = floor(uv.y * lanes);
  float within = fract(uv.y * lanes);
  float band = smoothstep(0.2, 0.4, within) * smoothstep(0.8, 0.6, within);
  float speed = 0.05 + 0.035 * fract(sin(lane * 12.9898) * 43758.5453);
  float head = fract(t * speed + lane * 0.37);
  float d = head - uv.x;
  d = d < 0.0 ? d + 1.0 : d;
  float trail = exp(-d * 5.0) * smoothstep(0.0, 0.01, d + 0.01);
  float fade = smoothstep(0.0, 0.5, uv.y) * 0.9 + 0.1;
  return heroIntensity * band * trail * fade;
}
`;

export function HeroField({ className }: { className?: string }) {
  return (
    <DitherShader
      field={FIELD}
      className={className}
      palette={["--dither-paper", "oklch(0.38 0.05 250)", "oklch(0.62 0.07 250)"]}
      matrix="bayer4"
      stillTime={14}
      speed={1}
      uniforms={{ heroIntensity: 0.7 }}
      fallback={
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_80%_0%,oklch(0.55_0.08_250/0.25),transparent_60%)]" />
      }
    />
  );
}
