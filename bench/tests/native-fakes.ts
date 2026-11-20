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

/** Serve these fakes from the native SDK loader. Loading any other package fails. */
export function fakeNativeModules(fakes: Partial<NativeModules>) {
  return vi.spyOn(nativeModules, "load").mockImplementation(async (name) => {
    const fake = fakes[name];

    if (fake === undefined) throw new Error("Unexpected native SDK import");

    return fake;
  });
}
