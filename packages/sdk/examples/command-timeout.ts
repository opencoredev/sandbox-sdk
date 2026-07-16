import type { Sandbox } from "../src";

export async function bounded(sandbox: Sandbox) {
  return sandbox.run("long-task", { timeout: 5_000 });
}
