import { boatApi } from "../boat-api/index.js";
import type { BoatPlane } from "../boat-api/transport.js";
import type { NativeApi } from "../../native.js";
import type { Provider } from "../../provider.js";
/** Boat machine types: 2 CPU/4 GB, 4 CPU/8 GB, 8 CPU/16 GB, 16 CPU/32 GB. */
export type BoatMachine = "small" | "default" | "large" | "xlarge";
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
  machine?: BoatMachine;
  /** @deprecated Use machine. Removed in 1.0.0. */
  type?: BoatMachine;
  /** Deadline for each control-plane request. Default: 90 seconds. */
  requestTimeoutMs?: number;
}

/** What `native.sdk()` needs from `@boatdev/sdk`: its `Configuration` and `BoatApi` classes. */
export interface BoatSdkModule {
  Configuration: new (parameters: { basePath?: string; accessToken?: string }) => object;
  BoatApi: new (configuration: never) => {
    get(request: { sandboxId: string }): Promise<{ sandbox: unknown }>;
  };
}
/** `box.native.sdk(() => import("@boatdev/sdk"))`: a `BoatApi` client with this adapter's base URL and key, and the sandbox's metadata from `client.get`. */
export type BoatSandboxSdk = <M extends BoatSdkModule>(
  load: () => Promise<M>,
) => Promise<{
  client: InstanceType<M["BoatApi"]>;
  sandbox: Awaited<ReturnType<InstanceType<M["BoatApi"]>["get"]>>["sandbox"];
}>;
/** `provider.api.sdk(() => import("@boatdev/sdk"))`: the `BoatApi` client. */
export type BoatClientSdk = <M extends BoatSdkModule>(
  load: () => Promise<M>,
) => Promise<InstanceType<M["BoatApi"]>>;

/**
 * `box.native`: Boat's HTTP API with this adapter's base URL, key, retries and redaction. Its one plane is
 * `"api"`, and `{sandboxId}` in a path fills from the sandbox.
 */
export type BoatNative = NativeApi<BoatPlane, BoatSandboxSdk>;
export type BoatProvider = Provider<BoatNative, "size"> & {
  /** Boat's API with no sandbox bound, for account calls such as `GET /limits`. */
  readonly api: NativeApi<BoatPlane, BoatClientSdk>;
};

/** Boat API v1 over plain HTTP. No other package to install. */
export function boat(options: BoatOptions = {}): BoatProvider {
  return boatApi(options).provider;
}
