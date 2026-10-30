import type { MetadataRoute } from "next";

import { SITE_URL, getPosts, latestUpdate } from "@/lib/blog";

export const dynamic = "force-static";

/**
 * The last content change to the homepage (apps/web/src/app/(home)). Builds
 * have no git history, so update this by hand when the homepage copy changes.
 */
const HOME_UPDATED = "2026-10-30";

// The docs app (apps/docs) publishes its own sitemap at /docs/sitemap.xml, and
// robots.ts lists both. Each lastModified is the page's real last change, not the build time.
export default function sitemap(): MetadataRoute.Sitemap {
  const posts = getPosts();
  const blogUpdated = latestUpdate(posts);

  return [
    { url: SITE_URL, lastModified: HOME_UPDATED, changeFrequency: "weekly", priority: 1 },
    ...(blogUpdated ? [{ url: `${SITE_URL}/blog`, lastModified: blogUpdated, priority: 0.7 }] : []),
    ...posts.map((post) => ({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified: post.updated,
      priority: 0.6,
    })),
  ];
}
