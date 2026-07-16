import { createSandbox } from "../src";
import { upstash } from "../src/providers/upstash";

await using sandbox = await createSandbox({
  provider: upstash({ runtime: "node" }),
  cwd: "/workspace/home",
});
console.log((await sandbox.run("printf upstash")).stdout);
