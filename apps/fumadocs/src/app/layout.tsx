import type { Metadata } from "next";
import { Inter } from "next/font/google";
import Script from "next/script";
import { Analytics } from "@vercel/analytics/next";

import { Provider } from "@/components/provider";
import { socialImage } from "@/lib/shared";

import "./global.css";

const inter = Inter({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://sandbox-sdk.app"),
  title: { default: "Sandbox SDK", template: "%s · Sandbox SDK" },
  description:
    "An open-source TypeScript SDK for running files, commands, processes, ports, and snapshots across sandbox providers.",
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
    "E2B",
    "Daytona",
    "Vercel Sandbox",
    "Upstash Box",
    "Railway Sandboxes",
  ],
  alternates: { canonical: "/" },
  openGraph: {
    title: "Sandbox SDK",
    description:
      "One open-source TypeScript API for isolated files, commands, processes, ports, and snapshots.",
    url: "https://sandbox-sdk.app",
    siteName: "Sandbox SDK",
    type: "website",
    images: [socialImage],
  },
  twitter: {
    card: "summary_large_image",
    title: "Sandbox SDK",
    description: "One open-source TypeScript API for every sandbox provider.",
    images: [socialImage],
  },
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
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
        <Provider>{children}</Provider>
        <Analytics />
      </body>
    </html>
  );
}
