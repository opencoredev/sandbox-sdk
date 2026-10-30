import { SandboxError } from "../src/index.js";

/** The SandboxError a promise rejects with. Resolving, or rejecting with anything else, fails the test. */
export async function rejection(promise: PromiseLike<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SandboxError) return error;
    throw error;
  }

  throw new Error("Expected the promise to reject with a SandboxError");
}
