import { withSandbox } from "../src";
import { local } from "../src/providers/local";

await withSandbox({ provider: local() }, async (sandbox) => {
  await sandbox.run("printf cleaned");
});
