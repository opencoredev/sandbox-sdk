import type { MetadataRoute } from "next";

export const dynamic = "force-static";

// The docs app (apps/docs) publishes its own sitemap for /docs.
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ url: "https://sandbox-sdk.app", changeFrequency: "weekly", priority: 1 }];
}
