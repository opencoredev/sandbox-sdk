import type { ModalClientParams, Sandbox } from "modal";
import { loadPeer } from "../../peer.js";
import {
  createModalProvider,
  type ModalAdapter,
  type ModalOptions as NativeModalOptions,
} from "./provider.js";

export type {
  ModalCapability,
  ModalDestroyEvent,
  ModalPendingSandbox,
  ModalPreparedApp,
  ModalResources,
  PrepareAppOptions,
} from "./provider.js";

export type ModalOptions = NativeModalOptions & {
  /** Defaults to MODAL_TOKEN_ID, then the active profile in ~/.modal.toml. */
  tokenId?: string;
  /** Defaults to MODAL_TOKEN_SECRET, then the active profile in ~/.modal.toml. */
  tokenSecret?: string;
  /** Other `ModalClient` settings, such as `timeoutMs`, `maxRetries` or `logLevel`. */
  client?: Omit<ModalClientParams, "tokenId" | "tokenSecret" | "environment">;
};

export type ModalProvider = ModalAdapter<Sandbox>;

/** Modal Sandboxes through the official `modal` SDK, an optional peer loaded on first use. */
export function modal(options: ModalOptions = {}): ModalProvider {
  const { tokenId, tokenSecret, client, ...settings } = options;

  return createModalProvider(async () => {
    const { ModalClient } = await loadPeer("modal", "modal", () => import("modal"));

    // Unset fields stay unset, so the SDK falls back to the environment and the profile file.
    const params: ModalClientParams = { ...client };

    if (tokenId !== undefined) params.tokenId = tokenId;

    if (tokenSecret !== undefined) params.tokenSecret = tokenSecret;

    if (settings.environment !== undefined) params.environment = settings.environment;

    return new ModalClient(params);
  }, settings);
}
