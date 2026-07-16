import { createSandbox } from "../src";
import { local } from "../src/providers/local";

await using sandbox = await createSandbox({ provider: local() });
await sandbox.files.mkdir("notes");
await sandbox.files.write("notes/hello.txt", "hello");
console.log(await sandbox.files.text("notes/hello.txt"));
console.log(await sandbox.files.list("notes"));
await sandbox.files.remove("notes");
