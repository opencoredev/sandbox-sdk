import type { MetadataRoute } from "next";

import { source } from "@/lib/source";

export const dynamic = "force-static";

const origin = "https://sandbox-sdk.app";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: origin,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${origin}/providers`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${origin}/compatibility`,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    {
      url: `${origin}/security`,
      changeFrequency: "monthly",
      priority: 0.6,
    },
    {
      url: `${origin}/partners`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: `${origin}/sponsors`,
      changeFrequency: "monthly",
      priority: 0.5,
    },
    ...source.getPages().map((page) => ({
      url: `${origin}${page.url}`,
      changeFrequency: "weekly" as const,
      priority: page.url === "/docs" ? 0.9 : 0.7,
    })),
  ];
}
