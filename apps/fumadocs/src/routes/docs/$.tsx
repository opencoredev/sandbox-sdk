import type { ProviderName } from "@opencoredev/sandbox-sdk";
import { providerNames } from "@opencoredev/sandbox-sdk";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense, use } from "react";
import { useMDXComponents } from "@/components/mdx";
import { ProviderDocsLink } from "@/components/provider-docs-link";
import { baseOptions } from "@/lib/layout.shared";
import { docsOrigin, gitConfig, socialImage } from "@/lib/shared";
import { docs, getPageMarkdownUrl, source } from "@/lib/source";

export const Route = createFileRoute("/docs/$")({
  component: DocsRoute,
  loader: async ({ params }) => {
    const slugs = params["_splat"]?.split("/").filter(Boolean) ?? [];
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    await docs.getPage(page.path)?.preload();

    return {
      description: page.data.description,
      githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/fumadocs/content/docs/${page.path}`,
      markdownUrl: getPageMarkdownUrl(page).url,
      path: page.path,
      provider: getProviderFromSlug(slugs),
      title: page.data.title,
      url: page.url,
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      { title: loaderData?.title },
      { name: "description", content: loaderData?.description },
      { property: "og:type", content: "article" },
      { property: "og:title", content: loaderData?.title },
      { property: "og:description", content: loaderData?.description },
      {
        property: "og:url",
        content: loaderData ? new URL(loaderData.url, docsOrigin).toString() : undefined,
      },
      { property: "og:image", content: socialImage.url },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: loaderData?.title },
      { name: "twitter:description", content: loaderData?.description },
      { name: "twitter:image", content: socialImage.url },
    ],
    links: loaderData
      ? [{ rel: "canonical", href: new URL(loaderData.url, docsOrigin).toString() }]
      : [],
  }),
});

function Content({
  githubUrl,
  markdownUrl,
  path,
  provider,
}: {
  githubUrl: string;
  markdownUrl: string;
  path: string;
  provider: ProviderName | undefined;
}) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`Unknown documentation page: ${path}`);

  const { toc } = use(page.load());
  const MDX = page.body;

  return (
    <DocsPage toc={toc}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.description}</DocsDescription>
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6">
        {provider && <ProviderDocsLink provider={provider} variant="button" />}
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover markdownUrl={markdownUrl} githubUrl={githubUrl} />
      </div>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

function DocsRoute() {
  const data = Route.useLoaderData();

  return (
    <DocsLayout {...baseOptions()} tree={source.pageTree}>
      <Suspense>
        <Content
          githubUrl={data.githubUrl}
          markdownUrl={data.markdownUrl}
          path={data.path}
          provider={data.provider}
        />
      </Suspense>
    </DocsLayout>
  );
}

function getProviderFromSlug(slug: string[]): ProviderName | undefined {
  if (slug.length !== 2 || slug[0] !== "providers") return undefined;

  return providerNames.find((provider) => provider === slug[1]);
}
