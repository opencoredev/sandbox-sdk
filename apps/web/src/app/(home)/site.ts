/** Links, the install command and halftone styles, shared by the landing page. Plain constants, so server components can read them. */
import type { HalftoneDots } from "@/components/halftone/halftone";

export const GITHUB = "https://github.com/opencoredev/sandbox-sdk";
export const NPM = "https://www.npmjs.com/package/@opencoredev/sandbox-sdk";
export const SECURITY = `${GITHUB}/security/policy`;
export const INSTALL = "bun add @opencoredev/sandbox-sdk";

/** Docs live in the Blume app under /docs (apps/docs). */
export const DOCS = {
  quickstart: "/docs",
  start: "/docs/getting-started/quickstart",
  providers: "/docs/providers",
  integrations: "/docs/integrations",
} as const;

export const BLOG = "/blog";

/** JSON-LD `@id`s: the layout defines these nodes on every page, and the homepage's SoftwareApplication points at them. */
export const SCHEMA_IDS = {
  website: "https://sandbox-sdk.app/#website",
  organization: "https://sandbox-sdk.app/#organization",
  sourceCode: "https://sandbox-sdk.app/#source",
  application: "https://sandbox-sdk.app/#application",
} as const;

export const INK: readonly [number, number, number] = [0.043, 0.043, 0.047];

export const CARD_DOTS: HalftoneDots = {
  cell: 5,
  fill: 0.8,
  dot: "square",
  glow: 0.12,
  ground: INK,
};

export const EMBER_DOTS: HalftoneDots = {
  cell: 13,
  fill: 0.62,
  dot: "square",
  glow: 0.4,
  ground: INK,
};
