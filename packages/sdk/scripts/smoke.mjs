import assert from "node:assert/strict";
import { createSandbox, connectSandbox, listSandboxes } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";
const provider = memory();
const box = await createSandbox(provider, { key: "built-consumer", secrets: { TOKEN: "hidden-token" } });
try {
  await box.files.write("app/hello.txt", "hello\n");
  assert.equal((await box.$`cat ${"app/hello.txt"}`).stdout, "hello\n");
  assert.equal((await box.run("printenv TOKEN")).stdout, "[REDACTED]\n");
  assert.equal((await box.run("cat", { stdin: "stdin" })).stdout, "stdin");
  assert.equal((await box.files.changes()).added[0], "/workspace/app/hello.txt");
  const dev = await box.start("echo READY; sleep 5", { name: "dev", ready: { log: /READY/ } });
  assert.equal(dev.ready, true);
  const client = await connectSandbox(provider, box.id);
  assert.match((await client.process("dev").logs()).text, /READY/);
  await client.process("dev").stop();
  assert.equal((await dev.wait()).exitCode, 143);
  await box.close();
  assert.equal((await listSandboxes(provider)).length, 1);
  console.log("PASS built ESM consumer: files, tag, stdin, redaction, changes, process reattach/stop, close");
} finally { await box.destroy(); }
