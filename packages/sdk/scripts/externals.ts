/**
 * Packages the build never bundles, whether or not they are peers today. Provider SDKs stay here after an
 * adapter stops depending on them: users may still import them for `box.native.sdk(() => import(...))`, and
 * a dev-installed copy must never end up in dist. `scripts/build.ts` fails when a peer is missing here, and
 * when anything from node_modules lands in dist.
 */
export const externalPackages: readonly string[] = [
  // Provider SDKs.
  "@boatdev/sdk",
  "@boxd-sh/sdk",
  "@daytonaio/sdk",
  "@daytona/api-client",
  "@daytona/toolbox-api-client",
  "@rivet-dev/agentos-core",
  "@superserve/sdk",
  "@tenkicloud/sandbox",
  "@upstash/box",
  "@vercel/sandbox",
  "@vercel/oidc",
  "e2b",
  "freestyle",
  "railway",
  // Agent frameworks and test runners behind their own subpaths.
  "@mastra/core",
  "@openai/agents",
  "ai",
  "vitest",
  "zod",
];
