import type { ComponentMarkdown } from "blume";

/** Display names and logos for <ProviderTab provider="...">, shared by the page and Markdown output. */
export const PROVIDERS = {
  local: { name: "Local", logo: "/integrations/docker.svg" },
  e2b: { name: "E2B", logo: "/integrations/e2b.svg" },
  vercel: { name: "Vercel Sandbox", logo: "/integrations/vercel.svg" },
  daytona: { name: "Daytona", logo: "/integrations/daytona.svg" },
  upstash: { name: "Upstash Box", logo: "/integrations/upstash.svg" },
  railway: { name: "Railway", logo: "/integrations/railway.svg" },
  boat: { name: "Boat", logo: "/integrations/boat.svg" },
  freestyle: { name: "Freestyle", logo: "/integrations/freestyle.svg" },
  boxd: { name: "boxd", logo: "/integrations/boxd.svg" },
  tenki: { name: "Tenki", logo: "/integrations/tenki.svg" },
  agentos: { name: "agentOS", logo: "/integrations/agentos.svg" },
  memory: { name: "Memory", logo: "/integrations/memory.svg" },
} as const satisfies Record<string, { name: string; logo: string | undefined }>;

export type ProviderKey = keyof typeof PROVIDERS;

const NAMES: ReadonlyMap<unknown, string> = new Map(
  Object.entries(PROVIDERS).map(([key, { name }]) => [key, name]),
);

const providerLabel = (props: { readonly title?: unknown; readonly provider?: unknown }): string =>
  typeof props.title === "string" ? props.title : (NAMES.get(props.provider) ?? "Provider");

/**
 * Markdown for agents (`<route>.md`, llms-full.txt): every tab becomes a
 * `### <Provider>` section with its prose and code intact.
 */
export const providerTabsMarkdown: ComponentMarkdown = ({ childComponents, children }) => {
  const tabs = childComponents("ProviderTab");
  if (tabs.length === 0) return children;
  return tabs
    .map((tab) => [`### ${providerLabel(tab.props)}`, tab.children].filter(Boolean).join("\n\n"))
    .join("\n\n");
};
