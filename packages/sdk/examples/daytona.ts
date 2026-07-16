import { createSandbox } from "../src";
import { daytona } from "../src/providers/daytona";

const sandbox = await createSandbox({ provider: daytona({ image: "ubuntu:24.04" }) });
try {
  console.log((await sandbox.run("printf daytona")).stdout);
} finally {
  await sandbox.stop();
}
