import type { Metadata } from "next";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";

import { fontVariables } from "@/lib/fonts";
import { PostHogProvider } from "@/lib/posthog-provider";
import { socialImage } from "@/lib/shared";

import "./global.css";

const siteUrl = "https://sandbox-sdk.app";

const description =
  "Sandboxes for your agents and your users. Run commands, edit files, and serve previews on E2B, Daytona, Vercel, Docker, and more from one TypeScript SDK.";

// Structured data for search engines. JSON.stringify leaves "<" alone, so it is
// escaped to keep a string value from closing the script tag.
const jsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  name: "Sandbox SDK",
  description,
  url: siteUrl,
  codeRepository: "https://github.com/opencoredev/sandbox-sdk",
  programmingLanguage: "TypeScript",
  runtimePlatform: "Node.js",
  license: "https://opensource.org/licenses/MIT",
  author: { "@type": "Organization", name: "OpenCore" },
}).replace(/</g, "\\u003c");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Sandbox SDK: one TypeScript API for E2B, Daytona, Vercel Sandbox, and more",
    template: "%s · Sandbox SDK",
  },
  description,
  applicationName: "Sandbox SDK",
  icons: {
    icon:
      process.env.NODE_ENV === "development"
        ? "/favicon-development.svg"
        : [
            {
              url: "/favicon-light.svg",
              type: "image/svg+xml",
              media: "(prefers-color-scheme: light)",
            },
            {
              url: "/favicon-dark.svg",
              type: "image/svg+xml",
              media: "(prefers-color-scheme: dark)",
            },
          ],
    apple: "/apple-icon.png",
  },
  authors: [{ name: "OpenCore" }],
  creator: "OpenCore",
  category: "developer tools",
  keywords: [
    "TypeScript sandbox SDK",
    "code execution sandbox",
    "AI agent sandbox",
    "Docker",
    "E2B",
    "Daytona",
    "Vercel Sandbox",
    "Upstash Box",
    "Railway",
    "Boat",
    "Tenki",
    "agentOS",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    title: "Sandbox SDK",
    description: "Sandboxes for your agents and your users. Any provider, one line.",
    url: "https://sandbox-sdk.app",
    siteName: "Sandbox SDK",
    type: "website",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sandbox SDK",
    description: "Sandboxes for your agents and your users. Any provider, one line.",
    images: [socialImage],
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={fontVariables} suppressHydrationWarning>
      <head>
        {process.env.NODE_ENV === "development" && (
          <Script
            src="//unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body className="flex flex-col min-h-screen">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
        {children}
        <Analytics />
        <PostHogProvider />
      </body>
    </html>
  );
}
