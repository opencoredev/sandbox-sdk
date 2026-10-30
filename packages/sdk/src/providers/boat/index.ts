import { boatApi } from "../boat-api/index.js";
import type { BoatApi, CreateSandboxRequest, Sandbox as BoatSandbox } from "@boatdev/sdk";
import type { Provider } from "../../provider.js";

/** Native create fields shared by Boat and Sandboxer. */
export interface BoatCreateOptions {
  /** Seconds until the VM auto-stops; `null` turns auto-stop off. Default: 3600.
   * At most 2592000. The timer restarts while the provider's own agent works,
   * so this caps idle cost but is not a hard lifetime. */
  ttlSeconds?: number | null;
  /** `false` never snapshots the VM: it pays nothing for background captures,
   * and a stop erases its disk. Default: true. */
  snapshots?: boolean;
  /** `false` keeps no command output, process list, or metrics at the provider.
   * Live output still streams. Default: the account setting. */
  monitoring?: boolean;
  /** Organization to bill, by id or name. Default: your active wallet. */
  org?: string;
}

export interface BoatOptions extends BoatCreateOptions {
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
