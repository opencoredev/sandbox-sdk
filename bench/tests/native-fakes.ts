import { vi } from "vitest";
import type { Provider } from "@opencoredev/sandbox-sdk/provider";
import { bindConnection } from "../src/connections.js";
import { nativeModules, type NativeModules } from "../src/existence.js";
import type { FactoryOptions } from "../src/providers.js";

/**
 * A provider bound as `loadProvider` binds the adapters it builds: its connection resolved from
 * these factory options and the environment as it is now, so set the environment first.
 */
export function bound<P extends Provider>(provider: P, options: FactoryOptions = {}): P {
  return bindConnection(provider, options);
}

/** Test credentials and scope for every connection model, so any cloud provider's binding resolves. */
const fakeConnection = {
  apiKey: "test-key",
  token: "test-token",
  teamId: "team_test",
  projectId: "prj_test",
  workspaceId: "ws-test",
  tokenId: "ak-test",
  tokenSecret: "as-test",
  environmentId: "env-test",
} satisfies FactoryOptions;

/**
 * A fake adapter bound as `loadProvider` binds a real one, with test credentials, so a run can
 * journal its connection fingerprint and create on it. A run skips any provider without one.
 */
export function boundFake<P extends Provider>(provider: P): P {
  return bindConnection(provider, fakeConnection);
}

/** Serve these fakes from the native SDK loader. Loading any other package fails. */
export function fakeNativeModules(fakes: Partial<NativeModules>) {
  return vi.spyOn(nativeModules, "load").mockImplementation(async (name) => {
    const fake = fakes[name];

    if (fake === undefined) throw new Error("Unexpected native SDK import");

    return fake;
  });
}
