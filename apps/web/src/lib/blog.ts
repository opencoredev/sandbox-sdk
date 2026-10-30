/**
 * Blog posts: Markdown files in apps/web/content/blog, read at build time.
 *
 * Each file starts with a small front matter block of `key: value` lines:
 *
 *   ---
 *   title: The post title
 *   description: One or two sentences for search results and the index.
 *   published: 2026-10-30
 *   updated: 2026-10-30
 *   ---
 *
 * The file name, without `.md`, is the slug: lowercase letters, digits and
 * single hyphens, so it goes into URLs and the RSS feed as is. `updated` is optional and
 * defaults to `published`; the sitemap and RSS feed use it as the last change.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Marked } from "marked";

export const SITE_URL = "https://sandbox-sdk.app";
export const BLOG_TITLE = "Sandbox SDK blog";

export const BLOG_DESCRIPTION =
  "Guides for running AI agent code in sandboxes from TypeScript: Docker on your machine, cloud providers, agent frameworks, and tests without a cloud.";

/** A calendar date as `yyyy-mm-dd`, checked when the post is parsed. */
export type PostDate = string & { readonly __brand: "PostDate" };

export type PostMeta = {
  slug: string;
  title: string;
  description: string;
  published: PostDate;
  updated: PostDate;
};

export type Post = PostMeta & { html: string };

const BLOG_DIR = join(process.cwd(), "content", "blog");
const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseDate({ value, field, file }: { value: string; field: string; file: string }) {
  const parsed = new Date(`${value}T00:00:00Z`);

  // The round trip rejects dates JavaScript rolls over, such as 2026-02-31.
  if (
    !DATE.test(value) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${file}: ${field} must be a real yyyy-mm-dd date, got "${value}"`);
  }

  // SAFETY: the checks above proved value is a real calendar date in yyyy-mm-dd form.
  return value as PostDate;
}

/** Splits a post file into its front matter fields and Markdown body. A missing field fails the build. */
function parsePost({ file, source: raw }: { file: string; source: string }) {
  // Files saved with Windows line endings parse the same as LF ones.
  const source = raw.replace(/\r\n/g, "\n");
  const slug = file.replace(/\.md$/, "");

  if (!SLUG.test(slug)) {
    throw new Error(`${file}: file names must be lowercase letters, digits and single hyphens`);
  }

  const match = FRONT_MATTER.exec(source);

  if (!match) throw new Error(`${file}: missing front matter`);

  const fields = new Map<string, string>();

  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");

    if (colon === -1) continue;

    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }

  const required = (field: string) => {
    const value = fields.get(field);

    if (!value) throw new Error(`${file}: front matter needs "${field}"`);

    return value;
  };

  const published = parseDate({ value: required("published"), field: "published", file });
  const updatedField = fields.get("updated");

  const updated = updatedField
    ? parseDate({ value: updatedField, field: "updated", file })
    : published;

  const meta: PostMeta = {
    slug,
    title: required("title"),
    description: required("description"),
    published,
    updated,
  };

  return { meta, body: source.slice(match[0].length) };
}

const markdown = new Marked({ gfm: true });

function readPosts(): Post[] {
  return readdirSync(BLOG_DIR)
    .filter((file) => file.endsWith(".md"))
    .map((file) => {
      const { meta, body } = parsePost({
        file,
        source: readFileSync(join(BLOG_DIR, file), "utf8"),
      });

      return { ...meta, html: markdown.parse(body, { async: false }) };
    })
    .sort((a, b) => b.published.localeCompare(a.published));
}

/** Every post, newest first. */
export function getPosts(): Post[] {
  return readPosts();
}

export function getPost(slug: string): Post | undefined {
  return readPosts().find((post) => post.slug === slug);
}

/** The newest `updated` date across all posts, for the blog index's last change. */
export function latestUpdate(posts: readonly Post[]): PostDate | undefined {
  return posts.map((post) => post.updated).sort((a, b) => b.localeCompare(a))[0];
}

export function postUrl(slug: string) {
  return `${SITE_URL}/blog/${slug}`;
}

/** "October 30, 2026", read as UTC so the date doesn't shift with the build machine's timezone. */
export function formatDate(date: PostDate) {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
