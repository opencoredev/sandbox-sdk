import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { createRelativeLink } from "fumadocs-ui/mdx";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ProviderName } from "@opencoredev/sandbox-sdk";
import { providerNames } from "@opencoredev/sandbox-sdk";

import { JsonLd } from "@/components/json-ld";
import { getMDXComponents } from "@/components/mdx";
import { ProviderDocsLink } from "@/components/provider-docs-link";
import { breadcrumbSchema, techArticleSchema } from "@/lib/seo";
import { appName, gitConfig } from "@/lib/shared";
import { getPageImage, getPageMarkdownUrl, source } from "@/lib/source";

export default async function Page(props: PageProps<"/docs/[[...slug]]">) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;
  const provider = getProviderFromSlug(params.slug);

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <JsonLd
        data={techArticleSchema({
          title: page.data.title,
          description: page.data.description,
          url: page.url,
        })}
      />
      <JsonLd data={breadcrumbSchema(getBreadcrumbTrail(params.slug))} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row flex-wrap gap-2 items-center border-b pb-6">
        {provider && <ProviderDocsLink provider={provider} variant="button" />}
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/fumadocs/content/docs/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

function getBreadcrumbTrail(slug: string[] | undefined) {
  const trail = [
    { name: appName, url: "/" },
    { name: "Docs", url: "/docs" },
  ];

  const segments: string[] = [];
  for (const segment of slug ?? []) {
    segments.push(segment);
    trail.push({
      name: source.getPage([...segments])?.data.title ?? titleCase(segment),
      url: `/docs/${segments.join("/")}`,
    });
  }

  return trail;
}

function titleCase(segment: string) {
  return segment
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getProviderFromSlug(slug: string[] | undefined): ProviderName | undefined {
  if (slug?.length !== 2 || slug[0] !== "providers") return undefined;

  return providerNames.find((provider) => provider === slug[1]);
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();
  const image = getPageImage(page).url;

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical: page.url,
      types: {
        "text/markdown": getPageMarkdownUrl(page).url,
      },
    },
    openGraph: {
      title: page.data.title,
      description: page.data.description,
      url: page.url,
      siteName: appName,
      type: "article",
      images: [{ url: image, width: 1200, height: 630, alt: page.data.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: page.data.title,
      description: page.data.description,
      images: [image],
    },
  };
}
