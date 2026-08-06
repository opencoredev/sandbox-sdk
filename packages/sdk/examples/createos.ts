import { createSandbox } from "../src";
import { createos } from "../src/providers/createos";

await using sandbox = await createSandbox({
  provider: createos({ shape: "s-1vcpu-256mb", rootfs: "devbox:1" }),
});

console.log((await sandbox.run("node --version")).stdout);

// Access createos-specific features via raw handle
// await sandbox.raw.pause();
// await sandbox.raw.resume();
// await sandbox.raw.fork();
