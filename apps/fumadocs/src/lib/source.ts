import { loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";

import { resolveDocsIcon } from "@/components/docs-icon";
import { docsContentRoute, docsRoute } from "./shared";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    async: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
});

export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  icon: resolveDocsIcon,
});

export function getPageMarkdownUrl(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "content.md"];

  return {
    segments,
    url: `${docsContentRoute}/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}
