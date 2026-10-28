import { boatApi } from "../boat-api/index.js";
import type { BoatApi, CreateSandboxRequest, Sandbox as BoatSandbox } from "@boatdev/sdk";
import type { Provider } from "../../provider.js";
export interface BoatOptions {
  /** Defaults to BOAT_API_KEY; required on first use. */
  apiKey?: string;
  /** Defaults to BOAT_API_BASE, then https://boat.dev/api/v1. */
  baseUrl?: string;
  /** @deprecated Use baseUrl. Removed in 1.0.0. */
  apiUrl?: string;
  /** Native machine size; default: Boat default (4 CPU/8 GB). Per-create size wins. */
  machine?: CreateSandboxRequest["type"];
  /** @deprecated Use machine. Removed in 1.0.0. */
  type?: CreateSandboxRequest["type"];
  /** Deadline for each control-plane request. Default: 90 seconds. */
  requestTimeoutMs?: number;
}
export interface BoatNative {
  readonly sandbox: BoatSandbox;
  readonly client: BoatApi;
}
export type BoatProvider = Provider<BoatNative, "size">;

/** Direct optional SDK with no installed remote agent or local daemon. */
export function boat(options: BoatOptions = {}): BoatProvider {
  return boatApi(options);
}
