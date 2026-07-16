import { createSandbox } from "../src";
import { local } from "../src/providers/local";

await using sandbox = await createSandbox({ provider: local() });
console.log((await sandbox.run({ command: "node", args: ["--version"] })).stdout);
