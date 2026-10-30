import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BLOG_TITLE, SITE_URL, formatDate, getPost, getPosts, postUrl } from "@/lib/blog";
import { socialImage } from "@/lib/shared";

import landing from "../../(home)/landing.module.css";
import { Footer, Nav } from "../../(home)/parts";
import styles from "../blog.module.css";

export const dynamicParams = false;

export function generateStaticParams() {
  return getPosts().map((post) => ({ slug: post.slug }));
}

export async function generateMetadata({ params }: PageProps<"/blog/[slug]">): Promise<Metadata> {
  const post = getPost((await params).slug);

  if (!post) return {};

  return {
    title: post.title,
    description: post.description,
    alternates: {
      canonical: `/blog/${post.slug}`,
      types: { "application/rss+xml": [{ url: "/blog/rss.xml", title: BLOG_TITLE }] },
    },
    openGraph: {
      title: post.title,
      description: post.description,
      url: postUrl(post.slug),
      siteName: "Sandbox SDK",
      type: "article",
      publishedTime: post.published,
      modifiedTime: post.updated,
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title: post.title,
      description: post.description,
      images: [socialImage],
    },
  };
}

export default async function BlogPost({ params }: PageProps<"/blog/[slug]">) {
  const post = getPost((await params).slug);

  if (!post) notFound();

  const url = postUrl(post.slug);

  const jsonLd = JSON.stringify([
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      url,
      mainEntityOfPage: url,
      image: `${SITE_URL}${socialImage.url}`,
      datePublished: post.published,
      dateModified: post.updated,
      author: { "@type": "Organization", name: "OpenCore", url: SITE_URL },
      publisher: {
        "@type": "Organization",
        name: "OpenCore",
        url: SITE_URL,
        logo: { "@type": "ImageObject", url: `${SITE_URL}/brand/sandbox-sdk-mark.png` },
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Sandbox SDK", item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE_URL}/blog` },
        { "@type": "ListItem", position: 3, name: post.title, item: url },
      ],
    },
  ]).replace(/</g, "\\u003c");

  return (
    <main className={landing.page}>
      <a href="#content" className={landing.skipLink}>
        Skip to content
      </a>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <Nav />
      <div className={landing.frame} id="content">
        <header className={styles.header}>
          <nav aria-label="Breadcrumb" className={`${landing.eyebrow} ${styles.crumbs}`}>
            <Link href="/blog">Blog</Link>
          </nav>
          <h1 className={landing.title}>{post.title}</h1>
          <p className={landing.lede}>{post.description}</p>
          <p className={styles.meta}>
            <time dateTime={post.published}>{formatDate(post.published)}</time>
            {post.updated !== post.published && (
              <>
                {" · Updated "}
                <time dateTime={post.updated}>{formatDate(post.updated)}</time>
              </>
            )}
          </p>
        </header>
        <article className={styles.article}>
          <div className={styles.prose} dangerouslySetInnerHTML={{ __html: post.html }} />
          <p className={styles.next}>
            More guides on the <Link href="/blog">Sandbox SDK blog</Link>, or start with the{" "}
            <Link href="/docs/getting-started/quickstart">quickstart</Link>.
          </p>
        </article>
        <Footer />
      </div>
    </main>
  );
}
