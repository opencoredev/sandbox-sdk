import type * as BriqSdk from "@briq-cloud/sdk";
import type { CreateInput } from "../../provider.js";
import { SandboxError } from "../../errors.js";
import { loadPeer } from "../../peer.js";
import { briqError } from "./errors.js";
import type { BriqOptions, BriqProvider } from "./types.js";

/** The `@briq-cloud/sdk` module the adapter loads on first use. */
export type BriqModule = typeof BriqSdk;

type Client = ReturnType<BriqModule["nativeSandbox"]>;

// The core's named sizes and the Briq sizes they select. Anything else, including a resources
// object, is refused: a Briq size is a fixed set of CPU, memory and disk.
const SIZES = new Map<CreateInput["size"], "small" | "medium" | "large">([
  ["small", "small"],
  ["medium", "medium"],
  ["large", "large"],
]);

function size(input: CreateInput["size"]): "small" | "medium" | "large" | undefined {
  if (input === undefined) return undefined;

  const mapped = SIZES.get(input);

  if (!mapped)
    throw briqError(
      "unsupported",
      "Briq sizes are small, medium and large; custom sizes are unsupported",
    );

  return mapped;
}

/**
 * Sandboxes on Briq through `@briq-cloud/sdk`, which owns the create, exec and file logic. This
 * file loads it, resolves the credentials and maps its errors to {@link SandboxError}.
 */
export function createBriqProvider(
  options: BriqOptions,
  load: () => Promise<BriqModule>,
): BriqProvider {
  if ("image" in options) throw briqError("unsupported", "Custom sandbox images are unsupported");

  let module: Promise<BriqModule> | undefined;
  let client: Client | undefined;

  const credentials = () => {
    const apiKey = options.apiKey ?? process.env.BRIQ_API_KEY;

    if (!apiKey)
      throw new SandboxError(
        "Briq API key is missing. Authentication is required. Set BRIQ_API_KEY or pass apiKey.",
        { code: "auth", provider: "briq" },
      );

    return {
      apiKey,
      baseUrl: options.baseUrl ?? (process.env.BRIQ_API_URL || undefined),
      stack: options.stack,
      fetch: options.fetch,
    };
  };

  // Every call goes through here: credentials, then the peer, then the client built from both.
  async function use<T>(run: (client: Client) => Promise<T>): Promise<T> {
    const config = credentials();
    const sdk = await (module ??= loadPeer("@briq-cloud/sdk", "briq", load));

    try {
      client ??= sdk.nativeSandbox(config);

      return await run(client);
    } catch (error) {
      throw error instanceof sdk.BriqOperationError ? briqError(error.code, error.message) : error;
    }
  }

  return {
    name: "briq",
    keyMode: "best-effort",
    capabilities: new Set<"size">(["size"]),
    create: async (input) => {
      const mapped = size(input.size);

      return use((briq) => briq.create({ ...input, size: mapped }));
    },
    find: (key) => use((briq) => briq.find(key)),
    connect: (id) => use((briq) => briq.connect(id)),
    list: (labels) => use((briq) => briq.list(labels)),
    destroy: (id) => use((briq) => briq.destroy(id)),
    exec: (id, input) => use((briq) => briq.exec(id, input)),
    // The flags are the ones the SDK's file layer declares; tests/briq.test.ts compares them.
    files: {
      transfer: "files",
      listOrder: "name",
      writeSupportsMode: true,
      read: (id, path) => use((briq) => briq.files.read(id, path)),
      write: (id, path, data, writeOptions) =>
        use((briq) => briq.files.write(id, path, data, writeOptions)),
      list: (id, path) => use((briq) => briq.files.list(id, path)),
      stat: (id, path) => use((briq) => briq.files.stat(id, path)),
      mkdir: (id, path) => use((briq) => briq.files.mkdir(id, path)),
      remove: (id, path, removeOptions) =>
        use((briq) => briq.files.remove(id, path, removeOptions)),
    },
    previewUrl: (id, port) => use((briq) => briq.previewUrl(id, port)),
    native: (id) => ({ id, status: () => use((briq) => briq.native(id).status()) }),
  };
}
