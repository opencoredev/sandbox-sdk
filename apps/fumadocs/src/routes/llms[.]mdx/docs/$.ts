import { createFileRoute } from "@tanstack/react-router";
import { getLLMText, source } from "@/lib/source";

export const Route = createFileRoute("/llms.mdx/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const parts = params["_splat"]?.split("/").filter(Boolean) ?? [];
        if (parts.at(-1) !== "content.md") {
          return new Response("Not Found", { status: 404 });
        }

        const page = source.getPage(parts.slice(0, -1));
        if (!page) return new Response("Not Found", { status: 404 });

        return new Response(await getLLMText(page), {
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      },
    },
  },
});
