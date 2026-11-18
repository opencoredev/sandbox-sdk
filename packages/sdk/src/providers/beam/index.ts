import { loadPeer } from "../../peer.js";
import {
  createBeamProvider,
  type BeamModule,
  type BeamOptions,
  type BeamProvider,
} from "./provider.js";

export type { BeamNative, BeamOptions, BeamProvider } from "./provider.js";

/** The adapter's view of `@beamcloud/beam-js` 1.1.6. */
async function load(): Promise<BeamModule> {
  const m = await loadPeer("@beamcloud/beam-js", "beam", () => import("@beamcloud/beam-js"));

  return {
    configure(settings) {
      m.beamOpts.token = settings.token;
      m.beamOpts.workspaceId = settings.workspaceId;
      m.beamOpts.gatewayUrl = settings.gatewayUrl;
    },
    template: (config) =>
      new m.Sandbox({
        name: "sandbox-sdk",
        cpu: config.cpu,
        memory: config.memoryMb,
        image: new m.Image({ baseImage: config.image }),
        keepWarmSeconds: config.keepWarmSeconds,
      }),
    restore: (snapshotId) => m.Sandbox.createFromSnapshot(snapshotId),
  };
}

export function beam(options: BeamOptions = {}): BeamProvider {
  return createBeamProvider(options, load);
}
