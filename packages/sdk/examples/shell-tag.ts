import { createSandbox } from "../src";
import { local } from "../src/providers/local";

await using sandbox = await createSandbox({ provider: local() });

// Interpolated values are quoted automatically, so untrusted input is safe.
const name = "hello world.txt";
await sandbox.$`touch ${name}`;
console.log((await sandbox.$`ls -la ${name}`).stdout);

// Nonzero exits throw CommandFailedError with the full result attached.
try {
  await sandbox.$`ls /missing`;
} catch (error) {
  console.log(String(error));
}
