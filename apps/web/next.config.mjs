import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/**
 * The docs are a separate Blume app (apps/docs) served under /docs. In
 * production the host routes /docs to it. In development, set DOCS_ORIGIN to
 * the Blume dev server (for example http://localhost:4000) and this app
 * proxies /docs to it, so links from the landing page work locally.
 */
const docsOrigin = process.env.DOCS_ORIGIN?.replace(/\/$/, "");

/** @type {(phase: string) => import('next').NextConfig} */
export default function config(phase) {
  if (phase === PHASE_DEVELOPMENT_SERVER) {
    return {
      reactStrictMode: true,
      async rewrites() {
        if (!docsOrigin) return [];

        return [
          { source: "/docs", destination: `${docsOrigin}/docs` },
          { source: "/docs/:path*", destination: `${docsOrigin}/docs/:path*` },
        ];
      },
    };
  }

  return { output: "export", reactStrictMode: true };
}
