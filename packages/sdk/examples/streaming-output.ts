import type { Sandbox } from "../src";

export async function stream(sandbox: Sandbox) {
  const process = await sandbox.processes.start("for n in 1 2 3; do echo $n; sleep 1; done");
  for await (const event of process.output()) console.log(event.stream, event.data);
}
