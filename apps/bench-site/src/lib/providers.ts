/**
 * Display names and chart colours of the providers on the page. Hues and
 * lightness are spread so every pair stays apart under protanopia and
 * deuteranopia (OKLab ΔE ≥ 7.5) and as 12px text on the card surface
 * (≥ 6:1). No hue sits near the red that marks failures.
 */
export const providerInfo = {
  e2b: { name: "E2B", color: "oklch(0.76 0.16 65)" },
  daytona: { name: "Daytona", color: "oklch(0.68 0.16 259)" },
  upstash: { name: "Upstash Box", color: "oklch(0.73 0.11 165)" },
  boat: { name: "Boat", color: "oklch(0.91 0.13 192)" },
  boxd: { name: "boxd", color: "oklch(0.92 0.11 96)" },
  freestyle: { name: "Freestyle", color: "oklch(0.82 0.11 303)" },
  tenki: { name: "Tenki", color: "oklch(0.68 0.16 331)" },
  superserve: { name: "Superserve", color: "oklch(0.86 0.22 129)" },
} as const satisfies Record<string, { name: string; color: string }>;

export type ProviderId = keyof typeof providerInfo;

export const isProviderId = (id: string): id is ProviderId => Object.hasOwn(providerInfo, id);

export const providerName = (id: ProviderId) => providerInfo[id].name;
export const providerColor = (id: ProviderId) => providerInfo[id].color;
