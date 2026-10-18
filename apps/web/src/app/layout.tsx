import type { Metadata } from "next";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";

import { fontVariables } from "@/lib/fonts";
import { socialImage } from "@/lib/shared";

import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://sandbox-sdk.app"),
  title: { default: "Sandbox SDK", template: "%s · Sandbox SDK" },
  description:
    "Sandboxes for your agents and your users. Run commands, edit files, and serve previews on Docker, E2B, Vercel, Daytona, or Upstash Box from one TypeScript SDK.",
    "Sandboxes for your agents and your users. Run commands, edit files, and serve previews on Docker, E2B, Vercel, Daytona, or Railway from one TypeScript SDK.",
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
    "Railway",
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
        {children}
        <Analytics />
      </body>
    </html>
  );
}
