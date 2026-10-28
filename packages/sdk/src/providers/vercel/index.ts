import type { Sandbox } from "@vercel/sandbox";
import type { Provider } from "../../provider.js";
import { loadPeer } from "../../peer.js";
import { createVercelProvider, type VercelOptions as NativeVercelOptions, type VercelCapability } from "./provider.js";
export type { VercelCapability } from "./provider.js";

export interface VercelOptions extends NativeVercelOptions {
  /** Defaults to VERCEL_TOKEN; otherwise the native SDK uses VERCEL_OIDC_TOKEN. */
  token?: string;
  /** Defaults to VERCEL_TEAM_ID; required with token authentication. */
  teamId?: string;
  /** Defaults to VERCEL_PROJECT_ID; required with token authentication. */
  projectId?: string;
}
export type VercelProvider = Provider<Sandbox, VercelCapability>;
export function vercel(options: VercelOptions = {}): VercelProvider {
  return createVercelProvider(async () => { const { Sandbox } = await loadPeer("@vercel/sandbox", "vercel", () => import("@vercel/sandbox")); return Sandbox; }, options);
}
