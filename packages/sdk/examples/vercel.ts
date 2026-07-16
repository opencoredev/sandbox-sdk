import { createSandbox } from "../src";
import { vercel } from "../src/providers/vercel";

const sandbox = await createSandbox({ provider: vercel({ runtime: "node24" }) });
try {
  console.log((await sandbox.run("printf vercel")).stdout);
} finally {
  await sandbox.stop();
}
