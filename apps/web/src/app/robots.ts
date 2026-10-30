import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    // The docs app (apps/docs) writes its own sitemap, which the deploy serves at /docs.
    sitemap: ["https://sandbox-sdk.app/sitemap.xml", "https://sandbox-sdk.app/docs/sitemap.xml"],
    host: "https://sandbox-sdk.app",
  };
}
