import { createSandbox } from "../src";
import { vercel } from "../src/providers/vercel";

await using sandbox = await createSandbox({ provider: vercel({ runtime: "node24" }) });
console.log((await sandbox.run("printf vercel")).stdout);
