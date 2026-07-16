import type { Sandbox } from "../src";

export async function background(sandbox: Sandbox) {
  const process = await sandbox.processes.start("sleep 60");
  console.log(await process.status());
  await process.kill();
}
