import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { Analytics } from "@vercel/analytics/react";
import { RootProvider } from "fumadocs-ui/provider/tanstack";
import SearchDialog from "@/components/search";
import { appName, docsOrigin, socialImage } from "@/lib/shared";
import appCss from "@/styles/app.css?url";

const description =
  "One TypeScript API across sandbox adapters you already pay for. Files and commands are portable. Ports and snapshots stay adapter-specific.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: appName },
      { name: "description", content: description },
      { name: "application-name", content: appName },
      { name: "author", content: "OpenCore" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: appName },
      { property: "og:description", content: description },
      { property: "og:url", content: docsOrigin },
      { property: "og:site_name", content: appName },
      { property: "og:image", content: socialImage.url },
      { property: "og:image:width", content: String(socialImage.width) },
      { property: "og:image:height", content: String(socialImage.height) },
      { property: "og:image:alt", content: socialImage.alt },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: appName },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: socialImage.url },
    ],
    links: [
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-icon.png" },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="flex min-h-screen flex-col">
        <RootProvider
          search={{ SearchDialog }}
          theme={{ defaultTheme: "system", enableSystem: true }}
        >
          <Outlet />
        </RootProvider>
        <Analytics />
        <Scripts />
      </body>
    </html>
  );
}
