/** Display names, chart colours and what the provider's default sandbox is. */
export const providerInfo = {
  local: { name: "Local Docker", color: "oklch(0.66 0 0)" },
  e2b: { name: "E2B", color: "oklch(0.79 0.15 62)" },
  daytona: { name: "Daytona", color: "oklch(0.72 0.14 250)" },
  upstash: { name: "Upstash Box", color: "oklch(0.8 0.17 152)" },
  boat: { name: "Boat", color: "oklch(0.82 0.12 200)" },
  boxd: { name: "boxd", color: "oklch(0.88 0.15 98)" },
  freestyle: { name: "Freestyle", color: "oklch(0.72 0.18 304)" },
  tenki: { name: "Tenki", color: "oklch(0.75 0.17 354)" },
} as const;

export type ProviderId = keyof typeof providerInfo;

export const isProviderId = (id: string): id is ProviderId => id in providerInfo;

export const providerName = (id: string) => (isProviderId(id) ? providerInfo[id].name : id);
export const providerColor = (id: string) =>
  isProviderId(id) ? providerInfo[id].color : "oklch(0.66 0 0)";
