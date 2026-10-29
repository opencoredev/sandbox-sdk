import { SandboxError } from "./errors.js";
import { isFunction, isObject } from "./core/guards.js";

/** Peers loaded through {@link loadPeer}, by package name. */
const loaded = new Map<string, unknown>();

const bundleHint = (name: string) =>
  `Bundle with a createRequire banner (import { createRequire } from "node:module"; const require = createRequire(import.meta.url);) or mark @opencoredev/sandbox-sdk and ${name} as external.`;

/** Loads an optional peer SDK on first use. A missing install becomes an
 * unavailable error naming the package, instead of the adapter's generic
 * provider failure. Callers pass a literal import() so bundlers keep it external.
 * The result goes through {@link peerModule}, so named exports work in bundles too.
 */
export async function loadPeer<T>(
  name: string,
  provider: string,
  load: () => Promise<T>,
): Promise<T> {
  let module: T;

  try {
    module = await load();
  } catch (error) {
    const missing =
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_MODULE_NOT_FOUND" &&
      error.message.includes(`'${name}'`);

    if (missing)
      throw new SandboxError(
        `${name} is not installed. The ${provider} adapter loads it as an optional peer. Install ${name} next to @opencoredev/sandbox-sdk.`,
        { code: "unavailable", provider, cause: error },
      );

    // esbuild's ESM output has no require, so a bundled CommonJS dependency fails as soon as it loads.
    const dynamic =
      error instanceof Error
        ? /Dynamic require of "[^"]{1,100}" is not supported/.exec(error.message)?.[0]
        : undefined;

    if (dynamic === undefined) throw error;
    throw new SandboxError(
      `${name} could not load in this bundle: ${dynamic}. ${bundleHint(name)}`,
      { code: "unavailable", provider, hint: bundleHint(name), cause: dynamic },
    );
  }

  const normalized = peerModule(module);
  loaded.set(name, normalized);

  return normalized;
}

/**
 * Whether `error` is an instance of the class `exportName` from the already loaded peer `name`.
 * Bundlers rename classes (minifiers always, esbuild on a collision such as `FileNotFoundError2`),
 * so `constructor.name`, and a `name` the SDK copies from `new.target.name`, are not stable. The
 * class object the adapter loaded is. False when the peer was never loaded: it cannot have thrown.
 */
export function isPeerError(cause: unknown, name: string, exportName: string): boolean {
  const module = loaded.get(name);

  if (!isObject(module)) return false;
  // Module namespaces and peerModule's merged objects hold their exports as own properties.
  const type = Object.getOwnPropertyDescriptor(module, exportName)?.value;

  return isFunction(type) && cause instanceof type;
}

/** Normalizes a dynamically imported CommonJS peer. Bundlers that split chunks
 * (esbuild with splitting, as Convex uses) give `import()` of a CommonJS package
 * a namespace whose only export is `default`, the original `module.exports`.
 * Named exports missing from the namespace are filled in from `default`, and
 * exports the namespace already has win. A namespace that lacks nothing is
 * returned as is.
 */
export function peerModule<T>(module: T): T {
  if (!isObject(module) || !("default" in module)) return module;
  const inner = module.default;

  if (!isObject(inner)) return module;

  if (Object.keys(inner).every((key) => key in module)) return module;

  return Object.assign({}, inner, module);
}
