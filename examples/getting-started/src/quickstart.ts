// Runs with no account and no Docker: the memory provider is an in-process fake
// with a small shell (echo, cat, printf, sleep, ls, printenv). Swap `memory()` for
// `local()` or any cloud provider and the rest of this file stays the same.
import { createSandbox, SandboxError } from "@opencoredev/sandbox-sdk";
import { memory } from "@opencoredev/sandbox-sdk/memory";

// `await using` destroys the sandbox when this module finishes, even on a throw.
await using box = await createSandbox(memory());

console.log(`created ${box.provider} sandbox ${box.id}`);

// Files. Relative paths resolve against /workspace.
await box.files.write("hello.txt", "hello from the sandbox\n");

const result = await box.run("cat hello.txt");

console.log(`run: ok=${result.ok} stdout=${JSON.stringify(result.stdout)}`);

// A non-zero exit is a result, not an exception.
const failed = await box.run("exit 3");

console.log(`exit 3: ok=${failed.ok} exitCode=${failed.exitCode}`);

// Stream output as it arrives, then await the same handle for the full result.
const stream = box.run("echo one; sleep 0.2; echo two");

for await (const chunk of stream) process.stdout.write(`[${chunk.stream}] ${chunk.text}`);

console.log(`stream finished in ${(await stream).durationMs} ms`);

// Timeouts resolve with `timedOut: true`.
const slow = await box.run("sleep 5", { timeoutMs: 200 });

console.log(`timeout: ok=${slow.ok} timedOut=${slow.timedOut} exitCode=${slow.exitCode}`);

// A background process, ready once its log prints "ready".
const worker = await box.start("echo ready; sleep 30", { name: "worker", ready: { log: /ready/ } });

console.log(`process ${worker.name}: ready=${worker.ready}`);

console.log(`logs: ${JSON.stringify((await box.process("worker").logs()).text)}`);

await worker.stop();

// The SDK throws only SandboxError. Branch on `code`.
try {
  await box.files.read("missing.txt");
} catch (error) {
  if (!(error instanceof SandboxError)) throw error;
  console.log(`error: code=${error.code} retryable=${error.retryable}`);
}
