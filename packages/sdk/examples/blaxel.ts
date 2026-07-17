import { createSandbox } from "../src";
import { blaxel } from "../src/providers/blaxel";

await using sandbox = await createSandbox({
  provider: blaxel({ region: "us-pdx-1" }),
});
console.log((await sandbox.run("printf blaxel")).stdout);
