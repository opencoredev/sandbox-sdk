import type { Sandbox } from "@vercel/sandbox";
import type { Provider } from "../../provider.js";
import { createVercelProvider, type VercelOptions, type VercelCapability } from "./provider.js";
export type { VercelOptions, VercelCapability } from "./provider.js";

export function vercel(options: VercelOptions = {}): Provider<Sandbox, VercelCapability> {
  return createVercelProvider(async () => { const { Sandbox } = await import("@vercel/sandbox"); return Sandbox; }, options);
}
