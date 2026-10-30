import { defineConfig } from "blume";

import site from "../../vercel.json" with { type: "json" };
import { providerTabsMarkdown } from "./components/providers.ts";
import { sandboxDark } from "./themes/code";

type Redirect = NonNullable<Parameters<typeof defineConfig>[0]["redirects"]>[number];

const base = "/docs";

/**
 * The repo's vercel.json is the one list of redirects, and Vercel answers them
 * with real 308s. The ones that start and end in the docs come through here too,
 * written relative to the base as Blume expects, so `blume validate` checks each
 * target is a page and a host that skips vercel.json still gets a redirect page.
 */
const docsRedirects = site.redirects.flatMap(({ source, destination }): Redirect[] => {
  const from = withinBase(source);
  const to = withinBase(destination);

  return from && to ? [{ from, to, status: 308 }] : [];
});

function withinBase(path: string): string | undefined {
  if (path === base) return "/";

  return path.startsWith(`${base}/`) ? path.slice(base.length) : undefined;
}

const llmsDetails = `**When to use Sandbox SDK.** Use it when server-side TypeScript (Node 22+ or Bun 1.3+) needs an isolated Linux machine to:

- give an AI agent tools to run commands, read and edit files, and start dev servers (AI SDK, Mastra, or the OpenAI Agents SDK);
- run code a user or a model wrote, such as an AI app builder with a live preview;
- keep one long-lived sandbox per user or project and find it again by key;
- switch between Docker or agentOS on your own machine, E2B, Vercel Sandbox, Daytona, Upstash Box, Railway, Boat, Sandboxer, Tenki, Superserve, boxd, and Freestyle without rewriting code;
- test all of the above offline with the in-process \`memory()\` provider.

It is not a hosted service: it calls each provider's HTTP API or SDK with your keys, and nothing runs between you and the provider. It does not run in the browser, since provider keys must stay on a server. It is not an isolation layer of its own: the provider supplies the security boundary.

**How an agent should use it.**

1. Install the package: \`npm i @opencoredev/sandbox-sdk@next\` or \`bun add @opencoredev/sandbox-sdk@next\` (1.0 is in beta on the \`next\` tag). E2B, Daytona, Freestyle, Superserve, Boat, and Sandboxer need nothing else. For Vercel, Upstash Box, Railway, Tenki, boxd, or agentOS, install that provider's SDK next to it (\`@vercel/sandbox\`, \`@upstash/box\`, \`railway\`, \`@tenkicloud/sandbox\`, \`@boxd-sh/sdk\`, or \`@rivet-dev/agentos-core\`).
2. Start with \`memory()\` from \`@opencoredev/sandbox-sdk/memory\` (no machine, no keys), then \`local()\` from \`/local\` (Docker), following the [Quickstart](https://sandbox-sdk.app/docs/getting-started/quickstart).
3. Create sandboxes with \`createSandbox(provider, options)\` and \`await using\`. Pass \`key\` to get the same sandbox back on the next request.
4. A non-zero exit code is a result, not an error: check \`result.ok\`. The SDK throws only \`SandboxError\`; branch on \`error.code\` ([errors](https://sandbox-sdk.app/docs/reference/errors)).
5. Check an option against the [capability matrix](https://sandbox-sdk.app/docs/reference/capabilities) before using it. An option a provider can't enforce fails with \`unsupported\` instead of being ignored.
6. For agent tools, import \`sandboxTools\` from \`/ai\`, \`/mastra\`, or \`/openai\` ([agent tools](https://sandbox-sdk.app/docs/reference/agent-tools)).

Source: [github.com/opencoredev/sandbox-sdk](https://github.com/opencoredev/sandbox-sdk). Package: [@opencoredev/sandbox-sdk on npm](https://www.npmjs.com/package/@opencoredev/sandbox-sdk).`;

export default defineConfig({
  title: "Sandbox SDK",
  description:
    "Sandboxes for your agents and your users. Any provider, one line. One TypeScript API over Docker, agentOS, E2B, Vercel Sandbox, Daytona, Upstash Box, Railway, Boat, Sandboxer, Tenki, Superserve, boxd, and Freestyle, called with your own keys.",
  logo: { image: "/logo.svg", text: "Sandbox SDK", href: "https://sandbox-sdk.app" },
  content: {
    root: "content",
  },
  deployment: {
    base,
    site: "https://sandbox-sdk.app",
  },
  github: {
    owner: "opencoredev",
    repo: "sandbox-sdk",
    dir: "apps/docs",
  },
  redirects: docsRedirects,
  navigation: {
    cta: { href: "https://github.com/opencoredev/sandbox-sdk", label: "GitHub" },
    // The repo link is the only thing in Blume's site footer, so hiding it drops
    // the footer. GitHub stays one click away through the header CTA above.
    repo: false,
    sidebar: {
      display: "group",
      items: [
        { label: "Overview", root: "/", icon: "home" },
        { label: "Install", root: "/getting-started/installation", icon: "package" },
        { label: "Quickstart", root: "/getting-started/quickstart", icon: "rocket" },
        { label: "Choose a provider", root: "/getting-started/choose-a-provider", icon: "route" },
        {
          label: "Providers",
          icon: "server",
          collapsed: false,
          items: [
            { label: "Compare providers", root: "/providers", icon: "table-2" },
            { label: "Local (Docker)", root: "/providers/local", icon: "/integrations/docker.svg" },
            {
              label: "Local (agentOS)",
              root: "/providers/agentos",
              icon: "/integrations/agentos.svg",
            },
            { label: "E2B", root: "/providers/e2b", icon: "/integrations/e2b.svg" },
            {
              label: "Vercel Sandbox",
              root: "/providers/vercel",
              icon: "/integrations/vercel.svg",
            },
            { label: "Daytona", root: "/providers/daytona", icon: "/integrations/daytona.svg" },
            { label: "Upstash Box", root: "/providers/upstash", icon: "/integrations/upstash.svg" },
            { label: "Railway", root: "/providers/railway", icon: "/integrations/railway.svg" },
            { label: "Boat", root: "/providers/boat", icon: "/integrations/boat.svg" },
            {
              label: "Sandboxer",
              root: "/providers/sandboxer",
              icon: "/integrations/sandboxer.svg",
            },
            { label: "Tenki", root: "/providers/tenki", icon: "/integrations/tenki.svg" },
            {
              label: "Superserve",
              root: "/providers/superserve",
              icon: "/integrations/superserve.svg",
            },
            { label: "boxd", root: "/providers/boxd", icon: "/integrations/boxd.svg" },
            {
              label: "Freestyle",
              root: "/providers/freestyle",
              icon: "/integrations/freestyle.svg",
            },
            { label: "Memory", root: "/providers/memory", icon: "memory-stick" },
            { label: "Write a provider", root: "/providers/custom", icon: "plug" },
          ],
        },
        {
          label: "Integrations",
          root: "/integrations",
          icon: "blocks",
          items: [
            { label: "All integrations", root: "/integrations", icon: "layout-grid" },
            {
              label: "Agent frameworks",
              icon: "bot",
              collapsed: false,
              items: [
                { label: "AI SDK", root: "/integrations/ai-sdk", icon: "/integrations/vercel.svg" },
                { label: "Mastra", root: "/integrations/mastra", icon: "/integrations/mastra.svg" },
                {
                  label: "OpenAI Agents",
                  root: "/integrations/openai-agents",
                  icon: "/integrations/openai.svg",
                },
              ],
            },
            {
              label: "Web frameworks",
              icon: "app-window",
              collapsed: false,
              items: [
                {
                  label: "Next.js",
                  root: "/integrations/nextjs",
                  icon: "/integrations/nextjs.svg",
                },
                { label: "Hono", root: "/integrations/hono", icon: "/integrations/hono.svg" },
              ],
            },
          ],
        },
        {
          label: "Guides",
          icon: "book-open",
          items: [
            {
              label: "Give your agent a sandbox",
              root: "/guides/give-your-agent-a-sandbox",
              icon: "bot",
            },
            {
              label: "Build an AI app builder",
              root: "/guides/build-an-ai-app-builder",
              icon: "wand-sparkles",
            },
            { label: "One sandbox per user", root: "/guides/per-user-sandboxes", icon: "users" },
            {
              label: "Dev servers and previews",
              root: "/guides/dev-servers-and-previews",
              icon: "monitor-play",
            },
            {
              label: "Test with memory()",
              root: "/guides/testing-with-memory",
              icon: "flask-conical",
            },
            {
              label: "Machine size and network",
              root: "/guides/machine-size-and-network",
              icon: "gauge",
            },
            { label: "Clean up sandboxes", root: "/guides/cleanup", icon: "trash-2" },
          ],
        },
        {
          label: "Concepts",
          icon: "shapes",
          items: [
            { label: "How it works", root: "/concepts/how-it-works", icon: "network" },
            {
              label: "Sandboxes and keys",
              root: "/concepts/sandboxes-and-keys",
              icon: "key-round",
            },
            { label: "Running commands", root: "/concepts/running-commands", icon: "terminal" },
            {
              label: "Processes and previews",
              root: "/concepts/processes-and-previews",
              icon: "activity",
            },
            { label: "Files and git", root: "/concepts/files-and-git", icon: "folder-git-2" },
            {
              label: "Lifecycle and cleanup",
              root: "/concepts/lifecycle-and-cleanup",
              icon: "timer",
            },
          ],
        },
        {
          label: "Reference",
          icon: "library",
          items: [
            { label: "Sandbox API", root: "/reference/sandbox", icon: "box" },
            { label: "Native API", root: "/reference/native", icon: "plug" },
            { label: "Agent tools", root: "/reference/agent-tools", icon: "wrench" },
            { label: "Errors", root: "/reference/errors", icon: "triangle-alert" },
            { label: "Capabilities", root: "/reference/capabilities", icon: "list-checks" },
            { label: "Benchmarks", root: "/reference/benchmarks", icon: "chart-no-axes-column" },
            { label: "Security", root: "/reference/security", icon: "shield" },
            { label: "FAQ", root: "/reference/faq", icon: "circle-help" },
          ],
        },
        { label: "Upgrade from 0.2", root: "/upgrade-from-0-2", icon: "arrow-up-circle" },
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
  agents: {
    llmsTxt: { details: llmsDetails },
    markdownComponents: { ProviderTabs: providerTabsMarkdown },
  },
  seo: {
    og: {
      enabled: true,
      site: "sandbox-sdk.app/docs",
      logo: "/logo.svg",
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
