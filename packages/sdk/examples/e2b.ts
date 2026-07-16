import { createSandbox } from "../src";
import { e2b } from "../src/providers/e2b";

const sandbox = await createSandbox({ provider: e2b() });
try {
  console.log((await sandbox.run("printf e2b")).stdout);
} finally {
  await sandbox.stop();
}
