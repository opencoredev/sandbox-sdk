import { memory } from "../src/providers/memory";

await using sandbox = await memory({ files: { "hello.txt": "hi" } }).create();
console.log(await sandbox.files.text("hello.txt"));
console.log((await sandbox.$`echo ready`).stdout);
