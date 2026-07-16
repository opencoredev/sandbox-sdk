import { withSandbox } from "../src";
import { ascii } from "../src/providers/ascii";

await withSandbox({ provider: ascii({ ttlSeconds: 600 }) }, async (sandbox) => {
  await sandbox.files.write("hello.txt", "hello from Ascii Box\n");
  const result = await sandbox.run("cat hello.txt");
  console.log(result.stdout);
});
