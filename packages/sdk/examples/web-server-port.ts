import type { Sandbox } from "../src";

export async function serve(sandbox: Sandbox) {
  const server = await sandbox.processes.start("python3 -m http.server 3000");
  const preview = await sandbox.ports.expose(3000);
  console.log(preview.url);
  await server.kill();
}
