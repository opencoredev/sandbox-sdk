import { withSandbox } from "../src";
import { local } from "../src/providers/local";

await withSandbox({ provider: local() }, async (sandbox) => {
  await sandbox.files.mkdir("notes");
  await sandbox.files.write("notes/hello.txt", "hello");
  console.log(await sandbox.files.text("notes/hello.txt"));
  console.log(await sandbox.files.list("notes"));
  await sandbox.files.remove("notes");
});
