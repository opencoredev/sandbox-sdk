import { loadPeer } from "../../peer.js";
import { cachedAuthorization, failure } from "./errors.js";
import {
  createBeamProvider,
  type BeamModule,
  type BeamOptions,
  type BeamProvider,
} from "./provider.js";

export type { BeamNative, BeamOptions, BeamProvider } from "./provider.js";

/**
 * beam-js keeps one global configuration and caches its HTTP client, with the first token and
 * gateway, for the life of the process. One process can therefore use one Beam account: a provider
 * with another token, workspace or gateway is refused instead of creating in the wrong account.
 */
let configured: string | undefined;

/** The adapter's view of `@beamcloud/beam-js` 1.1.6. */
async function load(): Promise<BeamModule> {
  const m = await loadPeer("@beamcloud/beam-js", "beam", () => import("@beamcloud/beam-js"));

  // The same module instance the root imports; it holds the cached HTTP client.
  const client = await loadPeer(
    "@beamcloud/beam-js",
    "beam",
    () => import("@beamcloud/beam-js/lib/client"),
  );

  return {
    configure(settings) {
      const value = JSON.stringify([settings.token, settings.workspaceId, settings.gatewayUrl]);
      const opts = m.beamOpts;
      const cached = cachedAuthorization(client.default);

      // Another provider, or code using beam-js directly, already set it up for another account.
      const taken =
        (configured !== undefined && configured !== value) ||
        (opts.token !== "" && opts.token !== settings.token) ||
        (opts.workspaceId !== "" && opts.workspaceId !== settings.workspaceId) ||
        (cached !== undefined &&
          (cached.authorization !== `Bearer ${settings.token}` ||
            cached.baseURL !== settings.gatewayUrl));

      if (taken)
        throw failure(
          "One process can use one Beam token, workspace and gateway: @beamcloud/beam-js keeps one global client",
          "invalid_argument",
        );
      configured = value;
      m.beamOpts.token = settings.token;
      m.beamOpts.workspaceId = settings.workspaceId;
      m.beamOpts.gatewayUrl = settings.gatewayUrl;
    },
    template(config) {
      const sandbox = new m.Sandbox({
        name: "sandbox-sdk",
        cpu: config.cpu,
        memory: config.memoryMb,
        image: new m.Image({ baseImage: config.image }),
        keepWarmSeconds: config.keepWarmSeconds,
      });

      return { create: () => sandbox.create({ waitForReady: false }) };
    },
  };
}

export function beam(options: BeamOptions = {}): BeamProvider {
  return createBeamProvider(options, load);
}
