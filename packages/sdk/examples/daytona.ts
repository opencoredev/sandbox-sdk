import { createSandbox } from "../src";
import { daytona } from "../src/providers/daytona";

await using sandbox = await createSandbox({ provider: daytona({ image: "ubuntu:24.04" }) });
console.log((await sandbox.run("printf daytona")).stdout);
