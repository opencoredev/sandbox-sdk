import { SandboxError } from "./errors.js";

/** Loads an optional peer SDK on first use. A missing install becomes an
 * unavailable error naming the package, instead of the adapter's generic
 * provider failure. Callers pass a literal import() so bundlers keep it external.
 * The result goes through {@link peerModule}, so named exports work in bundles too.
 */
export async function loadPeer<T>(name: string, provider: string, load: () => Promise<T>): Promise<T> {
  let module: T;
  try {
    module = await load();
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes(`'${name}'`);
    if (!missing) throw error;
    throw new SandboxError(`${name} is not installed. The ${provider} adapter loads it as an optional peer. Install ${name} next to @opencoredev/sandbox-sdk.`, { code: "unavailable", provider, cause: error });
  }
  return peerModule(module);
}

/** Normalizes a dynamically imported CommonJS peer. Bundlers that split chunks
 * (esbuild with splitting, as Convex uses) give `import()` of a CommonJS package
 * a namespace whose only export is `default`, the original `module.exports`.
 * Named exports missing from the namespace are filled in from `default`, and
 * exports the namespace already has win. A namespace that lacks nothing is
 * returned as is.
 */
export function peerModule<T>(module: T): T {
  if (typeof module !== "object" || module === null || !("default" in module)) return module;
  const inner = module.default;
  if (typeof inner !== "object" || inner === null) return module;
  if (Object.keys(inner).every(key => key in module)) return module;
  return Object.assign({}, inner, module);
}
