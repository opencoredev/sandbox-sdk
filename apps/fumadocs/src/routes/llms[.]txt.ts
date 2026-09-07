import { createFileRoute } from "@tanstack/react-router";
import { llms } from "fumadocs-core/source";
import { appName } from "@/lib/shared";
import { source } from "@/lib/source";

export const Route = createFileRoute("/llms.txt")({
  server: {
    handlers: {
      GET: () => {
        const index = llms(source)
          .index()
          .replace(/^# Docs$/m, `# ${appName}`);
        return new Response(index, {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    },
  },
});
