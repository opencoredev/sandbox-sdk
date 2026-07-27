import { createSandbox } from "../src";
import { box } from "../src/providers/box";

await using sandbox = await createSandbox({ provider: box() });
await sandbox.files.write("hello.txt", "hello from Ascii Box");
console.log((await sandbox.run("cat hello.txt")).stdout);
