import { createSandbox } from "../src";
import { local } from "../src/providers/local";

await using sandbox = await createSandbox({ provider: local() });

const python = await sandbox.runCode("print(sum(range(10)))");
console.log("python:", python.stdout.trim());

const javascript = await sandbox.runCode("console.log(21 * 2)", { language: "javascript" });
console.log("javascript:", javascript.stdout.trim());
