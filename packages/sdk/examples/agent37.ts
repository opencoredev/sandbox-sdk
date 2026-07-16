import { createSandbox } from "../src";
import { agent37 } from "../src/providers/agent37";

await using sandbox = await createSandbox({ provider: agent37() });
console.log((await sandbox.run("printf agent37")).stdout);
