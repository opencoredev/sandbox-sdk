import {
  BLOG_DESCRIPTION,
  BLOG_TITLE,
  SITE_URL,
  getPosts,
  latestUpdate,
  postUrl,
} from "@/lib/blog";

export const dynamic = "force-static";

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const rfc822 = (date: string) => new Date(`${date}T00:00:00Z`).toUTCString();

export function GET() {
  const posts = getPosts();
  const lastUpdate = latestUpdate(posts);

  const items = posts
    .map((post) => {
      const url = postUrl(post.slug);

      return `    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${escapeXml(post.description)}</description>
      <pubDate>${rfc822(post.published)}</pubDate>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(BLOG_TITLE)}</title>
    <link>${SITE_URL}/blog</link>
    <description>${escapeXml(BLOG_DESCRIPTION)}</description>
    <language>en-us</language>
    <atom:link href="${SITE_URL}/blog/rss.xml" rel="self" type="application/rss+xml" />
${lastUpdate ? `    <lastBuildDate>${rfc822(lastUpdate)}</lastBuildDate>\n` : ""}${items}
  </channel>
</rss>
`;

  return new Response(xml, { headers: { "Content-Type": "application/rss+xml; charset=utf-8" } });
}
