import { createSandbox } from "../src";
import { railway } from "../src/providers/railway";

await using sandbox = await createSandbox({ provider: railway() });
console.log((await sandbox.run("printf railway")).stdout);
