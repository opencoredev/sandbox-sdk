import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";

import { JsonLd } from "@/components/json-ld";
import { Provider } from "@/components/provider";
import {
  organizationSchema,
  siteDescription,
  siteKeywords,
  siteTagline,
  siteUrl,
  softwareSchema,
  websiteSchema,
} from "@/lib/seo";
import { appName, socialImage } from "@/lib/shared";

import "./global.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: `${appName} — ${siteTagline}`, template: `%s · ${appName}` },
  description: siteDescription,
  applicationName: appName,
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
  authors: [{ name: "OpenCore", url: "https://opencore.dev" }],
  creator: "OpenCore",
  publisher: "OpenCore",
  category: "developer tools",
  keywords: siteKeywords,
  alternates: { canonical: "/" },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1 },
  },
  openGraph: {
    title: `${appName} — ${siteTagline}`,
    description: siteDescription,
    url: siteUrl,
    siteName: appName,
    locale: "en_US",
    type: "website",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: `${appName} — ${siteTagline}`,
    description: "One open-source TypeScript API for every sandbox provider.",
    images: [socialImage],
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <head>
        <JsonLd data={organizationSchema} />
        <JsonLd data={websiteSchema} />
        <JsonLd data={softwareSchema} />
        {process.env.NODE_ENV === "development" && (
          <Script
            src="//unpkg.com/react-grab/dist/index.global.js"
            crossOrigin="anonymous"
            strategy="beforeInteractive"
          />
        )}
      </head>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
        <Analytics />
      </body>
    </html>
  );
}
