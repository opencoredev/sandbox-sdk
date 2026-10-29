import { vi } from "vitest";
import { nativeModules, type NativeModules } from "../src/existence.js";

/** Serve these fakes from the native SDK loader. Loading any other package fails. */
export function fakeNativeModules(fakes: Partial<NativeModules>) {
  return vi.spyOn(nativeModules, "load").mockImplementation(async (name) => {
    const fake = fakes[name];

    if (fake === undefined) throw new Error("Unexpected native SDK import");

    return fake;
  });
}
