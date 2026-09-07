import { createFileRoute } from "@tanstack/react-router";
import { docsOrigin } from "@/lib/shared";

export const Route = createFileRoute("/robots.txt")({
  server: {
    handlers: {
      GET: () =>
        new Response(
          `User-agent: *\nAllow: /\nHost: sandbox-sdk.app\nSitemap: ${new URL("/sitemap.xml", docsOrigin)}\n`,
          {
            headers: { "content-type": "text/plain; charset=utf-8" },
          },
        ),
    },
  },
});
