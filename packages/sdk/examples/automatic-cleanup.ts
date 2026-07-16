import { createSandbox } from "../src";
import { local } from "../src/providers/local";

await using sandbox = await createSandbox({ provider: local() });
await sandbox.run("printf cleaned");
