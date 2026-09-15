import { createSandbox } from "../src";
import { tenki } from "../src/providers/tenki";

await using sandbox = await createSandbox({
  provider: tenki({ idleTimeoutMinutes: 5 }),
});
await sandbox.files.write("hello.txt", "hello from Tenki");
console.log((await sandbox.run("cat hello.txt")).stdout);
