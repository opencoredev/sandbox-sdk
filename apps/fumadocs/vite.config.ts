import { readdirSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { createLogger, defineConfig } from "vite";

function isMissingSourcemapWarning(message: string): boolean {
  return message.includes("Sourcemap for") && message.includes("missing source files");
}

const logger = createLogger();
const warn = logger.warn.bind(logger);
const warnOnce = logger.warnOnce.bind(logger);

logger.warn = (msg, options) => {
  if (isMissingSourcemapWarning(msg)) return;
  warn(msg, options);
};

logger.warnOnce = (msg, options) => {
  if (isMissingSourcemapWarning(msg)) return;
  warnOnce(msg, options);
};

const docsPages = readdirSync(new URL("content/docs", import.meta.url), {
  recursive: true,
  encoding: "utf8",
})
  .filter((path) => path.endsWith(".mdx"))
  .map((path) => {
    const slug = path.replace(/\.mdx$/, "").replace(/(^|\/)index$/, "");
    return { path: `/docs${slug.length > 0 ? `/${slug}` : ""}` };
  });

const markdownPages = docsPages.map(({ path }) => ({
  path: path === "/docs" ? "/llms.mdx/docs/content.md" : `/llms.mdx${path}/content.md`,
}));

export default defineConfig({
  customLogger: logger,
  server: {
    host: "127.0.0.1",
    port: Number(process.env.PORT) || 4206,
  },
  plugins: [
    fumadocsMdx(),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        maskPath: "/spa-shell",
      },
      pages: [
        { path: "/" },
        { path: "/compatibility" },
        { path: "/partners" },
        { path: "/sponsors" },
        { path: "/security" },
        ...docsPages,
        ...markdownPages,
        { path: "/api/search" },
        { path: "/llms.txt" },
        { path: "/llms-full.txt" },
        { path: "/robots.txt" },
        { path: "/sitemap.xml" },
      ],
      prerender: {
        enabled: true,
        crawlLinks: true,
      },
      sitemap: {
        enabled: false,
      },
    }),
    react(),
  ],
  resolve: {
    tsconfigPaths: true,
  },
});
