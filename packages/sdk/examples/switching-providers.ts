import { createSandbox } from "../src";
import { daytona } from "../src/providers/daytona";

const sandbox = await createSandbox({ provider: daytona() }); // Replace only this import and factory.
try {
  await sandbox.files.write("main.ts", "console.log('same logic')");
  await sandbox.run("bun main.ts");
} finally {
  await sandbox.stop();
}
