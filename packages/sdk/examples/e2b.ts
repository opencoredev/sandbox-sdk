import { createSandbox } from "../src";
import { e2b } from "../src/providers/e2b";

await using sandbox = await createSandbox({ provider: e2b() });
console.log((await sandbox.run("printf e2b")).stdout);
