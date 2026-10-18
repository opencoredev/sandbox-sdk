import { defineConfig } from "blume";

import { sandboxDark } from "./themes/code";

export default defineConfig({
  title: "Sandbox SDK",
  description:
    "Sandboxes for your agents and your users. One TypeScript API over Docker, E2B, Vercel, and Daytona, called with your own keys.",
  logo: { image: "/logo.svg", text: "Sandbox SDK", href: "https://sandbox-sdk.app" },
  content: {
    root: "content",
  },
  deployment: {
    base: "/docs",
    site: "https://sandbox-sdk.app",
  },
  github: {
    owner: "opencoredev",
    repo: "sandbox-sdk",
    dir: "apps/docs",
  },
  navigation: {
    cta: { href: "https://github.com/opencoredev/sandbox-sdk", label: "GitHub" },
    sidebar: {
      display: "flat",
      items: [
        {
          label: "Get started",
          items: ["/", "/upgrade-from-0-2"],
        },
        {
          label: "Concepts",
          items: [
            "/concepts/sandboxes-and-keys",
            "/concepts/running-commands",
            "/concepts/processes-and-previews",
            "/concepts/files-and-git",
            "/concepts/lifecycle-and-cleanup",
          ],
        },
        {
          label: "Guides",
          items: [
            "/guides/give-your-agent-a-sandbox",
            "/guides/build-an-ai-app-builder",
            "/guides/testing-with-memory",
            "/guides/machine-size-and-network",
          ],
        },
        {
          label: "Providers",
          items: [
            "/providers",
            "/providers/local",
            "/providers/e2b",
            "/providers/vercel",
            "/providers/daytona",
            "/providers/memory",
          ],
        },
        {
          label: "Reference",
          items: [
            "/reference/sandbox",
            "/reference/agent-tools",
            "/reference/errors",
            "/reference/benchmarks",
          ],
        },
      ],
    },
  },
  theme: {
    mode: "dark",
    toggle: false,
    radius: "none",
    accent: "#e8a33c",
    action: "#e8a33c",
    background: "#0b0b0c",
    fonts: {
      display: "geist",
      body: "geist",
      mono: "geist-mono",
    },
  },
  markdown: {
    code: {
      theme: { light: sandboxDark, dark: sandboxDark },
    },
  },
  seo: {
    og: {
      enabled: true,
      site: "sandbox-sdk.app/docs",
      palette: {
        accent: "#e8a33c",
        background: "#0b0b0c",
        foreground: "#ecebe8",
        muted: "#8d8e93",
        border: "#23252a",
      },
    },
  },
});
