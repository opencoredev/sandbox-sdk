import { createSandbox } from "../src";
import { railway } from "../src/providers/railway";

await using sandbox = await createSandbox({
  provider: railway({ idleTimeoutMinutes: 5 }),
});
await sandbox.files.write("hello.txt", "hello from Railway");
console.log((await sandbox.run("cat hello.txt")).stdout);
