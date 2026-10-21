/** Display names and chart colours of the providers on the page. */
export const providerInfo = {
  e2b: { name: "E2B", color: "oklch(0.79 0.15 62)" },
  daytona: { name: "Daytona", color: "oklch(0.72 0.14 250)" },
  upstash: { name: "Upstash Box", color: "oklch(0.8 0.17 152)" },
  boat: { name: "Boat", color: "oklch(0.82 0.12 200)" },
  boxd: { name: "boxd", color: "oklch(0.88 0.15 98)" },
  freestyle: { name: "Freestyle", color: "oklch(0.72 0.18 304)" },
  tenki: { name: "Tenki", color: "oklch(0.75 0.17 354)" },
  superserve: { name: "Superserve", color: "oklch(0.88 0.2 125)" },
} as const satisfies Record<string, { name: string; color: string }>;

export type ProviderId = keyof typeof providerInfo;

export const isProviderId = (id: string): id is ProviderId => Object.hasOwn(providerInfo, id);

export const providerName = (id: ProviderId) => providerInfo[id].name;
export const providerColor = (id: ProviderId) => providerInfo[id].color;
