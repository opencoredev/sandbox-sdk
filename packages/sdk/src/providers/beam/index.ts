import { loadPeer } from "../../peer.js";
import { cachedAuthorization, failure } from "./errors.js";
import {
  createBeamProvider,
  type BeamModule,
  type BeamOptions,
  type BeamProvider,
} from "./provider.js";

export type { BeamNative, BeamOptions, BeamPlane, BeamProvider } from "./provider.js";

/**
 * beam-js keeps one global configuration and caches its HTTP client, with the first token, gateway
 * and timeout, for the life of the process. One process can therefore use one Beam account: a
 * provider with another token, workspace or gateway is refused instead of creating in the wrong
 * account. The adapter makes that client in the same turn as its first create, so it holds the
 * token and `requestTimeoutMs` of that create's provider; a client beam-js already made, by direct
 * use, keeps its own timeout.
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

      if (cached === undefined) {
        // Read only when beam-js makes its client; its image builds keep their own 10 minutes.
        m.beamOpts.timeout = settings.requestTimeoutMs;
        // beam-js makes its client synchronously at the start of a request; an aborted signal
        // makes axios reject it before anything is sent. The client now holds this token and
        // timeout, whatever changes beamOpts before the create's own first request.
        client.default
          .request({ method: "GET", url: "/api/v1/workspace/current", signal: AbortSignal.abort() })
          .catch(() => {});
      }
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

/**
 * Beam Sandboxes. Fresh creates go through `@beamcloud/beam-js`, which logs progress and raw HTTP
 * errors to the console; while a create runs, the console output from inside it is filtered (log
 * and info dropped, the token removed from warn and error). A console method replaced while a
 * create runs receives that output unfiltered until the create ends.
 */
export function beam(options: BeamOptions = {}): BeamProvider {
  return createBeamProvider(options, load);
}
