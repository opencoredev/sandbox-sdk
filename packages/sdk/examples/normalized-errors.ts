import { isSandboxError, type Sandbox } from "../src";

export async function run(sandbox: Sandbox) {
  try {
    await sandbox.run("work");
  } catch (error) {
    if (isSandboxError(error)) console.error(error.code, error.retryable);
    else throw error;
  }
}
