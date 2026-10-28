import { SandboxError } from "./errors.js";

/** Loads an optional peer SDK on first use. A missing install becomes an
 * unavailable error naming the package, instead of the adapter's generic
 * provider failure. Callers pass a literal import() so bundlers keep it external.
 */
export async function loadPeer<T>(name: string, provider: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes(`'${name}'`);
    if (!missing) throw error;
    throw new SandboxError(`${name} is not installed. The ${provider} adapter loads it as an optional peer. Install ${name} next to @opencoredev/sandbox-sdk.`, { code: "unavailable", provider, cause: error });
  }
}
