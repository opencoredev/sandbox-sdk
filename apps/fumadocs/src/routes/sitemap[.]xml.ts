import { createFileRoute } from "@tanstack/react-router";
import { docsOrigin } from "@/lib/shared";
import { source } from "@/lib/source";

function escapeXml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const extraPaths = ["/compatibility", "/security", "/partners", "/sponsors"];

export const Route = createFileRoute("/sitemap.xml")({
  server: {
    handlers: {
      GET: () => {
        const urls = [...extraPaths, ...source.getPages().map((page) => page.url)]
          .map((path) => `<url><loc>${escapeXml(new URL(path, docsOrigin).toString())}</loc></url>`)
          .join("");

        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
          {
            headers: { "content-type": "application/xml; charset=utf-8" },
          },
        );
      },
    },
  },
});
