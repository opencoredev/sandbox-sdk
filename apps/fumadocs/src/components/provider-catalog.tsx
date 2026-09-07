import { getProviderMetadata } from "@opencoredev/sandbox-sdk/metadata";
import { Link } from "@tanstack/react-router";

import { ProviderLogo } from "@/components/docs-icon";

const providerCopy = {
  local: "Run isolated AgentOS VMs on the same machine.",
  memory: "Test file and command flows with no VM.",
  e2b: "Spin up short-lived Linux sandboxes for coding agents.",
  daytona: "Keep persistent workspaces and GPU jobs.",
  vercel: "Run managed Linux sandboxes with persistent state.",
  upstash: "Keep durable serverless containers warm.",
  box: "Use full cloud VMs and hosted previews.",
  railway: "Run ephemeral jobs beside Railway services.",
  cloudflare: "Create Worker-bound containers through Durable Objects.",
} as const;

export function ProviderCatalog() {
  return (
    <div className="not-prose my-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {Object.entries(providerCopy).map(([id, copy]) => {
        const provider = getProviderMetadata(id);

        return (
          <Link
            key={provider.id}
            to="/docs/$"
            params={{ _splat: `providers/${provider.id}` }}
            className="group flex min-h-36 flex-col rounded-xl border bg-fd-card/45 p-4 transition-colors hover:border-fd-primary/45 hover:bg-fd-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
          >
            <div className="flex items-start justify-between gap-3">
              <ProviderLogo id={provider.id} className="size-10 rounded-xl [&>svg]:size-6" />
              {provider.technicalStatus === "experimental" && (
                <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                  Experimental
                </span>
              )}
            </div>
            <div className="mt-4">
              <h2 className="text-sm font-semibold text-fd-foreground group-hover:text-fd-primary">
                {provider.displayName}
              </h2>
              <p className="mt-1 text-sm leading-5 text-fd-muted-foreground">{copy}</p>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
