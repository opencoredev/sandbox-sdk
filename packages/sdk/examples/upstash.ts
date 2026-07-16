import { createSandbox } from "../src";
import { upstash } from "../src/providers/upstash";

const sandbox = await createSandbox({
  provider: upstash({ runtime: "node" }),
  cwd: "/workspace/home",
});
try {
  console.log((await sandbox.run("printf upstash")).stdout);
} finally {
  await sandbox.stop();
}
