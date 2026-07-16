import { createSandbox } from "../src";
import { local } from "../src/providers/local";

const sandbox = await createSandbox({ provider: local() });
try {
  console.log((await sandbox.run({ command: "node", args: ["--version"] })).stdout);
} finally {
  await sandbox.stop();
}
