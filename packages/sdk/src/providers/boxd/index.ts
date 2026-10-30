import { createBoxdProvider, type BoxdOptions, type BoxdProvider } from "./provider.js";
import { FileTransfers } from "./transfers.js";

export type { BoxdNative, BoxdOptions, BoxdProvider } from "./provider.js";

export function boxd(options: BoxdOptions = {}): BoxdProvider {
  return createBoxdProvider(
    options,
    () => import("@boxd-sh/sdk"),
    (config, signal) => new FileTransfers(config, signal),
  );
}
