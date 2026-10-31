import type { Metadata } from "next";
import Link from "next/link";

import { BLOG_DESCRIPTION, BLOG_TITLE, SITE_URL, formatDate, getPosts } from "@/lib/blog";
import { socialImage } from "@/lib/shared";

import landing from "../(home)/landing.module.css";
import { Arrow, Footer, Nav } from "../(home)/parts";
import styles from "./blog.module.css";

export const metadata: Metadata = {
  title: { absolute: BLOG_TITLE },
  description: BLOG_DESCRIPTION,
  alternates: {
    canonical: "/blog",
    types: { "application/rss+xml": [{ url: "/blog/rss.xml", title: BLOG_TITLE }] },
  },
  openGraph: {
    title: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    url: `${SITE_URL}/blog`,
    siteName: "Sandbox SDK",
    type: "website",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    images: [socialImage],
  },
};

export default function BlogIndex() {
  const posts = getPosts();

  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Blog",
    name: BLOG_TITLE,
    description: BLOG_DESCRIPTION,
    url: `${SITE_URL}/blog`,
    publisher: { "@type": "Organization", name: "OpenCore", url: SITE_URL },
    blogPost: posts.map((post) => ({
      "@type": "BlogPosting",
      headline: post.title,
      url: `${SITE_URL}/blog/${post.slug}`,
      datePublished: post.published,
      dateModified: post.updated,
    })),
  }).replace(/</g, "\\u003c");

  return (
    <main className={landing.page}>
      <a href="#content" className={landing.skipLink}>
        Skip to content
      </a>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <Nav />
      <div className={landing.frame} id="content">
        <header className={styles.header}>
          <p className={landing.eyebrow}>Blog</p>
          <h1 className={landing.title}>Guides for sandboxes in TypeScript</h1>
          <p className={landing.lede}>{BLOG_DESCRIPTION}</p>
        </header>
        <ul className={styles.list}>
          {posts.map((post) => (
            <li key={post.slug} className={styles.item}>
              <Link href={`/blog/${post.slug}`}>
                <h2>{post.title}</h2>
                <time className={styles.meta} dateTime={post.published}>
                  {formatDate(post.published)}
                </time>
                <p>{post.description}</p>
                <span className={styles.arrow}>
                  <Arrow />
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <Footer />
      </div>
    </main>
  );
}
